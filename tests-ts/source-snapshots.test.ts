import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { SourceSnapshots } from '../server/source-snapshots.js';
import type { ClientFactory, MediaAPI, MediaItem } from '../server/media.js';
import type { Job } from '../server/service.js';
import {
  encryptDatabase,
  readEnvelope,
  snapshotKey,
  writeEnvelope,
  SNAPSHOT_VERSION,
  type CaptureRequest,
  type CaptureResult,
} from '../server/snapshot-files.js';
import { snapshotProcess } from '../server/snapshot-process.js';
import * as snapshotFiles from '../server/snapshot-files.js';

vi.mock('../server/snapshot-process.js', () => ({ snapshotProcess: vi.fn() }));

const userId = '0123456789ab4cde81230123456789ab';
const otherUserId = '123456789abc4def8123123456789abc';
const resources: Array<{ manager: SourceSnapshots; store: Store; directory: string }> = [];
const worker = vi.mocked(snapshotProcess);

beforeEach(() => {
  worker.mockReset();
});
afterEach(async () => {
  for (const { manager, store, directory } of resources.splice(0)) {
    await manager.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function fixture(demo = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-snapshot-manager-'));
  const shared = join(directory, 'snapshots');
  vi.stubEnv('JELLYPORT_SNAPSHOT_DIR', shared);
  vi.stubEnv('TZ', 'Etc/UTC');
  const store = new Store(join(directory, 'state'));
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    emby_url: 'http://emby:8096/',
    emby_api_key: 'private-source-fixture-key',
    jellyfin_url: 'http://jellyfin:8096',
    jellyfin_api_key: 'private-target-fixture-key',
  };
  store.saveSettings(settings);
  const client = {
    systemInfo: vi.fn(async () => ({ Id: 'fixture-emby-server', Version: SNAPSHOT_VERSION })),
    users: vi.fn(async () => [{ Id: userId, Name: 'fixture-user' }]),
    close: vi.fn(async () => {}),
  };
  const factory = vi.fn<ClientFactory>(() => client as unknown as MediaAPI);
  let manager = new SourceSnapshots(store, { demo, clientFactory: () => factory });
  const resource = { manager, store, directory };
  resources.push(resource);
  await manager.start();
  // Keep scheduling deterministic: these tests explicitly tick the file protocol.
  clearInterval((manager as unknown as { timer?: ReturnType<typeof setInterval> }).timer);
  const key = demo ? undefined : await snapshotKey(shared);
  async function heartbeat(updatedAt = new Date().toISOString(), version = SNAPSHOT_VERSION) {
    await writeEnvelope(
      join(shared, 'helper.status'),
      {
        version: 1,
        emby_version: version,
        updated_at: updatedAt,
      },
      key!,
    );
  }
  if (key) await heartbeat();
  async function tick() {
    await (manager as unknown as { tick(): Promise<void> }).tick();
  }
  async function pendingRequest() {
    const requests = (await readdir(shared)).filter((name) => name.endsWith('.request'));
    expect(requests).toHaveLength(1);
    return readEnvelope<CaptureRequest>(join(shared, requests[0]), key!);
  }
  async function request() {
    await heartbeat();
    await manager.refresh();
    return pendingRequest();
  }
  async function finish(requested: CaptureRequest, overrides: Partial<CaptureResult> = {}) {
    const plaintext = `synthetic-private-database-${requested.id}`;
    const source = join(directory, `${requested.id}.fixture`);
    await writeFile(source, plaintext);
    await encryptDatabase(source, join(shared, `${requested.id}.db.enc`), key!, requested.id);
    await rm(source);
    const completed: CaptureResult = {
      ...requested,
      ok: true,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      schema: 'emby-4.10.1.0',
      bytes: Buffer.byteLength(plaintext),
      identities: { [userId]: 7 },
      ...overrides,
    };
    await writeEnvelope(join(shared, `${requested.id}.result`), completed, key!);
    await rm(join(shared, `${requested.id}.request`));
    await tick();
    return { ...completed, plaintext };
  }
  async function complete(overrides: Partial<CaptureResult> = {}) {
    return finish(await request(), overrides);
  }
  async function restart() {
    await manager.stop();
    manager = new SourceSnapshots(store, { demo, clientFactory: () => factory });
    resource.manager = manager;
    await manager.start();
    clearInterval((manager as unknown as { timer?: ReturnType<typeof setInterval> }).timer);
  }
  return {
    directory,
    shared,
    store,
    settings,
    client,
    factory,
    get manager() {
      return manager;
    },
    key,
    heartbeat,
    tick,
    request,
    pendingRequest,
    finish,
    complete,
    restart,
  };
}

it('starts disabled at 03:00 in the server time zone and never initializes helper files in demo mode', async () => {
  const f = await fixture(true);
  expect(await f.manager.status()).toMatchObject({
    config: { enabled: false, hour: 3, minute: 0, time_zone: 'Etc/UTC', scope: 'complete' },
    available: false,
    running: false,
    snapshots: 0,
    records: [],
  });
  await expect(stat(f.shared)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.manager.refresh()).rejects.toThrow('snapshot helper is unavailable');
  await expect(f.manager.clear()).rejects.toThrow('demo mode');
  const config = (await f.manager.status()).config;
  await expect(
    f.manager.configure({ ...config, expected_revision: config.revision }),
  ).rejects.toThrow('demo mode');
  expect(f.factory).not.toHaveBeenCalled();
});

it('requests an encrypted capture bound to verified source identity and its public user GUIDs', async () => {
  const f = await fixture();
  const request = await f.request();
  expect(request).toMatchObject({
    binding: {
      url: 'http://emby:8096',
      server_id: 'fixture-emby-server',
      version: SNAPSHOT_VERSION,
    },
    user_ids: [userId],
  });
  expect(f.factory).toHaveBeenCalledExactlyOnceWith(
    f.settings.emby_url,
    f.settings.emby_api_key,
    'emby',
  );
  expect(f.client.close).toHaveBeenCalledOnce();
  expect(
    (await readFile(join(f.shared, `${request.id}.request`))).includes(Buffer.from(userId)),
  ).toBe(false);
  expect(await f.manager.status()).toMatchObject({ available: true, running: true, snapshots: 0 });
  await expect(f.manager.refresh()).rejects.toThrow('already running');
  expect(f.factory).toHaveBeenCalledOnce();
});

it('fails closed for stale helpers, unsupported server versions and unsupported public user IDs', async () => {
  const f = await fixture();
  await f.heartbeat(new Date(Date.now() - 30_000).toISOString());
  await expect(f.manager.refresh()).rejects.toThrow('helper is unavailable');
  expect(f.factory).not.toHaveBeenCalled();
  await f.heartbeat();
  f.client.systemInfo.mockResolvedValueOnce({ Id: 'fixture-emby-server', Version: '4.10.2.0' });
  await expect(f.manager.refresh()).rejects.toThrow('4.10.1.0 only');
  f.client.users.mockResolvedValueOnce([{ Id: 'not-a-public-guid', Name: 'fixture' }]);
  await expect(f.manager.refresh()).rejects.toThrow('unsupported user identities');
  expect(f.client.close).toHaveBeenCalledTimes(2);
  expect((await readdir(f.shared)).filter((name) => name.endsWith('.request'))).toEqual([]);
});

it('rejects stale schedules rather than overwriting another administrator’s configuration', async () => {
  const f = await fixture();
  const initial = (await f.manager.status()).config;
  const input = { ...initial, enabled: true, minute: 15, expected_revision: initial.revision };
  const saved = await f.manager.configure(input);
  expect(saved.config).toMatchObject({ enabled: true, hour: 3, minute: 15 });
  expect(saved.config.revision).not.toBe(initial.revision);
  await expect(f.manager.configure(input)).rejects.toThrow('schedule changed');
  await expect(
    f.manager.configure({
      ...input,
      time_zone: 'Invalid/Zone',
      expected_revision: saved.config.revision,
    }),
  ).rejects.toThrow('valid IANA');
  expect((await f.manager.status()).config).toEqual(saved.config);
});

it('selects only captures for the configured server, user and age without falling back to live data', async () => {
  const f = await fixture();
  const capture = await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  expect(selected.id).toBe(capture.id);
  expect(selected.metadata).toMatchObject({
    source_type: 'sqlite_online_backup',
    schema: 'emby-4.10.1.0',
    source_server_version: SNAPSHOT_VERSION,
    source_user_id: userId,
    scope: 'complete',
  });
  await expect(f.manager.select(otherUserId, f.settings, 'fixture-emby-server')).rejects.toThrow(
    'user is absent',
  );
  await expect(
    f.manager.select(
      userId,
      { ...f.settings, emby_url: 'http://other-emby:8096' },
      'fixture-emby-server',
    ),
  ).rejects.toThrow('different Emby connection');
  await expect(f.manager.select(userId, f.settings, 'other-server')).rejects.toThrow(
    'different Emby connection',
  );
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', randomUUID()),
  ).rejects.toThrow('No completed');
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 49 * 60 * 60_000);
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', capture.id),
  ).rejects.toThrow('48 hours');
  expect(worker).not.toHaveBeenCalled();
});

