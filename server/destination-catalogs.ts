import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.js';
import {
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ITEMS,
  projectCatalogItem,
  isObject,
  type ClientFactory,
  type MediaItem,
} from './media.js';
import type { Settings } from './types.js';
import type { PathMapping } from './matching.js';
import { ServiceError } from './errors.js';
import { snapshotProcess } from './snapshot-process.js';
import { decryptDatabase, readEnvelope, snapshotKey, writeEnvelope } from './snapshot-files.js';
import {
  DESTINATION_CATALOG_MAX_AGE,
  DESTINATION_CATALOG_DEADLINE,
  destinationCatalogMetadata,
  destinationCatalogPrefix,
  normalizedServerVersion,
  validDestinationResult,
  type DestinationCatalogMetadata,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
} from './destination-catalog-files.js';

const CLEANUP_ERROR =
  'Temporary Jellyfin catalog cleanup failed. Review private storage permissions before importing or reading more data.';
const IDLE_MS = 60_000;
interface State {
  configured: boolean;
  generations: DestinationCatalogResult[];
  active?: DestinationCatalogRequest;
  last_attempt_at: string | null;
  last_error: string | null;
}
interface DatabaseEntry {
  promise: Promise<string>;
  directory?: string;
  users: number;
  lastUsed: number;
}
function canceled(): ServiceError {
  return new ServiceError('Saved Jellyfin catalog preparation was canceled.');
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw canceled();
}
async function cancelable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(canceled());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
function sameBinding(
  first: DestinationCatalogRequest['binding'],
  second: DestinationCatalogRequest['binding'],
): boolean {
  try {
    return (
      new URL(first.url).toString() === new URL(second.url).toString() &&
      first.server_id.toLowerCase() === second.server_id.toLowerCase() &&
      normalizedServerVersion(first.version) === normalizedServerVersion(second.version)
    );
  } catch {
    return false;
  }
}
function current(value: DestinationCatalogResult): boolean {
  return (
    validDestinationResult(value) &&
    Date.now() - Date.parse(value.backup_created_at!) <= DESTINATION_CATALOG_MAX_AGE &&
    Date.parse(value.backup_created_at!) <= Date.now() + 60_000 &&
    Date.parse(value.finished_at) <= Date.now() + 60_000
  );
}
function neutralItems(value: unknown, trustedMembership = false): MediaItem[] {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ITEMS)
    throw new ServiceError('The saved Jellyfin catalog returned too many matching candidates.');
  let bytes = 2;
  return value.map((raw) => {
    const item = projectCatalogItem(raw);
    if (trustedMembership && isObject(raw) && Object.hasOwn(raw, 'JellyportLibraryConfigHash')) {
      if (
        typeof raw.JellyportLibraryConfigHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.JellyportLibraryConfigHash)
      )
        throw new ServiceError(
          'The saved Jellyfin library configuration is invalid. Import again.',
        );
      item.JellyportLibraryConfigHash = raw.JellyportLibraryConfigHash;
    }
    // Only the authenticated private projection worker can supply this reserved
    // membership field. Remote DTO projectors deliberately never copy it.
    if (trustedMembership && isObject(raw) && Object.hasOwn(raw, 'JellyportLibraryIds')) {
      const ids = raw.JellyportLibraryIds;
      if (
        !Array.isArray(ids) ||
        item.JellyportLibraryConfigHash === undefined ||
        ids.length > 1000 ||
        ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new ServiceError('The saved Jellyfin library membership is invalid. Import again.');
      item.JellyportLibraryIds = [...ids] as string[];
    }
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > MAX_CATALOG_BYTES)
      throw new ServiceError(
        'The saved Jellyfin matching candidates exceed the supported account size.',
      );
    return item;
  });
}

