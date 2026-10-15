import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectLibrary, projectLibrary, readUserIdentities } from './emby-snapshot-reader.js';
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_VERSION,
  SNAPSHOT_PLUGIN_VERSION,
  SNAPSHOT_MAX_AGE,
} from './snapshot-files.js';
import type { FileCopyCaptureResult } from './snapshot-copy.js';

export const EMBY_BACKUP_PLUGIN_VERSION = SNAPSHOT_PLUGIN_VERSION;
export const PLUGIN_BACKUP_SETTLE_MS = 5 * 60_000;
export const PLUGIN_BACKUP_MAX_AGE_MS = SNAPSHOT_MAX_AGE;
const MAX_METADATA_BYTES = 1024 * 1024;
const sourceFiles = [
  'backupinfo.json',
  'data/device.txt',
  'data/library.db',
  'data/users.db',
] as const;
type SourceFile = (typeof sourceFiles)[number];
interface OpenSource {
  name: SourceFile;
  path: string;
  handle: FileHandle;
  initial: BigIntStats;
  metadata?: Buffer;
}
export interface PluginBackupCaptureResult extends FileCopyCaptureResult {
  backup_created_at: string;
  backup_fingerprint: string;
  plugin_version: typeof EMBY_BACKUP_PLUGIN_VERSION;
}
export interface PluginBackupCaptureOptions {
  /** Deterministic clock for isolated tests; callers do not supply this over IPC. */
  now?: number;
  /** A caller can lower, never raise, the combined source/output byte ceiling. */
  maxBytes?: number;
  /** Race observation point for isolated synthetic tests, never a source path. */
  copied?: (name: SourceFile) => void | Promise<void>;
}
const failed = () =>
  new Error('The Emby plugin backup could not be validated. The last good capture is preserved.');
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return (
    second.isFile() &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}
async function noSidecars(directory: string): Promise<void> {
  for (const database of ['library.db', 'users.db'])
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        await lstat(join(directory, database + suffix));
        throw failed();
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
}
async function exactRead(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    const result = await handle.read(buffer, position, length - position, position);
    if (!result.bytesRead) throw failed();
    position += result.bytesRead;
  }
  return buffer;
}
function backupManifest(buffer: Buffer, now: number): { created: string; users: Set<string> } {
  const value = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.ServerVersion !== SNAPSHOT_VERSION ||
    value.PluginVersion !== EMBY_BACKUP_PLUGIN_VERSION ||
    value.CanRestore !== true ||
    value.IsFullBackup !== true ||
    typeof value.DateCreated !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value.DateCreated) ||
    !Array.isArray(value.Users) ||
    value.Users.length < 1 ||
    value.Users.length > 1000
  )
    throw failed();
  const date = Date.parse(value.DateCreated);
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 19) !== value.DateCreated.slice(0, 19) ||
    date > now + 60_000 ||
    now - date > PLUGIN_BACKUP_MAX_AGE_MS
  )
    throw failed();
  const users = new Set<string>();
  for (const user of value.Users) {
    if (
      !user ||
      typeof user !== 'object' ||
      Array.isArray(user) ||
      typeof user.Id !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(user.Id) ||
      typeof user.Name !== 'string' ||
      user.Name.length > 1024 ||
      users.has(user.Id.toLowerCase())
    )
      throw failed();
    users.add(user.Id.toLowerCase());
  }
  return { created: new Date(date).toISOString(), users };
}
function checkPrivateDatabase(path: string): void {
  const database = new DatabaseSync(path, { allowExtension: false, timeout: 250 });
  try {
    database.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;',
    );
    if (database.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete')
      throw failed();
    let rows = 0;
    for (const row of database.prepare('PRAGMA integrity_check').iterate()) {
      if (++rows !== 1 || Object.keys(row).length !== 1 || row.integrity_check !== 'ok')
        throw failed();
    }
    if (rows !== 1) throw failed();
  } finally {
    database.close();
  }
}

/**
 * Imports the known full-backup format using ordinary read-only filesystem reads.
 * CanRestore, settling and unchanged files are validation evidence, not an atomic
 * completion contract from Emby. SQLite is opened only on private local copies.
 * The caller runs this in the existing isolated worker with a hard deadline.
 */