it('preserves the last good generation when a result is corrupt, unsupported or belongs to a different user database', async () => {
  const f = await fixture();
  const good = await f.complete();
  await f.complete({ schema: 'unsupported-schema' });
  expect(await f.manager.status()).toMatchObject({
    running: false,
    snapshots: 1,
    last_error: 'Database capture could not be validated. The last good copy is preserved.',
  });
  await f.complete({ identities: { [otherUserId]: 10 } });
  const status = await f.manager.status();
  expect(status.records.map((record) => record.id)).toEqual([good.id]);
  expect(status.last_error).not.toMatch(/fixture|private|\.db|\/tmp/);
  expect((await f.manager.select(userId, f.settings, 'fixture-emby-server')).id).toBe(good.id);
  const request = await f.request();
  await writeFile(join(f.shared, `${request.id}.result`), 'invalid-unauthenticated-result');
  await f.tick();
  expect(await f.manager.status()).toMatchObject({ running: true, snapshots: 1 });
});

it('retains the exact generation pinned by a queued job while newer captures replace unpinned history', async () => {
  const f = await fixture();
  const first = await f.complete();
  const job: Job = {
    id: randomUUID(),
    kind: 'migrate',
    status: 'queued',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: { processed: 0, total: 1 },
    results: [],
    source_snapshot_ids: { [userId]: first.id },
  };
  f.store.saveJob(job);
  await f.complete();
  const latest = await f.complete();
  expect((await f.manager.status()).records).toHaveLength(3);
  expect((await f.manager.select(userId, f.settings, 'fixture-emby-server', first.id)).id).toBe(
    first.id,
  );
  expect((await f.manager.select(userId, f.settings, 'fixture-emby-server')).id).toBe(latest.id);
  await expect(f.manager.clear()).rejects.toThrow('using saved data');
  f.store.saveJob({ ...job, status: 'completed' });
  // Preview pins expire independently of job pins.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  await (f.manager as unknown as { prune(): Promise<void> }).prune();
  expect((await f.manager.status()).records).toHaveLength(2);
  await expect(stat(join(f.shared, `${first.id}.db.enc`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('prevents clear during decryption and offline reads, then removes ciphertext and decrypted cache on clear', async () => {
  const f = await fixture();
  const capture = await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  let release!: (items: MediaItem[]) => void;
  worker.mockImplementation(async (request) => {
    const path = (request as { path: string }).path;
    expect((await readFile(path)).toString()).toBe(capture.plaintext);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const reading = f.manager.items(selected, userId, 'watched_only');
  await expect(f.manager.clear()).rejects.toThrow('using saved data');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(f.manager.clear()).rejects.toThrow('using saved data');
  release([{ Id: 'fixture-item', UserData: { Played: true } }]);
  expect(await reading).toEqual([{ Id: 'fixture-item', UserData: { Played: true } }]);
  expect(worker.mock.calls[0][0]).toMatchObject({
    operation: 'read',
    user_id: userId,
    scope: 'watched_only',
  });
  expect(
    (await readFile(join(f.shared, `${capture.id}.db.enc`))).includes(
      Buffer.from(capture.plaintext),
    ),
  ).toBe(false);
  // Expire incidental preview pins before clearing the encrypted generations and idle read cache.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  await (f.manager as unknown as { prune(): Promise<void> }).prune();
  expect(await f.manager.clear()).toMatchObject({ snapshots: 0, records: [] });
  expect(
    (await readdir(f.shared)).filter(
      (name) => name.startsWith('read-') || name.endsWith('.db.enc') || name.endsWith('.result'),
    ),
  ).toEqual([]);
});

it('authenticates database bytes against the selected generation and deletes failed plaintext', async () => {
  const f = await fixture();
  const capture = await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  const corrupt = await readFile(join(f.shared, `${capture.id}.db.enc`));
  corrupt[12] ^= 1;
  await writeFile(join(f.shared, `${capture.id}.db.enc`), corrupt);
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow(
    'Database authentication failed. Capture Emby again.',
  );
  expect(worker).not.toHaveBeenCalled();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
});

it('stop aborts externally signaled workers, waits for them to drain and removes all decrypted data', async () => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  let workerStarted = false;
  let drained = false;
  worker.mockImplementation(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        workerStarted = true;
        signal!.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              drained = true;
              reject(new Error('fixture worker canceled'));
            }, 10);
          },
          { once: true },
        );
      }),
  );
  const external = new AbortController();
  const readResult = f.manager
    .items(selected, userId, 'complete', external.signal)
    .catch((error: Error) => error.message);
  await vi.waitFor(() => expect(workerStarted).toBe(true));
  await f.manager.stop();
  expect(drained).toBe(true);
  expect(await readResult).toBe('fixture worker canceled');
  expect(external.signal.aborted).toBe(false);
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow('unavailable');
});

