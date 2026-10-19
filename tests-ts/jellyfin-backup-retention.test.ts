import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  processJellyfinBackupCleanupRequest,
  backupCleanupPrefix,
  validBackupCleanupRequest,
  type BackupCleanupRequest,
  type BackupCleanupResult,
} from '../server/jellyfin-backup-retention.js';
import { readEnvelope, snapshotKey, writeEnvelope } from '../server/snapshot-files.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(rename).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename,
  );
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
/** Independent minimal archive writer; all contents are synthetic. */
function archive(date: string) {
  const entries = {
    'manifest.json': JSON.stringify({
      ServerVersion: '12.2.0.0',
      BackupEngineVersion: '0.2.0',
      DateCreated: date,
      DatabaseTables: ['Synthetic'],
      Options: { Database: true, Metadata: false, Trickplay: false, Subtitles: false },
    }),
    'Database/BaseItems.json': '[]',
    'Database/BaseItemProviders.json': '[]',
  };
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [entry, text] of Object.entries(entries)) {
    const name = Buffer.from(entry),
      raw = Buffer.from(text),
      compressed = deflateRawSync(raw),
      crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jellyport-synthetic-retention-'));
  roots.push(root);
  const exchange = join(root, 'exchange'),
    backups = join(root, 'backups');
  await mkdir(backups);
  const key = await snapshotKey(exchange, true);
  const date = new Date().toISOString(),
    bytes = archive(date),
    id = randomUUID();
  const name = `jellyfin-backup-${date.slice(0, 19).replace(/[-:T]/g, '')}.zip`;
  const request: BackupCleanupRequest = {
    purpose: 'jellyfin_backup_cleanup',
    id,
    requested_at: date,
    binding: { url: 'http://jellyfin.test/', server_id: 'a'.repeat(32), version: '12.2.0.0' },
    backups: [
      {
        manifest: {
          name,
          created_at: date,
          server_version: '12.2.0.0',
          backup_engine_version: '0.2.0',
          database: true,
          metadata: false,
          trickplay: false,
          subtitles: false,
        },
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
  const prefix = backupCleanupPrefix(id),
    source = join(backups, name),
    controller = new AbortController();
  await writeFile(source, bytes);
  await writeEnvelope(join(exchange, `${prefix}.request`), request, key);
  const run = (suffix = 'request', enabled = true) =>
    processJellyfinBackupCleanupRequest(
      `${prefix}.${suffix}`,
      exchange,
      backups,
      enabled,
      key,
      controller.signal,
    );
  const result = () => readEnvelope<BackupCleanupResult>(join(exchange, `${prefix}.result`), key);
  return { root, exchange, backups, key, bytes, request, prefix, source, controller, run, result };
}
it('deletes only the authenticated exact archive and leaves manual files untouched', async () => {
  const f = await fixture();
  const manual = join(f.backups, 'jellyfin-backup-20260101000000.zip');
  await writeFile(manual, 'manual');
  expect(await f.run()).toBe(true);
  expect(await f.result()).toMatchObject({
    ok: true,
    removed: [f.request.backups[0]!.manifest.name],
  });
  await expect(stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(manual, 'utf8')).toBe('manual');
  expect(await readdir(f.backups)).toEqual(['jellyfin-backup-20260101000000.zip']);
});
it('preserves a replacement archive even with the same canonical filename', async () => {
  const f = await fixture();
  await writeFile(f.source, archive('2025-01-01T00:00:00.000Z'));
  await f.run();
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source)).not.toEqual(f.bytes);
});
it('requires matching manifest time even when a request supplies the correct archive digest', async () => {
  const f = await fixture();
  f.request.backups[0]!.manifest.created_at = '2025-01-01T00:00:00.000Z';
  await writeEnvelope(join(f.exchange, `${f.prefix}.request`), f.request, f.key);
  await f.run();
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source)).toEqual(f.bytes);
});
it('requires the helper cleanup opt-in and preserves archives on failure', async () => {
  const f = await fixture();
  await f.run('request', false);
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source)).toEqual(f.bytes);
});
it('rejects symlinks without following or deleting their target', async () => {
  const f = await fixture();
  const target = join(f.root, 'manual.zip');
  await rename(f.source, target);
  await symlink(target, f.source);
  await f.run();
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(target)).toEqual(f.bytes);
});
it('rejects stale and unauthenticated requests without touching archives', async () => {
  const f = await fixture();
  f.request.requested_at = new Date(Date.now() - 6 * 60_000).toISOString();
  await writeEnvelope(join(f.exchange, `${f.prefix}.request`), f.request, f.key);
  await f.run();
  expect(await readFile(f.source)).toEqual(f.bytes);
  await expect(f.result()).rejects.toMatchObject({ code: 'ENOENT' });
  await writeEnvelope(
    join(f.exchange, `${f.prefix}.request`),
    { ...f.request, requested_at: new Date().toISOString() },
    randomBytes(32),
  );
  await f.run();
  expect(await readFile(f.source)).toEqual(f.bytes);
});
it('rejects arbitrary paths, mismatched versions, excessive batches and duplicates', async () => {
  const f = await fixture();
  expect(validBackupCleanupRequest(f.request)).toBe(true);
  for (const name of [
    '../backup.zip',
    '/backup.zip',
    'backup.zip',
    'jellyfin-backup-20260101000000.zip\n',
  ]) {
    expect(
      validBackupCleanupRequest({
        ...f.request,
        backups: [
          { ...f.request.backups[0]!, manifest: { ...f.request.backups[0]!.manifest, name } },
        ],
      }),
    ).toBe(false);
  }
  expect(
    validBackupCleanupRequest({
      ...f.request,
      binding: { ...f.request.binding, version: '99.0.0' },
    }),
  ).toBe(false);
  expect(
    validBackupCleanupRequest({
      ...f.request,
      backups: [f.request.backups[0]!, f.request.backups[0]!],
    }),
  ).toBe(false);
  expect(
    validBackupCleanupRequest({ ...f.request, backups: Array(17).fill(f.request.backups[0]) }),
  ).toBe(false);
});
it('does not replay a completed authenticated deletion after a replacement is installed', async () => {
  const f = await fixture();
  await f.run();
  await writeFile(f.source, 'manual replacement');
  await writeEnvelope(join(f.exchange, `${f.prefix}.request`), f.request, f.key);
  await f.run();
  expect(await readFile(f.source, 'utf8')).toBe('manual replacement');
  expect((await f.result()).ok).toBe(true);
});
it('resumes an authenticated isolated archive after helper restart', async () => {
  const f = await fixture(),
    isolated = join(f.backups, `.jellyport-retention-${f.request.id}`);
  await mkdir(isolated, { mode: 0o700 });
  await rename(f.source, join(isolated, f.request.backups[0]!.manifest.name));
  await rename(join(f.exchange, `${f.prefix}.request`), join(f.exchange, `${f.prefix}.working`));
  await f.run('working');
  expect((await f.result()).ok).toBe(true);
  expect(await readdir(f.backups)).toEqual([]);
});
it('restores a mismatched isolated file without deleting it', async () => {
  const f = await fixture(),
    isolated = join(f.backups, `.jellyport-retention-${f.request.id}`);
  await mkdir(isolated, { mode: 0o700 });
  await rm(f.source);
  await writeFile(join(isolated, f.request.backups[0]!.manifest.name), 'manual moved file');
  await rename(join(f.exchange, `${f.prefix}.request`), join(f.exchange, `${f.prefix}.working`));
  await f.run('working');
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source, 'utf8')).toBe('manual moved file');
});
it('preserves both files when an isolated mismatch cannot be restored over an occupied name', async () => {
  const f = await fixture(),
    isolated = join(f.backups, `.jellyport-retention-${f.request.id}`);
  await mkdir(isolated, { mode: 0o700 });
  await writeFile(f.source, 'new manual');
  const saved = join(isolated, f.request.backups[0]!.manifest.name);
  await writeFile(saved, 'older manual');
  await rename(join(f.exchange, `${f.prefix}.request`), join(f.exchange, `${f.prefix}.working`));
  await f.run('working');
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source, 'utf8')).toBe('new manual');
  expect(await readFile(saved, 'utf8')).toBe('older manual');
});
it('restores a raced replacement after atomic quarantine instead of unlinking it', async () => {
  const f = await fixture();
  const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .rename;
  vi.mocked(rename).mockImplementation(async (source, target) => {
    if (source === f.source) {
      await actual(source, join(f.root, 'owned-original.zip'));
      await writeFile(source, 'raced manual');
    }
    return actual(source, target);
  });
  await f.run();
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source, 'utf8')).toBe('raced manual');
});
it('cancels promptly before deletion and restores an archive isolated just before cancellation', async () => {
  const f = await fixture();
  const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .rename;
  vi.mocked(rename).mockImplementation(async (source, target) => {
    await actual(source, target);
    if (source === f.source) f.controller.abort();
  });
  await f.run();
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source)).toEqual(f.bytes);
});

