import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotProcess, type SnapshotProcessOptions } from '../server/snapshot-process.js';
import {
  decryptDatabase,
  readEnvelope,
  snapshotKey,
  writeEnvelope,
} from '../server/snapshot-files.js';
import {
  destinationCatalogPrefix,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
  type DestinationCatalogDiagnostic,
  validDestinationDiagnostic,
} from '../server/destination-catalog-files.js';
import type { MediaItem } from '../server/media.js';

const directories: string[] = [];
const helpers: { child: ChildProcess; closed: Promise<number | null> }[] = [];
afterEach(async () => {
  for (const helper of helpers.splice(0)) {
    if (helper.child.exitCode === null && helper.child.signalCode === null)
      helper.child.kill('SIGTERM');
    const timer = setTimeout(() => helper.child.kill('SIGKILL'), 2000);
    try {
      await helper.closed;
    } finally {
      clearTimeout(timer);
    }
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const guid = '00000001-0000-0000-0000-000000000001';
const apiId = guid.replaceAll('-', '');
const secret = 'synthetic-user-history-password-not-for-catalog';

/** Small stored ZIP fixtures, independent of the production archive parser. */
function zip(entries: Record<string, unknown>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name),
      body = Buffer.from(JSON.stringify(value));
    const checksum = crc32(body),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
function archive(created = new Date(Date.now() - 60_000).toISOString(), count = 1) {
  return zip({
    'manifest.json': {
      ServerVersion: '12.2.0.0',
      BackupEngineVersion: '0.2.0',
      DateCreated: created,
      DatabaseTables: ['DbSet`1'],
      Options: { Database: true, Metadata: false, Subtitles: false, Trickplay: false },
    },
    'Database/BaseItems.json': Array.from({ length: count }, (_, index) => ({
      Id: `${(index + 1).toString(16).padStart(8, '0')}-0000-0000-0000-000000000001`,
      Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
      Name: `Synthetic ${index}`,
      Path: `/synthetic/${index}.mkv`,
      UserData: { Password: secret, Played: true },
    })),
    'Database/BaseItemProviders.json': [{ ItemId: guid, ProviderId: 'Tmdb', ProviderValue: '123' }],
    'Database/Users.json': [{ Password: secret }],
  });
}
async function fixture(bytes = archive()) {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-destination-worker-'));
  directories.push(directory);
  const backups = join(directory, 'backups'),
    output = join(directory, 'catalog.db');
  await mkdir(backups);
  const path = join(backups, 'jellyfin-backup-20260102030000.zip');
  await writeFile(path, bytes, { mode: 0o600 });
  return { directory, backups, output, path, bytes };
}
interface Capture {
  bytes: number;
  items: number;
  keys: number;
  backup_created_at: string;
  backup_fingerprint: string;
  server_version: string;
  backup_engine_version: string;
}
const capture = (
  value: Awaited<ReturnType<typeof fixture>>,
  version = '12.2.0',
  options: SnapshotProcessOptions = {},
) =>
  snapshotProcess<Capture>(
    {
      operation: 'destination_capture',
      directory: value.backups,
      output: value.output,
      version,
    },
    undefined,
    undefined,
    options,
  );
async function waitFor<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      return await read();
    } catch {
      await delay(20);
    }
  }
  throw new Error('Synthetic helper exceeded its test deadline.');
}