export class DestinationCatalogs {
  private readonly directory = process.env.JELLYPORT_SNAPSHOT_DIR || '';
  private key?: Buffer;
  private state: State;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private clearing = false;
  private revision = 0;
  private readonly reads = new AbortController();
  private readonly databases = new Map<string, DatabaseEntry>();
  private readonly pendingCleanup = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly options: {
      demo?: boolean;
      clientFactory: () => ClientFactory;
    },
  ) {
    const mode = process.env.JELLYPORT_JELLYFIN_CATALOG_MODE;
    if (mode !== undefined && mode !== '' && mode !== 'backup')
      throw new ServiceError('JELLYPORT_JELLYFIN_CATALOG_MODE must be backup or unset.');
    const row = store.db
      .prepare('SELECT encrypted FROM destination_catalog_state WHERE id=1')
      .get();
    this.state = row
      ? store.decrypt<State>(row.encrypted as Uint8Array)
      : {
          configured: false,
          generations: [],
          last_attempt_at: null,
          last_error: null,
        };
    if (mode === 'backup' && !this.state.configured) {
      this.state.configured = true;
      this.save();
    }
  }
  private save() {
    this.store.db
      .prepare('INSERT OR REPLACE INTO destination_catalog_state VALUES(1,?)')
      .run(this.store.encrypt(this.state));
  }
  async start(): Promise<void> {
    if (!this.directory || this.options.demo || this.timer) return;
    this.key = await snapshotKey(this.directory, true);
    for (const name of await readdir(this.directory))
      if (/^read-jellyfin-[a-f0-9-]{36}-[A-Za-z0-9]+$/.test(name))
        await rm(join(this.directory, name), { recursive: true, force: true });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
  }
  private async helper(): Promise<boolean> {
    if (!this.key || this.options.demo) return false;
    try {
      const value = await readEnvelope<{
        version: number;
        jellyfin_catalog_enabled?: boolean;
        updated_at: string;
      }>(join(this.directory, 'helper.status'), this.key);
      if (
        value.version !== 1 ||
        value.jellyfin_catalog_enabled !== true ||
        typeof value.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(value.updated_at)) ||
        Math.abs(Date.now() - Date.parse(value.updated_at)) >= 20_000
      )
        return false;
      if (!this.state.configured) {
        this.state.configured = true;
        this.save();
      }
      return true;
    } catch {
      return false;
    }
  }
  private pins(): Set<string> {
    return new Set(
      this.store
        .jobs()
        .filter((job) => ['queued', 'running'].includes(job.status))
        .flatMap((job) => (job.destination_catalog_id ? [job.destination_catalog_id] : [])),
    );
  }
  private async completeFile(value: DestinationCatalogResult): Promise<boolean> {
    try {
      const stat = await lstat(
        join(this.directory, `${destinationCatalogPrefix(value.id)}.db.enc`),
      );
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === value.bytes! + 28;
    } catch {
      return false;
    }
  }
  async status() {
    const available = await this.helper();
    const latest = this.state.generations[0];
    const record =
      latest && validDestinationResult(latest) ? destinationCatalogMetadata(latest) : null;
    let usable = false;
    try {
      usable =
        !!latest &&
        current(latest) &&
        new URL(latest.binding.url).toString() ===
          new URL(this.store.settings().jellyfin_url).toString() &&
        (await this.completeFile(latest));
    } catch {
      /* An expired/missing record remains visible, but cannot be selected. */
    }
    return {
      configured: this.state.configured,
      available,
      usable,
      running: !!this.state.active,
      record,
      last_attempt_at: this.state.last_attempt_at,
      last_error: this.state.last_error,
    };
  }
  /** Queue pinning is synchronous; execution authenticates the file and live identity again. */
  queuedSelection(settings: Settings): string | undefined {
    if (this.stopping || this.clearing)
      throw new ServiceError('Saved Jellyfin catalogs are unavailable.');
    if (!this.state.configured) return;
    const latest = this.state.generations[0];
    let usable = false;
    try {
      usable =
        !!latest &&
        current(latest) &&
        new URL(latest.binding.url).toString() === new URL(settings.jellyfin_url).toString();
    } catch {}
    if (!usable)
      throw new ServiceError(
        'Import a current Jellyfin matching catalog before migrating. Live library scans are disabled for this backup configuration.',
      );
    return latest.id;
  }
  async refresh() {
    const revision = this.revision;
    if (this.stopping || this.clearing || this.options.demo || !this.key || !(await this.helper()))
      throw new ServiceError(
        'The Jellyfin backup helper is unavailable. Check its backup folder and shared directory.',
      );
    if (this.state.active) throw new ServiceError('A Jellyfin catalog import is already running.');
    await this.prune();
    if (this.pendingCleanup.size) throw new ServiceError(CLEANUP_ERROR);
    if (this.state.generations.length >= 8)
      throw new ServiceError(
        'Older Jellyfin catalogs are still used by jobs. Finish them before importing again.',
      );
    const settings = this.store.settings();
    const client = this.options.clientFactory()(
      settings.jellyfin_url,
      settings.jellyfin_api_key,
      'jellyfin',
    );
    let request: DestinationCatalogRequest;
    try {
      const info = await client.systemInfo();
      if (
        typeof info.Id !== 'string' ||
        !/^[a-f0-9]{32}$/i.test(info.Id) ||
        typeof info.Version !== 'string' ||
        !normalizedServerVersion(info.Version)
      )
        throw new ServiceError('The linked Jellyfin server identity could not be verified.');
      request = {
        purpose: 'jellyfin_catalog',
        id: randomUUID(),
        requested_at: new Date().toISOString(),
        binding: {
          url: new URL(settings.jellyfin_url).toString(),
          server_id: info.Id,
          version: info.Version,
        },
      };
    } finally {
      await client.close();
    }
    if (
      this.state.active ||
      this.stopping ||
      this.clearing ||
      this.revision !== revision ||
      this.pendingCleanup.size ||
      this.store.settings().jellyfin_url !== settings.jellyfin_url ||
      this.store.settings().jellyfin_api_key !== settings.jellyfin_api_key
    )
      throw new ServiceError('The Jellyfin connection or import changed. Reload before importing.');
    this.state.active = request;
    this.state.last_attempt_at = request.requested_at;
    this.state.last_error = null;
    this.save();
    try {
      await writeEnvelope(
        join(this.directory, `${destinationCatalogPrefix(request.id)}.request`),
        request,
        this.key,
      );
    } catch {
      delete this.state.active;
      this.state.last_error = 'Unable to request the Jellyfin catalog import.';
      this.save();
      throw new ServiceError(this.state.last_error);
    }
    return this.status();
  }
  private async validated(
    id: string,
    settings: Settings,
    serverId: string,
    version: string,
  ): Promise<DestinationCatalogResult> {
    if (!this.key || this.stopping || this.clearing)
      throw new ServiceError('The saved Jellyfin catalog is unavailable.');
    try {
      const value = await readEnvelope<DestinationCatalogResult>(
        join(this.directory, `${destinationCatalogPrefix(id)}.result`),
        this.key,
      );
      const stored = this.state.generations.find((record) => record.id === id);
      if (
        !stored ||
        !current(value) ||
        !validDestinationResult(stored) ||
        value.id !== id ||
        value.backup_fingerprint !== stored.backup_fingerprint ||
        value.backup_created_at !== stored.backup_created_at ||
        value.finished_at !== stored.finished_at ||
        value.bytes !== stored.bytes ||
        value.items !== stored.items ||
        value.keys !== stored.keys ||
        value.projection_format !== stored.projection_format ||
        !sameBinding(value.binding, stored.binding) ||
        !sameBinding(value.binding, { url: settings.jellyfin_url, server_id: serverId, version }) ||
        !(await this.completeFile(value)) ||
        this.clearing ||
        this.stopping
      )
        throw new Error('Invalid catalog.');
      return value;
    } catch {
      throw new ServiceError(
        'The pinned Jellyfin catalog is expired, changed or incompatible. Import a current backup and review a new migration.',
      );
    }
  }
  async metadata(
    id: string,
    settings: Settings,
    serverId: string,
    version: string,
  ): Promise<DestinationCatalogMetadata> {
    return destinationCatalogMetadata(await this.validated(id, settings, serverId, version));
  }
  async candidates(
    id: string,
    settings: Settings,
    serverId: string,
    version: string,
    source: MediaItem[],
    mappings: PathMapping[],
    signal?: AbortSignal,
  ): Promise<MediaItem[]> {
    await this.validated(id, settings, serverId, version);
    const combined = AbortSignal.any([this.reads.signal, ...(signal ? [signal] : [])]);
    check(combined);
    if (this.clearing || this.pendingCleanup.size) throw new ServiceError(CLEANUP_ERROR);
    const neutral = neutralItems(source);
    let entry = this.databases.get(id);
    if (!entry) {
      const created: DatabaseEntry = {
        promise: Promise.resolve(''),
        users: 0,
        lastUsed: Date.now(),
      };
      created.promise = (async () => {
        try {
          created.directory = await mkdtemp(join(this.directory, `read-jellyfin-${id}-`));
          const path = join(created.directory, 'catalog.db');
          await decryptDatabase(
            join(this.directory, `${destinationCatalogPrefix(id)}.db.enc`),
            path,
            this.key!,
            id,
            this.reads.signal,
          );
          return path;
        } catch {
          if (this.databases.get(id) === created) this.databases.delete(id);
          if (created.directory) await this.cleanReadDirectory(created.directory);
          throw new ServiceError(
            'Saved Jellyfin catalog authentication failed. Import its backup again.',
          );
        }
      })();
      entry = created;
      this.databases.set(id, created);
    }
    entry.users++;
    try {
      const path = await cancelable(entry.promise, combined);
      check(combined);
      return neutralItems(
        await snapshotProcess<MediaItem[]>(
          { operation: 'destination_read', path, source: neutral, mappings },
          combined,
        ),
        true,
      );
    } finally {
      entry.users--;
      entry.lastUsed = Date.now();
    }
  }
  private async generationFiles(id: string): Promise<void> {
    for (const suffix of ['request', 'result', 'db.enc'])
      await rm(join(this.directory, `${destinationCatalogPrefix(id)}.${suffix}`), { force: true });
  }
  private async tick(): Promise<void> {
    if (!this.key || this.ticking || this.stopping || this.clearing) return;
    this.ticking = true;
    try {
      await this.helper();
      const active = this.state.active;
      if (active) {
        let value: DestinationCatalogResult | undefined;
        try {
          value = await readEnvelope(
            join(this.directory, `${destinationCatalogPrefix(active.id)}.result`),
            this.key,
          );
        } catch {}
        if (
          value &&
          value.id === active.id &&
          value.requested_at === active.requested_at &&
          sameBinding(value.binding, active.binding)
        ) {
          let adopted = false;
          if (!current(value) || !(await this.completeFile(value)))
            this.state.last_error =
              'The Jellyfin backup could not be validated. The last good catalog is preserved.';
          else {
            const previous = this.state.generations.find((record) =>
              sameBinding(record.binding, value!.binding),
            );
            if (
              previous &&
              Date.parse(value.backup_created_at!) < Date.parse(previous.backup_created_at!)
            )
              this.state.last_error =
                'The Jellyfin backup is older than the last imported catalog.';
            else if (previous && previous.projection_format! > value.projection_format!)
              this.state.last_error =
                'The snapshot helper produced an older Jellyfin catalog format. Update the helper and import again.';
            else if (
              previous &&
              previous.backup_fingerprint === value.backup_fingerprint &&
              previous.projection_format === value.projection_format
            )
              this.state.last_error = null;
            else {
              this.state.generations.unshift(value);
              this.state.last_error = null;
              adopted = true;
            }
          }
          delete this.state.active;
          this.save();
          if (!adopted) await this.generationFiles(active.id);
        } else if (
          Date.now() - Date.parse(active.requested_at) >
          DESTINATION_CATALOG_DEADLINE + 60_000
        ) {
          delete this.state.active;
          this.state.last_error =
            'Jellyfin catalog import timed out. The last good catalog is preserved.';
          this.save();
          await this.generationFiles(active.id);
        }
      }
      await this.prune();
    } catch {
      this.state.last_error =
        'Jellyfin catalog status could not be validated. The last good catalog is preserved.';
      this.save();
    } finally {
      this.ticking = false;
    }
  }
  private recordCleanupError() {
    this.state.last_error = CLEANUP_ERROR;
    try {
      this.save();
    } catch {
      /* Stop may run after persistence has closed. */
    }
  }
  private async cleanReadDirectory(directory: string): Promise<void> {
    this.pendingCleanup.add(directory);
    try {
      await rm(directory, { recursive: true, force: true });
      this.pendingCleanup.delete(directory);
    } catch {
      this.recordCleanupError();
      throw new ServiceError(CLEANUP_ERROR);
    }
  }
  private async removeDatabase(id: string): Promise<void> {
    const entry = this.databases.get(id);
    if (!entry || entry.users) return;
    this.databases.delete(id);
    await entry.promise.catch(() => {});
    if (entry.directory) await this.cleanReadDirectory(entry.directory);
  }
  private async prune() {
    const pins = this.pins(),
      latest = this.state.generations[0]?.id;
    for (const [id, entry] of this.databases)
      if (
        !entry.users &&
        !pins.has(id) &&
        (id !== latest || Date.now() - entry.lastUsed >= IDLE_MS)
      )
        await this.removeDatabase(id);
    const keep = new Set([
      ...this.state.generations.slice(0, 2).map((record) => record.id),
      ...pins,
      ...this.databases.keys(),
    ]);
    for (const value of this.state.generations)
      if (!keep.has(value.id)) await this.generationFiles(value.id);
    this.state.generations = this.state.generations.filter((record) => keep.has(record.id));
    this.save();
    if (this.state.active) keep.add(this.state.active.id);
    for (const name of await readdir(this.directory)) {
      const match = /^jellyfin-([a-f0-9-]{36})\.(?:request|result|db\.enc)$/.exec(name);
      if (!match || keep.has(match[1]!)) continue;
      const path = join(this.directory, name),
        stat = await lstat(path);
      if (Date.now() - stat.mtimeMs >= IDLE_MS) await rm(path, { force: true });
    }
  }
  async clear() {
    if (
      this.stopping ||
      this.clearing ||
      this.ticking ||
      this.options.demo ||
      this.state.active ||
      this.pins().size ||
      [...this.databases.values()].some((value) => value.users)
    )
      throw new ServiceError('A job or import is using this catalog. Finish it before clearing.');
    this.clearing = true;
    this.revision++;
    try {
      for (const id of this.databases.keys()) await this.removeDatabase(id);
      for (const directory of this.pendingCleanup) await this.cleanReadDirectory(directory);
      for (const value of this.state.generations) await this.generationFiles(value.id);
      this.state.generations = [];
      this.state.last_error = null;
      this.save();
    } finally {
      this.clearing = false;
    }
    return this.status();
  }
  async stop() {
    this.stopping = true;
    this.revision++;
    clearInterval(this.timer);
    this.reads.abort();
    while (this.ticking || [...this.databases.values()].some((value) => value.users))
      await new Promise((resolve) => setTimeout(resolve, 20));
    for (const id of this.databases.keys()) await this.removeDatabase(id);
    for (const directory of this.pendingCleanup) await this.cleanReadDirectory(directory);
  }
}
