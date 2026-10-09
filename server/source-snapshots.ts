import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { ClientFactory, MediaItem } from './media.js';
import type { Settings } from './types.js';
import type { MigrationScope } from './migration.js';
import { ServiceError } from './errors.js';
import { snapshotProcess } from './snapshot-process.js';
import {
  decryptDatabase,
  readEnvelope,
  snapshotId,
  snapshotKey,
  writeEnvelope,
  SNAPSHOT_VERSION,
  MAX_SNAPSHOT_BYTES,
  type CaptureRequest,
  type CaptureResult,
  type SnapshotBinding,
} from './snapshot-files.js';

const MAX_AGE = 48 * 60 * 60_000;
interface Config {
  enabled: boolean;
  hour: number;
  minute: number;
  time_zone: string;
  scope: MigrationScope;
  revision: string;
}
export interface SnapshotMetadata {
  id: string;
  source_server_url: string;
  source_server_id: string;
  source_server_version: string;
  source_user_id: string;
  source_username: string;
  scope: MigrationScope;
  started_at: string;
  finished_at: string;
  expires_at: string;
  items: number;
  playlists: number;
  playlist_entries: number;
  bytes: number;
  avatar: boolean;
  source_type: 'sqlite_online_backup';
  schema: string;
}
interface State {
  config: Config;
  active?: CaptureRequest;
  generations: string[];
  last_attempt_at: string | null;
  last_finished_at: string | null;
  last_error: string | null;
  last_scheduled_date?: string;
}
const sourceUrl = (settings: Settings) => new URL(settings.emby_url).toString().replace(/\/$/, '');
export class SourceSnapshots {
  private readonly directory = process.env.JELLYPORT_SNAPSHOT_DIR || '';
  private key?: Buffer;
  private state: State;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private clearing = false;
  private readonly reads = new AbortController();
  private readonly previewPins = new Map<string, number>();
  private readonly databases = new Map<
    string,
    {
      promise: Promise<string>;
      directory?: string;
      users: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly store: Store,
    private readonly options: { demo?: boolean; clientFactory: () => ClientFactory },
  ) {
    const row = store.db.prepare('SELECT encrypted FROM source_snapshot_state WHERE id=1').get();
    this.state = row
      ? store.decrypt<State>(row.encrypted as Uint8Array)
      : {
          config: {
            enabled: false,
            hour: 3,
            minute: 0,
            time_zone: process.env.TZ || 'Etc/UTC',
            scope: 'complete',
            revision: randomUUID(),
          },
          generations: [],
          last_attempt_at: null,
          last_finished_at: null,
          last_error: null,
        };
  }
  private save() {
    this.store.db
      .prepare('INSERT OR REPLACE INTO source_snapshot_state VALUES (1,?)')
      .run(this.store.encrypt(this.state));
  }
  async start(): Promise<void> {
    if (!this.directory || this.options.demo || this.timer) return;
    this.key = await snapshotKey(this.directory, true);
    for (const name of await readdir(this.directory))
      if (/^read-[a-f0-9-]{36}-[A-Za-z0-9]+$/.test(name))
        await rm(join(this.directory, name), { recursive: true, force: true });
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
    await this.tick();
  }
  private async available(): Promise<boolean> {
    if (!this.key || this.options.demo) return false;
    try {
      const status = await readEnvelope<{
        version: number;
        emby_version: string;
        updated_at: string;
      }>(join(this.directory, 'helper.status'), this.key);
      return (
        status.version === 1 &&
        status.emby_version === SNAPSHOT_VERSION &&
        Math.abs(Date.now() - Date.parse(status.updated_at)) < 20_000
      );
    } catch {
      return false;
    }
  }
  private async result(id: string): Promise<CaptureResult> {
    if (!snapshotId.test(id) || !this.key)
      throw new ServiceError('The selected database capture is unavailable.');
    try {
      const value = await readEnvelope<CaptureResult>(
        join(this.directory, `${id}.result`),
        this.key,
      );
      if (
        !value.ok ||
        value.id !== id ||
        value.binding.version !== SNAPSHOT_VERSION ||
        value.schema !== 'emby-4.10.1.0' ||
        !value.identities ||
        typeof value.bytes !== 'number' ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 1 ||
        value.bytes > MAX_SNAPSHOT_BYTES ||
        !Number.isFinite(Date.parse(value.started_at)) ||
        !Number.isFinite(Date.parse(value.finished_at)) ||
        Date.parse(value.finished_at) < Date.parse(value.started_at)
      )
        throw new Error('Invalid capture.');
      const database = await lstat(join(this.directory, `${id}.db.enc`));
      if (!database.isFile() || database.isSymbolicLink() || database.size !== value.bytes + 28)
        throw new Error('Missing or changed capture.');
      return value;
    } catch {
      throw new ServiceError(
        'The selected database capture is missing, corrupt or unsupported. Capture it again.',
      );
    }
  }
  private metadata(
    value: CaptureResult,
    userId = '',
    username = 'All Emby users',
  ): SnapshotMetadata {
    return {
      id: value.id,
      source_server_url: value.binding.url,
      source_server_id: value.binding.server_id,
      source_server_version: value.binding.version,
      source_user_id: userId,
      source_username: username,
      scope: 'complete',
      started_at: value.started_at,
      finished_at: value.finished_at,
      expires_at: new Date(Date.parse(value.finished_at) + MAX_AGE).toISOString(),
      items: value.item_count ?? 0,
      playlists: 0,
      playlist_entries: 0,
      bytes: value.bytes!,
      avatar: false,
      source_type: 'sqlite_online_backup',
      schema: value.schema!,
    };
  }
  async status() {
    const records: SnapshotMetadata[] = [];
    if (this.key)
      for (const id of this.state.generations)
        try {
          records.push(this.metadata(await this.result(id)));
        } catch {
          /* Retained error is reported separately. */
        }
    return {
      config: this.state.config,
      available: await this.available(),
      capture_method: 'sqlite_online_backup',
      running: !!this.state.active,
      last_attempt_at: this.state.last_attempt_at,
      last_finished_at: this.state.last_finished_at,
      last_error: this.state.last_error,
      users_total: 0,
      users_processed: 0,
      users_succeeded: 0,
      users_failed: 0,
      snapshots: records.length,
      encrypted_bytes: records.reduce((total, record) => total + record.bytes, 0),
      records,
    };
  }
  async configure(input: Omit<Config, 'revision'> & { expected_revision: string }) {
    if (this.options.demo) throw new ServiceError('Snapshot changes are unavailable in demo mode.');
    if (input.expected_revision !== this.state.config.revision)
      throw new ServiceError('The snapshot schedule changed. Reload it before saving.');
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.time_zone }).format();
    } catch {
      throw new ServiceError('Choose a valid IANA time zone.');
    }
    if (input.enabled && !this.key)
      throw new ServiceError('Configure the snapshot helper and shared directory first.');
    if (
      !Number.isInteger(input.hour) ||
      input.hour < 0 ||
      input.hour > 23 ||
      !Number.isInteger(input.minute) ||
      input.minute < 0 ||
      input.minute > 59 ||
      !['complete', 'watched_only'].includes(input.scope)
    )
      throw new ServiceError('Choose a valid snapshot schedule.');
    this.state.config = {
      enabled: input.enabled,
      hour: input.hour,
      minute: input.minute,
      time_zone: input.time_zone,
      scope: input.scope,
      revision: randomUUID(),
    };
    this.save();
    return this.status();
  }
  async refresh() {
    if (this.clearing || this.stopping)
      throw new ServiceError('Snapshot changes are in progress. Retry shortly.');
    if (this.options.demo || !this.key || !(await this.available()))
      throw new ServiceError(
        'The snapshot helper is unavailable. Check its same-host read-only mount and shared directory.',
      );
    if (this.state.active || this.clearing || this.stopping)
      throw new ServiceError('A database capture or change is already running.');
    await this.prune();
    if (this.state.generations.length >= 8)
      throw new ServiceError(
        'Older captures are still used by queued or running jobs. Finish those jobs before capturing again.',
      );
    const settings = this.store.settings();
    const client = this.options.clientFactory()(settings.emby_url, settings.emby_api_key, 'emby');
    let binding: SnapshotBinding;
    let userIds: string[];
    try {
      const info = await client.systemInfo();
      if (info.Version !== SNAPSHOT_VERSION || typeof info.Id !== 'string' || !info.Id)
        throw new ServiceError('Database snapshots currently support verified Emby 4.10.1.0 only.');
      binding = { url: sourceUrl(settings), server_id: info.Id, version: info.Version };
      userIds = (await client.users()).map((user) => user.Id.toLowerCase().replaceAll('-', ''));
      if (
        !userIds.length ||
        userIds.length > 1000 ||
        userIds.some((id) => !/^[a-f0-9]{32}$/.test(id))
      )
        throw new ServiceError(
          'Emby returned unsupported user identities. Database capture was not started.',
        );
    } finally {
      await client.close();
    }
    // Recheck after the network read: two concurrent administrator requests cannot enqueue two copies.
    if (this.state.active || this.clearing || this.stopping)
      throw new ServiceError('A database capture or change is already running.');
    const latestSettings = this.store.settings();
    if (
      latestSettings.emby_url !== settings.emby_url ||
      latestSettings.emby_api_key !== settings.emby_api_key
    )
      throw new ServiceError('The Emby connection changed. Review it before capturing.');
    const request: CaptureRequest = {
      id: randomUUID(),
      requested_at: new Date().toISOString(),
      binding,
      user_ids: userIds,
    };
    this.state.active = request;
    this.state.last_attempt_at = request.requested_at;
    this.state.last_error = null;
    this.save();
    try {
      await writeEnvelope(join(this.directory, `${request.id}.request`), request, this.key);
    } catch {
      delete this.state.active;
      this.state.last_error = 'Unable to request a database capture.';
      this.save();
      throw new ServiceError(this.state.last_error);
    }
    return this.status();
  }
  private async tick(): Promise<void> {
    if (this.ticking || this.stopping || this.clearing || !this.key) return;
    this.ticking = true;
    try {
      const active = this.state.active;
      if (active) {
        let result: CaptureResult | undefined;
        try {
          result = await readEnvelope<CaptureResult>(
            join(this.directory, `${active.id}.result`),
            this.key,
          );
        } catch {}
        if (
          result &&
          result.id === active.id &&
          JSON.stringify(result.binding) === JSON.stringify(active.binding)
        ) {
          if (result.ok) {
            await this.result(active.id);
            if (active.user_ids?.some((id) => !Object.hasOwn(result!.identities!, id)))
              throw new Error('The mounted database does not contain the configured server users.');
            this.state.generations.unshift(active.id);
            this.state.last_finished_at = result.finished_at;
            this.state.last_error = null;
          } else
            this.state.last_error =
              result.error || 'Database capture failed; the last good copy is preserved.';
          delete this.state.active;
          this.save();
          await this.prune();
        } else if (Date.now() - Date.parse(active.requested_at) > 10 * 60_000) {
          this.state.last_error =
            'Database capture timed out. Check the helper; the last good copy is preserved.';
          delete this.state.active;
          this.save();
          await rm(join(this.directory, `${active.id}.request`), { force: true });
        }
      } else if (this.state.config.enabled) {
        const config = this.state.config;
        const parts = (time: number) =>
          Object.fromEntries(
            new Intl.DateTimeFormat('en-CA', {
              timeZone: config.time_zone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            })
              .formatToParts(time)
              .map((part) => [part.type, part.value]),
          );
        const current = parts(Date.now()),
          last = this.state.last_attempt_at ? parts(Date.parse(this.state.last_attempt_at)) : null;
        const day = (value: Record<string, string>) => `${value.year}-${value.month}-${value.day}`;
        const minute = Number(current.hour) * 60 + Number(current.minute),
          scheduled = config.hour * 60 + config.minute;
        const elapsed = (minute - scheduled + 1440) % 1440;
        const occurrence =
          minute >= scheduled
            ? day(current)
            : new Date(
                Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) - 1),
              )
                .toISOString()
                .slice(0, 10);
        if (
          elapsed < 60 &&
          this.state.last_scheduled_date !== occurrence &&
          (!last || this.state.last_scheduled_date !== undefined || day(last) !== occurrence)
        ) {
          this.state.last_scheduled_date = occurrence;
          this.save();
          try {
            await this.refresh();
          } catch {
            this.state.last_attempt_at = new Date().toISOString();
            this.state.last_error =
              'Scheduled database capture could not start. Check helper availability and Emby version.';
            this.save();
          }
        }
      }
    } catch {
      this.state.last_error =
        'Database capture could not be validated. The last good copy is preserved.';
      delete this.state.active;
      this.save();
    } finally {
      this.ticking = false;
    }
  }
  async select(
    userId: string,
    settings: Settings,
    serverId: string,
    id?: string,
  ): Promise<{ id: string; metadata: SnapshotMetadata; result: CaptureResult }> {
    if (this.clearing || this.stopping)
      throw new ServiceError(
        'Database snapshots are being cleared or stopped. Review a new preview.',
      );
    const selected = id ?? this.state.generations[0];
    if (!selected || !this.state.generations.includes(selected))
      throw new ServiceError('No completed database capture is available. Capture Emby first.');
    const result = await this.result(selected);
    if (result.binding.url !== sourceUrl(settings) || result.binding.server_id !== serverId)
      throw new ServiceError(
        'The saved database belongs to a different Emby connection. Capture the configured server again.',
      );
    if (
      Date.now() - Date.parse(result.finished_at) > MAX_AGE ||
      Date.parse(result.finished_at) > Date.now() + 60_000
    )
      throw new ServiceError(
        'The saved database is more than 48 hours old. Capture Emby again before migrating.',
      );
    if (!Object.hasOwn(result.identities!, userId.toLowerCase().replaceAll('-', '')))
      throw new ServiceError(
        'This Emby user is absent from the database capture. Capture it again.',
      );
    this.previewPins.set(selected, Date.now() + 30 * 60_000);
    return { id: selected, metadata: this.metadata(result, userId), result };
  }
  async items(
    selected: Awaited<ReturnType<SourceSnapshots['select']>>,
    userId: string,
    scope: MigrationScope,
    signal?: AbortSignal,
  ): Promise<MediaItem[]> {
    if (
      !this.key ||
      this.stopping ||
      this.clearing ||
      !this.state.generations.includes(selected.id)
    )
      throw new ServiceError('Database snapshots are unavailable. Review a new preview.');
    let entry = this.databases.get(selected.id);
    if (!entry) {
      const created = { promise: Promise.resolve(''), users: 0 } as {
        promise: Promise<string>;
        directory?: string;
        users: number;
        timer?: ReturnType<typeof setTimeout>;
      };
      created.promise = (async () => {
        created.directory = await mkdtemp(join(this.directory, `read-${selected.id}-`));
        const path = join(created.directory, 'library.db');
        try {
          await decryptDatabase(
            join(this.directory, `${selected.id}.db.enc`),
            path,
            this.key!,
            selected.id,
            this.reads.signal,
          );
          return path;
        } catch {
          await rm(created.directory, { recursive: true, force: true });
          throw new ServiceError('Database authentication failed. Capture Emby again.');
        }
      })();
      entry = created;
      this.databases.set(selected.id, entry);
    }
    clearTimeout(entry.timer);
    entry.users++;
    try {
      const path = await entry.promise;
      return await snapshotProcess<MediaItem[]>(
        {
          operation: 'read',
          path,
          user_id: userId.toLowerCase().replaceAll('-', ''),
          identities: selected.result.identities,
          scope,
        },
        AbortSignal.any([this.reads.signal, ...(signal ? [signal] : [])]),
        2 * 60_000,
      );
    } finally {
      entry.users--;
      if (!entry.users)
        entry.timer = setTimeout(() => void this.removeDatabase(selected.id), 60_000);
      entry.timer?.unref();
    }
  }
  private async removeDatabase(id: string) {
    const entry = this.databases.get(id);
    if (!entry || entry.users) return;
    clearTimeout(entry.timer);
    this.databases.delete(id);
    await entry.promise.catch(() => {});
    if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
  }
  private pins(): Set<string> {
    return new Set(
      this.store
        .jobs()
        .filter((job) => ['queued', 'running'].includes(job.status))
        .flatMap((job) => Object.values(job.source_snapshot_ids ?? {})),
    );
  }
  private async prune() {
    for (const [id, expires] of this.previewPins)
      if (expires < Date.now()) this.previewPins.delete(id);
    const keep = new Set([
      ...this.state.generations.slice(0, 2),
      ...this.pins(),
      ...this.previewPins.keys(),
      ...this.databases.keys(),
    ]);
    for (const id of this.state.generations)
      if (!keep.has(id)) {
        await rm(join(this.directory, `${id}.db.enc`), { force: true });
        await rm(join(this.directory, `${id}.result`), { force: true });
      }
    this.state.generations = this.state.generations.filter((id) => keep.has(id));
    this.save();
    // Failed/interrupted helper output is not an unbounded archive. Never touch current work.
    for (const name of await readdir(this.directory)) {
      const match = /^([a-f0-9-]{36})\.(db\.enc|result|request|working)$/.exec(name);
      if (
        !match ||
        !snapshotId.test(match[1]!) ||
        keep.has(match[1]!) ||
        this.state.active?.id === match[1]
      )
        continue;
      const path = join(this.directory, name);
      try {
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 20 * 60_000)
          await rm(path, { force: true });
      } catch {
        /* A helper may atomically finish a file while it is inspected. */
      }
    }
  }
  async clear() {
    if (this.options.demo) throw new ServiceError('Snapshot changes are unavailable in demo mode.');
    if (
      this.clearing ||
      this.state.active ||
      this.pins().size ||
      [...this.databases.values()].some((value) => value.users)
    )
      throw new ServiceError(
        'A capture or migration is using saved data. Finish it before clearing snapshots.',
      );
    this.clearing = true;
    try {
      for (const id of this.databases.keys()) await this.removeDatabase(id);
      for (const id of this.state.generations) {
        await rm(join(this.directory, `${id}.db.enc`), { force: true });
        await rm(join(this.directory, `${id}.result`), { force: true });
      }
      this.state.generations = [];
      this.previewPins.clear();
      this.save();
      return await this.status();
    } finally {
      this.clearing = false;
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.reads.abort();
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 20));
    while ([...this.databases.values()].some((value) => value.users))
      await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [id, value] of this.databases) {
      await value.promise.catch(() => {});
      if (!value.users) await this.removeDatabase(id);
    }
  }
}
