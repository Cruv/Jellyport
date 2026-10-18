import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DestinationCatalogs } from '../server/destination-catalogs.js';
import {
  destinationCatalogPrefix,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
  type DestinationCatalogDiagnostic,
} from '../server/destination-catalog-files.js';
import {
  encryptDatabase,
  readEnvelope,
  snapshotKey,
  writeEnvelope,
} from '../server/snapshot-files.js';
import * as snapshotFiles from '../server/snapshot-files.js';
import { snapshotProcess } from '../server/snapshot-process.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import type { MediaAPI, MediaItem } from '../server/media.js';
import type { Job } from '../server/service.js';
import { ImportCoordinator } from '../server/daily-import-schedule.js';

vi.mock('../server/snapshot-process.js', () => ({ snapshotProcess: vi.fn() }));
const worker = vi.mocked(snapshotProcess);
const serverId = 'a'.repeat(32);
const resources: Array<{ manager: DestinationCatalogs; store: Store; directory: string }> = [];
const item: MediaItem = { Id: 'b'.repeat(32), Type: 'Movie', ProviderIds: { Tmdb: 'synthetic-1' } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  worker.mockReset();
  worker.mockResolvedValue([item]);
  vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', undefined);
  vi.stubEnv('TZ', 'Etc/UTC');
});

