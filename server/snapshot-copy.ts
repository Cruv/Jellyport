import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectLibrary, projectLibrary, readUserIdentities } from './emby-snapshot-reader.js';
import { MAX_SNAPSHOT_BYTES } from './snapshot-files.js';

const files = ['library.db', 'library.db-wal', 'users.db', 'users.db-wal'] as const;
type CaptureFile = (typeof files)[number];
interface OpenSource {
  name: CaptureFile;
  path: string;
  handle: FileHandle;
  initial: BigIntStats;
  walHeader?: Buffer;
}
export interface FileCopyCaptureResult {
  identities: Record<string, number>;
  schema: string;
  bytes: number;
  item_count: number;
}
export interface FileCopyCaptureOptions {
  /** Callers may lower the source/output byte ceiling, never raise it. */
  maxBytes?: number;
  /** An observation point for deterministic filesystem-race tests; never a source path. */
  copied?: (name: CaptureFile) => void | Promise<void>;
}
const failed = () =>
  new Error('The file-copy capture could not be validated. The last good capture is preserved.');
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return second.isFile() && first.dev === second.dev && first.ino === second.ino;
}
async function exactRead(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(bytes, offset, length - offset, position + offset);
    if (!read.bytesRead) throw failed();
    offset += read.bytesRead;
  }
  return bytes;
}
async function optionalStat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function noRollbackJournal(directory: string): Promise<void> {
  // A hot DELETE-mode journal cannot be reconstructed from the DB/WAL allowlist.
  for (const name of ['library.db-journal', 'users.db-journal'])
    if (await optionalStat(join(directory, name))) throw failed();
}
async function copyPrefix(source: OpenSource, target: string): Promise<void> {
  const destination = await open(
    target,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = Number(source.initial.size);
    let position = 0;
    while (position < size) {
      const read = await source.handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (!read.bytesRead) throw failed();
      let written = 0;
      while (written < read.bytesRead) {
        const result = await destination.write(
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
    if ((await destination.stat({ bigint: true })).size !== source.initial.size) throw failed();
    if (source.walHeader && !(await exactRead(destination, 32, 0)).equals(source.walHeader))
      throw failed();
  } finally {
    await destination.close();
  }
}

/** Normal SQLite recovery only, on private writable copies. No repair or data salvage. */
function recoverAndCheck(path: string): void {
  const database = new DatabaseSync(path, { allowExtension: false, timeout: 250 });
  try {
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;');
    // Opening the private WAL and checkpointing it regenerates its own shared-memory index.
    const mode = database.prepare('PRAGMA journal_mode').get()?.journal_mode;
    if (mode !== 'wal' && mode !== 'delete') throw failed();
    if (mode === 'wal') {
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (!checkpoint || checkpoint.busy !== 0) throw failed();
      if (database.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete')
        throw failed();
    }
    let rows = 0;
    for (const row of database.prepare('PRAGMA integrity_check').iterate()) {
      rows++;
      if (rows !== 1 || Object.keys(row).length !== 1 || row.integrity_check !== 'ok')
        throw failed();
    }
    if (rows !== 1) throw failed();
  } finally {
    database.close();
  }
}

/**
 * Best-effort ordinary file copy, deliberately not a transactional snapshot.
 * Live source files are accessed solely through bounded filesystem reads. Normal WAL
 * recovery and structural validation happen only after copying into private workspace.
 * A structurally valid copy still cannot prove it contains every concurrent commit.
 * The caller must run this inside a worker with a hard deadline and private output parent.
 */
export async function captureFileCopy(
  directory: string,
  output: string,
  options: FileCopyCaptureOptions = {},
): Promise<FileCopyCaptureResult> {
  let temporary: string | undefined;
  let ownsOutput = false;
  const sources: OpenSource[] = [];
  try {
    const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SNAPSHOT_BYTES)
      throw failed();
    const sourceInfo = await lstat(resolve(directory));
    const sourceDirectory = await realpath(resolve(directory)),
      outputParent = await realpath(resolve(dirname(output)));
    if (
      !sourceInfo.isDirectory() ||
      sourceInfo.isSymbolicLink() ||
      outputParent === sourceDirectory ||
      outputParent.startsWith(sourceDirectory + sep)
    )
      throw failed();
    if (await optionalStat(output)) throw failed();
    await noRollbackJournal(sourceDirectory);
    let bytes = 0n;
    for (const name of files) {
      const path = join(sourceDirectory, name);
      const initial = await optionalStat(path);
      if (!initial) {
        if (!name.endsWith('-wal')) throw failed();
        continue;
      }
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size > BigInt(maxBytes))
        throw failed();
      bytes += initial.size;
      if (bytes > BigInt(maxBytes)) throw failed();
      // NONBLOCK prevents an unexpected FIFO replacement from hanging open(); fstat rejects it.
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const source: OpenSource = { name, path, handle, initial };
      sources.push(source);
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(initial, opened) || opened.size < initial.size) throw failed();
      if (name.endsWith('-wal') && initial.size > 0n) {
        if (initial.size < 32n) throw failed();
        source.walHeader = await exactRead(handle, 32, 0);
      }
    }
    temporary = await mkdtemp(join(outputParent, 'file-copy-'));
    for (const source of sources) {
      const target = join(temporary, source.name);
      await copyPrefix(source, target);
      await options.copied?.(source.name);
    }
    await noRollbackJournal(sourceDirectory);
    for (const name of files) {
      const source = sources.find((entry) => entry.name === name);
      const current = await optionalStat(join(sourceDirectory, name));
      if (!source) {
        if (current) throw failed(); // A WAL appeared after discovery; its commits were not copied.
        continue;
      }
      const opened = await source.handle.stat({ bigint: true });
      if (
        !current ||
        !sameFile(source.initial, current) ||
        !sameFile(source.initial, opened) ||
        current.size < source.initial.size ||
        opened.size < source.initial.size
      )
        throw failed();
      // Appends and in-place DB changes are allowed as best effort; WAL reset/replacement is not.
      if (source.walHeader && !(await exactRead(source.handle, 32, 0)).equals(source.walHeader))
        throw failed();
    }
    for (const source of sources) await source.handle.close();
    sources.length = 0;
    const users = join(temporary, 'users.db'),
      library = join(temporary, 'library.db');
    recoverAndCheck(users);
    const identities = readUserIdentities(users);
    recoverAndCheck(library);
    inspectLibrary(library);
    projectLibrary(library, output);
    ownsOutput = true;
    const size = (await lstat(output)).size;
    if (size > maxBytes) throw failed();
    const inspected = inspectLibrary(output);
    return { identities, schema: inspected.adapter, bytes: size, item_count: inspected.item_count };
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
