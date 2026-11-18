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
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { readBackupVerification, verifyBackup } from '../server/backup-verification.js';

const paths: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'jellyport-offline-verifier-'));
  paths.push(path);
  return path;
}
const backupFiles = ['secret.key', 'jellyport.db', 'jellyport.db-wal'];

function retainedSettings() {
  const live = directory();
  const backup = directory();
  const writer = new Store(live);
  writer.saveSettings({ ...writer.settings(), emby_api_key: 'synthetic-checkpointed' });
  writer.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  writer.saveSettings({ ...writer.settings(), emby_api_key: 'synthetic-newer-wal' });
  writer.saveCredentials('wal-only-job', 'Synthetic', 'synthetic-wal-password', '');
  return {
    live,
    backup,
    writer,
    copy() {
      for (const file of backupFiles) copyFileSync(join(live, file), join(backup, file));
    },
  };
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
      const olderReceipt = join(directory(), 'older.verified');
      writeFileSync(olderReceipt, reopened.encrypt({ ...receipt, format: 1 }));
      expect(readBackupVerification(reopened, olderReceipt)).toBeNull();
    } finally {
      reopened.db.close();
      foreign.db.close();
    }
  });

  it('verifies newer committed settings in a retained WAL and leaves the backup and live bytes intact', () => {
    const { live, backup, writer, copy } = retainedSettings();
    try {
      copy();
      const before = backupFiles.map((file) => readFileSync(join(backup, file)));
      const db = new DatabaseSync(join(backup, 'jellyport.db'), { readOnly: true });
      try {
        const record = db.prepare('SELECT encrypted FROM settings WHERE id=1').get()!;
        expect(writer.decrypt(record.encrypted as Uint8Array)).toMatchObject({
          emby_api_key: 'synthetic-newer-wal',
        });
      } finally {
        db.close();
      }
      // The above read used the fixture copy. Re-copy before exercising the verifier so
      // no shared-memory sidecar is present and no helper opens the operating database.
      const isolated = directory();
      for (const file of backupFiles) copyFileSync(join(backup, file), join(isolated, file));
      expect(verifyBackup(isolated, live).encrypted_records).toBe(2);
      expect(existsSync(join(isolated, 'jellyport.db-shm'))).toBe(false);
      for (const [index, file] of backupFiles.entries()) {
        expect(readFileSync(join(isolated, file))).toEqual(before[index]);
        expect(readFileSync(join(live, file))).toEqual(before[index]);
      }
    } finally {
      writer.db.close();
    }
  });

  it.each([
    'empty file',
    'partial header',
    'partial frame',
    'damaged checksum',
    'damaged salt',
    'lost all frames',
    'truncated before commit',
  ])('rejects a %s WAL over a sound older database and issues no receipt', (damage) => {
    const { live, backup, writer, copy } = retainedSettings();
    try {
      copy();
      const standalone = directory();
      copyFileSync(join(backup, 'jellyport.db'), join(standalone, 'jellyport.db'));
      copyFileSync(join(backup, 'secret.key'), join(standalone, 'secret.key'));
      const base = new Store(standalone);
      try {
        expect(base.settings().emby_api_key).toBe('synthetic-checkpointed');
      } finally {
        base.close();
      }
      const wal = join(backup, 'jellyport.db-wal');
      const data = readFileSync(wal);
      expect(data.length).toBeGreaterThan(32 + 24);
      if (damage === 'damaged checksum') data[32 + 24]! ^= 1;
      if (damage === 'damaged salt') data[32 + 8]! ^= 1;
      let length = data.length;
      if (damage === 'empty file') length = 0;
      if (damage === 'lost all frames') length = 32;
      if (damage === 'partial header') length = 31;
      if (damage === 'partial frame') length--;
      if (damage === 'truncated before commit') {
        const frameSize = 24 + data.readUInt32BE(8);
        for (let offset = 32; offset < data.length; offset += frameSize)
          if (data.readUInt32BE(offset + 4) === 0) {
            length = offset + frameSize;
            break;
          }
        expect(length).toBeLessThan(data.length);
      }
      writeFileSync(wal, data.subarray(0, length));
      const before = backupFiles.map((file) => readFileSync(join(backup, file)));
      const liveBefore = backupFiles.map((file) => readFileSync(join(live, file)));
      const receipt = join(directory(), 'backup.verified');
      expect(() => verifyBackup(backup, live, receipt)).toThrow(/WAL/);
      expect(existsSync(receipt)).toBe(false);
      expect(existsSync(join(backup, 'jellyport.db-shm'))).toBe(false);
      for (const [index, file] of backupFiles.entries()) {
        expect(readFileSync(join(backup, file))).toEqual(before[index]);
        expect(readFileSync(join(live, file))).toEqual(liveBefore[index]);
      }
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
