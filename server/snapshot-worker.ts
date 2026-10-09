import { backup, DatabaseSync } from 'node:sqlite';
import { lstat, statfs, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  inspectLibrary,
  projectLibrary,
  readSnapshotItems,
  readUserIdentities,
} from './emby-snapshot-reader.js';
import {
  MAX_SNAPSHOT_BYTES,
  regular,
  snapshotCaptureMethod,
  type SnapshotCaptureMethod,
} from './snapshot-files.js';
import { captureFileCopy } from './snapshot-copy.js';
import type { MigrationScope } from './migration.js';

type Request =
  | {
      operation: 'capture';
      directory: string;
      output: string;
      capture_method?: SnapshotCaptureMethod;
    }
  | {
      operation: 'read';
      path: string;
      user_id: string;
      identities: Record<string, number>;
      scope: MigrationScope;
    };

process.once('message', (request: Request) => {
  void run(request).then(
    (value) => process.send?.({ ok: true, value }, () => process.exit(0)),
    () =>
      process.send?.(
        {
          ok: false,
          error:
            request.operation === 'capture'
              ? 'Database capture failed. Check the helper mount, version, permissions and WAL files; the last good capture is preserved.'
              : 'The saved database is unsupported or cannot be read. Capture it again and review the selected user.',
        },
        () => process.exit(1),
      ),
  );
});
async function run(request: Request): Promise<unknown> {
  if (request.operation === 'read') {
    const items = readSnapshotItems(
      request.path,
      request.user_id,
      request.identities,
      request.scope,
    );
    if (Buffer.byteLength(JSON.stringify(items)) > 32 * 1024 * 1024)
      throw new Error('Result too large.');
    return items;
  }
  if (request.operation !== 'capture') throw new Error('Unknown operation.');
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
  return { identities, schema: inspected.adapter, bytes: size, item_count: inspected.item_count };
}
