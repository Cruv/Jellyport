import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DestinationCatalogs, JELLYFIN_BACKUP_WAIT_MS } from '../server/destination-catalogs.js';
import { ImportCoordinator } from '../server/daily-import-schedule.js';
import { MediaError, ServiceError } from '../server/errors.js';
import type { JellyfinBackupManifest, JellyfinBackupTask } from '../server/jellyfin-backup-api.js';
import type { MediaAPI } from '../server/media.js';
import {
  destinationCatalogPrefix,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
} from '../server/destination-catalog-files.js';
import {
  encryptDatabase,
  readEnvelope,
  snapshotKey,
  writeEnvelope,
} from '../server/snapshot-files.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import {
  backupCleanupPrefix,
  type BackupCleanupRequest,
  type BackupCleanupResult,
  type OwnedJellyfinBackup,
} from '../server/jellyfin-backup-retention.js';

const serverId = 'a'.repeat(32);
const initialTime = Date.parse('2026-10-18T02:00:00.000Z');
const dueTime = Date.parse('2026-10-18T03:00:00.000Z');
const resources: Array<{ manager: DestinationCatalogs; store: Store; directory: string }> = [];
const manifest = (time = Date.now()): JellyfinBackupManifest => ({
  name: `jellyfin-backup-${new Date(time).toISOString().slice(0, 19).replace(/[-:T]/g, '')}.zip`,
  created_at: new Date(time).toISOString(),
  server_version: '12.2.0.0',
  backup_engine_version: '0.2.0',
  database: true,
  metadata: false,
  trickplay: false,
  subtitles: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(initialTime);
  vi.stubEnv('TZ', 'Etc/UTC');
  vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', 'backup');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of resources.splice(0)) {
    await value.manager.stop();
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-synthetic-backup-schedule-'));
  const shared = join(directory, 'shared');
  vi.stubEnv('JELLYPORT_SNAPSHOT_DIR', shared);
  const store = new Store(join(directory, 'state'));
  store.saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    jellyfin_url: 'http://jellyfin.test:8096/',
    jellyfin_api_key: 'synthetic-private-api-key',
  });
  const imports = new ImportCoordinator();
  const creation = deferred<JellyfinBackupManifest>();
  const old = manifest(initialTime - 60 * 60_000);
  const client = {
    systemInfo: vi.fn(async () => ({ Id: serverId, Version: '12.2.0.0' })),
    jellyfinBackups: vi.fn(async (): Promise<JellyfinBackupManifest[]> => [old]),
    createJellyfinBackup: vi.fn(() => creation.promise),
    jellyfinBackupTasks: vi.fn(async (): Promise<JellyfinBackupTask[]> => [
      { key: 'RefreshLibrary', state: 'Idle' },
    ]),
    close: vi.fn(async () => {}),
  };
  const factory = vi.fn(() => client as unknown as MediaAPI);
  let manager = new DestinationCatalogs(store, { clientFactory: () => factory, imports });
  await manager.start();
  clearInterval((manager as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const key = await snapshotKey(shared);
  let cleanupSupported = false;
  async function heartbeat(selection = true) {
    await writeEnvelope(
      join(shared, 'helper.status'),
      {
        version: 1,
        jellyfin_catalog_enabled: true,
        jellyfin_backup_selection_enabled: selection,
        jellyfin_backup_cleanup_enabled: cleanupSupported,
        updated_at: new Date().toISOString(),
      },
      key,
    );
  }
  async function tick(freshHeartbeat = true) {
    if (freshHeartbeat) await heartbeat();
    await (manager as unknown as { tick(): Promise<void> }).tick();
  }
  async function enable(createBackup = true) {
    const { config } = await manager.status();
    return manager.configure({
      ...config,
      enabled: true,
      create_backup: createBackup,
      expected_revision: config.revision,
    });
  }
  async function due() {
    vi.setSystemTime(dueTime);
    await tick();
  }
  async function requests() {
    const names = (await readdir(shared)).filter((name) => name.endsWith('.request'));
    return Promise.all(
      names.map((name) => readEnvelope<DestinationCatalogRequest>(join(shared, name), key)),
    );
  }
  function savedState() {
    const row = store.db
      .prepare('SELECT encrypted FROM destination_catalog_state WHERE id=1')
      .get()!;
    return store.decrypt<Record<string, unknown>>(row.encrypted as Uint8Array);
  }
  async function restart() {
    await manager.stop();
    manager = new DestinationCatalogs(store, { clientFactory: () => factory, imports });
    await heartbeat();
    await manager.start();
    clearInterval((manager as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  }
  async function finish(request: DestinationCatalogRequest) {
    const plaintext = `synthetic-neutral-catalog-${request.id}`;
    const raw = join(directory, `${request.id}.raw`);
    await writeFile(raw, plaintext);
    await encryptDatabase(
      raw,
      join(shared, `${destinationCatalogPrefix(request.id)}.db.enc`),
      key,
      request.id,
    );
    const result: DestinationCatalogResult = {
      ...request,
      ok: true,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      bytes: Buffer.byteLength(plaintext),
      items: 1,
      keys: 1,
      backup_created_at: request.expected_backup?.created_at ?? old.created_at,
      backup_fingerprint: createHash('sha256').update(request.id).digest('hex'),
      server_version: '12.2.0.0',
      backup_engine_version: '0.2.0',
      projection_format: 2,
    };
    await writeEnvelope(
      join(shared, `${destinationCatalogPrefix(request.id)}.result`),
      result,
      key,
    );
    await rm(join(shared, `${destinationCatalogPrefix(request.id)}.request`));
    await tick();
    return result;
  }
  async function seedGood() {
    await heartbeat();
    await manager.refresh();
    return finish((await requests())[0]!);
  }
  async function acknowledge() {
    const status = await manager.status();
    return manager.acknowledgeBackup(status.backup_creation!.attempt_id);
  }
  const value = {
    directory,
    shared,
    store,
    imports,
    client,
    factory,
    creation,
    old,
    key,
    heartbeat,
    enableCleanupHelper: async () => {
      cleanupSupported = true;
      await heartbeat();
    },
    tick,
    enable,
    due,
    requests,
    savedState,
    restart,
    finish,
    seedGood,
    acknowledge,
    get manager() {
      return manager;
    },
  };
  resources.push(value);
  return value;
}

describe('scheduled native Jellyfin backup creation', () => {
  it('creates once, waits for completion, and imports the exact new backup before releasing its slot', async () => {
    const f = await fixture();
    f.client.createJellyfinBackup.mockImplementation(() => {
      expect(f.savedState()).toMatchObject({ backup_creation: { phase: 'creating' } });
      return f.creation.promise;
    });
    const good = await f.seedGood();
    const saved = await f.enable();
    await f.due();
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    expect(await f.requests()).toEqual([]);
    expect(await f.manager.status()).toMatchObject({
      running: true,
      backup_creation: { phase: 'creating' },
      record: { id: good.id },
    });
    expect(f.imports.busy).toBe(true);
    const fresh = manifest();
    f.creation.resolve(fresh);
    await vi.waitFor(async () => {
      expect((await f.manager.status()).backup_creation?.phase).toBe('waiting');
    });
    await f.tick();
    const [request] = await f.requests();
    expect(request).toMatchObject({
      expected_backup: { name: fresh.name, created_at: fresh.created_at },
      binding: { server_id: serverId },
    });
    expect(request!.expected_backup?.name).not.toBe(f.old.name);
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    await f.finish(request!);
    expect(await f.manager.status()).toMatchObject({
      running: false,
      last_outcome: 'succeeded',
      config: saved.config,
      record: { id: request!.id, backup_created_at: fresh.created_at },
    });
    expect(f.imports.busy).toBe(false);
    await f.tick();
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
  });

  it('keeps manual imports import-only even when automatic creation is enabled', async () => {
    const f = await fixture();
    const saved = await f.enable();
    await f.heartbeat();
    await f.manager.refresh();
    expect((await f.requests())[0]!.expected_backup).toBeUndefined();
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
    expect(f.client.jellyfinBackups).not.toHaveBeenCalled();
    expect((await f.manager.status()).config).toEqual(saved.config);
  });

  it('defaults legacy schedules to import-only and persists explicit revisioned opt-in independently', async () => {
    const f = await fixture();
    const config = (await f.manager.status()).config;
    expect(config.create_backup).toBe(false);
    const legacy = f.savedState();
    delete (legacy.config as Record<string, unknown>).create_backup;
    f.store.db
      .prepare('UPDATE destination_catalog_state SET encrypted=? WHERE id=1')
      .run(f.store.encrypt(legacy));
    await f.restart();
    expect((await f.manager.status()).config.create_backup).toBe(false);
    const settings = f.store.settings();
    const enabled = await f.enable();
    await expect(
      f.manager.configure({ ...config, create_backup: false, expected_revision: config.revision }),
    ).rejects.toThrow('schedule changed');
    await f.restart();
    expect((await f.manager.status()).config).toEqual(enabled.config);
    expect(f.store.settings()).toEqual(settings);
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
  });

  it.each([
    new MediaError('Jellyfin request timed out. The operation may have been applied.'),
    new MediaError('Jellyfin rejected the request (HTTP 500).', 500),
  ])(
    'reconciles an uncertain mutation from completed backups without repeating POST',
    async (error) => {
      const f = await fixture();
      f.client.createJellyfinBackup.mockRejectedValueOnce(error);
      await f.enable();
      await f.due();
      await vi.waitFor(async () => {
        expect((await f.manager.status()).backup_creation?.phase).toBe('waiting');
      });
      await f.tick();
      expect(await f.requests()).toEqual([]);
      const fresh = manifest(Date.now() + 1000);
      f.client.jellyfinBackups.mockResolvedValue([f.old, fresh]);
      vi.setSystemTime(Date.now() + 16_000);
      await f.tick();
      expect((await f.requests())[0]!.expected_backup).toEqual({
        name: fresh.name,
        created_at: fresh.created_at,
      });
      expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    },
  );

  it('recovers a durable creating intent across restart using observations only', async () => {
    const f = await fixture();
    await f.enable();
    await f.due();
    expect(f.savedState()).toMatchObject({ backup_creation: { phase: 'creating' } });
    const fresh = manifest();
    f.client.jellyfinBackups.mockResolvedValue([f.old, fresh]);
    await f.restart();
    expect((await f.requests())[0]!.expected_backup).toEqual({
      name: fresh.name,
      created_at: fresh.created_at,
    });
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    expect(f.imports.busy).toBe(true);
  });

  it('does not request a backup during a library scan and does not replay the failed daily claim', async () => {
    const f = await fixture();
    f.client.jellyfinBackupTasks.mockResolvedValue([{ key: 'RefreshLibrary', state: 'Running' }]);
    await f.enable();
    await f.due();
    expect(await f.manager.status()).toMatchObject({
      last_outcome: 'failed',
      last_error: expect.stringContaining('scanning its library'),
    });
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
    expect(f.imports.busy).toBe(false);
    f.client.jellyfinBackupTasks.mockResolvedValue([{ key: 'RefreshLibrary', state: 'Idle' }]);
    await f.tick();
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
  });

  it('rejects an unsupported future server version before native backup work and retains the last valid catalog', async () => {
    const f = await fixture();
    const good = await f.seedGood();
    f.client.systemInfo.mockResolvedValue({ Id: serverId, Version: '13.0.0' });
    await f.enable();
    await f.due();
    expect(await f.manager.status()).toMatchObject({
      last_outcome: 'failed',
      last_error: expect.stringContaining('unsupported'),
      record: { id: good.id },
    });
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
    expect(f.client.jellyfinBackupTasks).not.toHaveBeenCalled();
    expect(f.client.jellyfinBackups).not.toHaveBeenCalled();
    expect(await f.requests()).toEqual([]);
    expect(f.imports.busy).toBe(false);
  });

  it.each(['old', 'unavailable'] as const)(
    'fails before POST when the helper is %s',
    async (helper) => {
      const f = await fixture();
      await f.enable();
      vi.setSystemTime(dueTime);
      if (helper === 'old') await f.heartbeat(false);
      await f.tick(false);
      expect((await f.manager.status()).last_outcome).toBe('failed');
      expect(await f.requests()).toEqual([]);
      expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
      expect(f.imports.busy).toBe(false);
    },
  );

  it('keeps ambiguous completed backups blocked instead of selecting an arbitrary new archive', async () => {
    const f = await fixture();
    const good = await f.seedGood();
    f.client.createJellyfinBackup.mockRejectedValueOnce(new MediaError('Request timed out.'));
    await f.enable();
    await f.due();
    f.client.jellyfinBackups.mockResolvedValue([f.old, manifest(), manifest(Date.now() + 1000)]);
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      running: false,
      backup_creation: { phase: 'uncertain' },
      last_outcome: 'interrupted',
      record: { id: good.id },
    });
    expect(await f.requests()).toEqual([]);
    expect(f.imports.busy).toBe(true);
    await expect(f.manager.refresh()).rejects.toThrow('already running');
    await f.acknowledge().catch(() => {});
    expect((await f.manager.status()).backup_creation?.phase).toBe('uncertain');
    expect(f.imports.busy).toBe(true);
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
  });

  it('holds the shared slot after timeout until explicit confirmation and never replays that daily claim', async () => {
    const f = await fixture();
    await f.enable();
    await f.due();
    vi.setSystemTime(dueTime + JELLYFIN_BACKUP_WAIT_MS);
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      running: false,
      backup_creation: { phase: 'uncertain' },
      last_outcome: 'interrupted',
    });
    expect(f.imports.acquire('emby:synthetic-other-import')).toBe(false);
    await expect(f.manager.refresh()).rejects.toThrow('already running');
    await expect(f.manager.clear()).rejects.toThrow('using this catalog');
    const reads = f.client.jellyfinBackups.mock.calls.length;
    await f.acknowledge();
    expect(f.client.jellyfinBackups.mock.calls.length).toBe(reads + 1);
    expect((await f.manager.status()).backup_creation).toBeNull();
    expect(f.imports.busy).toBe(false);
    await f.tick();
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    expect(await f.requests()).toEqual([]);
  });
  it.each(['connection', 'shutdown'] as const)(
    'retains an uncertain attempt if %s changes during final reconciliation close',
    async (change) => {
      const f = await fixture();
      f.client.createJellyfinBackup.mockRejectedValueOnce(new MediaError('Synthetic timeout'));
      await f.enable();
      await f.due();
      vi.setSystemTime(dueTime + JELLYFIN_BACKUP_WAIT_MS);
      await f.tick();
      const entered = deferred<void>();
      const closing = deferred<void>();
      f.client.close.mockImplementationOnce(async () => {
        entered.resolve();
        await closing.promise;
      });
      const status = await f.manager.status();
      const confirmation = f.manager.acknowledgeBackup(status.backup_creation!.attempt_id);
      const result = confirmation.then(
        () => 'cleared',
        () => 'blocked',
      );
      await entered.promise;
      if (change === 'connection')
        f.store.saveSettings({
          ...f.store.settings(),
          jellyfin_url: 'http://replacement.test:8096/',
        });
      else await f.manager.stop();
      closing.resolve();
      expect(await result).toBe('blocked');
      expect((await f.manager.status()).backup_creation?.phase).toBe('uncertain');
      expect(f.imports.busy).toBe(true);
      expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    },
  );

  it('ignores a late POST completion after stop and after a restarted attempt has been reconciled', async () => {
    const f = await fixture();
    await f.enable();
    await f.due();
    await f.restart();
    vi.setSystemTime(dueTime + JELLYFIN_BACKUP_WAIT_MS);
    await f.tick();
    await f.acknowledge();
    const released = await f.manager.status();
    f.creation.resolve(manifest());
    await vi.waitFor(() => expect(f.client.close.mock.calls.length).toBeGreaterThanOrEqual(3));
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      last_outcome: released.last_outcome,
      last_finished_at: released.last_finished_at,
    });
    expect((await f.manager.status()).backup_creation).toBeNull();
    expect(await f.requests()).toEqual([]);
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
  });

  it('fails closed when the server identity changes while a native backup is outstanding', async () => {
    const f = await fixture();
    await f.enable();
    await f.due();
    f.client.systemInfo.mockResolvedValue({ Id: 'b'.repeat(32), Version: '12.2.0.0' });
    f.creation.resolve(manifest());
    await vi.waitFor(async () => {
      expect((await f.manager.status()).backup_creation?.phase).toBe('waiting');
    });
    await f.tick();
    expect((await f.manager.status()).backup_creation?.phase).toBe('uncertain');
    await f.acknowledge().catch(() => {});
    expect((await f.manager.status()).backup_creation?.phase).toBe('uncertain');
    expect(f.imports.busy).toBe(true);
    expect(await f.requests()).toEqual([]);
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
  });

  it('does not issue POST when the saved API key changes during preflight', async () => {
    const f = await fixture();
    const baseline = deferred<JellyfinBackupManifest[]>();
    f.client.jellyfinBackups.mockReturnValueOnce(baseline.promise);
    await f.enable();
    vi.setSystemTime(dueTime);
    const pending = f.tick();
    await vi.waitFor(() => expect(f.client.jellyfinBackups).toHaveBeenCalledOnce());
    f.store.saveSettings({ ...f.store.settings(), jellyfin_api_key: 'synthetic-replaced-key' });
    baseline.resolve([f.old]);
    await pending;
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
    expect(await f.requests()).toEqual([]);
    expect((await f.manager.status()).last_outcome).toBe('failed');
  });

  it('persists the native mutation intent before POST and does not mutate when that persistence fails', async () => {
    const f = await fixture();
    await f.enable();
    const encrypt = f.store.encrypt.bind(f.store);
    vi.spyOn(f.store, 'encrypt').mockImplementation((value) => {
      if (typeof value === 'object' && value !== null && 'backup_creation' in value)
        throw new Error('synthetic-private-storage-failure');
      return encrypt(value);
    });
    await f.due().catch(() => {});
    expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
    expect(await f.requests()).toEqual([]);
    expect(f.savedState().backup_creation).toBeUndefined();
  });

  it('releases a definitively rejected mutation while preserving the previous catalog', async () => {
    const f = await fixture();
    const good = await f.seedGood();
    f.client.createJellyfinBackup.mockRejectedValueOnce(new MediaError('Forbidden.', 403));
    await f.enable();
    await f.due();
    await vi.waitFor(async () => {
      expect((await f.manager.status()).last_outcome).toBe('failed');
    });
    expect((await f.manager.status()).record?.id).toBe(good.id);
    expect((await f.manager.status()).backup_creation).toBeNull();
    expect(f.imports.busy).toBe(false);
    await f.tick();
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    expect(await f.requests()).toEqual([]);
  });

  it('bounds repeated observations to the poll interval without repeating creation', async () => {
    const f = await fixture();
    f.client.createJellyfinBackup.mockRejectedValueOnce(new MediaError('Request timed out.'));
    await f.enable();
    await f.due();
    await f.tick();
    const reads = f.client.jellyfinBackups.mock.calls.length;
    for (let index = 0; index < 5; index++) await f.tick();
    expect(f.client.jellyfinBackups).toHaveBeenCalledTimes(reads);
    vi.setSystemTime(Date.now() + 15_000);
    await f.tick();
    expect(f.client.jellyfinBackups).toHaveBeenCalledTimes(reads + 1);
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
  });

  it('allows API-key rotation only after read-only verification of the original server', async () => {
    const f = await fixture();
    f.client.createJellyfinBackup.mockRejectedValueOnce(new MediaError('Request timed out.'));
    await f.enable();
    await f.due();
    const fresh = manifest();
    f.client.jellyfinBackups.mockResolvedValue([f.old, fresh]);
    f.store.saveSettings({ ...f.store.settings(), jellyfin_api_key: 'synthetic-rotated-key' });
    await f.tick();
    expect(f.factory).toHaveBeenLastCalledWith(
      'http://jellyfin.test:8096/',
      'synthetic-rotated-key',
      'jellyfin',
    );
    expect((await f.requests())[0]!.expected_backup).toEqual({
      name: fresh.name,
      created_at: fresh.created_at,
    });
    expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'changed connection'] as const)(
    'cannot publish a helper request after %s during the final helper await',
    async (change) => {
      const f = await fixture();
      await f.enable();
      await f.due();
      f.creation.resolve(manifest());
      await vi.waitFor(async () => {
        expect((await f.manager.status()).backup_creation?.phase).toBe('waiting');
      });
      const entered = deferred<void>();
      const helperResult = deferred<boolean>();
      vi.spyOn(f.manager as unknown as { helper(): Promise<boolean> }, 'helper')
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(() => {
          entered.resolve();
          return helperResult.promise;
        });
      const pending = f.tick(false);
      await entered.promise;
      const stopping =
        change === 'stop'
          ? f.manager.stop()
          : Promise.resolve(
              f.store.saveSettings({
                ...f.store.settings(),
                jellyfin_api_key: 'synthetic-changed-during-helper-key',
              }),
            );
      helperResult.resolve(true);
      await pending;
      await stopping;
      expect(await f.requests()).toEqual([]);
      expect(f.savedState().active).toBeUndefined();
      expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    },
  );

  it.each(['preflight', 'reconcile'] as const)(
    'closes a stalled %s client on stop without losing its durable safety state',
    async (phase) => {
      const f = await fixture();
      const observation = deferred<JellyfinBackupManifest[]>();
      await f.enable();
      if (phase === 'preflight') {
        f.client.jellyfinBackups.mockReturnValueOnce(observation.promise);
        vi.setSystemTime(dueTime);
      } else {
        f.client.createJellyfinBackup.mockRejectedValueOnce(new MediaError('Request timed out.'));
        await f.due();
        await vi.waitFor(async () => {
          expect((await f.manager.status()).backup_creation?.phase).toBe('waiting');
        });
        f.client.jellyfinBackups.mockReturnValueOnce(observation.promise);
      }
      const reads = f.client.jellyfinBackups.mock.calls.length;
      f.client.close.mockImplementation(async () => {
        observation.reject(new MediaError('Synthetic request aborted.'));
      });
      const pending = f.tick();
      await vi.waitFor(() => expect(f.client.jellyfinBackups).toHaveBeenCalledTimes(reads + 1));
      await f.manager.stop();
      await pending;
      expect(f.client.close).toHaveBeenCalled();
      expect(await f.requests()).toEqual([]);
      if (phase === 'reconcile') {
        expect(f.savedState().backup_creation).toBeDefined();
        expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
      } else {
        expect(f.client.createJellyfinBackup).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['old', 'unavailable'] as const)(
    'does not release an uncertain attempt when a completed backup cannot use an %s helper',
    async (helper) => {
      const f = await fixture();
      await f.enable();
      await f.due();
      vi.setSystemTime(dueTime + JELLYFIN_BACKUP_WAIT_MS);
      await f.tick();
      f.client.jellyfinBackups.mockResolvedValue([f.old, manifest(dueTime)]);
      if (helper === 'old') await f.heartbeat(false);
      else await rm(join(f.shared, 'helper.status'));
      await f.acknowledge().catch(() => {});
      expect((await f.manager.status()).backup_creation?.phase).toBe('uncertain');
      expect(f.imports.busy).toBe(true);
      expect(await f.requests()).toEqual([]);
      expect(f.client.createJellyfinBackup).toHaveBeenCalledOnce();
    },
  );

  it('rejects stale attempt confirmation before reconciling or releasing the current owner', async () => {
    const f = await fixture();
    await f.enable();
    await f.due();
    vi.setSystemTime(dueTime + JELLYFIN_BACKUP_WAIT_MS);
    await f.tick();
    const reads = f.client.jellyfinBackups.mock.calls.length;
    await expect(f.manager.acknowledgeBackup(randomUUID())).rejects.toBeInstanceOf(ServiceError);
    expect(f.client.jellyfinBackups).toHaveBeenCalledTimes(reads);
    expect((await f.manager.status()).backup_creation?.phase).toBe('uncertain');
    expect(f.imports.busy).toBe(true);
  });
});

