import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DestinationCatalogs } from '../server/destination-catalogs.js';
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
import * as snapshotFiles from '../server/snapshot-files.js';
import { snapshotProcess } from '../server/snapshot-process.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import type { MediaAPI, MediaItem } from '../server/media.js';
import type { Job } from '../server/service.js';

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
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.manager.stop();
    resource.store.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(mode?: string) {
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
  let manager = new DestinationCatalogs(store, { clientFactory: () => factory });
  const resource = { manager, store, directory };
  resources.push(resource);
  await manager.start();
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
    manager = new DestinationCatalogs(store, { clientFactory: () => factory });
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
      expect((await f.manager.status()).last_error).toContain('could not be validated');
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