describe('isolated destination catalog worker and helper', () => {
  it('imports the exact newly completed native archive even when another filename sorts later', async () => {
    const created_at = new Date(Date.now() - 1000).toISOString();
    const value = await fixture(archive(created_at));
    await writeFile(
      join(value.backups, 'jellyfin-backup-20990102040000.zip'),
      Buffer.from('unrelated incomplete backup'),
    );
    const result = await snapshotProcess<Capture>({
      operation: 'destination_capture',
      directory: value.backups,
      output: value.output,
      version: '12.2.0',
      expected_backup: { name: 'jellyfin-backup-20260102030000.zip', created_at },
    });
    expect(Date.parse(result.backup_created_at)).toBe(Date.parse(created_at));
    expect(result.backup_fingerprint).toBe(createHash('sha256').update(value.bytes).digest('hex'));
  });
  it('never falls back to an old archive when a requested native backup is absent or changed', async () => {
    for (const expected_backup of [
      { name: 'jellyfin-backup-20990102040000.zip', created_at: new Date().toISOString() },
      { name: '../jellyfin-backup-20260102030000.zip', created_at: new Date().toISOString() },
      {
        name: 'jellyfin-backup-20260102030000.zip',
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ]) {
      const value = await fixture();
      await expect(
        snapshotProcess<Capture>({
          operation: 'destination_capture',
          directory: value.backups,
          output: value.output,
          version: '12.2.0',
          expected_backup,
        }),
      ).rejects.toThrow(/backup|changed|found/i);
      await expect(stat(value.output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('selects the latest completed archive, builds its index and reads only matching identity candidates', async () => {
    const value = await fixture(Buffer.from('older incomplete archive'));
    const bytes = archive();
    await writeFile(join(value.backups, 'jellyfin-backup-20260102040000.zip'), bytes);
    const progress: DestinationCatalogDiagnostic[] = [];
    const result = await capture(value, '12.2.0', {
      onProgress: (entry) => {
        expect(validDestinationDiagnostic(entry)).toBe(true);
        progress.push(entry as DestinationCatalogDiagnostic);
      },
    });
    expect(result).toMatchObject({
      items: 1,
      keys: 2,
      server_version: '12.2.0.0',
      backup_engine_version: '0.2.0',
      backup_fingerprint: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(result.bytes).toBe((await stat(value.output)).size);
    expect((await stat(value.output)).mode & 0o777).toBe(0o600);
    expect((await readFile(value.output)).includes(Buffer.from(secret))).toBe(false);
    expect(progress.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining([
        'validating_backup',
        'reading_items',
        'reading_providers',
        'enriching',
        'indexing',
        'fingerprinting',
      ]),
    );
    expect(progress.at(-1)).toMatchObject({ items: 1, keys: 2, bytes: result.bytes });
    expect(JSON.stringify(progress)).not.toMatch(/Synthetic|synthetic\/|00000001|password/);
    const items = await snapshotProcess<MediaItem[]>({
      operation: 'destination_read',
      path: value.output,
      source: [{ Id: 'source-item', Type: 'Movie', ProviderIds: { Tmdb: '123' } }],
      mappings: [],
    });
    expect(items).toEqual([
      {
        Id: apiId,
        Type: 'Movie',
        Name: 'Synthetic 0',
        Path: '/synthetic/0.mkv',
        ProviderIds: { Tmdb: '123' },
      },
    ]);
    expect(items[0]?.UserData).toBeUndefined();
  });

  it.each([
    [
      'an expired original backup',
      new Date(Date.now() - 49 * 60 * 60_000).toISOString(),
      '12.2.0',
      'backup_expired',
    ],
    [
      'a future original backup',
      new Date(Date.now() + 120_000).toISOString(),
      '12.2.0',
      'backup_future',
    ],
    [
      'an incompatible linked version',
      new Date(Date.now() - 60_000).toISOString(),
      '12.3.0',
      'version_mismatch',
    ],
  ])(
    'rejects %s with an early safe diagnostic before table processing',
    async (_name, created, version, code) => {
      const value = await fixture(archive(created));
      const progress: unknown[] = [];
      await expect(
        capture(value, version, { onProgress: (entry) => progress.push(entry) }),
      ).rejects.toMatchObject({
        error_code: code,
        diagnostic: {
          stage: 'validating_backup',
          source_rows: 0,
          provider_rows: 0,
          items: 0,
          keys: 0,
          bytes: 0,
        },
      });
      expect(progress).toHaveLength(1);
      await expect(stat(value.output)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects a newer symlink instead of falling back to an older archive', async () => {
    const value = await fixture();
    await symlink(value.path, join(value.backups, 'jellyfin-backup-20260102040000.zip'));
    await expect(capture(value)).rejects.toMatchObject({ error_code: 'backup_invalid' });
  });

  it('does not treat an arbitrary or invalid-date ZIP filename as a completed backup', async () => {
    const value = await fixture();
    await rm(value.path);
    await writeFile(join(value.backups, 'backup.zip'), value.bytes);
    await writeFile(join(value.backups, 'jellyfin-backup-20260230030000.zip'), value.bytes);
    await expect(capture(value)).rejects.toMatchObject({ error_code: 'backup_missing' });
  });

  it('rejects a source which changes while importing rather than publishing its partial projection', async () => {
    const value = await fixture(archive(undefined, 10_000));
    let changes = 0;
    const timer = setInterval(() => {
      void utimes(value.path, new Date(), new Date(Date.now() + ++changes)).catch(() => {});
    }, 2);
    try {
      await expect(capture(value)).rejects.toMatchObject({ error_code: 'backup_changed' });
    } finally {
      clearInterval(timer);
    }
    expect(changes).toBeGreaterThan(0);
  });

  it('honors a pre-canceled candidate read and leaves its saved index unchanged', async () => {
    const value = await fixture();
    await capture(value);
    const before = createHash('sha256')
      .update(await readFile(value.output))
      .digest('hex');
    const controller = new AbortController();
    controller.abort();
    await expect(
      snapshotProcess(
        { operation: 'destination_read', path: value.output, source: [], mappings: [] },
        controller.signal,
      ),
    ).rejects.toThrow('canceled');
    expect(
      createHash('sha256')
        .update(await readFile(value.output))
        .digest('hex'),
    ).toBe(before);
  });

  it('dispatches the destination namespace, advertises helper availability and recovers interrupted imports', async () => {
    const value = await fixture();
    const exchange = join(value.directory, 'exchange'),
      work = join(value.directory, 'work');
    await mkdir(exchange);
    await mkdir(work);
    const key = await snapshotKey(exchange, true);
    const request: DestinationCatalogRequest = {
      purpose: 'jellyfin_catalog',
      id: randomUUID(),
      requested_at: new Date().toISOString(),
      binding: { url: 'http://jellyfin.invalid', server_id: '1'.repeat(32), version: '12.2.0' },
    };
    const interrupted = { ...request, id: randomUUID() };
    await writeEnvelope(
      join(exchange, `${destinationCatalogPrefix(request.id)}.request`),
      request,
      key,
    );
    await writeEnvelope(
      join(exchange, `${destinationCatalogPrefix(interrupted.id)}.working`),
      interrupted,
      key,
    );
    const child = fork(
      fileURLToPath(new URL('../server/snapshot-helper.ts', import.meta.url)),
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          JELLYPORT_SNAPSHOT_DIR: exchange,
          JELLYPORT_SNAPSHOT_WORK_DIR: work,
          JELLYPORT_SNAPSHOT_METHOD: 'plugin_backup',
          JELLYPORT_EMBY_BACKUP_DIR: value.backups,
          JELLYPORT_EMBY_VERSION: '4.10.1.0',
          JELLYPORT_JELLYFIN_BACKUP_DIR: value.backups,
        },
      },
    );
    helpers.push({
      child,
      closed: new Promise((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      }),
    });
    const heartbeat = await waitFor(() =>
      readEnvelope<{ jellyfin_catalog_enabled: boolean }>(join(exchange, 'helper.status'), key),
    );
    expect(heartbeat.jellyfin_catalog_enabled).toBe(true);
    const result = await waitFor(() =>
      readEnvelope<DestinationCatalogResult>(
        join(exchange, `${destinationCatalogPrefix(request.id)}.result`),
        key,
      ),
    );
    expect(result).toMatchObject({ ...request, ok: true, items: 1, keys: 2 });
    const recovered = await readEnvelope<DestinationCatalogResult>(
      join(exchange, `${destinationCatalogPrefix(interrupted.id)}.result`),
      key,
    );
    expect(recovered).toMatchObject({
      ok: false,
      error: 'Jellyfin backup import was interrupted. Any previously saved catalog is preserved.',
    });
    const output = join(value.directory, 'decrypted.db');
    await decryptDatabase(
      join(exchange, `${destinationCatalogPrefix(request.id)}.db.enc`),
      output,
      key,
      request.id,
    );
    expect((await readFile(output)).includes(Buffer.from(secret))).toBe(false);
    expect(
      (await readFile(join(exchange, `${destinationCatalogPrefix(request.id)}.db.enc`))).includes(
        Buffer.from('/synthetic/0.mkv'),
      ),
    ).toBe(false);
  });
});
