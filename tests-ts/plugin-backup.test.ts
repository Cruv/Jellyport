import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  importPluginBackup,
  PLUGIN_BACKUP_MAX_AGE_MS,
  PLUGIN_BACKUP_SETTLE_MS,
} from '../server/plugin-backup.js';
import { readSnapshotItems } from '../server/emby-snapshot-reader.js';
import { MAX_SNAPSHOT_BYTES } from '../server/snapshot-files.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const GUID = '00112233445566778899aabbccddeeff';
const SERVER = 'ffeeddccbbaa99887766554433221100';
const SECRET = 'synthetic-private-password-never-published';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function settled(path: string) {
  const date = new Date(NOW - PLUGIN_BACKUP_SETTLE_MS - 60_000);
  await utimes(path, date, date);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-plugin-backup-test-'));
  directories.push(directory);
  const root = join(directory, 'backups'),
    full = join(root, 'embyserver-backup-full'),
    data = join(full, 'data'),
    work = join(directory, 'work'),
    output = join(work, 'projection.db');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  const schema = await readFile(
    new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url),
    'utf8',
  );
  const library = new DatabaseSync(join(data, 'library.db'));
  try {
    library.exec(schema.slice(0, schema.indexOf('CREATE TABLE LocalUsersv2')));
    library.exec(`
      INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (1,'movie-fixture');
      INSERT INTO MediaItems(Id,type,Name,Path,ProviderIds,UserDataKeyId) VALUES (1,5,'Movie','/media/movie.mkv','Tmdb=42',1);
      INSERT INTO UserDatas(UserDataKeyId,userId,played,playCount,isFavorite,HideFromResume,playbackPositionTicks,LastPlayedDateInt,RatingLastModified,PlaystateLastModified)
        VALUES (1,1,1,9,1,0,123000,1791374400,0,0);
    `);
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
  const manifest = {
    ServerVersion: '4.10.1.0',
    PluginVersion: '1.8.7.0',
    CanRestore: true,
    IsFullBackup: true,
    DateCreated: '2026-10-15T10:00:00.1234567Z',
    Users: [{ Name: 'Synthetic User', Id: GUID }],
  };
  await writeFile(join(full, 'backupinfo.json'), JSON.stringify(manifest));
  await writeFile(join(data, 'device.txt'), `\uFEFF${SERVER}\n`);
  await writeFile(join(data, 'authentication.db'), SECRET);
  await mkdir(join(full, 'config'));
  await writeFile(join(full, 'config', 'system.xml'), SECRET);
  for (const path of ['backupinfo.json', 'data/device.txt', 'data/library.db', 'data/users.db'])
    await settled(join(full, path));
  return { directory, root, full, data, work, output, manifest };
}
async function changeManifest(
  value: Awaited<ReturnType<typeof fixture>>,
  patch: Record<string, unknown>,
) {
  await writeFile(
    join(value.full, 'backupinfo.json'),
    JSON.stringify({ ...value.manifest, ...patch }),
  );
  await settled(join(value.full, 'backupinfo.json'));
}
async function hash(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function reject(
  value: Awaited<ReturnType<typeof fixture>>,
  options: Parameters<typeof importPluginBackup>[3] = {},
) {
  await expect(
    importPluginBackup(value.root, value.output, SERVER, { now: NOW, ...options }),
  ).rejects.toThrow(
    'The Emby plugin backup could not be validated. The last good capture is preserved.',
  );
  expect(await readdir(value.work)).toEqual([]);
  await absent(value.output);
}

describe('Emby Backup & Restore completed full-backup imports', () => {
  it('reads only the fixed full-backup allowlist, preserves history and publishes a private sanitized projection', async () => {
    const value = await fixture(),
      before = await hash(join(value.data, 'library.db'));
    const copied: string[] = [];
    const result = await importPluginBackup(value.root, value.output, SERVER, {
      now: NOW,
      copied: async (name) => {
        copied.push(name);
        const temporary = (await readdir(value.work)).find((name) =>
          name.startsWith('plugin-backup-'),
        )!;
        expect((await lstat(join(value.work, temporary))).mode & 0o777).toBe(0o700);
        expect(await readdir(join(value.work, temporary))).not.toContain('authentication.db');
      },
    });
    expect(copied).toEqual([
      'backupinfo.json',
      'data/device.txt',
      'data/library.db',
      'data/users.db',
    ]);
    expect(result).toMatchObject({
      schema: 'emby-4.10.1.0',
      item_count: 1,
      identities: { [GUID]: 1 },
      backup_created_at: '2026-10-15T10:00:00.123Z',
      plugin_version: '1.8.7.0',
    });
    expect(result.backup_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBe((await lstat(value.output)).size);
    expect((await lstat(value.output)).mode & 0o777).toBe(0o600);
    expect(await hash(join(value.data, 'library.db'))).toBe(before);
    expect((await readFile(value.output)).includes(Buffer.from(SECRET))).toBe(false);
    expect(readSnapshotItems(value.output, GUID, result.identities)[0]?.UserData).toMatchObject({
      Played: true,
      PlayCount: 9,
      IsFavorite: true,
      PlaybackPositionTicks: 123000,
      LastPlayedDate: new Date(1791374400 * 1000).toISOString(),
    });
    expect(await readdir(value.work)).toEqual(['projection.db']);
    const database = new DatabaseSync(value.output, { readOnly: true });
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
    const second = await importPluginBackup(value.root, join(value.work, 'second.db'), SERVER, {
      now: NOW,
    });
    expect(second.backup_fingerprint).toBe(result.backup_fingerprint);
  });

  it.each([
    { ServerVersion: '4.10.2.0' },
    { PluginVersion: '1.8.8.0' },
    { CanRestore: false },
    { IsFullBackup: false },
    { Users: [] },
    { Users: [{ Name: 'Other', Id: SERVER }] },
    {
      Users: [
        { Name: 'One', Id: GUID },
        { Name: 'Duplicate', Id: GUID },
      ],
    },
    { Users: [{ Name: 'Bad', Id: '../escape' }] },
    { DateCreated: 'not a date' },
    { DateCreated: '2026-02-30T10:00:00Z' },
    { DateCreated: new Date(NOW - PLUGIN_BACKUP_MAX_AGE_MS - 1).toISOString() },
    { DateCreated: new Date(NOW + PLUGIN_BACKUP_SETTLE_MS + 1).toISOString() },
  ])('rejects unsupported/incomplete/invalid identity and age metadata %j', async (patch) => {
    const value = await fixture();
    await changeManifest(value, patch);
    await reject(value);
  });

  it('rejects a mismatched server binding without copying databases', async () => {
    const value = await fixture();
    await writeFile(join(value.data, 'device.txt'), GUID);
    await settled(join(value.data, 'device.txt'));
    const copied: string[] = [];
    await reject(value, {
      copied: (name) => {
        copied.push(name);
      },
    });
    expect(copied).toEqual([]);
  });

  it('allows at most one minute of backup clock skew, independently of the five-minute file settle period', async () => {
    const value = await fixture();
    await changeManifest(value, { DateCreated: new Date(NOW + 30_000).toISOString() });
    const result = await importPluginBackup(value.root, value.output, SERVER, { now: NOW });
    expect(result.backup_created_at).toBe(new Date(NOW + 30_000).toISOString());
    await rm(value.output);
    await changeManifest(value, { DateCreated: new Date(NOW + 2 * 60_000).toISOString() });
    const copied: string[] = [];
    await reject(value, {
      copied: (name) => {
        copied.push(name);
      },
    });
    expect(copied).toEqual([]);
  });

  it('requires canonical data/device.txt and does not trust a top-level lookalike', async () => {
    const value = await fixture();
    await rename(join(value.data, 'device.txt'), join(value.full, 'device.txt'));
    await reject(value);
  });

  it.each(['backupinfo.json', 'data/device.txt', 'data/library.db', 'data/users.db'])(
    'rejects an unsettled %s',
    async (name) => {
      const value = await fixture();
      const date = new Date(NOW - PLUGIN_BACKUP_SETTLE_MS + 60_000);
      await utimes(join(value.full, name), date, date);
      await reject(value);
    },
  );

  it.each([
    'library.db-wal',
    'users.db-wal',
    'library.db-shm',
    'users.db-shm',
    'library.db-journal',
    'users.db-journal',
  ])('rejects a %s sidecar even when empty', async (name) => {
    const value = await fixture();
    await writeFile(join(value.data, name), '');
    await reject(value);
  });

  it.each(['full', 'data', 'database', 'manifest', 'device'])(
    'rejects a symlinked %s path',
    async (kind) => {
      const value = await fixture();
      const path =
        kind === 'full'
          ? value.full
          : kind === 'data'
            ? value.data
            : join(
                value.full,
                kind === 'database'
                  ? 'data/library.db'
                  : kind === 'device'
                    ? 'data/device.txt'
                    : 'backupinfo.json',
              );
      await rename(path, `${path}.original`);
      await symlink(`${path}.original`, path);
      await reject(value);
    },
  );

  it.each([
    'manifest',
    'same-length-database',
    'replaced-database',
    'sidecar',
    'removed-user-database',
  ])('rejects %s mutation during copying and removes private raw copies', async (kind) => {
    const value = await fixture();
    await reject(value, {
      copied: async (name) => {
        if (name !== 'data/library.db') return;
        if (kind === 'manifest')
          await writeFile(
            join(value.full, 'backupinfo.json'),
            JSON.stringify({ ...value.manifest, DateCreated: '2026-10-15T11:00:00Z' }),
          );
        if (kind === 'same-length-database') {
          const path = join(value.data, 'library.db');
          const bytes = await readFile(path);
          await writeFile(path, bytes);
          await settled(path);
        }
        if (kind === 'replaced-database') {
          const path = join(value.data, 'library.db');
          await rename(path, `${path}.old`);
          await writeFile(path, await readFile(`${path}.old`));
          await settled(path);
        }
        if (kind === 'sidecar') await writeFile(join(value.data, 'library.db-wal'), '');
        if (kind === 'removed-user-database') await rm(join(value.data, 'users.db'));
      },
    });
  });

  it.each(['library.db', 'users.db'])(
    'rejects corrupt %s with a fixed safe error',
    async (name) => {
      const value = await fixture();
      await writeFile(join(value.data, name), SECRET);
      await settled(join(value.data, name));
      await reject(value);
    },
  );

  it('enforces combined size and metadata limits before copying and never raises ceilings', async () => {
    const value = await fixture();
    const copied: string[] = [];
    for (const maxBytes of [1, 0, MAX_SNAPSHOT_BYTES + 1, Number.NaN])
      await reject(value, {
        maxBytes,
        copied: (name) => {
          copied.push(name);
        },
      });
    expect(copied).toEqual([]);
    await writeFile(join(value.full, 'backupinfo.json'), Buffer.alloc(1024 * 1024 + 1));
    await settled(join(value.full, 'backupinfo.json'));
    await reject(value);
  });

  it('refuses existing outputs and writes inside the source tree without deleting them', async () => {
    const value = await fixture();
    await writeFile(value.output, 'last-good-generation');
    await expect(
      importPluginBackup(value.root, value.output, SERVER, { now: NOW }),
    ).rejects.toThrow();
    expect(await readFile(value.output, 'utf8')).toBe('last-good-generation');
    const path = join(value.full, 'unsafe.db');
    await expect(importPluginBackup(value.root, path, SERVER, { now: NOW })).rejects.toThrow();
    await absent(path);
  });
});
