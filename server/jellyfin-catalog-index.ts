import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogCandidateKeys, MIGRATABLE_ITEM_TYPES, type PathMapping } from './matching.js';
import {
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ITEMS,
  projectCatalogItem,
  type MediaItem,
} from './media.js';
import { ServiceError } from './errors.js';
import { jellyfinLibraryConfigHash } from './jellyfin-library-membership.js';

const INDEX_VERSION = 2;
const MAX_PROJECTION_ITEMS = 2_000_000;
const MAX_PROJECTION_BYTES = 8 * 1024 ** 3;
const MAX_ITEM_BYTES = 256 * 1024;
const MAX_KEYS_PER_ITEM = 129;
const BATCH = 1000;
const supported = new Set<string>(MIGRATABLE_ITEM_TYPES);
const fields = new Set([
  'Id',
  'Type',
  'Name',
  'Path',
  'ProviderIds',
  'SeriesProviderIds',
  'SeriesId',
  'SeriesName',
  'ProductionYear',
  'IndexNumber',
  'ParentIndexNumber',
  'IndexNumberEnd',
  'RunTimeTicks',
]);
const invalid = () =>
  new ServiceError('The saved Jellyfin matching index is invalid. Import its backup again.');

export interface JellyfinCatalogIndexProgress {
  rows: number;
  keys: number;
  elapsed_ms: number;
}
export interface JellyfinCatalogCandidateProgress {
  keys: number;
  items: number;
  elapsed_ms: number;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ServiceError('Saved Jellyfin catalog preparation was canceled.');
}
function observe<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    /* Observers cannot change catalog correctness. */
  }
}
function databaseAt(path: string, readOnly: boolean): DatabaseSync {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECTION_BYTES) throw invalid();
  const database = new DatabaseSync(path, { readOnly, allowExtension: false, timeout: 250 });
  try {
    // Read-only main databases still allow private disk-backed TEMP lookup tables.
    database.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;',
    );
    database.exec('PRAGMA temp.max_page_count=2097152;');
    if (!readOnly) database.exec('PRAGMA max_page_count=2097152;');
    requireTable(database, 'catalog_items', [
      ['id', 'TEXT', 1],
      ['item', 'TEXT', 0],
    ]);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
function requireTable(
  database: DatabaseSync,
  name: string,
  expected: [string, string, number][],
): void {
  const table = database
    .prepare('SELECT type,substr(sql,1,65537) AS sql FROM sqlite_master WHERE name=?')
    .get(name);
  if (
    !table ||
    table.type !== 'table' ||
    typeof table.sql !== 'string' ||
    table.sql.length > 65536 ||
    /CREATE\s+VIRTUAL/i.test(table.sql) ||
    !/\bSTRICT\s*(?:,\s*WITHOUT\s+ROWID\s*)?$/i.test(table.sql)
  )
    throw invalid();
  // Table names here are module-owned constants, never archive or request text.
  const columns = database.prepare(`PRAGMA table_info(${name})`).all();
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const [field, type, key] = expected[index]!;
      return (
        column.name !== field || column.type !== type || column.pk !== key || column.notnull !== 1
      );
    })
  )
    throw invalid();
}
function itemRow(row: Record<string, unknown>): MediaItem {
  if (
    typeof row.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(row.id) ||
    typeof row.item !== 'string' ||
    Buffer.byteLength(row.item) > MAX_ITEM_BYTES
  )
    throw invalid();
  const value: unknown = JSON.parse(row.item);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.has(field))
  )
    throw invalid();
  const item = projectCatalogItem(value);
  if (
    item.Id !== row.id ||
    !supported.has(item.Type!) ||
    (item.SeriesId !== undefined && !/^[a-f0-9]{32}$/.test(item.SeriesId))
  )
    throw invalid();
  return item;
}
function membershipSchema(database: DatabaseSync): boolean {
  const names = [
    'catalog_membership',
    'catalog_item_roots',
    'catalog_roots',
    'catalog_library_roots',
    'catalog_library_config',
  ];
  const present = names.filter((name) =>
    database.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name),
  );
  if (!present.length) return false; // A persisted v1 projection remains readable without hints.
  if (present.length !== names.length) throw invalid();
  requireTable(database, 'catalog_membership', [['version', 'INTEGER', 1]]);
  requireTable(database, 'catalog_item_roots', [
    ['id', 'TEXT', 1],
    ['root_id', 'TEXT', 0],
  ]);
  requireTable(database, 'catalog_roots', [
    ['id', 'TEXT', 1],
    ['path', 'TEXT', 0],
    ['known', 'INTEGER', 0],
  ]);
  requireTable(database, 'catalog_library_roots', [
    ['library_id', 'TEXT', 1],
    ['root_id', 'TEXT', 2],
  ]);
  requireTable(database, 'catalog_library_config', [
    ['library_id', 'TEXT', 1],
    ['locations', 'TEXT', 0],
  ]);
  const marker = database.prepare('SELECT version FROM catalog_membership LIMIT 2').all();
  if (marker.length !== 1 || marker[0]!.version !== 1) throw invalid();
  return true;
}
function libraryConfigHash(database: DatabaseSync): string {
  if (
    database
      .prepare(
        'SELECT 1 FROM catalog_library_roots l WHERE NOT EXISTS (SELECT 1 FROM catalog_library_config c WHERE c.library_id=l.library_id) LIMIT 1',
      )
      .get()
  )
    throw invalid();
  const entries = database
    .prepare(
      'SELECT library_id,substr(locations,1,1048577) AS locations FROM catalog_library_config ORDER BY library_id LIMIT 1001',
    )
    .all();
  if (entries.length > 1000) throw invalid();
  return jellyfinLibraryConfigHash(
    entries.map((row) => {
      if (
        typeof row.library_id !== 'string' ||
        typeof row.locations !== 'string' ||
        Buffer.byteLength(row.locations) > 1024 * 1024
      )
        throw invalid();
      return { id: row.library_id, locations: JSON.parse(row.locations) as string[] };
    }),
  );
}
function keys(item: MediaItem, mappings: PathMapping[] = [], source = false): string[] {
  const values = catalogCandidateKeys(item, mappings, source);
  if (
    values.length > MAX_KEYS_PER_ITEM ||
    values.some((value) => Buffer.byteLength(value) > MAX_ITEM_BYTES)
  )
    throw invalid();
  return values;
}

