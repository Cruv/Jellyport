import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBY_SNAPSHOT_VERSION,
  inspectLibrary,
  projectLibrary,
  readSnapshotItems,
  readUserIdentities,
} from '../server/emby-snapshot-reader.js';

// Values compared with API output from a clean official Emby 4.10.1.0 server.
// The original users.db password/configuration data and authentication.db are
// deliberately absent from these fixtures.
const alice = '51b10a51a1064e538a0aef64703aaa86';
const bob = '76aba1734e2f4dbe835acb9ab915d386';
const identities = { [alice]: 2, [bob]: 3 };
const schema = readFileSync(
  new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url),
  'utf8',
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-offline-reader-'));
  directories.push(directory);
  const path = join(directory, 'library.db');
  const database = new DatabaseSync(path);
  database.exec(schema);
  const item = (Id: number, type: number, key: number, fields: Record<string, unknown> = {}) => {
    database
      .prepare('INSERT OR IGNORE INTO UserDataKeys2(Id,UserDataKey) VALUES (?,?)')
      .run(key, String(key));
    const row = {
      Id,
      type,
      UserDataKeyId: key,
      Name: 'Synthetic media',
      Path: `/media/${Id}`,
      ...fields,
    };
    const names = Object.keys(row);
    database
      .prepare(
        `INSERT INTO MediaItems(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      )
      .run(...(Object.values(row) as (string | number | null)[]));
  };
  const state = (key: number, user: number, fields: Record<string, unknown> = {}) => {
    const row = {
      UserDataKeyId: key,
      userId: user,
      rating: null,
      played: 0,
      playCount: 0,
      isFavorite: 0,
      HideFromResume: 0,
      playbackPositionTicks: 0,
      LastPlayedDateInt: null,
      RatingLastModified: 0,
      PlaystateLastModified: 0,
      ...fields,
    };
    const names = Object.keys(row);
    database
      .prepare(
        `INSERT INTO UserDatas(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      )
      .run(...(Object.values(row) as (string | number | null | bigint)[]));
  };
  item(10, 5, 8, {
    Name: 'Synthetic Movie',
    ProviderIds: 'Tmdb=987654321|Imdb=tt999999991',
    RunTimeTicks: 20_000_000,
  });
  item(11, 6, 13, { Name: 'Synthetic Show', ProviderIds: 'Tvdb=987654323|Tmdb=987654324' });
  item(12, 7, 14, { Name: 'Season 1', SeriesId: 11, IndexNumber: 1 });
  item(13, 8, 15, {
    Name: 'Synthetic Pilot',
    ProviderIds: 'Tvdb=987654325',
    SeriesId: 11,
    ParentIndexNumber: 1,
    IndexNumber: 1,
  });
  state(8, 2, {
    played: 1,
    playCount: 7,
    isFavorite: 1,
    playbackPositionTicks: 123_456_789,
    LastPlayedDateInt: 1_738_555_506,
  });
  state(8, 3, {
    played: 0,
    playCount: 3,
    playbackPositionTicks: 456_789_012,
    LastPlayedDateInt: 1_772_600_767,
  });
  state(13, 2, { isFavorite: 1 });
  state(15, 2, { played: 1, playCount: 2, LastPlayedDateInt: 1_717_747_750 });
  database
    .prepare('INSERT INTO LocalUsersv2(Id,guid,data) VALUES (?,?,?)')
    .run(
      2,
      Buffer.from('510ab15106a1534e8a0aef64703aaa86', 'hex'),
      '{"Password":"fixture-secret","unexpected":"private"}',
    );
  database
    .prepare('INSERT INTO LocalUsersv2(Id,guid,data) VALUES (?,?,?)')
    .run(
      3,
      Buffer.from('73a1ab762f4ebe4d835acb9ab915d386', 'hex'),
      'deliberately invalid JSON: no password parsing permitted',
    );
  return { directory, path, database, item, state };
}

