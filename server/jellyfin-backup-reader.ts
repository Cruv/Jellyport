import { constants, closeSync, fstatSync, lstatSync, openSync, rmSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { parser, type Token } from 'stream-json/parser.js';
import { fromFdPromise, type Entry, type ZipFile } from 'yauzl';
import { ServiceError } from './errors.js';
import { projectCatalogItem, type MediaItem } from './media.js';

export const JELLYFIN_BACKUP_PROJECTION_FORMAT = 'jellyfin-backup-catalog-v1';
const VERSION = '12.2.0.0';
const ENGINE_VERSION = '0.2.0';
const MAX_ARCHIVE_BYTES = 8 * 1024 ** 3;
const MAX_ITEMS_BYTES = 16 * 1024 ** 3;
const MAX_PROVIDER_BYTES = 4 * 1024 ** 3;
const MAX_PROJECTED_BYTES = 8 * 1024 ** 3;
const MAX_SOURCE_ROWS = 5_000_000;
const MAX_PROJECTED_ITEMS = 2_000_000;
const MAX_PROVIDER_ROWS = 10_000_000;
const MAX_ROW_BYTES = 1024 * 1024;
const MAX_ITEM_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST = 'manifest.json';
const ITEMS = 'Database/BaseItems.json';
const PROVIDERS = 'Database/BaseItemProviders.json';
const clrTypes: Readonly<Record<string, string>> = Object.freeze({
  'MediaBrowser.Controller.Entities.Movies.Movie': 'Movie',
  'MediaBrowser.Controller.Entities.TV.Episode': 'Episode',
  'MediaBrowser.Controller.Entities.TV.Series': 'Series',
  'MediaBrowser.Controller.Entities.TV.Season': 'Season',
  'MediaBrowser.Controller.Entities.Audio.Audio': 'Audio',
  'MediaBrowser.Controller.Entities.Audio.MusicAlbum': 'MusicAlbum',
  'MediaBrowser.Controller.Entities.Audio.MusicArtist': 'MusicArtist',
  'MediaBrowser.Controller.Entities.MusicVideo': 'MusicVideo',
  'MediaBrowser.Controller.Entities.Video': 'Video',
  'MediaBrowser.Controller.Entities.Book': 'Book',
  'MediaBrowser.Controller.Entities.AudioBook': 'AudioBook',
  'MediaBrowser.Controller.Entities.Photo': 'Photo',
  'MediaBrowser.Controller.Entities.PhotoAlbum': 'PhotoAlbum',
  'MediaBrowser.Controller.Entities.Movies.BoxSet': 'BoxSet',
  'MediaBrowser.Controller.Entities.Trailer': 'Trailer',
});
const itemFields = new Set([
  'Id',
  'Type',
  'Name',
  'Path',
  'SeriesId',
  'IndexNumber',
  'ParentIndexNumber',
  'RunTimeTicks',
  'Data',
]);
const providerFields = new Set(['ItemId', 'ProviderId', 'ProviderValue']);
export interface JellyfinBackupManifest {
  serverVersion: string;
  backupEngineVersion: string;
  createdAt: string;
}
export interface JellyfinBackupStats {
  sourceRows: number;
  providerRows: number;
  ignoredRows: number;
  projectedItems: number;
  projectedBytes: number;
}
export interface JellyfinBackupProgress extends JellyfinBackupStats {
  phase: 'items' | 'providers' | 'enriching';
}
export interface JellyfinBackupReadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: JellyfinBackupProgress) => void;
}
export interface JellyfinBackupCatalogResult {
  manifest: JellyfinBackupManifest;
  stats: JellyfinBackupStats;
}
const invalid = () =>
  new ServiceError('The Jellyfin backup has an unsupported or invalid catalog.');