/** Builds reusable disk-backed identity keys without materializing the catalog in RAM. */
export async function buildJellyfinCatalogIndex(
  path: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (value: JellyfinCatalogIndexProgress) => void;
  } = {},
): Promise<{ rows: number; keys: number }> {
  let database: DatabaseSync | undefined;
  const started = performance.now();
  try {
    check(options.signal);
    database = databaseAt(path, false);
    const membership = membershipSchema(database);
    if (membership) libraryConfigHash(database);
    database.exec(`BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS catalog_keys;
      DROP TABLE IF EXISTS catalog_index;
      CREATE TABLE catalog_keys(key TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE catalog_index(version INTEGER NOT NULL PRIMARY KEY,rows INTEGER NOT NULL,keys INTEGER NOT NULL) STRICT;
    `);
    const insert = database.prepare('INSERT OR IGNORE INTO catalog_keys(key,id) VALUES (?,?)');
    const query = database.prepare(
      `SELECT id,substr(item,1,${MAX_ITEM_BYTES + 1}) AS item FROM catalog_items ORDER BY id`,
    );
    let rows = 0,
      count = 0;
    for (const row of query.iterate()) {
      check(options.signal);
      if (++rows > MAX_PROJECTION_ITEMS) throw invalid();
      const item = itemRow(row);
      for (const key of keys(item)) count += Number(insert.run(key, item.Id).changes);
      if (rows % BATCH === 0) {
        observe(options.onProgress, { rows, keys: count, elapsed_ms: performance.now() - started });
        check(options.signal);
        await delay(0);
      }
    }
    check(options.signal);
    database
      .prepare('INSERT INTO catalog_index(version,rows,keys) VALUES (?,?,?)')
      .run(membership ? INDEX_VERSION : 1, rows, count);
    database.exec('COMMIT');
    observe(options.onProgress, { rows, keys: count, elapsed_ms: performance.now() - started });
    check(options.signal);
    return { rows, keys: count };
  } catch {
    check(options.signal);
    throw invalid();
  } finally {
    if (database?.isTransaction) database.exec('ROLLBACK');
    database?.close();
  }
}