it('blocks new reads while clear awaits idle cache removal and rejects a stale selected generation afterward', async () => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  worker.mockResolvedValue([]);
  await f.manager.items(selected, userId, 'complete');
  const internal = f.manager as unknown as { removeDatabase(id: string): Promise<void> };
  const remove = internal.removeDatabase.bind(f.manager);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let removing = false;
  vi.spyOn(internal, 'removeDatabase').mockImplementation(async (id) => {
    await remove(id);
    removing = true;
    await barrier;
  });
  const clearing = f.manager.clear();
  await vi.waitFor(() => expect(removing).toBe(true));
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow('unavailable');
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', selected.id),
  ).rejects.toThrow('cleared or stopped');
  await expect(f.manager.refresh()).rejects.toThrow('changes are in progress');
  release();
  expect(await clearing).toMatchObject({ snapshots: 0 });
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow(
    'Review a new preview',
  );
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', selected.id),
  ).rejects.toThrow('No completed');
  expect(worker).toHaveBeenCalledOnce();
});

it('cancels decryption during stop and cleans its partial plaintext before resolving shutdown', async () => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  const decrypt = snapshotFiles.decryptDatabase;
  let entered = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(snapshotFiles, 'decryptDatabase').mockImplementation(async (...args) => {
    entered = true;
    await barrier;
    return decrypt(...args);
  });
  const outcome = f.manager
    .items(selected, userId, 'complete')
    .catch((error: Error) => error.message);
  await vi.waitFor(() => expect(entered).toBe(true));
  let stopped = false;
  const stopping = f.manager.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(await outcome).toBe('Database authentication failed. Capture Emby again.');
  expect(worker).not.toHaveBeenCalled();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
});

