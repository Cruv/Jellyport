import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { captureFileCopy } from '../server/snapshot-copy.js';
import { MAX_SNAPSHOT_BYTES } from '../server/snapshot-files.js';
import { readSnapshotItems } from '../server/emby-snapshot-reader.js';

const GUID = '00112233445566778899aabbccddeeff';
const GUID_BYTES = Buffer.from('33221100554477668899aabbccddeeff', 'hex');
const privateText = 'synthetic-private-user-password-must-never-be-published';
const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      /* A deliberately corrupted fixture may already be closed. */
    }
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(wal = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-file-copy-test-'));
  directories.push(directory);
  const source = join(directory, 'source'),
    work = join(directory, 'work'),
    output = join(work, 'migration.db');
  await mkdir(source, { mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  const schema = await readFile(
    new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url),
    'utf8',
  );
  const library = new DatabaseSync(join(source, 'library.db'));
  databases.push(library);
  library.exec(schema.slice(0, schema.indexOf('CREATE TABLE LocalUsersv2')));
  library.exec(`
    INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (1,'movie-fixture');
    INSERT INTO MediaItems(Id,type,Name,Path,ProviderIds,UserDataKeyId) VALUES (1,5,'Movie','/media/movie.mkv','Tmdb=42',1);
    INSERT INTO UserDatas(UserDataKeyId,userId,played,playCount,isFavorite,HideFromResume,playbackPositionTicks,RatingLastModified,PlaystateLastModified)
      VALUES (1,1,0,0,0,0,0,0,0);
  `);
  const users = new DatabaseSync(join(source, 'users.db'));
  databases.push(users);
  users.exec(
    'CREATE TABLE LocalUsersv2 (Id INTEGER PRIMARY KEY AUTOINCREMENT,guid BLOB NOT NULL,data TEXT NOT NULL) STRICT;',
  );
  if (wal) {
    for (const database of [library, users])
      database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);',
      );
  }
  users
    .prepare('INSERT INTO LocalUsersv2(Id,guid,data) VALUES (1,?,?)')
    .run(GUID_BYTES, privateText);
  library.exec(
    'UPDATE UserDatas SET played=1,playCount=9,isFavorite=1,LastPlayedDateInt=1791374400 WHERE UserDataKeyId=1 AND userId=1;',
  );
  if (!wal) {
    library.close();
    users.close();
    databases.splice(databases.indexOf(library), 1);
    databases.splice(databases.indexOf(users), 1);
  }
  await writeFile(join(source, 'authentication.db'), privateText);
  await writeFile(join(source, 'device.txt'), 'not-copied-server-identity');
  return { source, work, output, library, users };
}
async function hashes(directory: string) {
  const values: Record<string, string> = {};
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await lstat(path)).isFile())
      values[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
  return values;
}
async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('best-effort ordinary Emby database copies', () => {
  it.each([false, true])(
    'validates closed DELETE / live WAL copies (WAL=%s), recovering latest captured commits and sanitizing output',
    async (wal) => {
      const value = await fixture(wal),
        before = await hashes(value.source),
        copied: string[] = [];
      const result = await captureFileCopy(value.source, value.output, {
        copied: (name) => {
          copied.push(name);
        },
      });
      expect(result).toMatchObject({
        schema: 'emby-4.10.1.0',
        identities: { [GUID]: 1 },
        item_count: 1,
      });
      expect(result.bytes).toBe((await lstat(value.output)).size);
      expect((await lstat(value.output)).mode & 0o777).toBe(0o600);
      expect(copied).toEqual(
        wal
          ? ['library.db', 'library.db-wal', 'users.db', 'users.db-wal']
          : ['library.db', 'users.db'],
      );
      expect(await hashes(value.source)).toEqual(before);
      expect((await readFile(value.output)).includes(Buffer.from(privateText))).toBe(false);
      const item = readSnapshotItems(value.output, GUID, result.identities)[0]!;
      expect(item).toMatchObject({
        Id: '1',
        Type: 'Movie',
        ProviderIds: { Tmdb: '42' },
        UserData: { Played: true, PlayCount: 9, IsFavorite: true },
      });
      const output = new DatabaseSync(value.output, { readOnly: true });
      try {
        expect(
          output
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
            .all()
            .map((row) => row.name),
        ).toEqual(['MediaItems', 'UserDatas']);
        expect(output.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
        expect(output.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      } finally {
        output.close();
      }
      expect(await readdir(value.work)).toEqual(['migration.db']);
    },
  );

  it('uses filesystem reads without acquiring source SQLite locks, even when a source is exclusively locked', async () => {
    const value = await fixture(true);
    value.library.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    const blocked = new DatabaseSync(join(value.source, 'library.db'), {
      readOnly: true,
      timeout: 1,
    });
    try {
      expect(() => blocked.prepare('SELECT count(*) FROM MediaItems').get()).toThrow(/locked/);
    } finally {
      blocked.close();
    }
    const before = await hashes(value.source);
    const result = await captureFileCopy(value.source, value.output);
    expect(readSnapshotItems(value.output, GUID, result.identities)[0]?.UserData?.PlayCount).toBe(
      9,
    );
    expect(await hashes(value.source)).toEqual(before);
    value.library.exec('ROLLBACK;');
  });

  it('bounds each read to its initial prefix while allowing a live WAL append', async () => {
    const value = await fixture(true);
    let advanced = false;
    const result = await captureFileCopy(value.source, value.output, {
      copied: (name) => {
        if (name === 'library.db') {
          value.library.exec('UPDATE UserDatas SET playCount=10 WHERE UserDataKeyId=1;');
          advanced = true;
        }
      },
    });
    expect(advanced).toBe(true);
    expect(value.library.prepare('SELECT playCount FROM UserDatas').get()?.playCount).toBe(10);
    // This mode intentionally cannot promise inclusion of concurrent commits after discovery.
    expect(readSnapshotItems(value.output, GUID, result.identities)[0]?.UserData?.PlayCount).toBe(
      9,
    );
    expect(await readdir(value.work)).toEqual(['migration.db']);
  });

  it.each(['library.db', 'users.db'])(
    'rejects a corrupt %s with only a safe error and removes raw copies',
    async (name) => {
      const value = await fixture();
      await writeFile(join(value.source, name), Buffer.from(`corrupt-${privateText}`));
      await expect(captureFileCopy(value.source, value.output)).rejects.toThrow(
        'The file-copy capture could not be validated. The last good capture is preserved.',
      );
      expect(await readdir(value.work)).toEqual([]);
      await absent(value.output);
    },
  );

  it('never copies or trusts source SHM, authentication databases or unrelated config', async () => {
    const value = await fixture();
    await writeFile(join(value.source, 'library.db-shm'), privateText);
    await writeFile(join(value.source, 'users.db-shm'), privateText);
    const copied: string[] = [],
      before = await hashes(value.source);
    await captureFileCopy(value.source, value.output, {
      copied: async (name) => {
        copied.push(name);
        const pending = (await readdir(value.work)).find((entry) =>
          entry.startsWith('file-copy-'),
        )!;
        expect((await lstat(join(value.work, pending))).mode & 0o777).toBe(0o700);
        expect((await lstat(join(value.work, pending, name))).mode & 0o777).toBe(0o600);
        expect(await readdir(join(value.work, pending))).not.toContain('authentication.db');
        expect(await readdir(join(value.work, pending))).not.toContain('library.db-shm');
        expect(await readdir(join(value.work, pending))).not.toContain('users.db-shm');
      },
    });
    expect(copied).toEqual(['library.db', 'users.db']);
    expect(await hashes(value.source)).toEqual(before);
  });

  it('rejects per-file and cumulative size excess before copying, and cannot raise hard limits', async () => {
    const value = await fixture();
    const copied: string[] = [];
    const sizes = await Promise.all(
      ['library.db', 'users.db'].map(async (name) => (await lstat(join(value.source, name))).size),
    );
    for (const maxBytes of [1, Math.max(...sizes), MAX_SNAPSHOT_BYTES + 1, 0, Number.NaN]) {
      await expect(
        captureFileCopy(value.source, value.output, {
          maxBytes,
          copied: (name) => {
            copied.push(name);
          },
        }),
      ).rejects.toThrow();
      expect(await readdir(value.work)).toEqual([]);
    }
    expect(copied).toEqual([]);
  });

  it.each(['symlink', 'directory'])(
    'rejects a %s in place of an allowlisted source file',
    async (kind) => {
      const value = await fixture();
      const path = join(value.source, 'library.db');
      await rename(path, join(value.source, 'original.db'));
      if (kind === 'symlink') await symlink(join(value.source, 'original.db'), path);
      else await mkdir(path);
      await expect(captureFileCopy(value.source, value.output)).rejects.toThrow();
      expect(await readdir(value.work)).toEqual([]);
    },
  );

  it.each(['missing', 'replaced', 'truncated', 'wal-reset'])(
    'fails without retries when a copied file is %s',
    async (kind) => {
      const value = await fixture(true);
      let changes = 0;
      await expect(
        captureFileCopy(value.source, value.output, {
          copied: async (name) => {
            if (name !== 'library.db-wal') return;
            changes++;
            if (kind === 'missing') await rm(join(value.source, 'users.db-wal'));
            if (kind === 'replaced') {
              const path = join(value.source, 'library.db');
              const data = await readFile(path);
              await rename(path, `${path}.old`);
              await writeFile(path, data);
            }
            if (kind === 'truncated') await truncate(join(value.source, 'library.db'), 1);
            if (kind === 'wal-reset') {
              const path = join(value.source, 'library.db-wal');
              const data = await readFile(path);
              data[16] ^= 1;
              await writeFile(path, data);
            }
          },
        }),
      ).rejects.toThrow();
      expect(changes).toBe(1);
      expect(await readdir(value.work)).toEqual([]);
      await absent(value.output);
    },
  );

  it('rejects a WAL that appears after discovery and a hot rollback journal', async () => {
    for (const journal of [false, true]) {
      const value = await fixture();
      if (journal)
        await writeFile(
          join(value.source, 'library.db-journal'),
          Buffer.from('unrecoverable-private-journal'),
        );
      await expect(
        captureFileCopy(value.source, value.output, {
          copied: async (name) => {
            if (!journal && name === 'library.db')
              await appendFile(join(value.source, 'library.db-wal'), Buffer.alloc(32));
          },
        }),
      ).rejects.toThrow();
      expect(await readdir(value.work)).toEqual([]);
    }
  });

  it('preserves an existing output and rejects writing inside the source tree', async () => {
    const value = await fixture();
    await writeFile(value.output, 'preserve-existing-output');
    await expect(captureFileCopy(value.source, value.output)).rejects.toThrow();
    expect((await readFile(value.output)).toString()).toBe('preserve-existing-output');
    await expect(captureFileCopy(value.source, join(value.source, 'unsafe.db'))).rejects.toThrow();
    await absent(join(value.source, 'unsafe.db'));
    expect(await readdir(value.work)).toEqual(['migration.db']);
  });
});
