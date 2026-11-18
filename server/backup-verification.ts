import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SecretCipher } from './crypto.js';
import { Store } from './store.js';

const databaseName = 'jellyport.db';
const keyName = 'secret.key';
const invalidDatabase =
  'The backup database could not be read. Obtain a complete offline Jellyport backup and include its WAL if present.';
const invalidKey = 'Restore the secret.key that was saved with this Jellyport database.';
const invalidWal =
  'The retained SQLite WAL is malformed, incomplete, or could not be replayed. Obtain a complete checkpointed or offline Jellyport backup.';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export interface BackupVerification {
  format: 2;
  verified_at: string;
  encrypted_records: number;
}

function within(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

function fingerprint(file: string, required = true): string | null {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('Invalid backup file');
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(file.endsWith(keyName) ? invalidKey : invalidDatabase);
  }
}

/** Validate the retained WAL before SQLite has a chance to ignore a damaged tail. */
function verifyRetainedWal(database: string, wal: string): number {
  const length = lstatSync(wal).size;
  const databaseHeader = Buffer.alloc(20);
  const source = openSync(database, 'r');
  try {
    if (
      readSync(source, databaseHeader, 0, databaseHeader.length, 0) !== databaseHeader.length ||
      !databaseHeader.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) ||
      databaseHeader[18] !== 2 ||
      databaseHeader[19] !== 2
    )
      throw new Error(invalidWal);
  } finally {
    closeSync(source);
  }
  const fd = openSync(wal, 'r');
  try {
    const header = Buffer.alloc(32);
    if (
      !Number.isSafeInteger(length) ||
      length <= header.length ||
      readSync(fd, header, 0, header.length, 0) !== header.length
    )
      throw new Error(invalidWal);
    const magic = header.readUInt32BE(0);
    const pageSize = header.readUInt32BE(8);
    const basePageSize = databaseHeader.readUInt16BE(16);
    if (
      (magic !== 0x377f0682 && magic !== 0x377f0683) ||
      header.readUInt32BE(4) !== 3_007_000 ||
      pageSize !== (basePageSize === 1 ? 65_536 : basePageSize) ||
      pageSize < 512 ||
      pageSize > 65_536 ||
      (pageSize & (pageSize - 1)) !== 0
    )
      throw new Error(invalidWal);
    const frameSize = 24 + pageSize;
    if ((length - header.length) % frameSize !== 0) throw new Error(invalidWal);

    // The header and every frame use one cumulative checksum. Its word order
    // comes from the magic number, while the stored checksum fields are always BE.
    const word =
      magic === 0x377f0682
        ? (buffer: Buffer, offset: number) => buffer.readUInt32LE(offset)
        : (buffer: Buffer, offset: number) => buffer.readUInt32BE(offset);
    let first = 0;
    let second = 0;
    const checksum = (buffer: Buffer, start: number, end: number) => {
      for (let offset = start; offset < end; offset += 8) {
        first = (first + word(buffer, offset) + second) >>> 0;
        second = (second + word(buffer, offset + 4) + first) >>> 0;
      }
    };
    checksum(header, 0, 24);
    if (header.readUInt32BE(24) !== first || header.readUInt32BE(28) !== second)
      throw new Error(invalidWal);
    const salt = header.subarray(16, 24);
    const frame = Buffer.alloc(frameSize);
    let pagesAtCommit = 0;
    for (let offset = header.length; offset < length; offset += frameSize) {
      if (readSync(fd, frame, 0, frameSize, offset) !== frameSize) throw new Error(invalidWal);
      const page = frame.readUInt32BE(0);
      pagesAtCommit = frame.readUInt32BE(4);
      if (
        page === 0 ||
        page === 0xffffffff ||
        pagesAtCommit === 0xffffffff ||
        !frame.subarray(8, 16).equals(salt)
      )
        throw new Error(invalidWal);
      checksum(frame, 0, 8);
      checksum(frame, 24, frameSize);
      if (frame.readUInt32BE(16) !== first || frame.readUInt32BE(20) !== second)
        throw new Error(invalidWal);
    }
    if (!pagesAtCommit) throw new Error(invalidWal);
    return (length - header.length) / frameSize;
  } finally {
    closeSync(fd);
  }
}