const canceled = () => new ServiceError('Jellyfin backup import canceled.');
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw canceled();
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
    throw invalid();
  return value.replaceAll('-', '').toLowerCase();
}
function unchanged(first: BigIntStats, second: BigIntStats): boolean {
  return (
    second.isFile() &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}
function readManifest(bytes: Buffer): JellyfinBackupManifest {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !isObject(value) ||
    value.ServerVersion !== VERSION ||
    value.BackupEngineVersion !== ENGINE_VERSION ||
    !isObject(value.Options) ||
    value.Options.Database !== true ||
    !Array.isArray(value.DatabaseTables) ||
    value.DatabaseTables.length < 1 ||
    value.DatabaseTables.length > 128 ||
    value.DatabaseTables.some((table) => typeof table !== 'string' || table.length > 256) ||
    typeof value.DateCreated !== 'string' ||
    value.DateCreated.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value.DateCreated,
    )
  )
    throw invalid();
  const date = Date.parse(value.DateCreated);
  const wallTime = Date.parse(value.DateCreated.slice(0, 19) + 'Z');
  if (
    !Number.isFinite(date) ||
    !Number.isFinite(wallTime) ||
    new Date(wallTime).toISOString().slice(0, 19) !== value.DateCreated.slice(0, 19)
  )
    throw invalid();
  return {
    serverVersion: VERSION,
    backupEngineVersion: ENGINE_VERSION,
    createdAt: new Date(date).toISOString(),
  };
}

