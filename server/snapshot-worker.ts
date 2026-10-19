import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, statfs, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  inspectLibrary,
  projectLibrary,
  readSnapshotHistory,
  readUserIdentities,
} from './emby-snapshot-reader.js';
import {
  MAX_SNAPSHOT_BYTES,
  regular,
  snapshotCaptureMethod,
  type SnapshotCaptureMethod,
} from './snapshot-files.js';
import { captureFileCopy } from './snapshot-copy.js';
import { importPluginBackup } from './plugin-backup.js';
import type { MigrationScope } from './migration.js';
import { importJellyfinBackupCatalog } from './jellyfin-backup-reader.js';
import {
  buildJellyfinCatalogIndex,
  readJellyfinCatalogCandidates,
} from './jellyfin-catalog-index.js';
import {
  DESTINATION_CATALOG_MAX_AGE,
  normalizedServerVersion,
  DestinationCatalogError,
  destinationCatalogErrorCode,
  type DestinationCatalogDiagnostic,
  type DestinationCatalogStage,
} from './destination-catalog-files.js';
import type { MediaItem } from './media.js';
import type { PathMapping } from './matching.js';

type Request =
  | {
      operation: 'capture';
      directory: string;
      output: string;
      capture_method?: SnapshotCaptureMethod;
      server_id?: string;
    }
  | {
      operation: 'read';
      path: string;
      user_id: string;
      identities: Record<string, number>;
      scope: MigrationScope;
    }
  | {
      operation: 'destination_capture';
      directory: string;
      output: string;
      version: string;
      expected_backup?: { name: string; created_at: string };
    }
  | {
      operation: 'destination_read';
      path: string;
      source: MediaItem[];
      mappings: PathMapping[];
    };

