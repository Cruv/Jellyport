import { afterEach, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  decryptDatabase,
  readEnvelope,
  snapshotKey,
  writeEnvelope,
  type CaptureRequest,
  type CaptureResult,
} from '../server/snapshot-files.js';
import { snapshotProcess } from '../server/snapshot-process.js';
import type { SnapshotHistoryResult } from '../server/emby-snapshot-reader.js';

const GUID = '00112233445566778899aabbccddeeff';
const NEW_USER = '112233445566778899aabbccddeeff00';
const SERVER = 'ffeeddccbbaa99887766554433221100';
const SECRET = 'synthetic-authentication-configuration-password-must-never-be-published';
const directories: string[] = [];
const helpers: { child: ChildProcess; closed: Promise<number | null> }[] = [];

async function stopHelper(helper: (typeof helpers)[number]): Promise<number | null> {
  if (helper.child.exitCode === null && helper.child.signalCode === null)
    helper.child.kill('SIGTERM');
  const timer = setTimeout(() => helper.child.kill('SIGKILL'), 2_000);
  try {
    return await helper.closed;
  } finally {
    clearTimeout(timer);
  }
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(helpers.splice(0).map(stopHelper));
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function waitFor<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await read();
    } catch {
      await delay(20);
    }
  }
  throw new Error('The synthetic helper did not complete within its bounded test deadline.');
}
async function hash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