describe('owned Jellyfin backup retention', () => {
  async function ownedFixture(count = 9) {
    const f = await fixture();
    const state = f.savedState();
    const owned: OwnedJellyfinBackup[] = Array.from({ length: count }, (_, index) => ({
      attempt_id: randomUUID(),
      binding: { url: 'http://jellyfin.test:8096/', server_id: serverId, version: '12.2.0.0' },
      manifest: manifest(initialTime - index * 60_000),
      fingerprint: createHash('sha256').update(`synthetic-${index}`).digest('hex'),
    }));
    state.owned_backups = owned;
    f.client.jellyfinBackups.mockResolvedValue([f.old, ...owned.map((entry) => entry.manifest)]);
    f.store.db
      .prepare('INSERT OR REPLACE INTO destination_catalog_state VALUES(1,?)')
      .run(f.store.encrypt(state));
    await f.restart();
    await f.enableCleanupHelper();
    const config = (await f.manager.status()).backup_cleanup.config;
    await f.manager.configureRetention({
      enabled: true,
      keep: 7,
      expected_revision: config.revision,
    });
    return { f, owned };
  }
  async function cleanupRequest(f: Awaited<ReturnType<typeof fixture>>) {
    const name = (await readdir(f.shared)).find((name) =>
      /^jellyfin-cleanup-.*\.request$/.test(name),
    )!;
    return readEnvelope<BackupCleanupRequest>(join(f.shared, name), f.key);
  }
  it('never claims pre-existing or uncertain recovered native backups as owned', async () => {
    const f = await fixture();
    await f.enable();
    f.client.createJellyfinBackup.mockRejectedValueOnce(
      new MediaError('Synthetic network uncertainty.'),
    );
    await f.due();
    await vi.waitFor(async () =>
      expect((await f.manager.status()).backup_creation?.phase).toBe('waiting'),
    );
    f.client.jellyfinBackups.mockResolvedValue([f.old, manifest(dueTime)]);
    await f.tick();
    await f.finish((await f.requests())[0]!);
    expect((await f.manager.status()).backup_cleanup.owned_backups).toBe(0);
    expect((await f.manager.status()).backup_cleanup.last_outcome).toBeNull();
  });
  it('records ownership only from a positive creation response and confirms fingerprint after successful import', async () => {
    const f = await fixture();
    await f.enable();
    await f.due();
    f.creation.resolve(manifest(dueTime));
    await vi.waitFor(async () =>
      expect((await f.manager.status()).backup_creation?.phase).toBe('waiting'),
    );
    expect(f.savedState()).toMatchObject({
      owned_backups: [
        { attempt_id: expect.any(String), manifest: { name: manifest(dueTime).name } },
      ],
    });
    expect((f.savedState().owned_backups as OwnedJellyfinBackup[])[0]!.fingerprint).toBeUndefined();
    await f.tick();
    const result = await f.finish((await f.requests())[0]!);
    expect((f.savedState().owned_backups as OwnedJellyfinBackup[])[0]!.fingerprint).toBe(
      result.backup_fingerprint,
    );
  });
  it('queues only eligible older owned files after success, retains seven, and durably blocks overlapping work', async () => {
    const { f, owned } = await ownedFixture();
    expect((await f.manager.status()).backup_cleanup).toMatchObject({
      running: false,
      last_outcome: null,
    });
    expect((await readdir(f.shared)).some((name) => name.startsWith('jellyfin-cleanup-'))).toBe(
      false,
    );
    const good = await f.seedGood(),
      request = await cleanupRequest(f);
    expect(request.backups.map((entry) => entry.manifest.name)).toEqual(
      owned.slice(7).map((entry) => entry.manifest.name),
    );
    expect(f.imports.busy).toBe(true);
    expect(await f.manager.status()).toMatchObject({
      running: true,
      last_outcome: 'succeeded',
      record: { id: good.id },
      backup_cleanup: { running: true },
    });
    await expect(f.manager.refresh()).rejects.toBeInstanceOf(ServiceError);
    const config = (await f.manager.status()).backup_cleanup.config;
    await expect(
      f.manager.configureRetention({ enabled: false, keep: 7, expected_revision: config.revision }),
    ).rejects.toBeInstanceOf(ServiceError);
    await f.restart();
    expect(f.imports.busy).toBe(true);
    expect((await cleanupRequest(f)).id).toBe(request.id);
    const result: BackupCleanupResult = {
      ...request,
      ok: true,
      removed: request.backups.map((entry) => entry.manifest.name),
      finished_at: new Date().toISOString(),
    };
    await writeEnvelope(join(f.shared, `${backupCleanupPrefix(request.id)}.result`), result, f.key);
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      running: false,
      last_outcome: 'succeeded',
      backup_cleanup: { last_outcome: 'succeeded', last_deleted: 2, owned_backups: 7 },
    });
    expect(f.imports.busy).toBe(false);
    expect(
      await readEnvelope(join(f.shared, `${backupCleanupPrefix(request.id)}.result`), f.key),
    ).toEqual(result);
  });
  it('preserves wrong-server, unconfirmed and last-good archives and reports cleanup failure separately', async () => {
    const { f, owned } = await ownedFixture(11);
    const state = f.savedState(),
      entries = state.owned_backups as OwnedJellyfinBackup[];
    entries[7]!.binding.server_id = 'b'.repeat(32);
    delete entries[8]!.fingerprint;
    f.store.db
      .prepare('INSERT OR REPLACE INTO destination_catalog_state VALUES(1,?)')
      .run(f.store.encrypt(state));
    await f.restart();
    await f.enableCleanupHelper();
    const good = await f.seedGood(),
      request = await cleanupRequest(f);
    expect(request.backups.map((entry) => entry.manifest.name)).toEqual(
      owned.slice(9).map((entry) => entry.manifest.name),
    );
    const invalid = {
      ...request,
      ok: true,
      removed: request.backups.map((entry) => entry.manifest.name),
      finished_at: new Date().toISOString(),
      binding: { ...request.binding, server_id: 'b'.repeat(32) },
    };
    await writeEnvelope(
      join(f.shared, `${backupCleanupPrefix(request.id)}.result`),
      invalid,
      f.key,
    );
    await f.tick();
    expect((await f.manager.status()).backup_cleanup.running).toBe(true);
    await writeEnvelope(
      join(f.shared, `${backupCleanupPrefix(request.id)}.result`),
      { ...request, ok: false, removed: [], finished_at: new Date().toISOString() },
      f.key,
    );
    await f.tick();
    expect(await f.manager.status()).toMatchObject({
      last_outcome: 'succeeded',
      last_error: null,
      record: { id: good.id },
      backup_cleanup: {
        last_outcome: 'failed',
        last_deleted: 0,
        owned_backups: 11,
        error: expect.any(String),
      },
    });
  });
  it('counts only positively present archives so a missing newest ZIP cannot consume a retention slot', async () => {
    const { f, owned } = await ownedFixture(9);
    f.client.jellyfinBackups.mockResolvedValue([
      f.old,
      ...owned.slice(1).map((entry) => entry.manifest),
    ]);
    await f.seedGood();
    const request = await cleanupRequest(f);
    expect(request.backups.map((entry) => entry.manifest.name)).toEqual([owned[8]!.manifest.name]);
    expect(request.backups.some((entry) => entry.manifest.name === owned[7]!.manifest.name)).toBe(
      false,
    );
    expect(
      (f.savedState().owned_backups as OwnedJellyfinBackup[]).some(
        (entry) => entry.manifest.name === owned[0]!.manifest.name,
      ),
    ).toBe(false);
    expect((await f.manager.status()).backup_cleanup.owned_backups).toBe(8);
    expect(f.client.jellyfinBackups).toHaveBeenCalledTimes(1);
  });
  it('preserves changed archives and does not count them toward the seven matching owned files', async () => {
    const { f, owned } = await ownedFixture(9);
    const changed = { ...owned[0]!.manifest, created_at: new Date(initialTime + 1).toISOString() };
    f.client.jellyfinBackups.mockResolvedValue([
      f.old,
      changed,
      ...owned.slice(1).map((entry) => entry.manifest),
    ]);
    await f.seedGood();
    const request = await cleanupRequest(f);
    expect(request.backups.map((entry) => entry.manifest.name)).toEqual([owned[8]!.manifest.name]);
    expect((await f.manager.status()).backup_cleanup.owned_backups).toBe(9);
  });
  it.each(['unavailable', 'changed-server'] as const)(
    'fails cleanup independently and retains ownership on %s evidence',
    async (failure) => {
      const { f } = await ownedFixture(9);
      if (failure === 'unavailable')
        f.client.jellyfinBackups.mockRejectedValue(
          new MediaError('Synthetic backup listing unavailable.'),
        );
      else
        f.client.systemInfo
          .mockResolvedValueOnce({ Id: serverId, Version: '12.2.0.0' })
          .mockResolvedValue({ Id: 'b'.repeat(32), Version: '12.2.0.0' });
      const good = await f.seedGood();
      expect(await f.manager.status()).toMatchObject({
        last_outcome: 'succeeded',
        last_error: null,
        record: { id: good.id },
        backup_cleanup: {
          running: false,
          last_outcome: 'failed',
          last_deleted: 0,
          owned_backups: 9,
          error: expect.any(String),
        },
      });
      expect((await readdir(f.shared)).some((name) => name.startsWith('jellyfin-cleanup-'))).toBe(
        false,
      );
      expect(f.imports.busy).toBe(false);
      if (failure === 'changed-server') expect(f.client.jellyfinBackups).not.toHaveBeenCalled();
    },
  );
  it('does not queue cleanup after a failed import or with an uncertain native creation', async () => {
    const { f } = await ownedFixture();
    await f.manager.refresh();
    const request = (await f.requests())[0]!;
    await writeEnvelope(
      join(f.shared, `${destinationCatalogPrefix(request.id)}.result`),
      {
        ...request,
        ok: false,
        error_code: 'backup_invalid',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
      f.key,
    );
    await f.tick();
    expect((await f.manager.status()).backup_cleanup.last_outcome).toBeNull();
    expect((await readdir(f.shared)).some((name) => name.startsWith('jellyfin-cleanup-'))).toBe(
      false,
    );
    await f.enable();
    await f.due();
    vi.setSystemTime(dueTime + JELLYFIN_BACKUP_WAIT_MS);
    await f.tick();
    const config = (await f.manager.status()).backup_cleanup.config;
    await expect(
      f.manager.configureRetention({ enabled: false, keep: 7, expected_revision: config.revision }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

it('keeps last-good raw archives protected and bounds each cleanup batch to sixteen files', async () => {
  const f = await fixture(),
    state = f.savedState();
  const owned: OwnedJellyfinBackup[] = Array.from({ length: 30 }, (_, index) => ({
    attempt_id: randomUUID(),
    binding: { url: 'http://jellyfin.test:8096/', server_id: serverId, version: '12.2.0.0' },
    manifest: manifest(initialTime - index * 60_000),
    fingerprint: 'b'.repeat(64),
  }));
  owned[1]!.manifest = f.old;
  state.owned_backups = owned;
  f.client.jellyfinBackups.mockResolvedValue(owned.map((entry) => entry.manifest));
  f.store.db
    .prepare('INSERT OR REPLACE INTO destination_catalog_state VALUES(1,?)')
    .run(f.store.encrypt(state));
  await f.restart();
  await f.enableCleanupHelper();
  const config = (await f.manager.status()).backup_cleanup.config;
  await f.manager.configureRetention({
    enabled: true,
    keep: 1,
    expected_revision: config.revision,
  });
  await f.seedGood();
  const name = (await readdir(f.shared)).find((name) =>
    /^jellyfin-cleanup-.*\.request$/.test(name),
  )!;
  const request = await readEnvelope<BackupCleanupRequest>(join(f.shared, name), f.key);
  expect(request.backups).toHaveLength(16);
  expect(request.backups.some((entry) => entry.manifest.name === f.old.name)).toBe(false);
  vi.setSystemTime(initialTime + 21 * 60_000 + 1);
  await f.tick();
  expect(await f.manager.status()).toMatchObject({
    running: false,
    last_outcome: 'succeeded',
    last_error: null,
    backup_cleanup: { last_outcome: 'interrupted', error: expect.any(String) },
  });
  expect(f.imports.busy).toBe(false);
});