it('does not report a completed capture when its authenticated manifest has no matching database bytes', async () => {
  const f = await fixture();
  const capture = await f.complete();
  await rm(join(f.shared, `${capture.id}.db.enc`));
  expect(await f.manager.status()).toMatchObject({ snapshots: 0, records: [] });
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', capture.id),
  ).rejects.toThrow('missing, corrupt or unsupported');
  expect(worker).not.toHaveBeenCalled();
});

it('does not enqueue a helper request after shutdown interrupts source identity validation', async () => {
  const f = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let validating = false;
  f.client.users.mockImplementationOnce(async () => {
    validating = true;
    await barrier;
    return [{ Id: userId, Name: 'fixture-user' }];
  });
  const refreshing = f.manager.refresh().catch((error: Error) => error);
  await vi.waitFor(() => expect(validating).toBe(true));
  await f.manager.stop();
  release();
  expect(await refreshing).toBeInstanceOf(Error);
  expect((await readdir(f.shared)).filter((name) => name.endsWith('.request'))).toEqual([]);
  expect(f.client.close).toHaveBeenCalledOnce();
});

it('keeps daily capture off until enabled and only catches up within one hour of the configured time', async () => {
  vi.setSystemTime(new Date('2026-10-08T03:45:00Z'));
  const f = await fixture();
  await f.tick();
  expect(f.factory).not.toHaveBeenCalled();
  const config = (await f.manager.status()).config;
  await f.manager.configure({
    ...config,
    enabled: true,
    hour: 3,
    minute: 15,
    expected_revision: config.revision,
  });
  vi.setSystemTime(new Date('2026-10-09T03:14:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-10-09T04:15:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-10-10T04:14:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  expect(await f.pendingRequest()).toMatchObject({ requested_at: '2026-10-10T04:14:00.000Z' });
});

it('restores the named-zone schedule and last daily attempt across a manager restart', async () => {
  vi.setSystemTime(new Date('2026-01-15T08:30:00Z')); // 03:30 America/New_York.
  const f = await fixture();
  const config = (await f.manager.status()).config;
  const saved = await f.manager.configure({
    ...config,
    enabled: true,
    hour: 3,
    minute: 15,
    time_zone: 'America/New_York',
    expected_revision: config.revision,
  });
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  await f.finish(await f.pendingRequest());
  vi.setSystemTime(new Date('2026-01-15T08:40:00Z'));
  await f.heartbeat();
  await f.restart();
  expect((await f.manager.status()).config).toEqual(saved.config);
  expect(f.factory).toHaveBeenCalledOnce();
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date('2026-01-16T08:14:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date('2026-01-16T08:15:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).toHaveBeenCalledTimes(2);
  expect(await f.pendingRequest()).toMatchObject({ requested_at: '2026-01-16T08:15:00.000Z' });
});

it('does not capture twice when daylight saving repeats the scheduled local wall-clock time', async () => {
  vi.setSystemTime(new Date('2026-11-01T05:30:00Z')); // First 01:30, still EDT.
  const f = await fixture();
  const config = (await f.manager.status()).config;
  await f.manager.configure({
    ...config,
    enabled: true,
    hour: 1,
    minute: 30,
    time_zone: 'America/New_York',
    expected_revision: config.revision,
  });
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  await f.finish(await f.pendingRequest());
  vi.setSystemTime(new Date('2026-11-01T06:30:00Z')); // Repeated 01:30, now EST.
  await f.heartbeat();
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  expect(await f.manager.status()).toMatchObject({
    running: false,
    snapshots: 1,
    last_attempt_at: '2026-11-01T05:30:00.000Z',
  });
  expect((await readdir(f.shared)).filter((name) => name.endsWith('.request'))).toEqual([]);
});

it('catches up a late-night schedule after midnight once across restart and permits the next night', async () => {
  vi.setSystemTime(new Date('2026-10-08T22:00:00Z'));
  const f = await fixture();
  const config = (await f.manager.status()).config;
  await f.manager.configure({
    ...config,
    enabled: true,
    hour: 23,
    minute: 30,
    expected_revision: config.revision,
  });
  await f.tick();
  expect(f.factory).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-10-09T00:10:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  expect(await f.pendingRequest()).toMatchObject({ requested_at: '2026-10-09T00:10:00.000Z' });
  await f.finish(await f.pendingRequest());
  vi.setSystemTime(new Date('2026-10-09T00:20:00Z'));
  await f.heartbeat();
  await f.restart();
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  expect(await f.manager.status()).toMatchObject({ running: false, snapshots: 1 });
  vi.setSystemTime(new Date('2026-10-09T23:30:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).toHaveBeenCalledTimes(2);
  expect(await f.pendingRequest()).toMatchObject({ requested_at: '2026-10-09T23:30:00.000Z' });
});
