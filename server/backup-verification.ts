import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
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
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export interface BackupVerification {
  format: 1;
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
    const keyFile = join(scratch, keyName);
    if (lstatSync(keyFile).size > 128) throw new Error(invalidKey);
    let cipher: SecretCipher;
    try {
      cipher = new SecretCipher(readFileSync(keyFile, 'utf8'));
    } catch {
      throw new Error(invalidKey);
    }
    const encrypted_records = verifyDatabase(scratch, cipher);
    // Exercise the current schema upgrade and startup checks on the disposable copy.
    try {
      new Store(scratch).db.close();
    } catch {
      throw new Error(
        'The database passed SQLite integrity checks but could not open in this Jellyport version.',
      );
    }
    const result: BackupVerification = {
      format: 1,
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
    return result.format === 1 &&
      Number.isFinite(verified) &&
      verified <= Date.now() &&
      Number.isSafeInteger(result.encrypted_records) &&
      result.encrypted_records > 0
      ? { format: 1, verified_at: result.verified_at, encrypted_records: result.encrypted_records }
      : null;
  } catch {
    return null;
  }
}