describe('Jellyfin daily backup import schedule', () => {
  async function enable(
    f: Awaited<ReturnType<typeof fixture>>,
    extra: Record<string, unknown> = {},
  ) {
    const config = (await f.manager.status()).config;
    return f.manager.configure({
      ...config,
      enabled: true,
      expected_revision: config.revision,
      ...extra,
    });
  }
  it('starts an enabled daily import through the actual background timer without an inline save mutation', async () => {
    vi.setSystemTime(new Date('2026-10-09T03:20:00Z'));
    const f = await fixture('backup', undefined, true);
    await f.heartbeat();
    await enable(f);
    expect(f.factory).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        expect((await readdir(f.shared)).filter((name) => name.endsWith('.request'))).toHaveLength(
          1,
        );
      },
      { timeout: 5000, interval: 20 },
    );
    expect(f.factory).toHaveBeenCalledOnce();
    expect((await f.manager.status()).last_outcome).toBe('running');
  });
  it('upgrades legacy state with a disabled schedule while retaining the validated catalog', async () => {
    const f = await fixture('backup');
    const good = await f.complete();
    f.store.db.prepare('INSERT OR REPLACE INTO destination_catalog_state VALUES(1,?)').run(
      f.store.encrypt({
        configured: true,
        generations: [good],
        last_attempt_at: good.requested_at,
        last_error: null,
      }),
    );
    await f.restart();
    expect(await f.manager.status()).toMatchObject({
      config: { enabled: false, hour: 3, minute: 0, time_zone: 'Etc/UTC' },
      next_run_at: null,
      record: { id: good.id },
      last_outcome: 'succeeded',
    });
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it('reports preparation interrupted across restart when no helper request had been saved', async () => {
    const f = await fixture('backup');
    const good = await f.complete();
    const row = f.store.db
      .prepare('SELECT encrypted FROM destination_catalog_state WHERE id=1')
      .get()!;
    const state = f.store.decrypt<Record<string, unknown>>(row.encrypted as Uint8Array);
    state.last_outcome = 'running';
    state.last_finished_at = null;
    f.store.db
      .prepare('UPDATE destination_catalog_state SET encrypted=? WHERE id=1')
      .run(f.store.encrypt(state));
    await f.restart();
    expect(await f.manager.status()).toMatchObject({
      running: false,
      last_outcome: 'interrupted',
      record: { id: good.id, backup_created_at: good.backup_created_at },
    });
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it('independently saves revisioned settings, persists restart and leaves global settings unchanged', async () => {
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    const f = await fixture('backup');
    const oldSettings = f.store.settings();
    const saved = await enable(f, { hour: 4, minute: 15, time_zone: 'America/New_York' });
    expect(saved.next_run_at).toBe('2026-10-09T08:15:00.000Z');
    expect(f.factory).not.toHaveBeenCalled();
    await expect(
      f.manager.configure({ ...saved.config, expected_revision: 'stale' }),
    ).rejects.toThrow('schedule changed');
    await expect(
      f.manager.configure({
        ...saved.config,
        time_zone: 'Invalid/Zone',
        expected_revision: saved.config.revision,
      }),
    ).rejects.toThrow('valid IANA');
    await f.restart();
    expect((await f.manager.status()).config).toEqual(saved.config);
    expect(f.store.settings()).toEqual(oldSettings);
  });
  it('runs the real encrypted request workflow once and recovers its active owner across restart', async () => {
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    const imports = new ImportCoordinator();
    const f = await fixture('backup', imports);
    const saved = await enable(f);
    vi.setSystemTime(new Date('2026-10-09T03:20:00Z'));
    await f.heartbeat();
    await f.tick();
    const names = (await readdir(f.shared)).filter((name) => name.endsWith('.request'));
    expect(names).toHaveLength(1);
    const request = await readEnvelope<DestinationCatalogRequest>(join(f.shared, names[0]!), f.key);
    expect(await f.manager.status()).toMatchObject({
      running: true,
      last_outcome: 'running',
      last_finished_at: null,
    });
    await f.restart();
    expect(f.factory).toHaveBeenCalledOnce();
    expect(imports.busy).toBe(true);
    await f.finish(request);
    expect(await f.manager.status()).toMatchObject({
      running: false,
      last_outcome: 'succeeded',
      config: saved.config,
      record: { id: request.id },
    });
    expect(imports.busy).toBe(false);
    await f.tick();
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it('records unavailable-helper failure once without automatically retrying that daily occurrence', async () => {
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    const imports = new ImportCoordinator();
    const f = await fixture('backup', imports);
    await enable(f);
    vi.setSystemTime(new Date('2026-10-09T03:20:00Z'));
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      running: false,
      last_outcome: 'failed',
      last_attempt_at: '2026-10-09T03:20:00.000Z',
      last_finished_at: '2026-10-09T03:20:00.000Z',
      next_run_at: '2026-10-10T03:00:00.000Z',
    });
    expect(imports.busy).toBe(false);
    await f.heartbeat();
    await f.restart();
    await f.tick();
    expect(f.factory).not.toHaveBeenCalled();
    expect((await f.manager.status()).last_outcome).toBe('failed');
  });
  it('keeps the daily claim monotonic when an edit targets yesterday across midnight', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:00:00Z'));
    const f = await fixture('backup');
    await enable(f, { hour: 0, minute: 5 });
    vi.setSystemTime(new Date('2026-10-09T00:06:00Z'));
    await f.heartbeat();
    await f.tick();
    const name = (await readdir(f.shared)).find((name) => name.endsWith('.request'))!;
    await f.finish(await readEnvelope<DestinationCatalogRequest>(join(f.shared, name), f.key));
    expect(f.factory).toHaveBeenCalledOnce();

    // At 00:10, 23:30 refers to yesterday within catch-up, not another allowed run.
    vi.setSystemTime(new Date('2026-10-09T00:10:00Z'));
    await enable(f, { hour: 23, minute: 30 });
    await f.heartbeat();
    await f.tick();
    expect(f.factory).toHaveBeenCalledOnce();
    expect((await f.manager.status()).next_run_at).toBe('2026-10-10T23:30:00.000Z');

    await enable(f, { hour: 0, minute: 15 });
    vi.setSystemTime(new Date('2026-10-09T00:15:00Z'));
    await f.heartbeat();
    await f.tick();
    expect(f.factory).toHaveBeenCalledOnce();
    await f.restart();
    expect(f.factory).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date('2026-10-10T00:15:00Z'));
    await f.heartbeat();
    await f.tick();
    expect(f.factory).toHaveBeenCalledTimes(2);
  });
  it('defers while another import owns the helper without claiming or queueing the occurrence', async () => {
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    const imports = new ImportCoordinator();
    const f = await fixture('backup', imports);
    await enable(f);
    imports.restore('emby:synthetic-running');
    vi.setSystemTime(new Date('2026-10-09T03:20:00Z'));
    await f.heartbeat();
    await f.tick();
    expect((await f.manager.status()).next_run_at).toBe('2026-10-09T03:00:00.000Z');
    expect(f.factory).not.toHaveBeenCalled();
    await expect(f.manager.refresh()).rejects.toThrow('already running');
    imports.release('emby:synthetic-running');
    await f.tick();
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it('does not replay a missed run or mutate its saved schedule during a manual import', async () => {
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    const f = await fixture('backup');
    const saved = await enable(f);
    vi.setSystemTime(new Date('2026-10-09T04:00:00Z'));
    await f.heartbeat();
    await f.tick();
    expect(f.factory).not.toHaveBeenCalled();
    const imported = await f.complete();
    expect((await f.manager.status()).config).toEqual(saved.config);
    expect((await f.manager.status()).last_finished_at).toBe(imported.finished_at);
    const disabled = await f.manager.configure({
      ...saved.config,
      enabled: false,
      expected_revision: saved.config.revision,
    });
    expect(disabled.next_run_at).toBeNull();
    await f.restart();
    expect((await f.manager.status()).config.enabled).toBe(false);
  });
  it('lets a manual import spanning the schedule satisfy the occurrence without a duplicate import', async () => {
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    const f = await fixture('backup');
    await enable(f);
    vi.setSystemTime(new Date('2026-10-09T02:59:00Z'));
    const request = await f.request();
    vi.setSystemTime(new Date('2026-10-09T03:01:00Z'));
    await f.heartbeat();
    await f.finish(request);
    await f.tick();
    expect(f.factory).toHaveBeenCalledOnce();
    expect((await f.manager.status()).next_run_at).toBe('2026-10-10T03:00:00.000Z');
  });
  it('contains lookup failures and interrupted results while preserving the last valid catalog', async () => {
    const imports = new ImportCoordinator();
    const f = await fixture('backup', imports);
    const good = await f.complete();
    f.client.systemInfo.mockRejectedValueOnce(new Error('synthetic-private-diagnostic'));
    await expect(f.manager.refresh()).rejects.toThrow();
    expect(await f.manager.status()).toMatchObject({
      last_outcome: 'failed',
      record: { id: good.id },
    });
    expect(JSON.stringify(await f.manager.status())).not.toContain('synthetic-private-diagnostic');
    expect(imports.busy).toBe(false);
    await f.finish(await f.request(), {
      ok: false,
      error: 'Jellyfin backup import was interrupted.',
    });
    expect(await f.manager.status()).toMatchObject({
      last_outcome: 'interrupted',
      record: { id: good.id, backup_created_at: good.backup_created_at },
    });
    expect(imports.busy).toBe(false);
  });
  it.each([false, true])(
    'reports conditional failure retention with a previous Jellyfin catalog: %s',
    async (retained) => {
      const f = await fixture('backup');
      const good = retained ? await f.complete() : undefined;
      await f.finish(await f.request(), { ok: false, error: 'Synthetic backup import failed.' });
      expect(await f.manager.status()).toMatchObject({
        running: false,
        last_outcome: 'failed',
        usable: retained,
        record: good ? { id: good.id, backup_created_at: good.backup_created_at } : null,
        error_code: 'backup_invalid',
        last_error: expect.stringContaining('completed database backup'),
      });
      await f.restart();
      expect((await f.manager.status()).record?.id).toBe(good?.id);
      if (good) expect(f.manager.queuedSelection(f.settings)).toBe(good.id);
      else expect(() => f.manager.queuedSelection(f.settings)).toThrow('current Jellyfin');
    },
  );
});
describe('safe Jellyfin import diagnostics', () => {
  const observation = (at: string): DestinationCatalogDiagnostic => ({
    stage: 'reading_items',
    started_at: at,
    updated_at: at,
    source_rows: 10,
    provider_rows: 0,
    items: 9,
    keys: 0,
    bytes: 0,
  });
  it('prunes old orphan observations while keeping recent and active attempts', async () => {
    const f = await fixture('backup');
    const active = await f.request();
    const stale = join(f.shared, `${destinationCatalogPrefix(randomUUID())}.progress`);
    const recent = join(f.shared, `${destinationCatalogPrefix(randomUUID())}.progress`);
    const owned = join(f.shared, `${destinationCatalogPrefix(active.id)}.progress`);
    for (const path of [stale, recent, owned]) await writeFile(path, 'synthetic observation');
    const old = new Date(Date.now() - 61_000);
    await utimes(stale, old, old);
    await utimes(owned, old, old);
    await f.tick();
    await expect(stat(stale)).rejects.toThrow();
    expect((await stat(recent)).isFile()).toBe(true);
    expect((await stat(owned)).isFile()).toBe(true);
    expect((await f.manager.status()).running).toBe(true);
  });
  it('accepts only authenticated progress bound to the active attempt and retains it across restart', async () => {
    const f = await fixture('backup');
    const request = await f.request();
    const diagnostic = observation(request.requested_at);
    const path = join(f.shared, `${destinationCatalogPrefix(request.id)}.progress`);
    await writeEnvelope(path, { ...request, diagnostic }, f.key);
    await f.tick();
    expect((await f.manager.status()).diagnostic).toEqual(diagnostic);
    for (const progress of [
      { ...request, id: randomUUID(), diagnostic },
      {
        ...request,
        requested_at: new Date(Date.parse(request.requested_at) - 1).toISOString(),
        diagnostic,
      },
      { ...request, binding: { ...request.binding, server_id: 'f'.repeat(32) }, diagnostic },
      { ...request, diagnostic: { ...diagnostic, private_path: '/synthetic-private/path' } },
      { ...request, diagnostic: { ...diagnostic, items: 2_000_001 } },
      {
        ...request,
        diagnostic: { ...diagnostic, updated_at: new Date(Date.now() + 120_000).toISOString() },
      },
    ]) {
      await writeEnvelope(path, progress, f.key);
      await f.tick();
      expect(await f.manager.status()).toMatchObject({
        running: true,
        last_outcome: 'running',
        diagnostic,
      });
    }
    await writeFile(path, Buffer.from('unauthenticated synthetic observation'));
    await f.tick();
    expect((await f.manager.status()).diagnostic).toEqual(diagnostic);
    await f.restart();
    expect((await f.manager.status()).diagnostic).toEqual(diagnostic);
    expect((await f.manager.status()).last_outcome).toBe('running');
  });
  it.each([false, true])(
    'preserves the safe expired-backup cause and diagnostic without adopting or leaking failed output (retained=%s)',
    async (retained) => {
      const f = await fixture('backup');
      const good = retained ? await f.complete() : undefined;
      const request = await f.request();
      const diagnostic = {
        ...observation(request.requested_at),
        stage: 'validating_backup' as const,
        items: 0,
        source_rows: 0,
      };
      const failed = await f.finish(request, {
        ok: false,
        error_code: 'backup_expired',
        diagnostic,
        error: '/synthetic-private/path synthetic-secret-token',
      });
      const status = await f.manager.status();
      expect(status).toMatchObject({
        running: false,
        last_outcome: 'failed',
        error_code: 'backup_expired',
        diagnostic,
      });
      expect(status.last_error).toContain('48 hours');
      expect(JSON.stringify(status)).not.toMatch(/synthetic-private|synthetic-secret/);
      expect(status.record?.id).toBe(good?.id);
      for (const suffix of ['progress', 'result', 'db.enc'])
        await expect(
          stat(join(f.shared, `${destinationCatalogPrefix(failed.id)}.${suffix}`)),
        ).rejects.toThrow();
      await f.restart();
      expect(await f.manager.status()).toMatchObject({
        error_code: 'backup_expired',
        diagnostic,
        last_outcome: 'failed',
      });
      expect((await f.manager.status()).record?.id).toBe(good?.id);
    },
  );
  it('does not let fresh progress extend the absolute helper deadline or turn an observation into success', async () => {
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    const f = await fixture('backup');
    const request = await f.request();
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000 + 1));
    await f.heartbeat();
    const diagnostic = {
      ...observation(request.requested_at),
      updated_at: new Date().toISOString(),
    };
    await writeEnvelope(
      join(f.shared, `${destinationCatalogPrefix(request.id)}.progress`),
      { ...request, diagnostic },
      f.key,
    );
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      running: false,
      last_outcome: 'failed',
      error_code: 'timeout',
      record: null,
      diagnostic,
    });
    expect((await f.manager.status()).last_attempt_at).toBe(request.requested_at);
    await expect(
      stat(join(f.shared, `${destinationCatalogPrefix(request.id)}.progress`)),
    ).rejects.toThrow();
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.manager.stop();
    resource.store.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function fixture(mode?: string, imports?: ImportCoordinator, keepTimer = false) {
  vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', mode);
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-synthetic-destination-catalogs-'));
  const shared = join(directory, 'shared');
  vi.stubEnv('JELLYPORT_SNAPSHOT_DIR', shared);
  const store = new Store(join(directory, 'state'));
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    jellyfin_url: 'http://jellyfin:8096/',
    jellyfin_api_key: 'synthetic-private-key',
  };
  store.saveSettings(settings);
  const client = {
    systemInfo: vi.fn(async () => ({ Id: serverId, Version: '12.2.0' })),
    close: vi.fn(async () => {}),
  };
  const factory = vi.fn(() => client as unknown as MediaAPI);
  let manager = new DestinationCatalogs(store, { clientFactory: () => factory, imports });
  const resource = { manager, store, directory };
  resources.push(resource);
  await manager.start();
  if (!keepTimer)
    clearInterval((manager as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const key = await snapshotKey(shared);
  async function heartbeat(updatedAt = new Date(Date.now()).toISOString()) {
    await writeEnvelope(
      join(shared, 'helper.status'),
      { version: 1, jellyfin_catalog_enabled: true, updated_at: updatedAt },
      key,
    );
  }
  async function tick() {
    await (manager as unknown as { tick(): Promise<void> }).tick();
  }
  async function request() {
    await heartbeat();
    await manager.refresh();
    const name = (await readdir(shared)).find((name) => name.endsWith('.request'))!;
    return readEnvelope<DestinationCatalogRequest>(join(shared, name), key);
  }
  async function finish(
    requested: DestinationCatalogRequest,
    override: Partial<DestinationCatalogResult> = {},
    file: 'valid' | 'missing' | 'truncate' | 'symlink' = 'valid',
  ) {
    const plaintext = `synthetic-neutral-catalog-${requested.id}`;
    const raw = join(directory, `${requested.id}.raw`),
      encrypted = join(shared, `${destinationCatalogPrefix(requested.id)}.db.enc`);
    await writeFile(raw, plaintext);
    if (file !== 'missing') await encryptDatabase(raw, encrypted, key, requested.id);
    if (file === 'truncate') await writeFile(encrypted, Buffer.alloc(3));
    if (file === 'symlink') {
      await rm(encrypted);
      await symlink(raw, encrypted);
    }
    const completed: DestinationCatalogResult = {
      ...requested,
      ok: true,
      started_at: new Date(Date.now()).toISOString(),
      finished_at: new Date(Date.now()).toISOString(),
      bytes: Buffer.byteLength(plaintext),
      items: 1,
      keys: 1,
      backup_created_at: new Date(Date.now() - 3600000).toISOString(),
      backup_fingerprint: createHash('sha256').update(requested.id).digest('hex'),
      server_version: '12.2.0.0',
      backup_engine_version: '0.2.0',
      projection_format: 1,
      ...override,
    };
    await writeEnvelope(
      join(shared, `${destinationCatalogPrefix(requested.id)}.result`),
      completed,
      key,
    );
    await rm(join(shared, `${destinationCatalogPrefix(requested.id)}.request`), { force: true });
    await tick();
    return completed;
  }
  async function complete(override: Partial<DestinationCatalogResult> = {}) {
    return finish(await request(), override);
  }
  function pin(id: string, status = 'running') {
    const job: Job = {
      id: randomUUID(),
      kind: 'migrate',
      status,
      created_at: new Date(Date.now()).toISOString(),
      updated_at: new Date(Date.now()).toISOString(),
      progress: { processed: 0, total: 1 },
      results: [],
      destination_catalog_id: id,
    };
    store.saveJob(job);
    return job;
  }
  async function restart() {
    await manager.stop();
    manager = new DestinationCatalogs(store, { clientFactory: () => factory, imports });
    resource.manager = manager;
    await manager.start();
    clearInterval((manager as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  }
  return {
    directory,
    shared,
    store,
    settings,
    key,
    client,
    factory,
    get manager() {
      return manager;
    },
    heartbeat,
    tick,
    request,
    finish,
    complete,
    pin,
    restart,
  };
}
async function read(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  source: MediaItem[] = [item],
  signal?: AbortSignal,
) {
  return f.manager.candidates(id, f.settings, serverId, '12.2.0.0', source, [], signal);
}

describe('saved destination catalog manager', () => {
  it('fails closed before the first helper heartbeat when backup mode is explicitly configured', async () => {
    const f = await fixture('backup');
    expect(await f.manager.status()).toMatchObject({
      configured: true,
      available: false,
      usable: false,
      record: null,
    });
    expect(() => f.manager.queuedSelection(f.settings)).toThrow('Live library scans are disabled');
    vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', undefined);
    await f.restart();
    expect(() => f.manager.queuedSelection(f.settings)).toThrow('Live library scans are disabled');
  });
  it('keeps legacy discovery unconfigured until a valid helper advertisement', async () => {
    const f = await fixture();
    expect(f.manager.queuedSelection(f.settings)).toBeUndefined();
    await f.heartbeat('invalid');
    expect((await f.manager.status()).configured).toBe(false);
    await f.heartbeat();
    expect((await f.manager.status()).configured).toBe(true);
    await rm(join(f.shared, 'helper.status'));
    expect(await f.manager.status()).toMatchObject({ configured: true, available: false });
    expect(() => f.manager.queuedSelection(f.settings)).toThrow('Live library scans');
  });
  it('rejects invalid explicit modes at construction without exposing their content', async () => {
    const f = await fixture();
    vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', 'live');
    expect(() => new DestinationCatalogs(f.store, { clientFactory: () => f.factory })).toThrow(
      'must be backup or unset',
    );
  });
  it('adopts a complete bound encrypted record and preserves it through restart or helper downtime', async () => {
    const f = await fixture();
    const record = await f.complete();
    await f.restart();
    await rm(join(f.shared, 'helper.status'));
    expect(await f.manager.status()).toMatchObject({
      configured: true,
      available: false,
      usable: true,
      record: { id: record.id, backup_created_at: record.backup_created_at },
    });
    expect(f.manager.queuedSelection(f.settings)).toBe(record.id);
    expect(await f.manager.metadata(record.id, f.settings, serverId, '12.2.0')).toMatchObject({
      id: record.id,
    });
    expect(worker).not.toHaveBeenCalled();
  });
  it.each(['missing', 'truncate', 'symlink'] as const)(
    'rejects %s encrypted output before adoption and cleans unused files',
    async (file) => {
      const f = await fixture();
      const good = await f.complete();
      const rejected = await f.finish(await f.request(), {}, file);
      expect((await f.manager.status()).record?.id).toBe(good.id);
      expect((await f.manager.status()).last_error).toContain('could not be validated');
      for (const suffix of ['result', 'db.enc'])
        await expect(
          stat(join(f.shared, `${destinationCatalogPrefix(rejected.id)}.${suffix}`)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('deduplicates unchanged imports without renewing the original age and removes duplicate output', async () => {
    const f = await fixture();
    const first = await f.complete();
    const duplicate = await f.complete({
      backup_fingerprint: first.backup_fingerprint,
      backup_created_at: new Date(Date.parse(first.backup_created_at!) + 1000).toISOString(),
    });
    expect(await f.manager.status()).toMatchObject({
      last_error: null,
      record: { id: first.id, backup_created_at: first.backup_created_at },
    });
    await expect(
      stat(join(f.shared, `${destinationCatalogPrefix(duplicate.id)}.db.enc`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('adopts a new projection format for the same backup without refreshing its age', async () => {
    const f = await fixture();
    const legacy = await f.complete({ projection_format: 1 });
    const upgraded = await f.complete({
      projection_format: 2,
      backup_fingerprint: legacy.backup_fingerprint,
      backup_created_at: legacy.backup_created_at,
    });
    expect((await f.manager.status()).record?.id).toBe(upgraded.id);
    expect(await f.manager.metadata(upgraded.id, f.settings, serverId, '12.2.0')).toMatchObject({
      projection_format: 2,
      backup_created_at: legacy.backup_created_at,
    });
    await f.restart();
    expect(f.manager.queuedSelection(f.settings)).toBe(upgraded.id);
  });
  it('keeps the newer projection when an outdated helper returns an older format', async () => {
    const f = await fixture();
    const current = await f.complete({ projection_format: 2 });
    await f.complete({
      projection_format: 1,
      backup_created_at: new Date(Date.parse(current.backup_created_at!) + 1000).toISOString(),
    });
    expect((await f.manager.status()).record?.id).toBe(current.id);
    expect((await f.manager.status()).last_error).toContain('older Jellyfin catalog format');
  });
  it('rejects a changed projection format on an already pinned generation', async () => {
    const f = await fixture();
    const record = await f.complete({ projection_format: 1 });
    await writeEnvelope(
      join(f.shared, `${destinationCatalogPrefix(record.id)}.result`),
      { ...record, projection_format: 2 },
      f.key,
    );
    await expect(read(f, record.id)).rejects.toThrow('changed or incompatible');
    expect(worker).not.toHaveBeenCalled();
  });
  it('preserves only validated worker membership and strips forged source membership', async () => {
    const f = await fixture();
    const record = await f.complete({ projection_format: 2 });
    const membership = ['a'.repeat(32)];
    const JellyportLibraryConfigHash = 'b'.repeat(64);
    worker.mockResolvedValueOnce([
      {
        ...item,
        JellyportLibraryIds: membership,
        JellyportLibraryConfigHash,
        UserData: { Played: true },
        Secret: 'private',
      },
    ]);
    await expect(
      read(f, record.id, [{ ...item, JellyportLibraryIds: ['forged'] }]),
    ).resolves.toEqual([{ ...item, JellyportLibraryIds: membership, JellyportLibraryConfigHash }]);
    expect((worker.mock.calls[0]![0] as { source: MediaItem[] }).source).toEqual([item]);
  });
  it.each([
    null,
    'not-an-array',
    ['invalid'],
    ['a'.repeat(32), 'a'.repeat(32)],
    Array(1001).fill('a'.repeat(32)),
  ])(
    'rejects malformed worker membership before returning candidates (%j)',
    async (JellyportLibraryIds) => {
      const f = await fixture();
      const record = await f.complete({ projection_format: 2 });
      worker.mockResolvedValueOnce([
        { ...item, JellyportLibraryIds, JellyportLibraryConfigHash: 'b'.repeat(64) },
      ]);
      await expect(read(f, record.id)).rejects.toThrow('library membership is invalid');
    },
  );
  it.each([undefined, null, '', 'invalid', 'b'.repeat(65)])(
    'rejects incomplete or forged configuration provenance (%j)',
    async (JellyportLibraryConfigHash) => {
      const f = await fixture();
      const record = await f.complete({ projection_format: 2 });
      worker.mockResolvedValueOnce([
        { ...item, JellyportLibraryIds: ['a'.repeat(32)], JellyportLibraryConfigHash },
      ]);
      await expect(read(f, record.id)).rejects.toThrow('invalid');
    },
  );
  it('rejects rollback, expired and future captures while preserving the last good record', async () => {
    const f = await fixture();
    const first = await f.complete();
    await f.complete({
      backup_created_at: new Date(Date.parse(first.backup_created_at!) - 1000).toISOString(),
    });
    expect((await f.manager.status()).last_error).toContain('older');
    for (const age of [-49 * 3600000, 120000]) {
      await f.complete({ backup_created_at: new Date(Date.now() + age).toISOString() });
      expect((await f.manager.status()).record?.id).toBe(first.id);
      expect((await f.manager.status()).error_code).toBe(
        age < 0 ? 'backup_expired' : 'backup_future',
      );
      expect((await f.manager.status()).last_error).toContain('backup');
    }
  });
  it('retains pinned generations and refuses clearing while a job needs one', async () => {
    const f = await fixture();
    const first = await f.complete();
    const job = f.pin(first.id);
    await f.complete();
    await f.complete();
    expect(await f.manager.metadata(first.id, f.settings, serverId, '12.2.0')).toMatchObject({
      id: first.id,
    });
    await expect(f.manager.clear()).rejects.toThrow('using this catalog');
    job.status = 'completed';
    f.store.saveJob(job);
    await f.tick();
    await expect(f.manager.metadata(first.id, f.settings, serverId, '12.2.0')).rejects.toThrow(
      'expired, changed or incompatible',
    );
  });
  it('expires from backup creation time rather than import time', async () => {
    const f = await fixture();
    const record = await f.complete({
      backup_created_at: new Date(Date.now() - 47 * 3600000).toISOString(),
    });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 3600000);
    expect((await f.manager.status()).usable).toBe(false);
    expect(() => f.manager.queuedSelection(f.settings)).toThrow('current Jellyfin');
    await expect(read(f, record.id)).rejects.toThrow('expired');
  });
  it('shares one in-flight decryption and strips all personal fields before worker IPC', async () => {
    const f = await fixture();
    const record = await f.complete();
    const gate = deferred<void>(),
      entered = deferred<void>();
    const original = snapshotFiles.decryptDatabase;
    const decrypt = vi
      .spyOn(snapshotFiles, 'decryptDatabase')
      .mockImplementation(async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      });
    const source = [
      { ...item, UserData: { Played: true }, Password: 'synthetic-private-password' },
    ];
    const first = read(f, record.id, source),
      second = read(f, record.id, source);
    await entered.promise;
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([[item], [item]]);
    expect(decrypt).toHaveBeenCalledOnce();
    expect(worker).toHaveBeenCalledTimes(2);
    for (const [request] of worker.mock.calls)
      expect((request as { source: MediaItem[] }).source).toEqual([item]);
    expect(
      (await readdir(f.shared)).filter((name) => name.startsWith('read-jellyfin-')),
    ).toHaveLength(1);
  });
  it('cancels one waiter promptly without aborting another shared-decryption reader', async () => {
    const f = await fixture();
    const record = await f.complete();
    const gate = deferred<void>(),
      entered = deferred<void>(),
      controller = new AbortController();
    const original = snapshotFiles.decryptDatabase;
    vi.spyOn(snapshotFiles, 'decryptDatabase').mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const first = read(f, record.id, [item], controller.signal),
      second = read(f, record.id);
    const rejected = expect(first).rejects.toThrow('canceled');
    await entered.promise;
    controller.abort();
    await rejected;
    expect(worker).not.toHaveBeenCalled();
    gate.resolve();
    await expect(second).resolves.toEqual([item]);
    expect(worker).toHaveBeenCalledOnce();
  });
  it('evicts an unused old decrypted generation while retaining an in-use or pinned one', async () => {
    const f = await fixture();
    const first = await f.complete();
    await read(f, first.id);
    const job = f.pin(first.id);
    await f.complete();
    await f.tick();
    expect(
      (await readdir(f.shared)).filter((name) => name.startsWith(`read-jellyfin-${first.id}-`)),
    ).toHaveLength(1);
    job.status = 'completed';
    f.store.saveJob(job);
    await f.tick();
    expect(
      (await readdir(f.shared)).filter((name) => name.startsWith(`read-jellyfin-${first.id}-`)),
    ).toHaveLength(0);
  });
  it('evicts an idle latest plaintext cache and keeps its encrypted generation', async () => {
    const f = await fixture();
    const record = await f.complete();
    await read(f, record.id);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
    await f.tick();
    expect(
      (await readdir(f.shared)).filter((name) => name.startsWith('read-jellyfin-')),
    ).toHaveLength(0);
    await expect(
      stat(join(f.shared, `${destinationCatalogPrefix(record.id)}.db.enc`)),
    ).resolves.toBeDefined();
  });
  it('rejects same-ID replacement or corrupt authentication before worker reads', async () => {
    const f = await fixture();
    const record = await f.complete();
    const path = join(f.shared, `${destinationCatalogPrefix(record.id)}.result`);
    await writeEnvelope(path, { ...record, backup_fingerprint: 'f'.repeat(64) }, f.key);
    await expect(read(f, record.id)).rejects.toThrow('changed or incompatible');
    await writeEnvelope(path, record, f.key);
    const encrypted = join(f.shared, `${destinationCatalogPrefix(record.id)}.db.enc`),
      bytes = await readFile(encrypted);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(encrypted, bytes);
    await expect(read(f, record.id)).rejects.toThrow('authentication failed');
    expect(worker).not.toHaveBeenCalled();
    expect(
      (await readdir(f.shared)).filter((name) => name.startsWith('read-jellyfin-')),
    ).toHaveLength(0);
  });
  it('clears data without re-enabling live scans and blocks an earlier refresh from publishing after clear', async () => {
    const f = await fixture();
    await f.complete();
    const gate = deferred<{ Id: string; Version: string }>(),
      entered = deferred<void>();
    f.client.systemInfo.mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
    const refresh = f.manager.refresh();
    const rejected = expect(refresh).rejects.toThrow('connection or import changed');
    await entered.promise;
    await f.manager.clear();
    gate.resolve({ Id: serverId, Version: '12.2.0' });
    await rejected;
    expect(await f.manager.status()).toMatchObject({
      configured: true,
      usable: false,
      record: null,
    });
    expect(() => f.manager.queuedSelection(f.settings)).toThrow('Live library scans');
    expect((await readdir(f.shared)).some((name) => name.endsWith('.request'))).toBe(false);
  });
});
