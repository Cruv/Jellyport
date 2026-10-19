import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { importJellyfinBackupCatalog } from '../server/jellyfin-backup-reader.js';
import {
  buildJellyfinCatalogIndex,
  readJellyfinCatalogCandidates,
} from '../server/jellyfin-catalog-index.js';
import { createMatcher } from '../server/matching.js';
import type { MediaItem } from '../server/media.js';

// Deliberately accepts no paths, credentials, URLs or external data. Every input
// is generated here, written inside a private temporary directory, and removed.
if (process.argv.length > 2) throw new Error('This synthetic benchmark accepts no arguments.');
const SOURCE_ROWS = 487_859;
const PROVIDER_ROWS = 969_462;
const SERIES = 755;
const MOVIES = 1000;
const EPISODES = 193_000;
const PROJECTED_ITEMS = SERIES + MOVIES + EPISODES;
const CREATED_AT = '2026-10-18T05:15:07.425Z';
const VERSION = '12.2.0.0';
const directory = await mkdtemp(join(tmpdir(), 'jellyport-synthetic-jellyfin-import-'));
const archive = join(directory, 'backup.zip');
const output = join(directory, 'catalog.db');
const id = (value: number) => createHash('md5').update(`synthetic-item-${value}`).digest('hex');
const guid = (value: number) => {
  const valueId = id(value);
  return `${valueId.slice(0, 8)}-${valueId.slice(8, 12)}-${valueId.slice(12, 16)}-${valueId.slice(16, 20)}-${valueId.slice(20)}`;
};
const seriesFor = (episode: number) => Math.floor(episode / 256);
const episodeNumber = (episode: number) => (episode % 256) + 1;
const seriesName = (series: number) => `Synthetic series ${series.toString().padStart(4, '0')}`;
const episodePath = (episode: number) =>
  `/synthetic/library/Television/${'Synthetic organization '.padEnd(109, 'x')}/${seriesName(seriesFor(episode))}/Season 01/${seriesName(seriesFor(episode))} - S01E${episodeNumber(episode).toString().padStart(3, '0')} - Synthetic episode ${episode.toString().padStart(6, '0')}.mkv`;

async function jsonArray(path: string, rows: number, row: (index: number) => unknown) {
  const stream = createWriteStream(path, { mode: 0o600 });
  const finished = once(stream, 'finish');
  const write = async (value: string) => {
    if (!stream.write(value)) await once(stream, 'drain');
  };
  await write('[');
  for (let index = 0; index < rows; index++)
    await write((index ? ',' : '') + JSON.stringify(row(index)));
  stream.end(']');
  await finished;
}

/** Independent streaming ZIP fixture; no large JSON array or archive is retained in memory. */
async function zip(entries: Array<{ name: string; path: string }>) {
  const handle = await open(archive, 'wx', 0o600);
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const compressedPath = join(directory, `compressed-${index}`);
      let bytes = 0,
        checksum = 0;
      await pipeline(
        createReadStream(entry.path),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            checksum = crc32(chunk, checksum);
            callback(null, chunk);
          },
        }),
        createDeflateRaw(),
        createWriteStream(compressedPath, { mode: 0o600 }),
      );
      const compressedBytes = (await stat(compressedPath)).size;
      const name = Buffer.from(entry.name);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(compressedBytes, 18);
      header.writeUInt32LE(bytes, 22);
      header.writeUInt16LE(name.length, 26);
      await handle.write(header);
      await handle.write(name);
      for await (const chunk of createReadStream(compressedPath)) await handle.write(chunk);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50);
      record.writeUInt16LE(0x0314, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(8, 10);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(compressedBytes, 20);
      record.writeUInt32LE(bytes, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE((0o100600 << 16) >>> 0, 38);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      offset += header.length + name.length + compressedBytes;
      await rm(compressedPath);
    }
    const records = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(records.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(records);
    await handle.write(end);
  } finally {
    await handle.close();
  }
}