it('captures a synthetic plugin backup through the real helper, encrypted exchange and worker history reader without network access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-plugin-helper-test-'));
  directories.push(directory);
  const backups = join(directory, 'backups'),
    full = join(backups, 'embyserver-backup-full'),
    data = join(full, 'data'),
    exchange = join(directory, 'exchange'),
    work = join(directory, 'work');
  for (const path of [data, exchange, work]) await mkdir(path, { recursive: true, mode: 0o700 });
  const schema = await readFile(
    new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url),
    'utf8',
  );
  const library = new DatabaseSync(join(data, 'library.db'));
  try {
    library.exec(schema.slice(0, schema.indexOf('CREATE TABLE LocalUsersv2')));
    library.exec(`
      INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (1,'movie-one'),(2,'movie-two'),(3,'unsupported'),(4,'orphan');
      INSERT INTO MediaItems(Id,type,Name,Path,ProviderIds,UserDataKeyId) VALUES
        (1,5,'First Movie','/media/one.mkv','Tmdb=42',1),
        (2,5,'Second' || char(10) || 'Movie','/media/two.mkv','Tmdb=43',2),
        (3,99,'Unsupported','/media/unknown','Tmdb=44',3);
      INSERT INTO UserDatas(UserDataKeyId,userId,played,playCount,isFavorite,HideFromResume,playbackPositionTicks,LastPlayedDateInt,RatingLastModified,PlaystateLastModified) VALUES
        (1,1,1,9,1,0,123000,1791374400,0,0),
        (2,1,0,2,1,0,-1,1791374401,0,0),
        (3,1,1,1,0,0,0,1791374402,0,0),
        (4,1,1,1,0,0,0,1791374403,0,0);
      CREATE TABLE PrivateIntegrationData(value TEXT);
    `);
    library.prepare('INSERT INTO PrivateIntegrationData VALUES (?)').run(SECRET);
  } finally {
    library.close();
  }
  const users = new DatabaseSync(join(data, 'users.db'));
  try {
    users.exec(
      'CREATE TABLE LocalUsersv2 (Id INTEGER PRIMARY KEY AUTOINCREMENT,guid BLOB NOT NULL,data TEXT NOT NULL) STRICT;',
    );
    users
      .prepare('INSERT INTO LocalUsersv2(Id,guid,data) VALUES (1,?,?)')
      .run(Buffer.from('33221100554477668899aabbccddeeff', 'hex'), SECRET);
  } finally {
    users.close();
  }
  const created = new Date(Date.now() - 60 * 60_000).toISOString();
  await writeFile(
    join(full, 'backupinfo.json'),
    JSON.stringify({
      ServerVersion: '4.10.1.0',
      PluginVersion: '1.8.7.0',
      CanRestore: true,
      IsFullBackup: true,
      DateCreated: created,
      Users: [{ Name: 'Synthetic Account', Id: GUID }],
    }),
  );
  await writeFile(join(data, 'device.txt'), `\uFEFF${SERVER}\n`);
  await writeFile(join(data, 'authentication.db'), SECRET);
  await mkdir(join(full, 'config'));
  await writeFile(join(full, 'config', 'system.xml'), SECRET);
  const settled = new Date(Date.now() - 6 * 60_000);
  for (const path of ['backupinfo.json', 'data/device.txt', 'data/library.db', 'data/users.db'])
    await utimes(join(full, path), settled, settled);
  const originalLibrary = await hash(join(data, 'library.db')),
    originalUsers = await hash(join(data, 'users.db'));

  // The guard is inherited by the nested capture worker through NODE_OPTIONS.
  // It records attempts even if application code catches a resulting exception.
  const marker = join(directory, 'network-attempt'),
    guard = join(directory, 'deny-network.mjs');
  await writeFile(
    guard,
    `import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const denied = () => { appendFileSync(${JSON.stringify(marker)}, 'attempt\\n'); throw new Error('Network access is prohibited in this synthetic helper test.'); };
globalThis.fetch = denied;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  // tsx uses local Unix-domain IPC sockets. Those are not media-server requests.
  if (options && typeof options === 'object' && typeof options.path === 'string' && options.port === undefined && options.host === undefined)
    return connect.apply(this, args);
  return denied();
};
http.request = denied; http.get = denied;
https.request = denied; https.get = denied;
for (const name of Object.keys(dns))
  if (name === 'lookup' || name.startsWith('resolve') || name === 'reverse') dns[name] = denied;
for (const name of Object.keys(dns.promises))
  if (name === 'lookup' || name.startsWith('resolve') || name === 'reverse') dns.promises[name] = denied;
dgram.Socket.prototype.send = denied;
syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  const key = await snapshotKey(exchange, true);
  const request: CaptureRequest = {
    id: randomUUID(),
    requested_at: new Date().toISOString(),
    binding: { url: 'http://emby.invalid', server_id: SERVER, version: '4.10.1.0' },
    // A completed backup may legitimately predate a newly created live user.
    user_ids: [GUID, NEW_USER],
    capture_method: 'plugin_backup',
  };
  const wrongMethod: CaptureRequest = {
    ...request,
    id: randomUUID(),
    capture_method: 'file_copy',
  };
  for (const value of [request, wrongMethod])
    await writeEnvelope(join(exchange, `${value.id}.request`), value, key);
  expect(
    (await readFile(join(exchange, `${request.id}.request`))).includes(Buffer.from(GUID)),
  ).toBe(false);

  let stderr = '';
  const child = fork(fileURLToPath(new URL('../server/snapshot-helper.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
      JELLYPORT_SNAPSHOT_DIR: exchange,
      JELLYPORT_SNAPSHOT_WORK_DIR: work,
      JELLYPORT_SNAPSHOT_METHOD: 'plugin_backup',
      JELLYPORT_EMBY_BACKUP_DIR: backups,
      JELLYPORT_EMBY_DATA_DIR: join(directory, 'live-source-does-not-exist'),
      JELLYPORT_EMBY_VERSION: '4.10.1.0',
    },
  });
  child.stderr?.on('data', (bytes: Buffer) => {
    // Bounded diagnostics are synthetic only and never include real backup data.
    stderr = (stderr + bytes.toString()).slice(-4096);
  });
  const helper = {
    child,
    closed: new Promise<number | null>((resolve, reject) => {
      child.once('close', (code) => resolve(code));
      child.once('error', reject);
    }),
  };
  helpers.push(helper);
  const status = await waitFor(() =>
    readEnvelope<{ capture_method: string }>(join(exchange, 'helper.status'), key),
  );
  expect(status.capture_method).toBe('plugin_backup');
  const result = await waitFor(() =>
    readEnvelope<CaptureResult>(join(exchange, `${request.id}.result`), key),
  );
  expect(result, stderr).toMatchObject({
    id: request.id,
    ok: true,
    capture_method: 'plugin_backup',
    identities: { [GUID]: 1 },
    backup_created_at: created,
    plugin_version: '1.8.7.0',
    schema: 'emby-4.10.1.0',
    item_count: 3,
  });
  expect(result.identities).not.toHaveProperty(NEW_USER);
  expect(result.backup_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const rejected = await waitFor(() =>
    readEnvelope<CaptureResult>(join(exchange, `${wrongMethod.id}.result`), key),
  );
  expect(rejected).toMatchObject({ ok: false, capture_method: 'file_copy' });
  await expect(stat(join(exchange, `${wrongMethod.id}.db.enc`))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const encrypted = join(exchange, `${request.id}.db.enc`),
    projection = join(directory, 'decrypted-projection.db');
  expect((await readFile(encrypted)).includes(Buffer.from(SECRET))).toBe(false);
  expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
  await decryptDatabase(encrypted, projection, key, request.id);
  expect((await readFile(projection)).includes(Buffer.from(SECRET))).toBe(false);
  const database = new DatabaseSync(projection, { readOnly: true });
  try {
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(['MediaItems', 'UserDatas']);
  } finally {
    database.close();
  }
  vi.stubEnv('NODE_OPTIONS', `--import=${pathToFileURL(guard).href}`);
  const history = await snapshotProcess<SnapshotHistoryResult>(
    {
      operation: 'read',
      path: projection,
      user_id: GUID,
      identities: result.identities,
      scope: 'complete',
    },
    undefined,
    3_000,
  );
  expect(history.diagnostics).toEqual({
    unsupported_state_items: 1,
    invalid_resume_positions: 1,
    invalid_display_names: 1,
    orphan_state_items: 1,
  });
  expect(history.items).toHaveLength(2);
  expect(history.items[0]?.UserData).toMatchObject({
    Played: true,
    PlayCount: 9,
    IsFavorite: true,
    PlaybackPositionTicks: 123000,
    LastPlayedDate: new Date(1791374400 * 1000).toISOString(),
  });
  expect(history.items[1]?.UserData).toMatchObject({
    Played: false,
    PlayCount: 2,
    IsFavorite: true,
  });
  expect(history.items[1]?.UserData).not.toHaveProperty('PlaybackPositionTicks');
  expect(history.items[1]).not.toHaveProperty('Name');

  expect(await stopHelper(helper), stderr).toBe(0);
  expect(await readdir(work)).toEqual([]);
  expect((await readdir(exchange)).some((name) => /\.(request|working|pending)$/.test(name))).toBe(
    false,
  );
  expect(await hash(join(data, 'library.db'))).toBe(originalLibrary);
  expect(await hash(join(data, 'users.db'))).toBe(originalUsers);
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
}, 10_000);