it('does not renew the absolute cleanup budget when recovering near its deadline', async () => {
  const f = await fixture();
  await rename(join(f.exchange, `${f.prefix}.request`), join(f.exchange, `${f.prefix}.working`));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(f.request.requested_at) + 20 * 60_000 - 1000);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    await f.run('working');
    expect(timeout).toHaveBeenCalledWith(1000);
    expect((await f.result()).ok).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('does not delete after the original execution deadline even when a working envelope is recovered', async () => {
  const f = await fixture();
  await rename(join(f.exchange, `${f.prefix}.request`), join(f.exchange, `${f.prefix}.working`));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(f.request.requested_at) + 20 * 60_000 + 1);
  try {
    await f.run('working');
    expect((await f.result()).ok).toBe(false);
    expect(await readFile(f.source)).toEqual(f.bytes);
  } finally {
    vi.useRealTimers();
  }
});
it('refuses a symlinked quarantine directory', async () => {
  const f = await fixture(),
    target = join(f.root, 'manual-directory');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(f.backups, `.jellyport-retention-${f.request.id}`));
  await f.run();
  expect((await f.result()).ok).toBe(false);
  expect(await readFile(f.source)).toEqual(f.bytes);
  expect(await readdir(target)).toEqual([]);
});

it('caps a fresh cleanup execution at fifteen minutes', async () => {
  const f = await fixture(),
    timeout = vi.spyOn(AbortSignal, 'timeout');
  await f.run();
  expect(timeout).toHaveBeenCalledWith(15 * 60_000);
  expect((await f.result()).ok).toBe(true);
});

it('rejects malformed backup-version types in authenticated metadata without throwing', async () => {
  const f = await fixture();
  const malformed = {
    ...f.request,
    backups: [
      {
        ...f.request.backups[0]!,
        manifest: { ...f.request.backups[0]!.manifest, server_version: 12.2 },
      },
    ],
  };
  expect(validBackupCleanupRequest(malformed as unknown as BackupCleanupRequest)).toBe(false);
});
