import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { readBackupVerification, verifyBackup } from '../server/backup-verification.js';

const paths: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'jellyport-offline-verifier-'));
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('offline Jellyport backups', () => {
  it('authenticates saved encrypted records, writes an external receipt, and leaves both directories intact', () => {
    const live = directory();
    const source = new Store(live);
    source.saveSettings({ ...source.settings(), emby_api_key: 'synthetic-private-key' });
    source.db.close();
    const backup = directory();
    const files = ['secret.key', 'jellyport.db'];
    for (const file of files) copyFileSync(join(live, file), join(backup, file));
    const receiptPath = join(directory(), 'backup.verified');
    const before = files.map((file) => readFileSync(join(backup, file)));
    const receipt = verifyBackup(backup, live, receiptPath);
    expect(receipt.encrypted_records).toBe(1);
    expect(readdirSync(backup).sort()).toEqual(files.toSorted());
    for (const [index, file] of files.entries()) {
      expect(readFileSync(join(backup, file))).toEqual(before[index]);
      expect(readFileSync(join(live, file))).toEqual(before[index]);
    }
    expect(readFileSync(receiptPath, 'utf8')).not.toContain(live);
    const reopened = new Store(live);
    const foreign = new Store(directory());
    try {
      expect(readBackupVerification(reopened, receiptPath)).toEqual(receipt);
      expect(readBackupVerification(foreign, receiptPath)).toBeNull();
    } finally {
      reopened.db.close();
      foreign.db.close();
    }
  });

  it('reads committed data from a retained WAL on scratch storage and does not create backup sidecars', () => {
    const live = directory();
    const backup = directory();
    const writer = new Store(live);
    try {
      writer.saveSettings({ ...writer.settings(), emby_api_key: 'synthetic-only-in-wal' });
      for (const file of ['secret.key', 'jellyport.db', 'jellyport.db-wal'])
        copyFileSync(join(live, file), join(backup, file));
      expect(verifyBackup(backup, live).encrypted_records).toBe(1);
      expect(existsSync(join(backup, 'jellyport.db-shm'))).toBe(false);
    } finally {
      writer.db.close();
    }
  });

  it('rejects live paths, key mismatches, corrupt databases, and unprovable empty backups', () => {
    const live = directory();
    const source = new Store(live);
    source.saveSettings({ ...source.settings(), jellyfin_api_key: 'synthetic-private' });
    source.db.close();
    expect(() => verifyBackup(live, live)).toThrow(/separate from the operating/);
    const backup = directory();
    const blank = new Store(backup);
    blank.db.close();
    expect(() => verifyBackup(backup, live)).toThrow(/no encrypted records/);
    expect(() => verifyBackup(backup, live, join(live, 'never'))).toThrow(/outside the operating/);
    copyFileSync(join(live, 'jellyport.db'), join(backup, 'jellyport.db'));
    expect(() => verifyBackup(backup, live)).toThrow(/secret.key that was saved/);
    writeFileSync(join(backup, 'jellyport.db'), 'not a database');
    expect(() => verifyBackup(backup, live)).toThrow();
  });
});
