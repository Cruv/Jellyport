import { DatabaseSync } from 'node:sqlite';
import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MediaItem, MediaUserDataPatch } from './media.js';
import type { MigrationScope } from './migration.js';
import { ServiceError } from './errors.js';

// Verified against a clean official emby/embyserver:4.10.1.0 instance, with media
// scanned and state written through its API. The capture manifest must separately
// verify the running server version; SQLite does not record an Emby version.
export const EMBY_SNAPSHOT_VERSION = '4.10.1.0';
export interface EmbySnapshotLibraryInfo {
  adapter: 'emby-4.10.1.0';
  item_count: number;
  user_data_count: number;
}
const MAX_USERS = 1_000;
const MAX_LIBRARY_ITEMS = 2_000_000;
const MAX_USER_ITEMS = 100_000;
const MAX_USER_BYTES = 32 * 1024 * 1024;
// API-verified Folder rows are excluded by migrationItems' IncludeItemTypes too.
const excludedTypes = new Set([3]);
const itemTypes: Readonly<Record<number, string>> = {
  5: 'Movie',
  6: 'Series',
  7: 'Season',
  8: 'Episode',
  9: 'BoxSet',
  11: 'Audio',
  15: 'MusicVideo',
  18: 'Video',
  20: 'Book',
  25: 'Photo',
  26: 'PhotoAlbum',
};
const playableTypes = new Set([
  'Movie',
  'Episode',
  'Audio',
  'MusicVideo',
  'Video',
  'Book',
  'AudioBook',
  'Trailer',
]);
const providerNames = new Set([
  'imdb',
  'tmdb',
  'themoviedb',
  'tvdb',
  'thetvdb',
  'tvmaze',
  'anidb',
  'anilist',
  'myanimelist',
  'kitsu',
  'tmdbcollection',
  'musicbrainzrecording',
  'musicbrainztrack',
  'musicbrainzreleasetrack',
  'musicbrainzalbum',
  'musicbrainzrelease',
  'musicbrainzreleasegroup',
  'musicbrainzartist',
  'musicbrainzalbumartist',
  'audiodbalbum',
  'audiodbartist',
  'isbn',
  'isbn10',
  'isbn13',
  'googlebooks',
  'comicvine',
]);
const invalid = () =>
  new ServiceError('This Emby database snapshot has an unsupported or invalid format.');

function withDatabase<T>(path: string, read: (database: DatabaseSync) => T): T {
  let database: DatabaseSync | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid();
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');
    return read(database);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw invalid();
  } finally {
    database?.close();
  }
}

function requireTable(
  database: DatabaseSync,
  name: string,
  columns: Record<string, [string, number]>,
): void {
  const table = database
    .prepare('SELECT type,substr(sql,1,65537) AS sql FROM sqlite_master WHERE name=?')
    .get(name);
  if (
    !table ||
    table.type !== 'table' ||
    typeof table.sql !== 'string' ||
    table.sql.length > 65_536 ||
    /CREATE\s+VIRTUAL/i.test(table.sql)
  )
    throw invalid();
  // Names are constants from the adapter, never request input.
  const fields = database.prepare(`PRAGMA table_info(${name})`).all();
  for (const [column, [type, primaryKey]] of Object.entries(columns)) {
    const field = fields.find((value) => value.name === column);
    if (!field || String(field.type).toUpperCase() !== type || field.pk !== primaryKey)
      throw invalid();
  }
}

function validateLibrary(database: DatabaseSync): void {
  requireTable(database, 'MediaItems', {
    Id: ['INTEGER', 1],
    type: ['INT', 0],
    Path: ['TEXT', 0],
    Name: ['TEXT', 0],
    ProviderIds: ['TEXT', 0],
    SeriesId: ['INT', 0],
    IndexNumber: ['INT', 0],
    ParentIndexNumber: ['INT', 0],
    IndexNumberEnd: ['INT', 0],
    RunTimeTicks: ['INTEGER', 0],
    UserDataKeyId: ['INT', 0],
  });
  requireTable(database, 'UserDatas', {
    UserDataKeyId: ['INT', 1],
    userId: ['INT', 2],
    rating: ['REAL', 0],
    played: ['INT', 0],
    playCount: ['INT', 0],
    isFavorite: ['INT', 0],
    playbackPositionTicks: ['INTEGER', 0],
    LastPlayedDateInt: ['INT', 0],
  });
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max)
    throw invalid();
  return result;
}
function flag(value: unknown): boolean {
  return integer(value, 0, 1) === 1;
}
function text(value: unknown, maximum: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    throw invalid();
  return value;
}
function providerIds(value: unknown): Record<string, string> | undefined {
  const encoded = text(value, 16_384);
  if (!encoded) return undefined;
  const entries = encoded.split('|');
  if (entries.length > 64) throw invalid();
  const providers: Record<string, string> = {};
  for (const entry of entries) {
    const equal = entry.indexOf('=');
    if (equal < 1) throw invalid();
    const key = entry.slice(0, equal),
      id = entry.slice(equal + 1);
    if (key.length > 64 || id.length > 512 || !id) throw invalid();
    if (!providerNames.has(key.toLowerCase())) continue;
    if (Object.hasOwn(providers, key) && providers[key] !== id) throw invalid();
    providers[key] = id;
  }
  return Object.keys(providers).length ? providers : undefined;
}