/** Keep streamed strings unpacked: even an unneeded multi-gigabyte field is never assembled. */
function rowProjection(
  fields: Set<string>,
  consume: (row: Record<string, unknown>) => Promise<void>,
): Writable {
  let depth = 0;
  let row: Record<string, unknown> | undefined;
  let keys = new Set<string>();
  let key = '';
  let text = '';
  let keyText = '';
  let numberText = '';
  let numberSize = 0;
  let readingKey = false;
  let readingNumber = false;
  let readingString = false;
  let size = 0;
  let rootSeen = false;
  const value = (entry: unknown) => {
    if (depth === 2 && fields.has(key))
      Object.defineProperty(row!, key, { value: entry, enumerable: true, configurable: true });
  };
  return new Writable({
    objectMode: true,
    highWaterMark: 16,
    write(token: Token, _encoding, callback) {
      try {
        if (!rootSeen) {
          if (token.name !== 'startArray') throw invalid();
          rootSeen = true;
        }
        if (token.name === 'startArray' || token.name === 'startObject') {
          if (depth === 1 && token.name !== 'startObject') throw invalid();
          if (++depth > 16) throw invalid();
          if (depth === 2) {
            row = Object.create(null);
            keys = new Set();
            size = 0;
          }
          size += 2;
        } else if (token.name === 'endArray' || token.name === 'endObject') {
          if (depth === 2) {
            if (token.name !== 'endObject' || !row) throw invalid();
            const completed = row;
            row = undefined;
            depth--;
            void consume(completed).then(
              () => callback(),
              (error: unknown) => callback(error as Error),
            );
            return;
          }
          depth--;
        } else if (token.name === 'startKey') {
          readingKey = true;
          keyText = '';
        } else if (token.name === 'endKey') {
          size += 3;
          if (depth === 2) {
            if (keys.has(keyText) || keys.size >= 512) throw invalid();
            keys.add(keyText);
            key = keyText;
          }
          readingKey = false;
          keyText = '';
        } else if (token.name === 'startString') {
          readingString = depth === 2 && fields.has(key);
          text = '';
        } else if (token.name === 'stringChunk') {
          size += Buffer.byteLength(token.value);
          if (size > MAX_ROW_BYTES) throw invalid();
          if (readingKey) {
            keyText += token.value;
            if (keyText.length > 1024) throw invalid();
          } else if (readingString) text += token.value;
        } else if (token.name === 'endString') {
          if (readingString) value(text);
          readingString = false;
          text = '';
        } else if (token.name === 'startNumber') {
          readingNumber = depth === 2 && fields.has(key);
          numberText = '';
          numberSize = 0;
        } else if (token.name === 'numberChunk') {
          size += token.value.length;
          numberSize += token.value.length;
          if (numberSize > 64 || size > MAX_ROW_BYTES) throw invalid();
          if (readingNumber) numberText += token.value;
        } else if (token.name === 'endNumber') {
          if (readingNumber) value(Number(numberText));
          readingNumber = false;
          numberText = '';
        } else if (
          token.name === 'keyValue' ||
          token.name === 'numberValue' ||
          token.name === 'stringValue'
        ) {
          // Packing would allocate a malicious scalar before its size can be checked.
          throw invalid();
        } else if (
          token.name === 'nullValue' ||
          token.name === 'trueValue' ||
          token.name === 'falseValue'
        ) {
          size += 5;
          value(token.value);
        }
        if (
          size > MAX_ROW_BYTES ||
          depth < 0 ||
          (depth === 1 && !['endObject', 'endArray'].includes(token.name))
        ) {
          // At the root, only object rows are valid. The opening array is special.
          if (!(token.name === 'startArray' && depth === 1)) throw invalid();
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      callback(rootSeen && depth === 0 ? undefined : invalid());
    },
  });
}

async function selectedEntries(zip: ZipFile, signal?: AbortSignal): Promise<Map<string, Entry>> {
  if (zip.entryCount > 512) throw invalid();
  const seen = new Set<string>();
  const selected = new Map<string, Entry>();
  let total = 0;
  for await (const entry of zip.eachEntry()) {
    check(signal);
    const name = entry.fileName;
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (
      name.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      seen.has(name.toLowerCase()) ||
      entry.isEncrypted() ||
      mode === 0xa000 ||
      ![0, 8].includes(entry.compressionMethod) ||
      !Number.isSafeInteger(entry.uncompressedSize) ||
      !Number.isSafeInteger(entry.compressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.compressedSize < 0 ||
      entry.uncompressedSize > Math.max(1, entry.compressedSize) * 1000
    )
      throw invalid();
    seen.add(name.toLowerCase());
    total += entry.uncompressedSize;
    if (total > 32 * 1024 ** 3) throw invalid();
    const maximum =
      name === MANIFEST
        ? MAX_MANIFEST_BYTES
        : name === ITEMS
          ? MAX_ITEMS_BYTES
          : name === PROVIDERS
            ? MAX_PROVIDER_BYTES
            : 0;
    if (maximum) {
      if (entry.uncompressedSize > maximum || entry.uncompressedSize === 0) throw invalid();
      selected.set(name, entry);
    }
  }
  if (![MANIFEST, ITEMS, PROVIDERS].every((name) => selected.has(name))) throw invalid();
  return selected;
}

async function entryPipeline(
  zip: ZipFile,
  entry: Entry,
  sink: Writable,
  options: JellyfinBackupReadOptions,
  jsonRows = false,
): Promise<void> {
  check(options.signal);
  const input = await zip.openReadStreamPromise(entry);
  let bytes = 0;
  let checksum = 0;
  const integrity = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        check(options.signal);
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize) throw invalid();
        checksum = crc32(chunk, checksum);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      callback(
        bytes === entry.uncompressedSize && checksum === entry.crc32 ? undefined : invalid(),
      );
    },
  });
  if (jsonRows) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const utf8 = new Transform({
      readableObjectMode: true,
      transform(chunk: Buffer, _encoding, callback) {
        try {
          callback(null, decoder.decode(chunk, { stream: true }));
        } catch (error) {
          callback(error as Error);
        }
      },
      flush(callback) {
        try {
          callback(null, decoder.decode());
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    await pipeline(
      input,
      integrity,
      utf8,
      parser.asStream({
        packKeys: false,
        streamKeys: true,
        packStrings: false,
        streamStrings: true,
        packNumbers: false,
        streamNumbers: true,
      }),
      sink,
      { signal: options.signal },
    );
  } else await pipeline(input, integrity, sink, { signal: options.signal });
}

/**
 * Read only neutral catalog tables from a completed, unchanged backup. The caller
 * owns the private output directory and publishes only after this promise succeeds.
 * The archive contains no trustworthy server ID: its configured binding and fresh
 * API candidate checks are separate requirements, not inferred from the manifest.
 */
export async function importJellyfinBackupCatalog(
  archivePath: string,
  outputPath: string,
  options: JellyfinBackupReadOptions = {},
): Promise<JellyfinBackupCatalogResult> {
  let fd: number | undefined;
  let zip: ZipFile | undefined;
  let database: DatabaseSync | undefined;
  let createdOutput = false;
  let completed = false;
  const stats: JellyfinBackupStats = {
    sourceRows: 0,
    providerRows: 0,
    ignoredRows: 0,
    projectedItems: 0,
    projectedBytes: 0,
  };
  let lastObservation = 0;
  const report = (phase: JellyfinBackupProgress['phase'], force = false) => {
    if (!force && Date.now() - lastObservation < 1000) return;
    lastObservation = Date.now();
    try {
      options.onProgress?.({ ...stats, phase });
    } catch {
      /* Observers cannot change correctness. */
    }
  };
  try {
    check(options.signal);
    const initial = lstatSync(archivePath, { bigint: true });
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.size <= 0 ||
      initial.size > BigInt(MAX_ARCHIVE_BYTES)
    )
      throw invalid();
    fd = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!unchanged(initial, fstatSync(fd, { bigint: true }))) throw invalid();
    zip = await fromFdPromise(fd, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    zip.on('error', () => {
      /* eachEntry/readStream reject with sanitized caller errors. */
    });
    const entries = await selectedEntries(zip, options.signal);
    const buffers: Buffer[] = [];
    await entryPipeline(
      zip,
      entries.get(MANIFEST)!,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          buffers.push(chunk);
          callback();
        },
      }),
      options,
    );
    const manifest = readManifest(Buffer.concat(buffers));
    const outputFd = openSync(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(outputFd);
    createdOutput = true;
    database = new DatabaseSync(outputPath, { allowExtension: false });
    const pageSize = Number(database.prepare('PRAGMA page_size').get()?.page_size);
    if (!Number.isSafeInteger(pageSize) || pageSize < 512 || pageSize > 65_536) throw invalid();
    database.exec(`PRAGMA max_page_count=${Math.floor(MAX_PROJECTED_BYTES / pageSize)};`);
    database.exec(`PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;
      CREATE TABLE catalog_items(id TEXT PRIMARY KEY,item TEXT NOT NULL) STRICT;
      CREATE TABLE source_ids(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE provider_keys(id TEXT NOT NULL,provider_key TEXT NOT NULL,PRIMARY KEY(id,provider_key)) STRICT;
      CREATE TABLE providers(id TEXT NOT NULL,provider_key TEXT NOT NULL,provider_value TEXT NOT NULL,PRIMARY KEY(id,provider_key)) STRICT;
      BEGIN IMMEDIATE;`);
    const insertId = database.prepare('INSERT INTO source_ids(id) VALUES(?)');
    const insertItem = database.prepare('INSERT INTO catalog_items(id,item) VALUES(?,?)');
    let transactionRows = 0;
    const checkpoint = async (phase: JellyfinBackupProgress['phase']) => {
      check(options.signal);
      report(phase);
      if (++transactionRows % 10_000 === 0) database!.exec('COMMIT; BEGIN IMMEDIATE;');
      if (transactionRows % 1000 === 0) {
        await yieldTurn();
        check(options.signal);
      }
    };
    await entryPipeline(
      zip,
      entries.get(ITEMS)!,
      rowProjection(itemFields, async (row) => {
        if (++stats.sourceRows > MAX_SOURCE_ROWS) throw invalid();
        const id = identifier(row.Id);
        insertId.run(id);
        if (typeof row.Type !== 'string') throw invalid();
        const type = Object.hasOwn(clrTypes, row.Type) ? clrTypes[row.Type] : undefined;
        if (!type) stats.ignoredRows++;
        else {
          const projected: Record<string, unknown> = { Id: id, Type: type };
          for (const field of ['Name', 'Path', 'IndexNumber', 'ParentIndexNumber', 'RunTimeTicks'])
            if (row[field] !== null && row[field] !== undefined) projected[field] = row[field];
          if (row.SeriesId !== null && row.SeriesId !== undefined)
            projected.SeriesId = identifier(row.SeriesId);
          if (type === 'Episode' && row.Data !== null && row.Data !== undefined) {
            if (typeof row.Data !== 'string') throw invalid();
            const data: unknown = JSON.parse(row.Data);
            if (!isObject(data)) throw invalid();
            if (data.IndexNumberEnd !== undefined && data.IndexNumberEnd !== null)
              projected.IndexNumberEnd = data.IndexNumberEnd;
          }
          const item = projectCatalogItem(projected);
          const serialized = JSON.stringify(item);
          if (
            Buffer.byteLength(serialized) > MAX_ITEM_BYTES ||
            ++stats.projectedItems > MAX_PROJECTED_ITEMS
          )
            throw invalid();
          insertItem.run(id, serialized);
        }
        await checkpoint('items');
      }),
      options,
      true,
    );
    const sourceId = database.prepare('SELECT 1 AS present FROM source_ids WHERE id=?');
    const targetId = database.prepare('SELECT 1 AS present FROM catalog_items WHERE id=?');
    const insertProviderKey = database.prepare(
      'INSERT INTO provider_keys(id,provider_key) VALUES(?,?)',
    );
    const insertProvider = database.prepare(
      'INSERT INTO providers(id,provider_key,provider_value) VALUES(?,?,?)',
    );
    await entryPipeline(
      zip,
      entries.get(PROVIDERS)!,
      rowProjection(providerFields, async (row) => {
        if (++stats.providerRows > MAX_PROVIDER_ROWS) throw invalid();
        const id = identifier(row.ItemId);
        const key = row.ProviderId;
        const value = row.ProviderValue;
        if (
          typeof key !== 'string' ||
          !key ||
          key.length > 128 ||
          /[\u0000-\u001f\u007f]/.test(key) ||
          typeof value !== 'string' ||
          value.length > 1024 ||
          /[\u0000-\u001f\u007f]/.test(value) ||
          !sourceId.get(id)
        )
          throw invalid();
        insertProviderKey.run(id, key.toLowerCase());
        if (targetId.get(id)) insertProvider.run(id, key, value);
        await checkpoint('providers');
      }),
      options,
      true,
    );
    if (stats.projectedItems === 0) throw invalid();
    const readBatch = database.prepare(
      'SELECT id,item FROM catalog_items WHERE id>? ORDER BY id LIMIT 1000',
    );
    const readProviders = database.prepare(
      'SELECT provider_key,provider_value FROM providers WHERE id=?',
    );
    const updateItem = database.prepare('UPDATE catalog_items SET item=? WHERE id=?');
    const series = database.prepare('SELECT item FROM catalog_items WHERE id=?');
    let cursor = '';
    while (true) {
      check(options.signal);
      const batch = readBatch.all(cursor);
      if (batch.length === 0) break;
      for (const row of batch) {
        const item = JSON.parse(String(row.item)) as MediaItem;
        const providers = readProviders.all(String(row.id));
        if (providers.length > 64) throw invalid();
        if (providers.length) {
          item.ProviderIds = Object.create(null) as Record<string, unknown>;
          for (const provider of providers)
            Object.defineProperty(item.ProviderIds, String(provider.provider_key), {
              value: provider.provider_value,
              enumerable: true,
            });
        }
        updateItem.run(JSON.stringify(projectCatalogItem(item)), row.id!);
        cursor = String(row.id);
      }
      report('enriching');
      await yieldTurn();
    }
    cursor = '';
    while (true) {
      check(options.signal);
      const batch = readBatch.all(cursor);
      if (batch.length === 0) break;
      for (const row of batch) {
        const item = JSON.parse(String(row.item)) as MediaItem;
        if (item.SeriesId) {
          const parent = series.get(item.SeriesId);
          if (!parent) throw invalid();
          const parentItem = JSON.parse(String(parent.item)) as MediaItem;
          if (parentItem.Type !== 'Series') throw invalid();
          if (parentItem.ProviderIds) item.SeriesProviderIds = parentItem.ProviderIds;
        }
        const serialized = JSON.stringify(projectCatalogItem(item));
        const bytes = Buffer.byteLength(serialized);
        stats.projectedBytes += bytes;
        if (bytes > MAX_ITEM_BYTES || stats.projectedBytes > MAX_PROJECTED_BYTES) throw invalid();
        updateItem.run(serialized, row.id!);
        cursor = String(row.id);
      }
      report('enriching');
      await yieldTurn();
    }
    database.exec(
      'COMMIT; DROP TABLE provider_keys; DROP TABLE providers; DROP TABLE source_ids; VACUUM;',
    );
    check(options.signal);
    if (
      !unchanged(initial, fstatSync(fd, { bigint: true })) ||
      !unchanged(initial, lstatSync(archivePath, { bigint: true }))
    )
      throw invalid();
    report('enriching', true);
    completed = true;
    return { manifest, stats };
  } catch (error) {
    if (options.signal?.aborted) throw canceled();
    if (error instanceof ServiceError) throw error;
    throw invalid();
  } finally {
    database?.close();
    if (zip)
      await new Promise<void>((resolve) => {
        zip!.once('close', resolve);
        zip!.close();
      });
    else if (fd !== undefined) closeSync(fd);
    if (createdOutput && !completed) {
      rmSync(outputPath, { force: true });
      rmSync(outputPath + '-journal', { force: true });
    }
  }
}