/** Union every identity candidate before access filtering or matching precedence. */
export async function readJellyfinCatalogCandidates(
  path: string,
  sourceItems: MediaItem[],
  pathMappings: PathMapping[] = [],
  options: {
    signal?: AbortSignal;
    onProgress?: (value: JellyfinCatalogCandidateProgress) => void;
    /** Tests/constrained callers may lower, never raise, account payload limits. */
    maxItems?: number;
    maxBytes?: number;
  } = {},
): Promise<MediaItem[]> {
  let database: DatabaseSync | undefined;
  const started = performance.now();
  let work = 0,
    visitedKeys = 0;
  const items: MediaItem[] = [];
  const advance = async () => {
    check(options.signal);
    if (++work % BATCH === 0) {
      observe(options.onProgress, {
        keys: visitedKeys,
        items: items.length,
        elapsed_ms: performance.now() - started,
      });
      check(options.signal);
      await delay(0);
    }
  };
  try {
    check(options.signal);
    const maximum = options.maxItems ?? MAX_CATALOG_ITEMS,
      bytesMaximum = options.maxBytes ?? MAX_CATALOG_BYTES;
    if (
      !Array.isArray(sourceItems) ||
      sourceItems.length > MAX_CATALOG_ITEMS ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > MAX_CATALOG_ITEMS ||
      !Number.isSafeInteger(bytesMaximum) ||
      bytesMaximum < 1 ||
      bytesMaximum > MAX_CATALOG_BYTES ||
      !Array.isArray(pathMappings) ||
      pathMappings.length > 1000
    )
      throw invalid();
    database = databaseAt(path, true);
    requireTable(database, 'catalog_keys', [
      ['key', 'TEXT', 1],
      ['id', 'TEXT', 2],
    ]);
    requireTable(database, 'catalog_index', [
      ['version', 'INTEGER', 1],
      ['rows', 'INTEGER', 0],
      ['keys', 'INTEGER', 0],
    ]);
    const marker = database.prepare('SELECT version,rows,keys FROM catalog_index LIMIT 2').all();
    if (
      marker.length !== 1 ||
      ![1, INDEX_VERSION].includes(Number(marker[0]!.version)) ||
      !Number.isSafeInteger(marker[0]!.rows) ||
      Number(marker[0]!.rows) < 0 ||
      Number(marker[0]!.rows) > MAX_PROJECTION_ITEMS ||
      !Number.isSafeInteger(marker[0]!.keys) ||
      Number(marker[0]!.keys) < 0 ||
      Number(marker[0]!.keys) > MAX_PROJECTION_ITEMS * MAX_KEYS_PER_ITEM
    )
      throw invalid();
    const membership = marker[0]!.version === INDEX_VERSION;
    if (membership && !membershipSchema(database)) throw invalid();
    const configHash = membership ? libraryConfigHash(database) : undefined;
    const libraryMembership = membership
      ? database.prepare(`
      SELECT r.known,l.library_id FROM catalog_item_roots i
      JOIN catalog_roots r ON r.id=i.root_id
      LEFT JOIN catalog_library_roots l ON l.root_id=r.id
      WHERE i.id=? LIMIT 1001`)
      : undefined;
    database.exec(`CREATE TEMP TABLE requested_keys(key TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID;
      CREATE TEMP TABLE selected_ids(id TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID;
      CREATE TEMP TABLE parent_ids(id TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID;`);
    const request = database.prepare('INSERT OR IGNORE INTO requested_keys(key) VALUES (?)');
    let sourceBytes = 2;
    for (const raw of sourceItems) {
      check(options.signal);
      const item = projectCatalogItem(raw);
      sourceBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
      if (sourceBytes > MAX_CATALOG_BYTES) throw invalid();
      for (const key of keys(item, pathMappings, true)) request.run(key);
      await advance();
    }
    const selected = database.prepare('INSERT OR IGNORE INTO selected_ids(id) VALUES (?)');
    const parents = database.prepare('INSERT OR IGNORE INTO parent_ids(id) VALUES (?)');
    let retainedBytes = 2;
    const retain = (row: Record<string, unknown>, parent = false) => {
      if (typeof row.id !== 'string') throw invalid();
      if (parent && itemRow(row).Type !== 'Series') throw invalid();
      if (!Number(selected.run(row.id).changes)) return;
      const item = itemRow(row);
      if (libraryMembership) {
        const roots = libraryMembership.all(item.Id);
        if (roots.length > 1000 || roots.some((root) => ![0, 1].includes(Number(root.known))))
          throw invalid();
        // Missing/conflicting associations stay unknown. An empty TopParentId
        // alone cannot establish standalone access, ownership or visibility.
        if (
          roots.length &&
          roots.every((root) => root.known === 1 && typeof root.library_id === 'string')
        ) {
          const ids = roots.map((root) => String(root.library_id)).sort();
          if (ids.some((id) => !/^[a-f0-9]{32}$/.test(id))) throw invalid();
          item.JellyportLibraryIds = ids;
          item.JellyportLibraryConfigHash = configHash;
        }
      }
      retainedBytes += Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
      if (items.length >= maximum || retainedBytes > bytesMaximum)
        throw new ServiceError(
          'The saved Jellyfin matching candidates exceed the supported account size.',
        );
      items.push(item);
      if (!parent && item.SeriesId) parents.run(item.SeriesId);
    };
    const candidates = database.prepare(`SELECT c.id,substr(c.item,1,${MAX_ITEM_BYTES + 1}) AS item
      FROM catalog_keys k CROSS JOIN catalog_items c ON c.id=k.id WHERE k.key=?`);
    for (const requested of database
      .prepare('SELECT key FROM requested_keys ORDER BY key')
      .iterate()) {
      visitedKeys++;
      for (const row of candidates.iterate(requested.key)) {
        retain(row);
        await advance();
      }
      await advance();
    }
    const parentById = database.prepare(
      `SELECT id,substr(item,1,${MAX_ITEM_BYTES + 1}) AS item FROM catalog_items WHERE id=?`,
    );
    for (const parent of database.prepare('SELECT id FROM parent_ids ORDER BY id').iterate()) {
      const row = parentById.get(parent.id);
      if (row) retain(row, true);
      await advance();
    }
    check(options.signal);
    observe(options.onProgress, {
      keys: visitedKeys,
      items: items.length,
      elapsed_ms: performance.now() - started,
    });
    check(options.signal);
    return items;
  } catch (error) {
    check(options.signal);
    if (error instanceof ServiceError) throw error;
    throw invalid();
  } finally {
    database?.close();
  }
}
