import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBY_SNAPSHOT_VERSION,
  inspectLibrary,
  projectLibrary,
  readSnapshotHistory,
  readSnapshotItems,
  readUserIdentities,
  snapshotHistoryWarnings,
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
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(definition = schema) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-offline-reader-'));
  directories.push(directory);
  const path = join(directory, 'library.db');
  const database = new DatabaseSync(path);
  database.exec(definition);
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
  const upgradedSchema = schema
    .replace('RunTimeTicks INTEGER', 'RunTimeTicks BIGINT')
    .replace('rating REAL', 'rating FLOAT')
    .replace('played INT not null', 'played BIT not null')
    .replace('isFavorite INT not null', 'isFavorite BIT not null')
    .replace('playbackPositionTicks INTEGER', 'playbackPositionTicks BIGINT')
    .replace(/guid BLOB/g, 'guid GUID')
    .replace('data TEXT NOT NULL', 'data BLOB NOT NULL')
    .replace(/,\s*PRIMARY KEY \(UserDataKeyId,userId\)/, '')
    .replace(
      ') STRICT, WITHOUT ROWID;',
      '); CREATE UNIQUE INDEX UpgradedUserDataUnique ON UserDatas(UserDataKeyId,userId);',
    )
    .replace(/ STRICT/g, '');

  it('accepts verified upgraded affinity declarations with a complete unique history key', () => {
    const f = fixture(upgradedSchema);
    f.database.close();
    expect(readUserIdentities(f.path)).toEqual(identities);
    expect(inspectLibrary(f.path)).toMatchObject({ item_count: 4, user_data_count: 4 });
    const expected = readSnapshotHistory(f.path, alice, identities);
    expect(expected.items).toHaveLength(3);
    expect(expected.diagnostics).toEqual({
      unsupported_state_items: 0,
      invalid_resume_positions: 0,
      invalid_display_names: 0,
      orphan_state_items: 0,
    });
    const projected = join(f.directory, 'upgraded-projection.db');
    projectLibrary(f.path, projected);
    expect(readSnapshotHistory(projected, alice, identities)).toEqual({
      ...expected,
      diagnostics: { ...expected.diagnostics, recovered_orphan_state_items: 0 },
    });
  });

  it('reads the show name from the existing parent join for episode and season review', () => {
    const f = fixture();
    f.state(14, 2, { played: 1 });
    f.database.close();
    const history = readSnapshotHistory(f.path, alice, identities, 'complete');
    expect(history.items.find((item) => item.Id === '13')).toMatchObject({
      Name: 'Synthetic Pilot',
      SeriesName: 'Synthetic Show',
      ParentIndexNumber: 1,
      IndexNumber: 1,
    });
    expect(history.items.find((item) => item.Id === '12')).toMatchObject({
      Type: 'Season',
      SeriesName: 'Synthetic Show',
      IndexNumber: 1,
    });
  });

  it('omits a malformed parent display name while preserving episode identity and played state', () => {
    const f = fixture();
    f.database.prepare('UPDATE MediaItems SET Name=? WHERE Id=11').run('bad\nshow');
    f.database.close();
    const history = readSnapshotHistory(f.path, alice, identities, 'watched_only');
    const episode = history.items.find((item) => item.Id === '13');
    expect(episode).not.toHaveProperty('SeriesName');
    expect(episode).toMatchObject({
      SeriesProviderIds: { Tvdb: '987654323', Tmdb: '987654324' },
      UserData: { Played: true },
    });
  });

  it.each([
    '',
    'CREATE INDEX InvalidKey ON UserDatas(UserDataKeyId,userId)',
    'CREATE UNIQUE INDEX InvalidKey ON UserDatas(UserDataKeyId,userId) WHERE played=1',
    'CREATE UNIQUE INDEX InvalidKey ON UserDatas(UserDataKeyId,userId,playCount)',
    'CREATE UNIQUE INDEX InvalidKey ON UserDatas(UserDataKeyId,lower(userId))',
  ])('requires a complete unique composite key in upgraded schemas: %s', (replacement) => {
    const f = fixture(upgradedSchema);
    f.database.exec('DROP INDEX UpgradedUserDataUnique');
    if (replacement) f.database.exec(replacement);
    f.database.close();
    expect(() => inspectLibrary(f.path)).toThrow('invalid format');
  });

  it('rejects unverified declarations instead of accepting arbitrary affinity coercion', () => {
    const f = fixture(upgradedSchema.replace('RunTimeTicks BIGINT', 'RunTimeTicks NUMERIC'));
    f.database.close();
    expect(() => inspectLibrary(f.path)).toThrow('invalid format');
  });

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

  it('projects only watched playable flags and matching metadata without excluded fields', () => {
    const f = fixture();
    f.state(13, 3, { played: 1 }); // Derived container flags must not become watched item writes.
    f.database.close();
    expect(
      readSnapshotItems(f.path, alice, identities, 'watched_only').map((item) => item.UserData),
    ).toEqual([{ Played: true }, { Played: true }]);
    expect(readSnapshotItems(f.path, alice, identities, 'watched_only')).toMatchObject([
      { Id: '10', Path: '/media/10', ProviderIds: { Tmdb: '987654321', Imdb: 'tt999999991' } },
      { Id: '13', Type: 'Episode', SeriesProviderIds: { Tvdb: '987654323', Tmdb: '987654324' } },
    ]);
    expect(
      readSnapshotItems(f.path, alice, identities, 'watched_only').every(
        (item) => !Object.hasOwn(item, 'RunTimeTicks'),
      ),
    ).toBe(true);
    expect(readSnapshotItems(f.path, bob, identities, 'watched_only')).toEqual([]);
  });

  it.each([
    ['LastPlayedDateInt', -1],
    ['LastPlayedDateInt', 9_223_372_036_854_775_807n],
    ['playCount', -1],
    ['isFavorite', 2],
    ['playbackPositionTicks', -1],
    ['rating', 11],
  ] as const)('ignores excluded %s=%s while still reading valid played flags', (field, value) => {
    const f = fixture();
    f.database
      .prepare(`UPDATE UserDatas SET ${field}=? WHERE UserDataKeyId=8 AND userId=2`)
      .run(value);
    f.database.close();
    const history = readSnapshotHistory(f.path, alice, identities, 'watched_only');
    expect(history.items.map((item) => item.UserData)).toEqual([
      { Played: true },
      { Played: true },
    ]);
    expect(history.diagnostics.invalid_resume_positions).toBe(0);
    // The complete compatibility reader retains its former validation behavior.
    if (field === 'playbackPositionTicks')
      expect(
        readSnapshotHistory(f.path, alice, identities).diagnostics.invalid_resume_positions,
      ).toBe(1);
    else expect(() => readSnapshotHistory(f.path, alice, identities)).toThrow('invalid format');
  });

  it('does not read or validate runtime when migrating only watched flags', () => {
    const f = fixture();
    f.database.exec('UPDATE MediaItems SET RunTimeTicks=-1 WHERE Id=10');
    f.database.close();
    expect(readSnapshotHistory(f.path, alice, identities, 'watched_only').items[0]).toMatchObject({
      Id: '10',
      UserData: { Played: true },
    });
    expect(() => readSnapshotHistory(f.path, alice, identities)).toThrow('invalid format');
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

  it('projects history into minimal tables while excluding raw keys, GUIDs and configuration/auth data', () => {
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
    expect(inspectLibrary(target)).toEqual({
      ...inspectLibrary(f.path),
      orphan_identity_version: 1,
    });
    expect(readSnapshotItems(target, alice, identities)).toEqual(expected);
    const projected = new DatabaseSync(target, { readOnly: true });
    expect(
      projected
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(['JellyportRecoveredHistory', 'MediaItems', 'UserDatas']);
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

  it('indexes every kind of personal state while omitting empty rows from the lookup index', () => {
    const f = fixture();
    for (const [offset, fields] of [
      { played: 1 },
      { playCount: 2 },
      { isFavorite: 1 },
      { playbackPositionTicks: 123_456 },
      { LastPlayedDateInt: 1_738_555_506 },
      { rating: 0 },
      {},
    ].entries()) {
      f.item(100 + offset, 5, 200 - offset);
      f.state(200 - offset, 2, fields);
    }
    f.database.close();
    const target = join(f.directory, 'indexed-state.db');
    projectLibrary(f.path, target);
    expect(readSnapshotItems(target, alice, identities)).toEqual(
      readSnapshotItems(f.path, alice, identities),
    );
    const ids = readSnapshotItems(target, alice, identities).map((item) => item.Id);
    expect(ids).toEqual(['10', '11', '13', '100', '101', '102', '103', '104', '105']);
    expect(readSnapshotItems(target, alice, identities).at(-1)?.UserData?.Rating).toBe(0);
    const projected = new DatabaseSync(target, { readOnly: true });
    expect(
      projected
        .prepare('PRAGMA index_list(UserDatas)')
        .all()
        .find((row) => row.name === 'JellyportUserDataUser')?.partial,
    ).toBe(1);
    projected.close();
  });

  it.each(['complete', 'watched_only'] as const)(
    'uses indexed per-user lookups without a catalog scan or SQL sort in %s mode',
    (scope) => {
      const f = fixture();
      f.database.close();
      const target = join(f.directory, 'query-plan.db');
      projectLibrary(f.path, target);
      const statements: string[] = [];
      const prepare = DatabaseSync.prototype.prepare;
      const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        statements.push(sql);
        return prepare.call(this, sql);
      });
      readSnapshotItems(target, alice, identities, scope);
      spy.mockRestore();
      const select = statements.find((sql) => sql.includes('FROM UserDatas ud'))!;
      const database = new DatabaseSync(target, { readOnly: true });
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${select}`)
        .all(2, 100_001)
        .map((row) => String(row.detail));
      database.close();
      expect(plan[0]).toMatch(/SEARCH ud USING INDEX JellyportUserDataUser \(userId=\?\)/);
      expect(plan).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/SEARCH m USING INDEX JellyportMediaUserDataKey/),
          expect.stringMatching(/SEARCH s USING INTEGER PRIMARY KEY/),
        ]),
      );
      expect(plan.join('\n')).not.toMatch(/SCAN |TEMP B-TREE/);
      expect(select).not.toMatch(/ORDER BY/i);
    },
  );

  it('keeps previous projections with a full per-user index readable', () => {
    const f = fixture();
    f.database.close();
    const target = join(f.directory, 'previous-generation.db');
    projectLibrary(f.path, target);
    const database = new DatabaseSync(target);
    database.exec(`
      DROP INDEX JellyportUserDataUser;
      CREATE INDEX JellyportUserDataUser ON UserDatas(userId,UserDataKeyId);
    `);
    database.close();
    expect(readSnapshotItems(target, alice, identities)).toEqual(
      readSnapshotItems(f.path, alice, identities),
    );
  });

  it.each(['complete', 'watched_only'] as const)(
    'reports unverified personal-state types while preserving supported history in %s mode',
    (scope) => {
      const f = fixture();
      f.item(90, 999, 90);
      f.state(90, 2, { played: 1 });
      f.database.close();
      const history = readSnapshotHistory(f.path, alice, identities, scope);
      expect(history.items.map((item) => item.Id)).toEqual(
        scope === 'complete' ? ['10', '11', '13'] : ['10', '13'],
      );
      expect(history.diagnostics.unsupported_state_items).toBe(1);
      expect(snapshotHistoryWarnings(history.diagnostics)).toEqual([
        '1 saved history entries use unsupported media types. Their state was not migrated; supported history is preserved.',
      ]);
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
    "UPDATE MediaItems SET ProviderIds='Tmdb=a|Tmdb=b' WHERE Id=10",
  ])('rejects malformed normalized fields: %s', (sql) => {
    const f = fixture();
    f.database.exec(sql);
    f.database.close();
    expect(() => readSnapshotItems(f.path, alice, identities)).toThrow('invalid format');
  });

  it.each([-1n, 9_223_372_036_854_775_807n])(
    'omits an invalid resume position without replacing it with zero or losing other state: %s',
    (position) => {
      const f = fixture();
      f.database
        .prepare('UPDATE UserDatas SET playbackPositionTicks=? WHERE UserDataKeyId=8 AND userId=2')
        .run(position);
      f.database.close();
      const history = readSnapshotHistory(f.path, alice, identities);
      expect(history.items[0]?.UserData).toEqual({
        Played: true,
        PlayCount: 7,
        IsFavorite: true,
        LastPlayedDate: '2025-02-03T04:05:06.000Z',
      });
      expect(history.diagnostics.invalid_resume_positions).toBe(1);
      expect(snapshotHistoryWarnings(history.diagnostics)).toEqual([
        '1 invalid saved resume positions were omitted. Valid watched flags, counts, dates and favorites are preserved.',
      ]);
      expect(
        readSnapshotHistory(f.path, alice, identities, 'watched_only').diagnostics
          .invalid_resume_positions,
      ).toBe(0);
    },
  );

  it.each(['Synthetic\tlabel', 'x'.repeat(1_025)])(
    'omits an invalid display label while retaining reliable matching metadata and history',
    (name) => {
      const f = fixture();
      f.database.prepare('UPDATE MediaItems SET Name=? WHERE Id=10').run(name);
      f.database.close();
      const history = readSnapshotHistory(f.path, alice, identities);
      expect(history.items[0]).not.toHaveProperty('Name');
      expect(history.items[0]).toMatchObject({
        Id: '10',
        Path: '/media/10',
        ProviderIds: { Tmdb: '987654321', Imdb: 'tt999999991' },
        UserData: { Played: true, PlayCount: 7, IsFavorite: true },
      });
      expect(history.diagnostics.invalid_display_names).toBe(1);
      expect(snapshotHistoryWarnings(history.diagnostics)).toEqual([
        '1 invalid saved display names were omitted. Matching still uses media identities and paths.',
      ]);
    },
  );

  it('keeps legacy missing diagnostics quiet and rejects nonnumeric diagnostic output', () => {
    expect(snapshotHistoryWarnings()).toEqual([]);
    expect(() =>
      snapshotHistoryWarnings({ unsupported_state_items: 'private-source' } as never),
    ).toThrow('invalid format');
  });

  it.each(['complete', 'watched_only'] as const)(
    'reports history for removed library items and bounds its indexed lookup in %s mode',
    (scope) => {
      const f = fixture();
      f.database
        .prepare('INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (?,?)')
        .run(900, 'synthetic-removed');
      f.state(900, 2, { played: 1, playCount: 3 });
      f.database.close();
      const projected = join(f.directory, 'orphan-history.db');
      projectLibrary(f.path, projected);
      const history = readSnapshotHistory(projected, alice, identities, scope);
      expect(history.items.map((item) => item.Id)).toEqual(
        scope === 'complete' ? ['10', '11', '13'] : ['10', '13'],
      );
      expect(history.diagnostics.orphan_state_items).toBe(1);
      expect(snapshotHistoryWarnings(history.diagnostics)).toEqual([
        '1 saved history entries have no verified media identity. They remain unresolved and were not assumed obsolete or migrated.',
      ]);
      expect(() =>
        readSnapshotHistory(projected, alice, identities, scope, {
          maxItems: history.items.length,
        }),
      ).toThrow('history size');
      const database = new DatabaseSync(projected, { readOnly: true });
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM UserDatas ud WHERE ud.userId=? AND played=1 AND NOT EXISTS(SELECT 1 FROM MediaItems m WHERE m.UserDataKeyId=ud.UserDataKeyId) LIMIT ?`,
        )
        .all(2, 100001)
        .map((row) => String(row.detail));
      database.close();
      expect(plan.join('\n')).not.toMatch(/SCAN |TEMP B-TREE/);
      expect(plan.join('\n')).toMatch(/JellyportUserDataUser/);
      expect(plan.join('\n')).toMatch(/JellyportMediaUserDataKey/);
    },
  );

  it.each(['complete', 'watched_only'] as const)(
    'recovers only played flags from a verified fallback GUID in %s mode',
    (scope) => {
      const f = fixture();
      f.database
        .prepare('UPDATE MediaItems SET guid=? WHERE Id=10')
        .run(Buffer.from('67452301ab89efcd0123456789abcdef', 'hex'));
      f.database.exec('UPDATE UserDatas SET played=0 WHERE UserDataKeyId=8 AND userId=2');
      f.database
        .prepare('INSERT INTO UserDataKeys2 VALUES (?,?)')
        .run(900, '01234567-89AB-CDEF-0123-456789ABCDEF');
      f.state(900, 2, {
        played: 1,
        playCount: -1,
        rating: 100,
        playbackPositionTicks: -1,
        LastPlayedDateInt: -1,
      });
      f.state(900, 3, { played: 0 });
      f.database.close();
      const projected = join(f.directory, 'recovered.db');
      projectLibrary(f.path, projected);
      const history = readSnapshotHistory(projected, alice, identities, scope);
      expect(history.diagnostics.recovered_orphan_state_items).toBe(1);
      expect(history.diagnostics.orphan_state_items).toBe(0);
      expect(history.items.filter((item) => item.Id === '10')).toHaveLength(1);
      expect(history.items.find((item) => item.Id === '10')?.UserData).toEqual(
        scope === 'watched_only'
          ? { Played: true }
          : {
              Played: true,
              PlayCount: 7,
              IsFavorite: true,
              PlaybackPositionTicks: 123456789,
              LastPlayedDate: '2025-02-03T04:05:06.000Z',
            },
      );
      expect(readSnapshotHistory(projected, bob, identities, 'watched_only').items).toEqual([]);
      expect(snapshotHistoryWarnings(history.diagnostics)).toEqual([]);
    },
  );

  it('preserves verified mappings when reprojecting without publishing native identity material', () => {
    const f = fixture();
    const key = '01234567-89ab-cdef-0123-456789abcdef';
    const guid = Buffer.from('67452301ab89efcd0123456789abcdef', 'hex');
    f.database.prepare('UPDATE MediaItems SET guid=? WHERE Id=10').run(guid);
    f.database.prepare('INSERT INTO UserDataKeys2 VALUES (?,?)').run(900, key);
    f.state(900, 2, { played: 1 });
    f.database.close();
    const first = join(f.directory, 'first.db'),
      second = join(f.directory, 'second.db');
    projectLibrary(f.path, first);
    projectLibrary(first, second);
    expect(inspectLibrary(second)).toEqual(inspectLibrary(first));
    expect(readSnapshotHistory(second, alice, identities, 'watched_only')).toEqual(
      readSnapshotHistory(first, alice, identities, 'watched_only'),
    );
    for (const path of [first, second]) {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        expect(database.prepare('SELECT * FROM JellyportRecoveredHistory').all()).toEqual([
          { UserDataKeyId: 900, ItemId: 10 },
        ]);
      } finally {
        database.close();
      }
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from(key))).toBe(false);
      expect(bytes.includes(guid)).toBe(false);
    }
  });

  it('keeps legacy projections readable without inventing recovery identities', () => {
    const f = fixture();
    f.database.exec('PRAGMA foreign_keys=OFF; DROP TABLE UserDataKeys2;');
    f.state(900, 2, { played: 1 });
    f.database.close();
    const projected = join(f.directory, 'legacy.db');
    projectLibrary(f.path, projected);
    expect(inspectLibrary(projected)).not.toHaveProperty('orphan_identity_version');
    const history = readSnapshotHistory(projected, alice, identities, 'watched_only');
    expect(history.items.map((item) => item.Id)).toEqual(['10', '13']);
    expect(history.diagnostics.orphan_state_items).toBe(1);
    expect(history.diagnostics.recovered_orphan_state_items).toBeUndefined();
  });

  it.each([
    'CREATE VIEW JellyportRecoveredHistory AS SELECT 1 AS UserDataKeyId,10 AS ItemId',
    'CREATE TABLE JellyportRecoveredHistory(UserDataKeyId INTEGER NOT NULL PRIMARY KEY,ItemId INTEGER NOT NULL)',
    'CREATE TABLE JellyportRecoveredHistory(UserDataKeyId INTEGER NOT NULL PRIMARY KEY,ItemId TEXT NOT NULL) STRICT',
    'CREATE TABLE JellyportRecoveredHistory(UserDataKeyId INTEGER NOT NULL PRIMARY KEY,ItemId INTEGER NOT NULL,private TEXT) STRICT',
    'CREATE TABLE JellyportRecoveredHistory(UserDataKeyId INTEGER NOT NULL PRIMARY KEY,ItemId INTEGER) STRICT',
  ])('rejects a partially present or unsupported recovery schema: %s', (sql) => {
    const f = fixture();
    f.database.exec(sql);
    f.database.close();
    expect(() => inspectLibrary(f.path)).toThrow('invalid format');
    expect(() => readSnapshotHistory(f.path, alice, identities, 'watched_only')).toThrow(
      'invalid format',
    );
  });

  it('bounds recovered rows and bytes and uses indexed per-user lookups without catalog scans', () => {
    const f = fixture();
    f.database
      .prepare('UPDATE MediaItems SET guid=? WHERE Id=10')
      .run(Buffer.from('67452301ab89efcd0123456789abcdef', 'hex'));
    f.database.exec('DELETE FROM UserDatas;');
    for (const [id, key] of [
      [900, '0123456789abcdef0123456789abcdef'],
      [901, '0123456789ABCDEF0123456789ABCDEF'],
    ] as const) {
      f.database.prepare('INSERT INTO UserDataKeys2 VALUES (?,?)').run(id, key);
      f.state(id, 2, { played: 1 });
    }
    f.database.close();
    const projected = join(f.directory, 'bounded-recovery.db');
    projectLibrary(f.path, projected);
    expect(() =>
      readSnapshotHistory(projected, alice, identities, 'watched_only', { maxItems: 1 }),
    ).toThrow('history size');
    expect(() =>
      readSnapshotHistory(projected, alice, identities, 'watched_only', { maxBytes: 100 }),
    ).toThrow('history size');
    expect(readSnapshotHistory(projected, alice, identities, 'watched_only').items).toHaveLength(1);
    const database = new DatabaseSync(projected, { readOnly: true });
    try {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT m.Id FROM UserDatas ud
        CROSS JOIN JellyportRecoveredHistory r ON r.UserDataKeyId=ud.UserDataKeyId
        CROSS JOIN MediaItems m ON m.Id=r.ItemId WHERE ud.userId=? AND ud.played=1
        AND NOT EXISTS(SELECT 1 FROM MediaItems native WHERE native.UserDataKeyId=ud.UserDataKeyId) LIMIT ?`,
        )
        .all(2, 100001)
        .map((row) => String(row.detail))
        .join('\n');
      expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
      expect(plan).toMatch(/JellyportUserDataUser/);
      expect(plan).toMatch(/SEARCH r USING INTEGER PRIMARY KEY/);
      expect(plan).toMatch(/SEARCH m USING INTEGER PRIMARY KEY/);
      expect(
        database.prepare('SELECT * FROM JellyportRecoveredHistory ORDER BY UserDataKeyId').all(),
      ).toEqual([
        { UserDataKeyId: 900, ItemId: 10 },
        { UserDataKeyId: 901, ItemId: 10 },
      ]);
    } finally {
      database.close();
    }
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
