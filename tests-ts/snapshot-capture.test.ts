import { afterEach, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  decryptDatabase,
  encryptDatabase,
  readEnvelope,
  seal,
  snapshotKey,
  unseal,
  writeEnvelope,
} from '../server/snapshot-files.js';
import { snapshotProcess } from '../server/snapshot-process.js';
import { readSnapshotItems } from '../server/emby-snapshot-reader.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'jellyport-capture-fixture-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it('authenticates encrypted capture messages and uses a fresh nonce for identical metadata', () => {
  const key = randomBytes(32);
  const metadata = {
    id: randomUUID(),
    source_user_id: 'private-fixture-user',
    source_username: 'private-fixture-name',
  };
  const first = seal(metadata, key);
  const second = seal(metadata, key);
  expect(unseal(first, key)).toEqual(metadata);
  expect(unseal(second, key)).toEqual(metadata);
  expect(first.equals(second)).toBe(false);
  expect(first.includes(Buffer.from(metadata.source_username))).toBe(false);
  expect(() => unseal(first, randomBytes(32))).toThrow();
  for (const offset of [0, 12, 28, first.length - 1]) {
    const corrupt = Buffer.from(first);
    corrupt[offset] ^= 1;
    expect(() => unseal(corrupt, key)).toThrow();
  }
  expect(() => unseal(first.subarray(0, 27), key)).toThrow('Invalid snapshot envelope.');
});

it('keeps helper message files and their key private without replacing an existing key', async () => {
  const path = await directory();
  const key = await snapshotKey(path, true);
  expect(key).toHaveLength(32);
  expect(await snapshotKey(path, true)).toEqual(key);
  expect(await snapshotKey(path)).toEqual(key);
  const messagePath = join(path, `${randomUUID()}.request`);
  const metadata = { id: randomUUID(), private: 'private-fixture-content' };
  await writeEnvelope(messagePath, metadata, key);
  expect(await readEnvelope(messagePath, key)).toEqual(metadata);
  expect((await readFile(messagePath)).includes(Buffer.from(metadata.private))).toBe(false);
  expect((await stat(join(path, 'snapshot.key'))).mode & 0o777).toBe(0o600);
  expect((await stat(messagePath)).mode & 0o777).toBe(0o600);
});

it('rejects symlinked keys, invalid key lengths, symlinked messages and oversized metadata', async () => {
  const path = await directory();
  const keyPath = join(path, 'snapshot.key');
  const target = join(path, 'fixture-target');
  await writeFile(target, randomBytes(32));
  await symlink(target, keyPath);
  await expect(snapshotKey(path, true)).rejects.toThrow('Expected a regular snapshot file.');
  await rm(keyPath);
  await writeFile(keyPath, randomBytes(31));
  await expect(snapshotKey(path)).rejects.toThrow('Invalid snapshot encryption key.');
  const key = randomBytes(32);
  const messagePath = join(path, 'fixture-message');
  await symlink(target, messagePath);
  await expect(readEnvelope(messagePath, key)).rejects.toThrow('Expected a regular snapshot file.');
  await rm(messagePath);
  await writeFile(messagePath, Buffer.alloc(1024 * 1024 + 1));
  await expect(readEnvelope(messagePath, key)).rejects.toThrow(
    'Snapshot metadata exceeds its limit.',
  );
});