process.once('message', (request: Request) => {
  void run(request).then(
    (value) => process.send?.({ ok: true, value }, () => process.exit(0)),
    (error: unknown) =>
      process.send?.(
        {
          ok: false,
          ...(request.operation === 'destination_capture'
            ? {
                error_code: destinationCatalogErrorCode(error),
                ...(error instanceof DestinationCatalogError && error.diagnostic
                  ? { diagnostic: error.diagnostic }
                  : {}),
              }
            : {}),
          error:
            request.operation === 'destination_capture'
              ? 'Jellyfin backup import failed. Any previously saved catalog is preserved.'
              : request.operation === 'destination_read'
                ? 'The saved Jellyfin matching catalog is unsupported or cannot be read. Import its backup again.'
                : request.operation === 'capture'
                  ? 'Database capture failed. Check the helper mount, version, permissions and WAL files; any previously saved capture is preserved.'
                  : 'The saved database is unsupported or cannot be read. Capture it again and review the selected user.',
        },
        () => process.exit(1),
      ),
  );
});
async function run(request: Request): Promise<unknown> {
  if (request.operation === 'destination_capture') return captureDestination(request);
  if (request.operation === 'destination_read')
    return readJellyfinCatalogCandidates(request.path, request.source, request.mappings);
  if (request.operation === 'read') {
    const history = readSnapshotHistory(
      request.path,
      request.user_id,
      request.identities,
      request.scope,
    );
    if (Buffer.byteLength(JSON.stringify(history.items)) > 32 * 1024 * 1024)
      throw new Error('Result too large.');
    return history;
  }
  if (request.operation !== 'capture') throw new Error('Unknown operation.');
  if (snapshotCaptureMethod(request.capture_method) === 'plugin_backup') {
    if (!request.server_id) throw new Error('A verified source server identity is required.');
    return importPluginBackup(request.directory, request.output, request.server_id);
  }
  if (snapshotCaptureMethod(request.capture_method) === 'file_copy')
    return captureFileCopy(request.directory, request.output);
  const path = join(request.directory, 'library.db');
  await regular(path);
  const fs = await statfs(path);
  // SQLite WAL locks/shared memory must refer to the same local filesystem as Emby.
  if ([0x6969, 0xff534d42, 0xfe534d42, 0x517b].includes(Number(fs.type) >>> 0))
    throw new Error('Network filesystems are unsupported.');
  if ((await lstat(path)).size > MAX_SNAPSHOT_BYTES) throw new Error('Database too large.');
  const identities = readUserIdentities(join(request.directory, 'users.db'));
  const source = new DatabaseSync(path, { readOnly: true, timeout: 250, allowExtension: false });
  try {
    source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    if (source.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal')
      throw new Error('A live snapshot requires WAL mode.');
    // Pin one read view: external writes continue in WAL rather than restarting every batch.
    // The deadline bounds how long this reader can delay checkpoint/reset and retain WAL pages.
    source.exec('BEGIN');
    source.prepare('SELECT name FROM sqlite_schema LIMIT 1').get();
    const pageSize = Number(source.prepare('PRAGMA page_size').get()?.page_size);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    await backup(source, request.output, {
      rate: 256,
      progress: ({ totalPages }) => {
        if (!Number.isSafeInteger(pageSize) || totalPages * pageSize > MAX_SNAPSHOT_BYTES)
          throw new Error('Database too large.');
        Atomics.wait(wait, 0, 0, 2);
      },
    });
  } finally {
    if (source.isTransaction) source.exec('ROLLBACK');
    source.close();
  }
  if (!isDeepStrictEqual(identities, readUserIdentities(join(request.directory, 'users.db'))))
    throw new Error('Emby identities changed during capture.');
  const copied = new DatabaseSync(request.output, { allowExtension: false });
  try {
    copied.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE');
    if (copied.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new Error('Invalid backup.');
  } finally {
    copied.close();
  }
  inspectLibrary(request.output);
  const projected = `${request.output}.projected`;
  projectLibrary(request.output, projected);
  await rm(request.output);
  await rename(projected, request.output);
  const size = (await lstat(request.output)).size;
  if (size > MAX_SNAPSHOT_BYTES) throw new Error('Database too large.');
  const inspected = inspectLibrary(request.output);
  return {
    identities,
    schema: inspected.adapter,
    bytes: size,
    item_count: inspected.item_count,
    ...(inspected.orphan_identity_version === undefined
      ? {}
      : { orphan_identity_version: inspected.orphan_identity_version }),
  };
}

function unchanged(first: BigIntStats, second: BigIntStats): boolean {
  return (
    second.isFile() &&
    !second.isSymbolicLink() &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function archiveName(name: string): boolean {
  const match = /^jellyfin-backup-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.zip$/.exec(name);
  if (!match) return false;
  const value = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

async function captureDestination(request: Extract<Request, { operation: 'destination_capture' }>) {
  const started_at = new Date().toISOString();
  let diagnostic: DestinationCatalogDiagnostic = {
    stage: 'validating_backup',
    started_at,
    updated_at: started_at,
    source_rows: 0,
    provider_rows: 0,
    items: 0,
    keys: 0,
    bytes: 0,
  };
  let lastSent = 0;
  const observe = (
    stage: DestinationCatalogStage,
    update: Partial<DestinationCatalogDiagnostic> = {},
    force = false,
  ) => {
    const previousStage = diagnostic.stage;
    const now = Date.now();
    diagnostic = { ...diagnostic, ...update, stage, updated_at: new Date().toISOString() };
    if (!force && stage === previousStage && now - lastSent < 1000) return;
    lastSent = now;
    try {
      process.send?.({ type: 'progress', value: diagnostic });
    } catch {
      /* No observer can alter the backup. */
    }
  };
  try {
    observe('validating_backup');
    const source = await lstat(request.directory, { bigint: true });
    if (!source.isDirectory() || source.isSymbolicLink())
      throw new DestinationCatalogError('backup_invalid');
    const names = (await readdir(request.directory)).filter(archiveName).sort().reverse();
    if (!names.length) throw new DestinationCatalogError('backup_missing');
    if (request.expected_backup && !names.includes(request.expected_backup.name))
      throw new DestinationCatalogError('backup_missing');
    const path = join(request.directory, request.expected_backup?.name ?? names[0]!);
    const initial = await lstat(path, { bigint: true });
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.size <= 0 ||
      initial.size > BigInt(MAX_SNAPSHOT_BYTES)
    )
      throw new DestinationCatalogError('backup_invalid');
    const imported = await importJellyfinBackupCatalog(path, request.output, {
      expectedServerVersion: request.version,
      expectedCreatedAt: request.expected_backup?.created_at,
      onProgress: (value) =>
        observe(
          value.phase === 'items'
            ? 'reading_items'
            : value.phase === 'providers'
              ? 'reading_providers'
              : 'enriching',
          {
            source_rows: value.sourceRows,
            provider_rows: value.providerRows,
            items: value.projectedItems,
            bytes: value.projectedBytes,
          },
        ),
    });
    const created = Date.parse(imported.manifest.createdAt);
    if (
      normalizedServerVersion(imported.manifest.serverVersion) !==
        normalizedServerVersion(request.version) ||
      !normalizedServerVersion(request.version) ||
      !Number.isFinite(created) ||
      created > Date.now() + 60_000 ||
      Date.now() - created > DESTINATION_CATALOG_MAX_AGE
    )
      throw new DestinationCatalogError(
        created > Date.now() + 60_000
          ? 'backup_future'
          : Date.now() - created > DESTINATION_CATALOG_MAX_AGE
            ? 'backup_expired'
            : 'version_mismatch',
      );
    observe('indexing');
    const indexed = await buildJellyfinCatalogIndex(request.output, {
      onProgress: (value) => observe('indexing', { keys: value.keys }),
    });
    observe('fingerprinting', { items: indexed.rows, keys: indexed.keys });
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let fingerprint: string;
    try {
      if (!unchanged(initial, await handle.stat({ bigint: true })))
        throw new DestinationCatalogError('backup_changed');
      const hash = createHash('sha256');
      let bytes = 0;
      let lastProgress = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += (chunk as Buffer).length;
        if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('The backup exceeds its size limit.');
        hash.update(chunk as Buffer);
        if (Date.now() - lastProgress >= 1000) {
          observe('fingerprinting');
          lastProgress = Date.now();
        }
      }
      if (
        BigInt(bytes) !== initial.size ||
        !unchanged(initial, await handle.stat({ bigint: true }))
      )
        throw new DestinationCatalogError('backup_changed');
      fingerprint = hash.digest('hex');
    } finally {
      await handle.close();
    }
    if (!unchanged(initial, await lstat(path, { bigint: true })))
      throw new DestinationCatalogError('backup_changed');
    const folder = await lstat(request.directory, { bigint: true });
    if (
      !folder.isDirectory() ||
      folder.isSymbolicLink() ||
      folder.dev !== source.dev ||
      folder.ino !== source.ino
    )
      throw new DestinationCatalogError('backup_changed');
    if (created > Date.now() + 60_000 || Date.now() - created > DESTINATION_CATALOG_MAX_AGE)
      throw new DestinationCatalogError(
        created > Date.now() + 60_000 ? 'backup_future' : 'backup_expired',
      );
    const output = await lstat(request.output);
    if (
      !output.isFile() ||
      output.isSymbolicLink() ||
      output.size <= 0 ||
      output.size > MAX_SNAPSHOT_BYTES
    )
      throw new DestinationCatalogError('backup_invalid');
    observe('fingerprinting', { bytes: output.size }, true);
    return {
      bytes: output.size,
      items: indexed.rows,
      keys: indexed.keys,
      backup_created_at: imported.manifest.createdAt,
      backup_fingerprint: fingerprint,
      server_version: imported.manifest.serverVersion,
      backup_engine_version: imported.manifest.backupEngineVersion,
      diagnostic,
    };
  } catch (error) {
    let code = destinationCatalogErrorCode(error);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      code = diagnostic.stage === 'validating_backup' ? 'backup_missing' : 'backup_changed';
    throw new DestinationCatalogError(code, diagnostic);
  }
}