export async function importPluginBackup(
  root: string,
  output: string,
  expectedServerId: string,
  options: PluginBackupCaptureOptions = {},
): Promise<PluginBackupCaptureResult> {
  const sources: OpenSource[] = [];
  let temporary: string | undefined;
  let ownsOutput = false;
  try {
    const now = options.now ?? Date.now(),
      maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
    if (
      !Number.isFinite(now) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_SNAPSHOT_BYTES ||
      !/^[a-f0-9]{32}$/i.test(expectedServerId)
    )
      throw failed();
    const sourceRoot = await realpath(resolve(root));
    const full = join(sourceRoot, 'embyserver-backup-full'),
      data = join(full, 'data'),
      outputParent = await realpath(resolve(dirname(output)));
    if (outputParent === sourceRoot || outputParent.startsWith(sourceRoot + sep)) throw failed();
    const directories: { path: string; initial: BigIntStats }[] = [];
    for (const path of [resolve(root), full, data]) {
      const initial = await lstat(path, { bigint: true });
      if (!initial.isDirectory() || initial.isSymbolicLink()) throw failed();
      directories.push({ path, initial });
    }
    try {
      await lstat(output);
      throw failed();
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await noSidecars(data);
    let bytes = 0n;
    for (const name of sourceFiles) {
      const path = join(full, name),
        initial = await lstat(path, { bigint: true });
      if (
        !initial.isFile() ||
        initial.isSymbolicLink() ||
        initial.size < 1n ||
        initial.size > BigInt(maxBytes) ||
        now - Number(initial.mtimeNs / 1_000_000n) < PLUGIN_BACKUP_SETTLE_MS ||
        (!name.endsWith('.db') && initial.size > BigInt(MAX_METADATA_BYTES)) ||
        (name === 'data/device.txt' && initial.size > 128n)
      )
        throw failed();
      bytes += initial.size;
      if (bytes > BigInt(maxBytes)) throw failed();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const source: OpenSource = { name, path, initial, handle };
      sources.push(source);
      if (!sameFile(initial, await handle.stat({ bigint: true }))) throw failed();
      if (!name.endsWith('.db')) source.metadata = await exactRead(handle, Number(initial.size));
    }
    const manifest = backupManifest(sources[0]!.metadata!, now);
    if (
      sources[1]!
        .metadata!.toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim() !== expectedServerId
    )
      throw failed();
    temporary = await mkdtemp(join(outputParent, 'plugin-backup-'));
    const fingerprint = createHash('sha256');
    for (const source of sources) {
      fingerprint.update(source.name).update('\0').update(String(source.initial.size)).update('\0');
      if (source.metadata) fingerprint.update(source.metadata);
      else {
        const target = await open(
          join(temporary, source.name.slice(5)),
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024),
            length = Number(source.initial.size);
          let position = 0;
          while (position < length) {
            const read = await source.handle.read(
              buffer,
              0,
              Math.min(buffer.length, length - position),
              position,
            );
            if (!read.bytesRead) throw failed();
            fingerprint.update(buffer.subarray(0, read.bytesRead));
            let written = 0;
            while (written < read.bytesRead) {
              const result = await target.write(
                buffer,
                written,
                read.bytesRead - written,
                position + written,
              );
              if (!result.bytesWritten) throw failed();
              written += result.bytesWritten;
            }
            position += read.bytesRead;
          }
        } finally {
          await target.close();
        }
      }
      await options.copied?.(source.name);
    }
    await noSidecars(data);
    for (const source of sources) {
      if (
        !sameFile(source.initial, await source.handle.stat({ bigint: true })) ||
        !sameFile(source.initial, await lstat(source.path, { bigint: true })) ||
        (source.metadata &&
          !(await exactRead(source.handle, Number(source.initial.size))).equals(source.metadata))
      )
        throw failed();
    }
    for (const directory of directories) {
      const current = await lstat(directory.path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== directory.initial.dev ||
        current.ino !== directory.initial.ino
      )
        throw failed();
    }
    for (const source of sources) await source.handle.close();
    sources.length = 0;
    const users = join(temporary, 'users.db'),
      library = join(temporary, 'library.db');
    checkPrivateDatabase(users);
    const identities = readUserIdentities(users);
    if (
      Object.keys(identities).length !== manifest.users.size ||
      Object.keys(identities).some((id) => !manifest.users.has(id))
    )
      throw failed();
    checkPrivateDatabase(library);
    inspectLibrary(library);
    projectLibrary(library, output);
    ownsOutput = true;
    const size = (await lstat(output)).size;
    if (size > maxBytes) throw failed();
    const inspected = inspectLibrary(output);
    return {
      identities,
      schema: inspected.adapter,
      bytes: size,
      item_count: inspected.item_count,
      backup_created_at: manifest.created,
      backup_fingerprint: fingerprint.digest('hex'),
      plugin_version: EMBY_BACKUP_PLUGIN_VERSION,
    };
  } catch {
    if (ownsOutput) await rm(output, { force: true }).catch(() => {});
    throw failed();
  } finally {
    await Promise.allSettled(sources.map((source) => source.handle.close()));
    if (temporary) {
      try {
        await rm(temporary, { recursive: true, force: true });
      } catch {
        throw failed();
      }
    }
  }
}