/** Reads only the two identity columns; password/configuration JSON is never selected. */
export function readUserIdentities(path: string): Record<string, number> {
  return withDatabase(path, (database) => {
    requireTable(database, 'LocalUsersv2', { Id: ['INTEGER', 1], guid: ['BLOB', 0] });
    const query = database.prepare('SELECT Id,substr(guid,1,17) AS guid FROM LocalUsersv2 LIMIT ?');
    query.setReadBigInts(true);
    const identities: Record<string, number> = {};
    let count = 0;
    for (const row of query.iterate(MAX_USERS + 1)) {
      if (++count > MAX_USERS || !(row.guid instanceof Uint8Array) || row.guid.length !== 16)
        throw invalid();
      const bytes = Buffer.from(row.guid);
      // .NET Guid.ToByteArray reverses the first 4, 2, and 2 byte fields.
      const guid = Buffer.concat([
        Buffer.from(bytes.subarray(0, 4)).reverse(),
        Buffer.from(bytes.subarray(4, 6)).reverse(),
        Buffer.from(bytes.subarray(6, 8)).reverse(),
        bytes.subarray(8),
      ]).toString('hex');
      if (Object.hasOwn(identities, guid)) throw invalid();
      identities[guid] = integer(row.Id, 1);
    }
    return identities;
  });
}

export function inspectLibrary(path: string): EmbySnapshotLibraryInfo {
  return withDatabase(path, (database) => {
    validateLibrary(database);
    const items = integer(
      database.prepare('SELECT count(*) AS count FROM MediaItems').get()!.count,
      0,
      MAX_LIBRARY_ITEMS,
    );
    const userData = integer(
      database.prepare('SELECT count(*) AS count FROM UserDatas').get()!.count,
    );
    return { adapter: 'emby-4.10.1.0', item_count: items, user_data_count: userData };
  });
}