const timing: Record<string, number> = {};
const rounded = (value: number) => Math.round(value * 10) / 10;
let monitor: ReturnType<typeof setInterval> | undefined;
try {
  const fixtureStarted = performance.now();
  const itemsPath = join(directory, 'items.json');
  const providersPath = join(directory, 'providers.json');
  const manifestPath = join(directory, 'manifest.json');
  await jsonArray(itemsPath, SOURCE_ROWS, (index) => {
    if (index < SERIES)
      return {
        Id: guid(index),
        Type: 'MediaBrowser.Controller.Entities.TV.Series',
        Name: seriesName(index),
        Path: `/synthetic/library/Television/${seriesName(index)}`,
      };
    if (index < SERIES + MOVIES)
      return {
        Id: guid(index),
        Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
        Name: `Synthetic movie ${index}`,
        Path: `/synthetic/library/Movies/Synthetic movie ${index}/Synthetic movie ${index}.mkv`,
        RunTimeTicks: 72_000_000_000,
      };
    if (index < PROJECTED_ITEMS) {
      const episode = index - SERIES - MOVIES;
      return {
        Id: guid(index),
        Type: 'MediaBrowser.Controller.Entities.TV.Episode',
        Name: `Synthetic episode ${episode.toString().padStart(6, '0')}`,
        Path: episodePath(episode),
        SeriesId: guid(seriesFor(episode)),
        IndexNumber: episodeNumber(episode),
        ParentIndexNumber: 1,
        RunTimeTicks: 23_000_000_000,
        Data: JSON.stringify({
          IndexNumberEnd: episodeNumber(episode) + (episode % 1000 === 0 ? 1 : 0),
          IgnoredNestedData: ['synthetic ignored value'],
        }),
        UserData: [{ Played: true, Password: 'synthetic-never-project-personal-state' }],
      };
    }
    return {
      Id: guid(index),
      Type: 'MediaBrowser.Controller.Entities.Person',
      Name: `Synthetic ignored person ${index}`,
      Path: `/synthetic/ignored/${index}`,
    };
  });
  await jsonArray(providersPath, PROVIDER_ROWS, (index) => {
    const item = Math.floor(index / 2);
    return {
      ItemId: guid(item),
      ProviderId: index % 2 ? 'Imdb' : 'Tvdb',
      ProviderValue: index % 2 ? `tt${item + 1}` : String(item + 1),
    };
  });
  const manifest = await open(manifestPath, 'wx', 0o600);
  try {
    await manifest.writeFile(
      JSON.stringify({
        ServerVersion: VERSION,
        BackupEngineVersion: '0.2.0',
        DateCreated: CREATED_AT,
        DatabaseTables: ['DbSet`1'],
        Options: { Database: true, Metadata: false, Subtitles: false, Trickplay: false },
      }),
    );
  } finally {
    await manifest.close();
  }
  await zip([
    { name: 'manifest.json', path: manifestPath },
    { name: 'Database/BaseItems.json', path: itemsPath },
    { name: 'Database/BaseItemProviders.json', path: providersPath },
  ]);
  timing.fixture_generation = performance.now() - fixtureStarted;
  const fixtureBytes = {
    items_json: (await stat(itemsPath)).size,
    providers_json: (await stat(providersPath)).size,
    archive: (await stat(archive)).size,
  };
  await Promise.all([itemsPath, providersPath, manifestPath].map((path) => rm(path)));

  let maximumRss = process.memoryUsage().rss;
  const sampleMemory = () => {
    maximumRss = Math.max(maximumRss, process.memoryUsage().rss);
  };
  monitor = setInterval(sampleMemory, 100);
  const started = performance.now();
  let phase = 'opening',
    phaseStarted = started;
  const result = await importJellyfinBackupCatalog(archive, output, {
    expectedServerVersion: VERSION,
    expectedCreatedAt: CREATED_AT,
    now: Date.parse(CREATED_AT) + 1000,
    onProgress: (progress) => {
      sampleMemory();
      if (phase !== progress.phase) {
        timing[phase] = (timing[phase] ?? 0) + performance.now() - phaseStarted;
        phase = progress.phase;
        phaseStarted = performance.now();
      }
    },
  });
  timing[phase] = (timing[phase] ?? 0) + performance.now() - phaseStarted;
  assert.equal(result.stats.sourceRows, SOURCE_ROWS);
  assert.equal(result.stats.providerRows, PROVIDER_ROWS);
  assert.equal(result.stats.projectedItems, PROJECTED_ITEMS);
  assert.equal(result.stats.ignoredRows, SOURCE_ROWS - PROJECTED_ITEMS);
  const indexStarted = performance.now();
  const indexed = await buildJellyfinCatalogIndex(output, { onProgress: sampleMemory });
  timing.indexing = performance.now() - indexStarted;
  assert.equal(indexed.rows, PROJECTED_ITEMS);
  assert.equal(indexed.keys, SERIES * 3 + MOVIES * 3 + EPISODES * 5);
  const fingerprintStarted = performance.now();
  const fingerprint = createHash('sha256');
  for await (const chunk of createReadStream(archive)) fingerprint.update(chunk);
  const archiveSha256 = fingerprint.digest('hex');
  timing.fingerprinting = performance.now() - fingerprintStarted;
  timing.import_and_index_and_fingerprint = performance.now() - started;
  sampleMemory();
  clearInterval(monitor);
  monitor = undefined;

  const database = new DatabaseSync(output, { readOnly: true, allowExtension: false });
  let projectionSha256: string, keysSha256: string;
  try {
    const itemsDigest = createHash('sha256'),
      keysDigest = createHash('sha256');
    for (const row of database.prepare('SELECT id,item FROM catalog_items ORDER BY id').iterate())
      itemsDigest.update(JSON.stringify(row));
    for (const row of database.prepare('SELECT key,id FROM catalog_keys ORDER BY key,id').iterate())
      keysDigest.update(JSON.stringify(row));
    projectionSha256 = itemsDigest.digest('hex');
    keysSha256 = keysDigest.digest('hex');
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM catalog_items WHERE json_extract(item,'$.UserData') IS NOT NULL",
        )
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
  const chosen = 12_345;
  const source: MediaItem = {
    Id: 'synthetic-source-episode',
    Type: 'Episode',
    ProviderIds: { Tvdb: String(SERIES + MOVIES + chosen + 1) },
    SeriesProviderIds: { Tvdb: String(seriesFor(chosen) + 1) },
    ParentIndexNumber: 1,
    IndexNumber: episodeNumber(chosen),
    IndexNumberEnd: episodeNumber(chosen),
    Path: episodePath(chosen),
  };
  const candidates = await readJellyfinCatalogCandidates(output, [source]);
  assert.equal(candidates.length, 2);
  const selected = candidates.find((item) => item.Type === 'Episode')!;
  assert.equal(selected.Id, id(SERIES + MOVIES + chosen));
  assert.equal(selected.SeriesName, seriesName(seriesFor(chosen)));
  assert.equal(selected.SeriesProviderIds?.Tvdb, String(seriesFor(chosen) + 1));
  assert.equal(createMatcher(candidates)([source]).matches.length, 1);

  console.log(
    JSON.stringify(
      {
        event: 'synthetic_jellyfin_import_benchmark',
        scope:
          'Generated native ZIP -> strict neutral SQLite projection -> matching index -> archive fingerprint; no external server, backup or credential.',
        environment: {
          node: process.version,
          sqlite: process.versions.sqlite,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        fixture: { ...fixtureBytes, source_rows: SOURCE_ROWS, provider_rows: PROVIDER_ROWS },
        result: {
          ...result.stats,
          ...indexed,
          output_database_bytes: (await stat(output)).size,
          sampled_peak_import_rss_bytes: maximumRss,
          projection_sha256: projectionSha256,
          ordered_keys_sha256: keysSha256,
          archive_sha256: archiveSha256,
          semantic_checks:
            'Exact row/key counts, excluded personal fields, enriched series providers/name, candidate union/dependency and final episode match passed.',
        },
        timing_ms: Object.fromEntries(
          Object.entries(timing).map(([name, value]) => [name, rounded(value)]),
        ),
        limitations:
          'One synthetic local run; timings depend on CPU/storage/cache and do not predict production completion or playback impact. RSS is sampled every 100 ms and at progress events, not a memory ceiling. Excludes native backup creation, scheduling, IPC, encryption/adoption and per-user live migration writes. Fixture generation and semantic checksum verification are outside the measured import workflow.',
      },
      null,
      2,
    ),
  );
} finally {
  if (monitor) clearInterval(monitor);
  await rm(directory, { recursive: true, force: true });
}