it('streams encrypted database bytes and binds authentication to the approved generation', async () => {
  const path = await directory();
  const source = join(path, 'fixture-library.db');
  const encrypted = join(path, 'fixture-library.enc');
  const restored = join(path, 'fixture-restored.db');
  const content = Buffer.concat([Buffer.from('private-library-fixture'), randomBytes(256 * 1024)]);
  await writeFile(source, content);
  const key = randomBytes(32);
  const id = randomUUID();
  await encryptDatabase(source, encrypted, key, id);
  const ciphertext = await readFile(encrypted);
  expect(ciphertext.length).toBe(content.length + 28);
  expect(ciphertext.includes(Buffer.from('private-library-fixture'))).toBe(false);
  expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
  await decryptDatabase(encrypted, restored, key, id);
  expect(await readFile(restored)).toEqual(content);
  expect((await stat(restored)).mode & 0o777).toBe(0o600);
  await expect(
    decryptDatabase(encrypted, join(path, 'wrong-id.db'), key, randomUUID()),
  ).rejects.toThrow();
  await expect(stat(join(path, 'wrong-id.db'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    decryptDatabase(encrypted, join(path, 'wrong-key.db'), randomBytes(32), id),
  ).rejects.toThrow();
  await expect(stat(join(path, 'wrong-key.db'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects corrupted database contents and preserves an existing destination', async () => {
  const path = await directory();
  const source = join(path, 'fixture-library.db');
  const encrypted = join(path, 'fixture-library.enc');
  const target = join(path, 'fixture-target.db');
  await writeFile(source, Buffer.from('synthetic-database-content'));
  const key = randomBytes(32);
  const id = randomUUID();
  await encryptDatabase(source, encrypted, key, id);
  const corrupt = await readFile(encrypted);
  corrupt[12] ^= 1;
  await writeFile(encrypted, corrupt);
  await expect(decryptDatabase(encrypted, target, key, id)).rejects.toThrow();
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(target, { force: true });
  await writeFile(target, Buffer.from('preserve-existing-target'));
  await expect(decryptDatabase(encrypted, target, key, id)).rejects.toThrow();
  expect((await readFile(target)).toString()).toBe('preserve-existing-target');
  await expect(encryptDatabase(source, encrypted, key, id)).rejects.toThrow();
  expect(await readFile(encrypted)).toEqual(corrupt);
});

it('kills and reaps a worker when its deadline expires rather than leaving native work running', async () => {
  await expect(
    snapshotProcess({ operation: 'unused-fixture-operation' }, undefined, 1),
  ).rejects.toThrow('Snapshot operation exceeded its time limit.');
});

it('honors both an already-aborted signal and cancellation immediately after worker launch', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(snapshotProcess({}, alreadyAborted.signal)).rejects.toThrow(
    'Snapshot operation was canceled.',
  );
  const controller = new AbortController();
  const pending = snapshotProcess({}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('Snapshot operation was canceled.');
});

it('sanitizes worker failures without returning source paths or database content', async () => {
  const privatePath = join(await directory(), 'private-user-name.db');
  let rejected: unknown;
  try {
    await snapshotProcess({
      operation: 'read',
      path: privatePath,
      user_id: 'private-user',
      identities: {},
      scope: 'complete',
    });
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(Error);
  expect((rejected as Error).message).not.toMatch(/private-user|capture-fixture|\/Users|\/var\//);
});

it('captures a consistent local WAL view while writes continue and publishes only migration tables', async () => {
  const path = await directory();
  const sourcePath = join(path, 'library.db');
  const outputPath = join(path, 'migration-projection.db');
  const source = new DatabaseSync(sourcePath);
  let writer: ReturnType<typeof setInterval> | undefined;
  let writes = 0;
  const writerErrors: unknown[] = [];
  const userId = '51b10a51a1064e538a0aef64703aaa86';
  try {
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    source.exec(
      await readFile(new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url), 'utf8'),
    );
    source.exec(`
      INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (8,'fixture-movie');
      INSERT INTO MediaItems(Id,type,Name,Path,ProviderIds,Overview,UserDataKeyId)
        VALUES (10,5,'Synthetic Movie','/media/synthetic.mkv','Tmdb=987654321',
          'private-unused-overview',8);
      INSERT INTO UserDatas(UserDataKeyId,userId,rating,played,playCount,isFavorite,
        HideFromResume,playbackPositionTicks,LastPlayedDateInt,RatingLastModified,PlaystateLastModified)
        VALUES (8,2,8,1,7,1,0,123456789,1738555506,0,0);
      CREATE TABLE CaptureNoise(counter INTEGER NOT NULL,secret TEXT NOT NULL,payload BLOB NOT NULL);
      INSERT INTO CaptureNoise VALUES (0,'private-nonmigration-integration-secret',zeroblob(5242880));
    `);
    const users = new DatabaseSync(join(path, 'users.db'));
    try {
      users.exec(
        'CREATE TABLE LocalUsersv2(Id INTEGER PRIMARY KEY AUTOINCREMENT,guid BLOB NOT NULL) STRICT;',
      );
      users
        .prepare('INSERT INTO LocalUsersv2(Id,guid) VALUES (?,?)')
        .run(2, Buffer.from('510ab15106a1534e8a0aef64703aaa86', 'hex'));
    } finally {
      users.close();
    }
    // This initial checkpoint belongs only to the synthetic fixture. Keep all later
    // writes in WAL so hashing the main file detects an unwanted source checkpoint.
    source.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const beforeMainHash = createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex');
    expect((await stat(sourcePath)).size).toBeGreaterThan(5 * 1024 * 1024);
    const updateCounter = source.prepare('UPDATE CaptureNoise SET counter=?');
    const updateHistory = source.prepare('UPDATE UserDatas SET playCount=? WHERE userId=2');
    writer = setInterval(() => {
      if (writerErrors.length) return;
      try {
        const next = writes + 1;
        source.exec('BEGIN IMMEDIATE');
        updateCounter.run(next);
        updateHistory.run(7 + next);
        source.exec('COMMIT');
        writes = next;
      } catch (error) {
        writerErrors.push(error);
        if (source.isTransaction) source.exec('ROLLBACK');
      }
    }, 3);
    const capture = await snapshotProcess<{
      identities: Record<string, number>;
      schema: string;
      bytes: number;
      item_count: number;
    }>({ operation: 'capture', directory: path, output: outputPath });
    const writesAtCompletion = writes;
    clearInterval(writer);
    writer = undefined;
    expect(writerErrors).toEqual([]);
    expect(writesAtCompletion).toBeGreaterThan(2);
    expect(capture).toMatchObject({
      identities: { [userId]: 2 },
      schema: 'emby-4.10.1.0',
      item_count: 1,
    });
    expect(capture.bytes).toBeLessThan(100 * 1024);
    const items = readSnapshotItems(outputPath, userId, capture.identities);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      Id: '10',
      Type: 'Movie',
      Name: 'Synthetic Movie',
      ProviderIds: { Tmdb: '987654321' },
      UserData: {
        Played: true,
        IsFavorite: true,
        Rating: 8,
        PlaybackPositionTicks: 123456789,
        LastPlayedDate: '2025-02-03T04:05:06.000Z',
      },
    });
    // The copied counter belongs to one earlier read view while the source keeps
    // accepting commits after that view is pinned, rather than forcing writer idle.
    expect(items[0]!.UserData!.PlayCount).toBeGreaterThanOrEqual(7);
    expect(items[0]!.UserData!.PlayCount).toBeLessThan(7 + writesAtCompletion);
    const projected = new DatabaseSync(outputPath, { readOnly: true });
    try {
      expect(
        projected.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
      ).toEqual([{ name: 'MediaItems' }, { name: 'UserDatas' }]);
      expect(
        projected
          .prepare('PRAGMA table_info(MediaItems)')
          .all()
          .map((row) => row.name),
      ).not.toContain('Overview');
    } finally {
      projected.close();
    }
    expect(
      (await readFile(outputPath)).includes(Buffer.from('private-nonmigration-integration-secret')),
    ).toBe(false);
    expect((await readFile(outputPath)).includes(Buffer.from('private-unused-overview'))).toBe(
      false,
    );
    expect(source.prepare('SELECT counter FROM CaptureNoise').get()?.counter).toBe(
      writesAtCompletion,
    );
    expect(source.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(source.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint).toBe(0);
    expect(
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex'),
    ).toBe(beforeMainHash);
  } finally {
    clearInterval(writer);
    source.close();
  }
});