describe('verified Emby 4.10.1.0 offline history reader', () => {
  it('maps .NET GUID blobs to public API IDs without reading secret user JSON', () => {
    const f = fixture();
    f.database.close();
    expect(readUserIdentities(f.path)).toEqual(identities);
    expect(JSON.stringify(readUserIdentities(f.path))).not.toMatch(
      /Password|fixture-secret|unexpected|private/,
    );
  });

  it('inspects the version-specific schema and returns only counts', () => {
    const f = fixture();
    f.database.close();
    expect(EMBY_SNAPSHOT_VERSION).toBe('4.10.1.0');
    expect(inspectLibrary(f.path)).toEqual({
      adapter: 'emby-4.10.1.0',
      item_count: 4,
      user_data_count: 4,
    });
  });

  it('reproduces API-verified identity and history fields while isolating users', () => {
    const f = fixture();
    f.database.close();
    const items = readSnapshotItems(f.path, alice, identities);
    expect(items.map((item) => item.Id)).toEqual(['10', '11', '13']);
    expect(items[0]).toMatchObject({
      Id: '10',
      Type: 'Movie',
      ProviderIds: { Tmdb: '987654321', Imdb: 'tt999999991' },
      UserData: {
        Played: true,
        PlayCount: 7,
        IsFavorite: true,
        PlaybackPositionTicks: 123_456_789,
        LastPlayedDate: '2025-02-03T04:05:06.000Z',
      },
    });
    expect(items[1]).toMatchObject({ Type: 'Series', UserData: { IsFavorite: true } });
    expect(items[2]).toMatchObject({
      Type: 'Episode',
      IndexNumber: 1,
      ParentIndexNumber: 1,
      SeriesId: '11',
      SeriesProviderIds: { Tvdb: '987654323', Tmdb: '987654324' },
      UserData: { LastPlayedDate: '2024-06-07T08:09:10.000Z' },
    });
    expect(readSnapshotItems(f.path, bob, identities)).toMatchObject([
      {
        Id: '10',
        UserData: {
          Played: false,
          IsFavorite: false,
          PlayCount: 3,
          PlaybackPositionTicks: 456_789_012,
          LastPlayedDate: '2026-03-04T05:06:07.000Z',
        },
      },
    ]);
  });

  it('projects watched-only playable state and original dates without excluded fields', () => {
    const f = fixture();
    f.state(13, 3, { played: 1 }); // Derived container flags must not become watched item writes.
    f.database.close();
    expect(
      readSnapshotItems(f.path, alice, identities, 'watched_only').map((item) => item.UserData),
    ).toEqual([
      { Played: true, LastPlayedDate: '2025-02-03T04:05:06.000Z' },
      { Played: true, LastPlayedDate: '2024-06-07T08:09:10.000Z' },
    ]);
    expect(readSnapshotItems(f.path, bob, identities, 'watched_only')).toEqual([]);
  });

  it('preserves edition rows sharing one data key and includes verified media kinds', () => {
    const f = fixture();
    f.item(40, 5, 8, { Path: '/media/alternate-edition.mkv' });
    for (const [code, type] of [
      [9, 'BoxSet'],
      [11, 'Audio'],
      [15, 'MusicVideo'],
      [18, 'Video'],
      [20, 'Book'],
      [25, 'Photo'],
      [26, 'PhotoAlbum'],
    ] as const) {
      f.item(100 + code, code, 100 + code);
      f.state(100 + code, 2, { isFavorite: 1 });
    }
    f.database.close();
    const items = readSnapshotItems(f.path, alice, identities);
    expect(items.filter((item) => item.Type === 'Movie').map((item) => item.Id)).toEqual([
      '10',
      '40',
    ]);
    expect(items.map((item) => item.Type)).toEqual(
      expect.arrayContaining([
        'BoxSet',
        'Audio',
        'MusicVideo',
        'Video',
        'Book',
        'Photo',
        'PhotoAlbum',
      ]),
    );
  });

  it('never projects arbitrary database fields, unknown provider keys or auth-like values', () => {
    const f = fixture();
    f.database
      .prepare('UPDATE MediaItems SET Overview=?,Images=?,ProviderIds=? WHERE Id=10')
      .run(
        'private-overview',
        'private-image-object',
        'Tmdb=987654321|ApiToken=private-provider-token|__proto__=private-prototype',
      );
    f.database.close();
    const result = readSnapshotItems(f.path, alice, identities);
    expect(result[0]!.ProviderIds).toEqual({ Tmdb: '987654321' });
    expect(JSON.stringify(result)).not.toMatch(
      /private-|Overview|Images|ApiToken|__proto__|HideFromResume|RatingLastModified/,
    );
  });

  it('projects history into two minimal tables while excluding raw configuration/auth data', () => {
    const f = fixture();
    f.database.exec(`
      CREATE TABLE NamedValues(Value TEXT); INSERT INTO NamedValues VALUES ('private-server-configuration');
      CREATE TABLE ItemExtradata(Value TEXT); INSERT INTO ItemExtradata VALUES ('private-extradata');
      CREATE TABLE SyncTargets2(Value TEXT); INSERT INTO SyncTargets2 VALUES ('private-sync-password');
      CREATE TABLE SyncJobs2(Value TEXT); INSERT INTO SyncJobs2 VALUES ('private-sync-settings');
      UPDATE MediaItems SET Overview='private-overview',Images='private-image-path';
    `);
    f.database.close();
    const target = join(f.directory, 'projected.db');
    const expected = readSnapshotItems(f.path, alice, identities);
    projectLibrary(f.path, target);
    expect(inspectLibrary(target)).toEqual(inspectLibrary(f.path));
    expect(readSnapshotItems(target, alice, identities)).toEqual(expected);
    const projected = new DatabaseSync(target, { readOnly: true });
    expect(
      projected
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(['MediaItems', 'UserDatas']);
    expect(
      projected
        .prepare('PRAGMA table_info(MediaItems)')
        .all()
        .map((row) => row.name),
    ).toEqual([
      'Id',
      'type',
      'Path',
      'Name',
      'ProviderIds',
      'SeriesId',
      'IndexNumber',
      'ParentIndexNumber',
      'IndexNumberEnd',
      'RunTimeTicks',
      'UserDataKeyId',
    ]);
    expect(
      projected
        .prepare('PRAGMA table_info(UserDatas)')
        .all()
        .map((row) => row.name),
    ).toEqual([
      'UserDataKeyId',
      'userId',
      'rating',
      'played',
      'playCount',
      'isFavorite',
      'playbackPositionTicks',
      'LastPlayedDateInt',
    ]);
    expect(
      projected
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(['JellyportMediaUserDataKey', 'JellyportUserDataUser']));
    projected.close();
    expect(readFileSync(target).includes(Buffer.from('private-'))).toBe(false);
  });

  it('creates projected output exclusively and leaves sources or existing files intact', () => {
    const f = fixture();
    f.database.close();
    const before = readFileSync(f.path);
    expect(() => projectLibrary(f.path, f.path)).toThrow('invalid format');
    const existing = join(f.directory, 'existing.db');
    writeFileSync(existing, 'private-existing-file');
    expect(() => projectLibrary(f.path, existing)).toThrow('invalid format');
    expect(readFileSync(existing, 'utf8')).toBe('private-existing-file');
    expect(readFileSync(f.path)).toEqual(before);
  });

  it.each(['complete', 'watched_only'] as const)(
    'fails closed for unverified types carrying personal state in %s mode',
    (scope) => {
      const f = fixture();
      f.item(90, 999, 90);
      f.state(90, 2, { played: 1 });
      f.database.close();
      expect(() => readSnapshotItems(f.path, alice, identities, scope)).toThrow(
        'unsupported media type',
      );
    },
  );

  it('excludes verified Folder state consistently with the live migration catalog filter', () => {
    const f = fixture();
    f.item(99, 3, 99);
    f.state(99, 2, { played: 1, isFavorite: 1 });
    f.database.close();
    expect(readSnapshotItems(f.path, alice, identities).map((item) => item.Id)).toEqual([
      '10',
      '11',
      '13',
    ]);
    expect(
      readSnapshotItems(f.path, alice, identities, 'watched_only').map((item) => item.Id),
    ).toEqual(['10', '13']);
  });

  it('rejects unknown users, invalid scopes and attempts to raise resource ceilings', () => {
    const f = fixture();
    f.database.close();
    expect(() => readSnapshotItems(f.path, '0'.repeat(32), identities)).toThrow('not present');
    expect(() => readSnapshotItems(f.path, alice, { [alice]: 0 })).toThrow('invalid format');
    expect(() => readSnapshotItems(f.path, alice, identities, 'all' as 'complete')).toThrow(
      'valid migration scope',
    );
    expect(() =>
      readSnapshotItems(f.path, alice, identities, 'complete', { maxItems: 100_001 }),
    ).toThrow('invalid format');
    expect(() =>
      readSnapshotItems(f.path, alice, identities, 'complete', { maxBytes: 32 * 1024 * 1024 + 1 }),
    ).toThrow('invalid format');
  });

  it('enforces per-user row and exact serialized byte budgets without returning partial data', () => {
    const f = fixture();
    f.database.close();
    expect(() => readSnapshotItems(f.path, alice, identities, 'complete', { maxItems: 2 })).toThrow(
      'history size',
    );
    const items = readSnapshotItems(f.path, alice, identities);
    const exactBytes = Buffer.byteLength(JSON.stringify(items));
    expect(
      readSnapshotItems(f.path, alice, identities, 'complete', { maxBytes: exactBytes }),
    ).toEqual(items);
    expect(() =>
      readSnapshotItems(f.path, alice, identities, 'complete', { maxBytes: exactBytes - 1 }),
    ).toThrow('history size');
  });

  it.each([
    'UPDATE UserDatas SET played=2 WHERE UserDataKeyId=8 AND userId=2',
    'UPDATE UserDatas SET LastPlayedDateInt=-1 WHERE UserDataKeyId=8 AND userId=2',
    'UPDATE UserDatas SET playbackPositionTicks=9223372036854775807 WHERE UserDataKeyId=8 AND userId=2',
    "UPDATE MediaItems SET ProviderIds='Tmdb=a|Tmdb=b' WHERE Id=10",
    "UPDATE MediaItems SET Name=printf('%01025d',0) WHERE Id=10",
  ])('rejects malformed normalized fields: %s', (sql) => {
    const f = fixture();
    f.database.exec(sql);
    f.database.close();
    expect(() => readSnapshotItems(f.path, alice, identities)).toThrow('invalid format');
  });

  it('refuses schema replacements and never creates missing database paths', () => {
    const f = fixture();
    f.database.exec('DROP TABLE UserDatas; CREATE VIEW UserDatas AS SELECT 1;');
    f.database.close();
    expect(() => inspectLibrary(f.path)).toThrow('invalid format');
    expect(() => inspectLibrary(join(f.directory, 'missing.db'))).toThrow('invalid format');
  });

  it('refuses symlinks and hides invalid file details', () => {
    const f = fixture();
    f.database.close();
    const link = join(f.directory, 'link.db');
    symlinkSync(f.path, link);
    expect(() => inspectLibrary(link)).toThrow('invalid format');
    writeFileSync(f.path, 'private-file-content');
    expect(() => inspectLibrary(f.path)).toThrow('invalid format');
  });

  it('rejects duplicate GUIDs, invalid blobs and excessive user identities', () => {
    const f = fixture();
    f.database.exec(
      'INSERT INTO LocalUsersv2(guid,data) SELECT guid,data FROM LocalUsersv2 WHERE Id=2',
    );
    expect(() => readUserIdentities(f.path)).toThrow('invalid format');
    f.database.exec(
      "DELETE FROM LocalUsersv2 WHERE Id>3; UPDATE LocalUsersv2 SET guid=x'00' WHERE Id=2",
    );
    expect(() => readUserIdentities(f.path)).toThrow('invalid format');
    f.database.exec(
      "DELETE FROM LocalUsersv2; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO LocalUsersv2(guid,data) SELECT randomblob(16),'private' FROM n",
    );
    expect(() => readUserIdentities(f.path)).toThrow('invalid format');
    f.database.close();
  });
});