/** Projects one completed private backup into the only tables/columns used by this adapter. */
export function projectLibrary(rawPath: string, outputPath: string): void {
  if (resolve(rawPath) === resolve(outputPath)) throw invalid();
  inspectLibrary(rawPath);
  let database: DatabaseSync | undefined;
  let created = false;
  try {
    writeFileSync(outputPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    created = true;
    database = new DatabaseSync(outputPath, { allowExtension: false });
    database.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA page_size=4096; PRAGMA max_page_count=2097152;',
    );
    database.prepare('ATTACH DATABASE ? AS captured').run(rawPath);
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE MediaItems (
        Id INTEGER PRIMARY KEY, type INT NOT NULL, Path TEXT, Name TEXT,
        ProviderIds TEXT, SeriesId INT, IndexNumber INT, ParentIndexNumber INT,
        IndexNumberEnd INT, RunTimeTicks INTEGER, UserDataKeyId INT
      ) STRICT;
      CREATE TABLE UserDatas (
        UserDataKeyId INT NOT NULL, userId INT NOT NULL, rating REAL, played INT NOT NULL,
        playCount INT NOT NULL, isFavorite INT NOT NULL, playbackPositionTicks INTEGER NOT NULL,
        LastPlayedDateInt INT, PRIMARY KEY (UserDataKeyId,userId)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO MediaItems
        SELECT Id,type,Path,Name,ProviderIds,SeriesId,IndexNumber,ParentIndexNumber,
          IndexNumberEnd,RunTimeTicks,UserDataKeyId FROM captured.MediaItems;
      INSERT INTO UserDatas
        SELECT UserDataKeyId,userId,rating,played,playCount,isFavorite,
          playbackPositionTicks,LastPlayedDateInt FROM captured.UserDatas;
      CREATE INDEX JellyportMediaUserDataKey ON MediaItems(UserDataKeyId);
      CREATE INDEX JellyportUserDataUser ON UserDatas(userId,UserDataKeyId);
      COMMIT;
    `);
    database.close();
    database = undefined;
    inspectLibrary(outputPath);
  } catch (error) {
    database?.close();
    if (created) {
      rmSync(outputPath, { force: true });
      rmSync(`${outputPath}-journal`, { force: true });
    }
    if (error instanceof ServiceError) throw error;
    throw invalid();
  }
}

/** Works on an isolated completed library backup, never Emby's live database path. */
export function readSnapshotItems(
  path: string,
  publicUserId: string,
  identities: Record<string, number>,
  scope: MigrationScope = 'complete',
  limits: { maxItems?: number; maxBytes?: number } = {},
): MediaItem[] {
  if (!['complete', 'watched_only'].includes(scope))
    throw new ServiceError('Choose a valid migration scope.');
  if (
    !/^[a-f0-9]{32}$/i.test(publicUserId) ||
    !Object.hasOwn(identities, publicUserId.toLowerCase())
  )
    throw new ServiceError(
      'This Emby account is not present in the database capture. Refresh the snapshot.',
    );
  const userId = integer(identities[publicUserId.toLowerCase()], 1);
  // Callers/tests can lower resource ceilings; neither ceiling can be raised.
  const maxItems = integer(limits.maxItems ?? MAX_USER_ITEMS, 1, MAX_USER_ITEMS);
  const maxBytes = integer(limits.maxBytes ?? MAX_USER_BYTES, 1, MAX_USER_BYTES);
  return withDatabase(path, (database) => {
    validateLibrary(database);
    const query = database.prepare(`
      SELECT m.Id,m.type,substr(m.Path,1,8193) AS Path,substr(m.Name,1,1025) AS Name,
        substr(m.ProviderIds,1,16385) AS ProviderIds,m.SeriesId,m.IndexNumber,
        m.ParentIndexNumber,m.IndexNumberEnd,m.RunTimeTicks,
        substr(s.ProviderIds,1,16385) AS SeriesProviderIds,
        ud.played,ud.playCount,ud.isFavorite,ud.playbackPositionTicks,ud.LastPlayedDateInt,ud.rating
      FROM UserDatas ud JOIN MediaItems m ON m.UserDataKeyId=ud.UserDataKeyId
      LEFT JOIN MediaItems s ON s.Id=m.SeriesId AND s.type=6
      WHERE ud.userId=? AND ${scope === 'watched_only' ? 'ud.played=1' : '(ud.played=1 OR ud.playCount>0 OR ud.isFavorite=1 OR ud.playbackPositionTicks>0 OR ud.LastPlayedDateInt IS NOT NULL OR ud.rating IS NOT NULL)'}
      ORDER BY m.Id LIMIT ?`);
    query.setReadBigInts(true);
    const items: MediaItem[] = [];
    let bytes = 2; // JSON array brackets; reserve commas as items are appended.
    let rows = 0;
    for (const row of query.iterate(userId, maxItems + 1)) {
      if (++rows > maxItems)
        throw new ServiceError('This Emby snapshot exceeds the supported per-user history size.');
      const typeCode = integer(row.type);
      if (excludedTypes.has(typeCode)) continue;
      const type = itemTypes[typeCode];
      if (!type)
        throw new ServiceError(
          'This Emby snapshot contains personal state for an unsupported media type. Use a live migration for this account.',
        );
      if (scope === 'watched_only' && !playableTypes.has(type)) continue;
      const data: MediaUserDataPatch = { Played: flag(row.played) };
      if (scope === 'complete') {
        data.PlayCount = integer(row.playCount, 0, 2_147_483_647);
        data.IsFavorite = flag(row.isFavorite);
        data.PlaybackPositionTicks = integer(row.playbackPositionTicks);
        if (row.rating !== null) {
          if (
            typeof row.rating !== 'number' ||
            !Number.isFinite(row.rating) ||
            row.rating < 0 ||
            row.rating > 10
          )
            throw invalid();
          data.Rating = row.rating;
        }
      }
      if (row.LastPlayedDateInt !== null) {
        const seconds = integer(row.LastPlayedDateInt, 0, 253_402_300_799);
        data.LastPlayedDate = new Date(seconds * 1000).toISOString();
      }
      const item: MediaItem = { Id: String(integer(row.Id, 1)), Type: type, UserData: data };
      const name = text(row.Name, 1_024),
        path = text(row.Path, 8_192);
      if (name !== undefined) item.Name = name;
      if (path !== undefined) item.Path = path;
      const providers = providerIds(row.ProviderIds),
        seriesProviders = providerIds(row.SeriesProviderIds);
      if (providers) item.ProviderIds = providers;
      if (seriesProviders) item.SeriesProviderIds = seriesProviders;
      if (row.SeriesId !== null) item.SeriesId = String(integer(row.SeriesId, 1));
      for (const key of ['IndexNumber', 'ParentIndexNumber', 'IndexNumberEnd', 'RunTimeTicks'])
        if (row[key] !== null) item[key] = integer(row[key]);
      bytes += Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
      if (bytes > maxBytes)
        throw new ServiceError('This Emby snapshot exceeds the supported per-user history size.');
      items.push(item);
    }
    return items;
  });
}