function confirmWalReplay(database: string, frames: number): void {
  // A checkpoint on scratch confirms SQLite adopted the complete validated
  // frame chain, including when the final commit keeps the same database size.
  const db = new DatabaseSync(database, { allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    const result = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    if (result?.busy !== 0 || result.log !== frames || result.checkpointed !== frames)
      throw new Error(invalidWal);
  } finally {
    db.close();
  }
}

function verifyDatabase(directory: string, cipher: SecretCipher): number {
  const db = new DatabaseSync(join(directory, databaseName), {
    readOnly: true,
    allowExtension: false,
  });
  let checked = 0;
  const verify = (value: unknown) => {
    try {
      if (!(typeof value === 'string' || value instanceof Uint8Array)) throw new Error();
      cipher.decrypt(value);
      checked++;
    } catch {
      throw new Error(invalidKey);
    }
  };
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check(1)').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error(invalidDatabase);
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    if (version !== 0 || !['settings', 'jobs', 'accounts'].every((name) => tables.includes(name)))
      throw new Error(
        'The SQLite file uses an unrecognized Jellyport schema. Verify it with the corresponding Jellyport version.',
      );
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
      const field = table === 'accounts' ? 'password' : 'encrypted';
      if (!columns.some(({ name }) => name === field)) continue;
      for (const row of db
        .prepare(`SELECT ${field} FROM ${quote(table)} WHERE ${field} IS NOT NULL`)
        .iterate())
        verify(row[field]);
    }
    if (tables.includes('subscriptions'))
      for (const row of db
        .prepare(
          `SELECT json_extract(payload,'$._stripe_entitlement_encrypted') AS token
        FROM subscriptions WHERE json_type(payload,'$._stripe_entitlement_encrypted') IS NOT NULL`,
        )
        .iterate())
        verify(Buffer.from(String(row.token), 'base64'));
    if (!checked)
      throw new Error('The database contains no encrypted records to prove that its key matches.');
  } finally {
    db.close();
  }
  return checked;
}

/** SQLite works only on a disposable copy, including a retained WAL. */
export function verifyBackup(backup: string, live: string, receipt?: string): BackupVerification {
  const source = realpathSync(backup);
  const livePath = (() => {
    try {
      return realpathSync(live);
    } catch {
      return resolve(live);
    }
  })();
  if (within(livePath, source) || within(source, livePath))
    throw new Error(
      'Choose an offline backup directory separate from the operating data directory.',
    );
  const output = receipt
    ? join(realpathSync(dirname(resolve(receipt))), basename(receipt))
    : undefined;
  if (output && (within(source, output) || within(livePath, output)))
    throw new Error(
      'Save the verification receipt outside the operating data and backup directories.',
    );
  const files = [databaseName, keyName, `${databaseName}-wal`];
  const before = files.map((name, index) => fingerprint(join(source, name), index !== 2));
  if (fingerprint(join(source, `${databaseName}-journal`), false))
    throw new Error('The backup has a rollback journal. Obtain a clean offline copy.');
  const scratch = mkdtempSync(join(tmpdir(), 'jellyport-backup-verify-'));
  try {
    files.forEach((name, index) => {
      if (before[index]) copyFileSync(join(source, name), join(scratch, name));
    });
    if (
      files.some((name, index) => fingerprint(join(source, name), index !== 2) !== before[index]) ||
      fingerprint(join(source, `${databaseName}-journal`), false)
    )
      throw new Error('The backup changed during verification. Retry with a stable offline copy.');
    const scratchDatabase = join(scratch, databaseName);
    const walFrames = before[2]
      ? verifyRetainedWal(scratchDatabase, join(scratch, `${databaseName}-wal`))
      : null;
    const keyFile = join(scratch, keyName);
    if (lstatSync(keyFile).size > 128) throw new Error(invalidKey);
    let cipher: SecretCipher;
    try {
      cipher = new SecretCipher(readFileSync(keyFile, 'utf8'));
    } catch {
      throw new Error(invalidKey);
    }
    const encrypted_records = verifyDatabase(scratch, cipher);
    if (walFrames !== null) confirmWalReplay(scratchDatabase, walFrames);
    // Exercise the current schema upgrade and startup checks on the disposable copy.
    try {
      new Store(scratch).db.close();
    } catch {
      throw new Error(
        'The database passed SQLite integrity checks but could not open in this Jellyport version.',
      );
    }
    const result: BackupVerification = {
      format: 2,
      verified_at: new Date().toISOString(),
      encrypted_records,
    };
    if (output) {
      const temporary = join(dirname(output), `.jellyport-verified-${randomUUID()}`);
      try {
        writeFileSync(temporary, cipher.encrypt(result), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, output);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readBackupVerification(store: Store, path?: string): BackupVerification | null {
  if (!path) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return null;
    const result = store.decrypt<BackupVerification>(readFileSync(path));
    const verified = typeof result.verified_at === 'string' ? Date.parse(result.verified_at) : NaN;
    return result.format === 2 &&
      Number.isFinite(verified) &&
      verified <= Date.now() &&
      Number.isSafeInteger(result.encrypted_records) &&
      result.encrypted_records > 0
      ? { format: 2, verified_at: result.verified_at, encrypted_records: result.encrypted_records }
      : null;
  } catch {
    return null;
  }
}
