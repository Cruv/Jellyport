import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { SourceSnapshots } from '../server/source-snapshots.js';
import { ImportCoordinator } from '../server/daily-import-schedule.js';
import type { ClientFactory, MediaAPI, MediaItem } from '../server/media.js';
import type { Job } from '../server/service.js';
import {
  encryptDatabase,
  readEnvelope,
  recoverSnapshotHelper,
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

async function fixture(demo = false, imports?: ImportCoordinator) {
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
  let manager = new SourceSnapshots(store, { demo, clientFactory: () => factory, imports });
  const resource = { manager, store, directory };
  resources.push(resource);
  await manager.start();
  // Keep scheduling deterministic: these tests explicitly tick the file protocol.
  clearInterval((manager as unknown as { timer?: ReturnType<typeof setInterval> }).timer);
  const key = demo ? undefined : await snapshotKey(shared);
  async function heartbeat(
    updatedAt = new Date().toISOString(),
    version = SNAPSHOT_VERSION,
    captureMethod?: unknown,
  ) {
    await writeEnvelope(
      join(shared, 'helper.status'),
      {
        version: 1,
        emby_version: version,
        updated_at: updatedAt,
        ...(captureMethod === undefined ? {} : { capture_method: captureMethod }),
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
    manager = new SourceSnapshots(store, { demo, clientFactory: () => factory, imports });
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

async function pluginCapture(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<CaptureResult> = {},
) {
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'plugin_backup');
  await f.manager.refresh();
  return f.finish(await f.pendingRequest(), {
    backup_created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    backup_fingerprint: 'a'.repeat(64),
    plugin_version: '1.8.7.0',
    ...overrides,
  });
}

it.each([false, true])(
  'reports conditional failure retention with a previous Emby capture: %s',
  async (retained) => {
    const f = await fixture();
    const good = retained ? await pluginCapture(f) : undefined;
    await pluginCapture(f, { schema: 'unsupported-schema' });
    const status = await f.manager.status();
    expect(status).toMatchObject({
      running: false,
      last_outcome: 'failed',
      snapshots: retained ? 1 : 0,
      last_error:
        'Database capture could not be validated. Any previously saved copy is preserved.',
    });
    expect(status.records.map((record) => record.id)).toEqual(good ? [good.id] : []);
    await f.restart();
    expect((await f.manager.status()).records.map((record) => record.id)).toEqual(
      good ? [good.id] : [],
    );
    if (good)
      expect((await f.manager.select(userId, f.settings, 'fixture-emby-server')).id).toBe(good.id);
    else
      await expect(f.manager.select(userId, f.settings, 'fixture-emby-server')).rejects.toThrow(
        'No completed',
      );
  },
);

it('imports plugin provenance with original history age and permits accounts created after the backup', async () => {
  const f = await fixture();
  f.client.users.mockResolvedValue([
    { Id: userId, Name: 'fixture-user' },
    { Id: otherUserId, Name: 'new-fixture-user' },
  ]);
  const backupTime = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const capture = await pluginCapture(f, { backup_created_at: backupTime });
  expect(await f.manager.status()).toMatchObject({
    running: false,
    capture_method: 'plugin_backup',
    snapshots: 1,
    records: [
      {
        id: capture.id,
        source_type: 'plugin_backup',
        backup_created_at: backupTime,
        backup_fingerprint: 'a'.repeat(64),
        plugin_version: '1.8.7.0',
        finished_at: capture.finished_at,
        expires_at: new Date(Date.parse(backupTime) + 48 * 60 * 60_000).toISOString(),
      },
    ],
  });
  expect((await f.manager.select(userId, f.settings, 'fixture-emby-server')).id).toBe(capture.id);
  await expect(f.manager.select(otherUserId, f.settings, 'fixture-emby-server')).rejects.toThrow(
    'user is absent',
  );
  await f.restart();
  expect((await f.manager.status()).records[0]?.backup_created_at).toBe(backupTime);
  expect(f.factory).toHaveBeenCalledOnce();
  expect(worker).not.toHaveBeenCalled();
});

it.each([
  { plugin_version: undefined },
  { plugin_version: '1.8.8.0' },
  { backup_fingerprint: undefined },
  { backup_fingerprint: '../private-backup' },
  { backup_created_at: undefined },
  { backup_created_at: 'not-a-date' },
  { backup_created_at: '2026-02-30T03:00:00.000Z' },
])('rejects invalid plugin metadata while preserving completed history (%j)', async (override) => {
  const f = await fixture();
  const good = await pluginCapture(f);
  const invalid = await pluginCapture(f, override);
  expect(await f.manager.status()).toMatchObject({
    snapshots: 1,
    records: [{ id: good.id }],
    last_error: 'Database capture could not be validated. Any previously saved copy is preserved.',
  });
  await expect(stat(join(f.shared, `${invalid.id}.db.enc`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(stat(join(f.shared, `${invalid.id}.result`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each([-49 * 60 * 60_000, 2 * 60_000])(
  'rejects a stale or future original plugin timestamp even when import has just finished (%i)',
  async (offset) => {
    const f = await fixture();
    const good = await pluginCapture(f);
    await pluginCapture(f, {
      backup_created_at: new Date(Date.now() + offset).toISOString(),
      backup_fingerprint: 'b'.repeat(64),
    });
    expect((await f.manager.status()).records.map((record) => record.id)).toEqual([good.id]);
    expect((await f.manager.status()).last_error).toContain('previously saved copy is preserved');
  },
);

it('does not renew the original plugin age through a new import and stops migration after 48 hours', async () => {
  const f = await fixture();
  const now = Date.now();
  const capture = await pluginCapture(f, {
    backup_created_at: new Date(now - 47 * 60 * 60_000).toISOString(),
  });
  vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 60_000);
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', capture.id),
  ).rejects.toThrow('48 hours');
  expect(worker).not.toHaveBeenCalled();
});

it.each<Record<string, number>>([
  {},
  { [otherUserId]: 10 },
  { [userId]: -1 },
  { [userId]: 7, [otherUserId]: 7 },
  { 'not-a-public-guid': 7 },
])(
  'rejects invalid or unrelated plugin identities without accepting partial unsafe maps (%j)',
  async (identities) => {
    const f = await fixture();
    const good = await pluginCapture(f);
    await pluginCapture(f, { identities });
    expect((await f.manager.status()).records.map((record) => record.id)).toEqual([good.id]);
  },
);

it('keeps per-user history diagnostics on that read instead of the shared decrypted database cache', async () => {
  const f = await fixture();
  await f.complete({ identities: { [userId]: 7, [otherUserId]: 8 } });
  const first = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  const second = await f.manager.select(otherUserId, f.settings, 'fixture-emby-server');
  const diagnostics = {
    unsupported_state_items: 2,
    invalid_resume_positions: 1,
    invalid_display_names: 3,
    orphan_state_items: 4,
    recovered_orphan_state_items: 7,
  };
  worker.mockResolvedValueOnce({
    items: [{ Id: 'first-item', UserData: { Played: true } }],
    diagnostics,
  });
  expect(await f.manager.items(first, userId, 'complete')).toEqual([
    { Id: 'first-item', UserData: { Played: true } },
  ]);
  expect(first.metadata.diagnostics).toEqual(diagnostics);
  diagnostics.unsupported_state_items = 99;
  expect(first.metadata.diagnostics?.unsupported_state_items).toBe(2);
  expect(second.metadata.diagnostics).toBeUndefined();
  worker.mockResolvedValueOnce({
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 0,
      invalid_display_names: 0,
    },
  });
  expect(await f.manager.items(second, otherUserId, 'complete')).toEqual([]);
  expect(first.metadata.diagnostics?.unsupported_state_items).toBe(2);
  expect(first.metadata.diagnostics?.orphan_state_items).toBe(4);
  expect(first.metadata.diagnostics?.recovered_orphan_state_items).toBe(7);
  expect(second.metadata.diagnostics?.unsupported_state_items).toBe(0);
  expect(second.metadata.diagnostics?.orphan_state_items).toBe(0);
  expect(second.metadata.diagnostics?.recovered_orphan_state_items).toBe(0);
  expect((await f.manager.status()).records[0]?.diagnostics).toBeUndefined();
  worker.mockResolvedValueOnce([]);
  await f.manager.items(first, userId, 'complete');
  expect(first.metadata.diagnostics).toBeUndefined();
});

it.each([
  { items: 'not-history', diagnostics: {} },
  { items: [], diagnostics: undefined },
  {
    items: [],
    diagnostics: {
      unsupported_state_items: -1,
      invalid_resume_positions: 0,
      invalid_display_names: 0,
    },
  },
  {
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 100_001,
      invalid_display_names: 0,
    },
  },
  {
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 0.5,
      invalid_display_names: 0,
    },
  },
  {
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 0,
      invalid_display_names: undefined,
    },
  },
  {
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 0,
      invalid_display_names: 0,
      orphan_state_items: -1,
    },
  },
  {
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 0,
      invalid_display_names: 0,
      orphan_state_items: 100_001,
    },
  },
  ...[-1, 100_001, '1'].map((count) => ({
    items: [],
    diagnostics: {
      unsupported_state_items: 0,
      invalid_resume_positions: 0,
      invalid_display_names: 0,
      recovered_orphan_state_items: count,
    },
  })),
])('rejects malformed or unbounded snapshot diagnostics (%j)', async (value) => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  worker.mockResolvedValueOnce(value);
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow(/history/);
  expect(selected.metadata.diagnostics).toBeUndefined();
});

it.each([null, 0, 2, '1'])(
  'rejects unsupported history identity capabilities without replacing completed history (%j)',
  async (version) => {
    const f = await fixture();
    const good = await f.complete();
    const invalid = await f.complete({ orphan_identity_version: version as 1 });
    expect((await f.manager.status()).records.map((record) => record.id)).toEqual([good.id]);
    expect((await f.manager.status()).last_error).toContain('previously saved copy is preserved');
    await expect(stat(join(f.shared, `${invalid.id}.db.enc`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('adopts a capable projection of the same plugin backup while preserving legacy pins and original age', async () => {
  const f = await fixture();
  const legacy = await pluginCapture(f);
  const pinned = await f.manager.select(userId, f.settings, 'fixture-emby-server', legacy.id);
  const job: Job = {
    id: randomUUID(),
    kind: 'migrate',
    status: 'queued',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: { processed: 0, total: 1 },
    results: [],
    source_snapshot_ids: { [userId]: legacy.id },
  };
  f.store.saveJob(job);
  const capable = await pluginCapture(f, {
    backup_created_at: legacy.backup_created_at,
    orphan_identity_version: 1,
  });
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  expect(selected.id).toBe(capable.id);
  expect(selected.metadata).toMatchObject({
    orphan_identity_version: 1,
    backup_created_at: legacy.backup_created_at,
    expires_at: pinned.metadata.expires_at,
  });
  expect((await f.manager.status()).records.map((record) => record.id)).toEqual([
    capable.id,
    legacy.id,
  ]);
  expect((await stat(join(f.shared, `${legacy.id}.db.enc`))).isFile()).toBe(true);
  expect(
    (await f.manager.select(userId, f.settings, 'fixture-emby-server', legacy.id)).metadata
      .orphan_identity_version,
  ).toBeUndefined();
  for (const orphan_identity_version of [1, undefined] as const) {
    const duplicate = await pluginCapture(f, {
      backup_created_at: legacy.backup_created_at,
      orphan_identity_version,
    });
    expect((await f.manager.status()).records.map((record) => record.id)).toEqual([
      capable.id,
      legacy.id,
    ]);
    const status = await f.manager.status();
    expect(status.last_finished_at).toBe(duplicate.finished_at);
    expect(status.records[0]?.finished_at).toBe(capable.finished_at);
    await expect(stat(join(f.shared, `${duplicate.id}.db.enc`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(f.shared, `${duplicate.id}.result`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
  await f.restart();
  expect((await f.manager.status()).records.map((record) => record.id)).toEqual([
    capable.id,
    legacy.id,
  ]);
  expect(f.store.job(job.id)?.source_snapshot_ids).toEqual({ [userId]: legacy.id });
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(legacy.backup_created_at!) + 48 * 60 * 60_000 + 1,
  );
  await expect(
    f.manager.select(userId, f.settings, 'fixture-emby-server', capable.id),
  ).rejects.toThrow('48 hours');
});

it('deduplicates the same plugin backup without replacing its generation or renewing history age', async () => {
  const f = await fixture();
  const good = await pluginCapture(f);
  const duplicate = await pluginCapture(f, { backup_created_at: good.backup_created_at });
  expect(await f.manager.status()).toMatchObject({
    snapshots: 1,
    records: [
      { id: good.id, backup_created_at: good.backup_created_at, finished_at: good.finished_at },
    ],
    last_finished_at: duplicate.finished_at,
    last_error: null,
  });
  await expect(stat(join(f.shared, `${duplicate.id}.db.enc`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(stat(join(f.shared, `${duplicate.id}.result`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('does not regress source history or let a changed timestamp relabel the same plugin backup', async () => {
  const f = await fixture();
  const good = await pluginCapture(f);
  await pluginCapture(f, {
    backup_created_at: new Date(Date.parse(good.backup_created_at!) - 1_000).toISOString(),
    backup_fingerprint: 'b'.repeat(64),
  });
  await pluginCapture(f, {
    backup_created_at: new Date(Date.parse(good.backup_created_at!) + 1_000).toISOString(),
  });
  expect((await f.manager.status()).records.map((record) => record.id)).toEqual([good.id]);
});

it('allows switching from a fresher legacy capture to a valid older plugin backup without renewing its original age', async () => {
  const f = await fixture();
  const good = await f.complete();
  const backup = await pluginCapture(f);
  expect((await f.manager.status()).records.map((record) => record.id)).toEqual([
    backup.id,
    good.id,
  ]);
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  expect(selected.id).toBe(backup.id);
  expect(selected.metadata.backup_created_at).toBe(backup.backup_created_at);
  expect(selected.metadata.expires_at).toBe(
    new Date(Date.parse(backup.backup_created_at!) + 48 * 60 * 60_000).toISOString(),
  );
});

it('allows original plugin history to replace a capture from a different bound connection', async () => {
  const f = await fixture();
  await f.complete();
  f.store.saveSettings({ ...f.settings, emby_url: 'http://replacement-emby:8096' });
  const next = await pluginCapture(f);
  expect((await f.manager.status()).records[0]?.id).toBe(next.id);
});

it('recovers a completed plugin import with newly created users absent while rejecting stale backup recovery', async () => {
  const f = await fixture();
  f.client.users.mockResolvedValue([
    { Id: userId, Name: 'fixture-user' },
    { Id: otherUserId, Name: 'new-fixture-user' },
  ]);
  const capture = await pluginCapture(f);
  const working = join(f.shared, `${capture.id}.working`);
  const request: CaptureRequest = {
    id: capture.id,
    requested_at: capture.requested_at,
    binding: capture.binding,
    user_ids: capture.user_ids,
    capture_method: 'plugin_backup',
  };
  await writeEnvelope(working, request, f.key!);
  await recoverSnapshotHelper(f.shared, f.key!);
  expect(
    (await readEnvelope<CaptureResult>(join(f.shared, `${capture.id}.result`), f.key!)).ok,
  ).toBe(true);
  await writeEnvelope(working, request, f.key!);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(capture.backup_created_at!) + 49 * 60 * 60_000);
  await recoverSnapshotHelper(f.shared, f.key!);
  expect(
    (await readEnvelope<CaptureResult>(join(f.shared, `${capture.id}.result`), f.key!)).ok,
  ).toBe(false);
  await expect(stat(working)).rejects.toMatchObject({ code: 'ENOENT' });
});

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

it('collects stale unfinished ciphertext while preserving recent work and the last completed capture', async () => {
  const f = await fixture();
  const completed = await f.complete();
  const stale = join(f.shared, `${randomUUID()}.db.enc.pending`);
  const recent = join(f.shared, `${randomUUID()}.db.enc.pending`);
  await writeFile(stale, 'unfinished-stale-ciphertext');
  await writeFile(recent, 'unfinished-recent-ciphertext');
  const past = new Date(Date.now() - 21 * 60_000);
  await utimes(stale, past, past);
  await f.manager.refresh();
  await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(recent, 'utf8')).toBe('unfinished-recent-ciphertext');
  expect((await stat(join(f.shared, `${completed.id}.db.enc`))).isFile()).toBe(true);
});

it('pins a file-copy helper method and preserves its provenance across restart and helper changes', async () => {
  const f = await fixture();
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'file_copy');
  expect(await f.manager.status()).toMatchObject({ available: true, capture_method: 'file_copy' });
  await f.manager.refresh();
  const request = await f.pendingRequest();
  expect(request.capture_method).toBe('file_copy');
  const capture = await f.finish(request);
  expect(
    (await f.manager.select(userId, f.settings, 'fixture-emby-server')).metadata.source_type,
  ).toBe('file_copy');
  await f.restart();
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'sqlite_online_backup');
  expect(await f.manager.status()).toMatchObject({
    capture_method: 'sqlite_online_backup',
    records: [{ id: capture.id, source_type: 'file_copy' }],
  });
  await f.heartbeat(new Date(Date.now() - 30_000).toISOString(), SNAPSHOT_VERSION, 'file_copy');
  expect(await f.manager.status()).toMatchObject({
    available: false,
    capture_method: 'sqlite_online_backup',
    history_source_known: true,
    records: [{ id: capture.id, source_type: 'file_copy' }],
  });
});

it('remembers an authenticated plugin source without any imported generation through helper failure and restart', async () => {
  const f = await fixture();
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'plugin_backup');
  expect(await f.manager.status()).toMatchObject({
    available: true,
    history_source_known: true,
    capture_method: 'plugin_backup',
    snapshots: 0,
  });
  await f.heartbeat(new Date(Date.now() - 30_000).toISOString(), SNAPSHOT_VERSION, 'plugin_backup');
  expect(await f.manager.status()).toMatchObject({
    available: false,
    history_source_known: true,
    capture_method: 'plugin_backup',
    snapshots: 0,
  });
  await rm(join(f.shared, 'helper.status'));
  await f.restart();
  expect(await f.manager.status()).toMatchObject({
    available: false,
    history_source_known: true,
    capture_method: 'plugin_backup',
    snapshots: 0,
  });
  expect(f.factory).not.toHaveBeenCalled();
  expect(worker).not.toHaveBeenCalled();
});

it('marks an unobserved configured source as unknown instead of authorizing a default live path', async () => {
  const f = await fixture();
  await rm(join(f.shared, 'helper.status'));
  expect(await f.manager.status()).toMatchObject({
    available: false,
    history_source_known: false,
    snapshots: 0,
  });
  await f.heartbeat(new Date(Date.now() - 30_000).toISOString(), SNAPSHOT_VERSION, 'plugin_backup');
  expect((await f.manager.status()).history_source_known).toBe(false);
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'plugin_backup');
  expect(await f.manager.status()).toMatchObject({
    available: true,
    history_source_known: true,
    capture_method: 'plugin_backup',
  });
});

it('rejects an authenticated result that silently changes file-copy capture to online backup', async () => {
  const f = await fixture();
  const good = await f.complete();
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'file_copy');
  await f.manager.refresh();
  const request = await f.pendingRequest();
  await f.finish(request, { capture_method: 'sqlite_online_backup' });
  expect(await f.manager.status()).toMatchObject({
    running: false,
    records: [{ id: good.id }],
    last_error: 'Database capture could not be validated. Any previously saved copy is preserved.',
  });
});

it('rejects unknown helper capture methods before making any Emby API request', async () => {
  const f = await fixture();
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'unrecognized-capture-method');
  await expect(f.manager.refresh()).rejects.toThrow('helper is unavailable');
  expect(f.factory).not.toHaveBeenCalled();
});

it('reads legacy capture manifests without a method as SQLite online backups', async () => {
  const f = await fixture();
  const capture = await f.complete({ capture_method: undefined });
  await f.restart();
  expect(
    (await f.manager.select(userId, f.settings, 'fixture-emby-server', capture.id)).metadata
      .source_type,
  ).toBe('sqlite_online_backup');
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
    last_error: 'Database capture could not be validated. Any previously saved copy is preserved.',
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

it('decrypts once for 100 bulk-job users across long write intervals and promptly removes plaintext on release', async () => {
  const f = await fixture();
  const capture = await f.complete({ identities: { [userId]: 7, [otherUserId]: 8 } });
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  const decrypt = vi.spyOn(snapshotFiles, 'decryptDatabase');
  const paths = new Set<string>();
  worker.mockImplementation(async (request) => {
    const read = request as { path: string; user_id: string };
    paths.add(read.path);
    return [{ Id: read.user_id, Type: 'Movie', UserData: { Played: true } }];
  });
  const release = f.manager.retainForJob([capture.id, capture.id]);
  vi.useFakeTimers();
  for (let index = 0; index < 100; index++) {
    const id = index % 2 ? otherUserId : userId;
    expect(await f.manager.items(selected, id, 'complete')).toEqual([
      { Id: id, Type: 'Movie', UserData: { Played: true } },
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
  }
  expect(decrypt).toHaveBeenCalledOnce();
  expect(paths.size).toBe(1);
  expect(worker).toHaveBeenCalledTimes(100);
  await expect(f.manager.clear()).rejects.toThrow('using saved data');
  await release();
  await release();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
  expect((await stat(join(f.shared, `${capture.id}.db.enc`))).isFile()).toBe(true);
});

it('keeps independent job references until the final release without retaining per-user state', async () => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  worker.mockResolvedValue([]);
  const first = f.manager.retainForJob([selected.id]);
  const second = f.manager.retainForJob([selected.id]);
  await f.manager.items(selected, userId, 'complete');
  await first();
  await first();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toHaveLength(1);
  await second();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
});

it('removes job plaintext after a failed worker and does not let job references delay shutdown', async () => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  const release = f.manager.retainForJob([selected.id]);
  worker.mockRejectedValueOnce(new Error('fixture read failed'));
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow(
    'fixture read failed',
  );
  await release();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
  const stoppedRelease = f.manager.retainForJob([selected.id]);
  worker.mockResolvedValue([]);
  await f.manager.items(selected, userId, 'complete');
  await f.manager.stop();
  await stoppedRelease();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
  expect(() => f.manager.retainForJob([selected.id])).toThrow('unavailable');
});

it('rejects invalid or unbounded job references before retaining any database', async () => {
  const f = await fixture();
  await f.complete();
  expect(() => f.manager.retainForJob(['../library.db'])).toThrow('invalid');
  expect(() => f.manager.retainForJob(Array.from({ length: 9 }, () => randomUUID()))).toThrow(
    'invalid',
  );
  expect(worker).not.toHaveBeenCalled();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
});

it.each(['clear', 'stop'] as const)(
  'releases every job generation despite one cleanup failure and retries tracked plaintext on %s',
  async (retry) => {
    const f = await fixture();
    const first = await f.complete();
    const second = await f.complete();
    const selections = await Promise.all(
      [first.id, second.id].map((id) =>
        f.manager.select(userId, f.settings, 'fixture-emby-server', id),
      ),
    );
    const release = f.manager.retainForJob([first.id, second.id]);
    worker.mockResolvedValue([]);
    for (const selected of selections) await f.manager.items(selected, userId, 'complete');
    const internal = f.manager as unknown as {
      cleanReadDirectory(directory: string): Promise<void>;
    };
    vi.spyOn(internal, 'cleanReadDirectory').mockRejectedValueOnce(new Error('fixture denial'));
    await expect(release()).rejects.toThrow('cleanup failed');
    expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toHaveLength(1);
    await expect(f.manager.items(selections[0]!, userId, 'complete')).rejects.toThrow(
      'cleanup failed',
    );
    expect(worker).toHaveBeenCalledTimes(2);
    await f.manager[retry]();
    expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
  },
);

it('handles idle cleanup rejection without an unhandled promise or further plaintext accumulation', async () => {
  const f = await fixture();
  await f.complete();
  const selected = await f.manager.select(userId, f.settings, 'fixture-emby-server');
  worker.mockResolvedValue([]);
  vi.useFakeTimers();
  await f.manager.items(selected, userId, 'complete');
  const internal = f.manager as unknown as { cleanReadDirectory(directory: string): Promise<void> };
  vi.spyOn(internal, 'cleanReadDirectory').mockRejectedValueOnce(new Error('fixture denial'));
  await vi.advanceTimersByTimeAsync(60_000);
  vi.useRealTimers();
  await vi.waitFor(async () =>
    expect((await f.manager.status()).last_error).toContain('cleanup failed'),
  );
  await expect(f.manager.items(selected, userId, 'complete')).rejects.toThrow('cleanup failed');
  expect(worker).toHaveBeenCalledOnce();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toHaveLength(1);
  await f.manager.clear();
  expect((await readdir(f.shared)).filter((name) => name.startsWith('read-'))).toEqual([]);
  expect((await f.manager.status()).last_error).toBeNull();
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

it('uses the file-copy method for daily scheduled captures without repeating the daily attempt', async () => {
  vi.setSystemTime(new Date('2026-10-09T03:30:00Z'));
  const f = await fixture();
  await f.heartbeat(new Date().toISOString(), SNAPSHOT_VERSION, 'file_copy');
  const config = (await f.manager.status()).config;
  await f.manager.configure({ ...config, enabled: true, expected_revision: config.revision });
  await f.tick();
  const request = await f.pendingRequest();
  expect(request.capture_method).toBe('file_copy');
  await f.finish(request);
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  expect(await f.manager.status()).toMatchObject({
    capture_method: 'file_copy',
    records: [{ source_type: 'file_copy' }],
  });
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

it('owns the shared helper throughout asynchronous identity lookup and releases it only after completion', async () => {
  const imports = new ImportCoordinator();
  const f = await fixture(false, imports);
  await f.heartbeat();
  let release!: (value: { Id: string; Version: string }) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.client.systemInfo.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const request = f.manager.refresh();
  await started;
  expect((await f.manager.status()).running).toBe(true);
  expect(imports.acquire('jellyfin:synthetic-other-import')).toBe(false);
  await expect(f.manager.refresh()).rejects.toThrow('already running');
  release({ Id: 'fixture-emby-server', Version: SNAPSHOT_VERSION });
  await request;
  expect(imports.busy).toBe(true);
  await f.finish(await f.pendingRequest());
  expect(imports.busy).toBe(false);
  expect((await f.manager.status()).last_outcome).toBe('succeeded');
});

it('records a failed scheduled start once and retains its schedule/outcome through restart', async () => {
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
  const imports = new ImportCoordinator();
  const f = await fixture(false, imports);
  const config = (await f.manager.status()).config;
  const saved = await f.manager.configure({
    ...config,
    enabled: true,
    expected_revision: config.revision,
  });
  vi.setSystemTime(new Date('2026-10-09T03:20:00Z'));
  await f.tick();
  expect(await f.manager.status()).toMatchObject({
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
  expect((await f.manager.status()).config).toEqual(saved.config);
});

it('reports interrupted source preparation across restart without adopting or replaying any work', async () => {
  const f = await fixture();
  const good = await f.complete();
  const row = f.store.db.prepare('SELECT encrypted FROM source_snapshot_state WHERE id=1').get()!;
  const state = f.store.decrypt<Record<string, unknown>>(row.encrypted as Uint8Array);
  state.last_outcome = 'running';
  state.last_finished_at = null;
  f.store.db
    .prepare('UPDATE source_snapshot_state SET encrypted=? WHERE id=1')
    .run(f.store.encrypt(state));
  await f.restart();
  expect(await f.manager.status()).toMatchObject({
    running: false,
    last_outcome: 'interrupted',
    records: [{ id: good.id, finished_at: good.finished_at }],
  });
  expect(f.factory).toHaveBeenCalledOnce();
});

it('treats a manual capture spanning its scheduled occurrence as the one daily attempt', async () => {
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
  const f = await fixture();
  const config = (await f.manager.status()).config;
  const saved = await f.manager.configure({
    ...config,
    enabled: true,
    expected_revision: config.revision,
  });
  vi.setSystemTime(new Date('2026-10-09T02:59:00Z'));
  const request = await f.request();
  vi.setSystemTime(new Date('2026-10-09T03:01:00Z'));
  await f.heartbeat();
  await f.finish(request);
  await f.tick();
  expect(f.factory).toHaveBeenCalledOnce();
  expect((await f.manager.status()).config).toEqual(saved.config);
  expect((await f.manager.status()).next_run_at).toBe('2026-10-10T03:00:00.000Z');
});

it('skips a nonexistent spring-forward wall-clock time in the actual scheduler', async () => {
  vi.setSystemTime(new Date('2026-03-08T05:00:00Z'));
  const f = await fixture();
  const config = (await f.manager.status()).config;
  await f.manager.configure({
    ...config,
    enabled: true,
    hour: 2,
    minute: 30,
    time_zone: 'America/New_York',
    expected_revision: config.revision,
  });
  vi.setSystemTime(new Date('2026-03-08T07:00:00Z'));
  await f.heartbeat();
  await f.tick();
  expect(f.factory).not.toHaveBeenCalled();
  expect((await f.manager.status()).next_run_at).toBe('2026-03-09T06:30:00.000Z');
});
