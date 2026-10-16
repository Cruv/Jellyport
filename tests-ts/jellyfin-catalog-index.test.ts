import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildJellyfinCatalogIndex,
  readJellyfinCatalogCandidates,
} from '../server/jellyfin-catalog-index.js';
import { createMatcher } from '../server/matching.js';
import type { MediaItem } from '../server/media.js';

const directories: string[] = [];
const id = (value: number) => value.toString(16).padStart(32, '0');
function fixture(items: MediaItem[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-jf-index-'));
  directories.push(directory);
  const path = join(directory, 'catalog.db');
  const database = new DatabaseSync(path);
  database.exec(
    'CREATE TABLE catalog_items(id TEXT PRIMARY KEY,item TEXT NOT NULL) STRICT; BEGIN;',
  );
  const insert = database.prepare('INSERT INTO catalog_items(id,item) VALUES (?,?)');
  for (const item of items) insert.run(item.Id, JSON.stringify(item));
  database.exec('COMMIT');
  database.close();
  return path;
}
const movie = (value: number, provider = String(value)): MediaItem => ({
  Id: id(value),
  Type: 'Movie',
  ProviderIds: { Tmdb: provider },
  Path: `/synthetic/movie-${value}.mkv`,
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('disk-backed Jellyfin catalog index', () => {
  it('unions provider, series and path candidates before final matching and retains series dependencies', async () => {
    const source: MediaItem = {
      Id: 'source-episode',
      Type: 'Episode',
      ProviderIds: { Tvdb: '100' },
      SeriesProviderIds: { Tvdb: '200' },
      ParentIndexNumber: 1,
      IndexNumber: 2,
      Path: '/old/library/episode.mkv',
    };
    const target: MediaItem[] = [
      {
        Id: id(1),
        Type: 'Episode',
        ProviderIds: { Tvdb: '100' },
        SeriesId: id(4),
        ParentIndexNumber: 1,
        IndexNumber: 2,
      },
      {
        Id: id(2),
        Type: 'Episode',
        ProviderIds: { Tvdb: '999' },
        SeriesProviderIds: { Tvdb: '200' },
        SeriesId: id(4),
        ParentIndexNumber: 1,
        IndexNumber: 2,
      },
      {
        Id: id(3),
        Type: 'Episode',
        Path: '/new/library/episode.mkv',
        SeriesId: id(4),
        ParentIndexNumber: 1,
        IndexNumber: 2,
      },
      { Id: id(4), Type: 'Series', ProviderIds: { Tvdb: '200' } },
      movie(5),
    ];
    const path = fixture(target);
    const mappings = [{ source: '/old', target: '/new' }];
    await buildJellyfinCatalogIndex(path);
    const candidates = await readJellyfinCatalogCandidates(path, [source], mappings);
    const expected = createMatcher(target, mappings)
      .candidates([source])
      .map((item) => item.Id);
    expect(new Set(candidates.map((item) => item.Id))).toEqual(new Set([...expected, id(4)]));
    expect(candidates).toHaveLength(4);
    // The contradictory provider candidate is retained for the access-scoped matcher.
    expect(candidates.some((item) => item.ProviderIds?.Tvdb === '999')).toBe(true);
  });

  it('uses the shared alias, type, path-mapping and exact multi-episode numbering semantics', async () => {
    const target: MediaItem[] = [
      { Id: id(1), Type: 'Audio', ProviderIds: { MusicBrainzTrack: 'track' } },
      { Id: id(2), Type: 'BoxSet', ProviderIds: { TmdbCollection: '900' } },
      { Id: id(3), Type: 'Movie', ProviderIds: { Tmdb: '900' } },
      {
        Id: id(4),
        Type: 'Episode',
        SeriesProviderIds: { Tvdb: 'series' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
        IndexNumberEnd: 3,
      },
      {
        Id: id(5),
        Type: 'Episode',
        SeriesProviderIds: { Tvdb: 'series' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
        IndexNumberEnd: 4,
      },
      { Id: id(6), Type: 'Season', SeriesProviderIds: { Tvdb: 'series' }, IndexNumber: 1 },
      { Id: id(7), Type: 'Video', Path: '/longest/media/file.mkv' },
    ];
    const source: MediaItem[] = [
      { Id: 's1', Type: 'Audio', ProviderIds: { MusicBrainzReleaseTrack: 'TRACK' } },
      { Id: 's2', Type: 'BoxSet', ProviderIds: { Tmdb: '900' } },
      {
        Id: 's3',
        Type: 'Episode',
        SeriesProviderIds: { TheTvdb: 'SERIES' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
        IndexNumberEnd: 3,
      },
      {
        Id: 's4',
        Type: 'Season',
        SeriesProviderIds: { Tvdb: 'series' },
        ProviderIds: { Tvdb: 'not-a-season-identity' },
        IndexNumber: 1,
      },
      { Id: 's5', Type: 'Video', Path: '\\old\\special\\media\\file.mkv' },
    ];
    const mappings = [
      { source: '/old', target: '/wrong' },
      { source: '/old/special', target: '/longest' },
    ];
    const path = fixture(target);
    await buildJellyfinCatalogIndex(path);
    const candidates = await readJellyfinCatalogCandidates(path, source, mappings);
    expect(new Set(candidates.map((item) => item.Id))).toEqual(
      new Set([id(1), id(2), id(4), id(6), id(7)]),
    );
    expect(createMatcher(candidates, mappings)(source).matches).toHaveLength(5);
  });

  it('deduplicates repeated source keys on disk and reads only selected rows from a large unrelated catalog', async () => {
    const target = Array.from({ length: 30_000 }, (_, index) => movie(index + 1));
    const path = fixture(target);
    const built = await buildJellyfinCatalogIndex(path);
    expect(built).toEqual({ rows: 30_000, keys: 60_000 });
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const progress = vi.fn();
    const candidates = await readJellyfinCatalogCandidates(
      path,
      Array.from({ length: 2500 }, () => ({
        Id: 'source',
        Type: 'Movie',
        ProviderIds: { Tmdb: '15000' },
      })),
      [],
      { onProgress: progress },
    );
    expect(candidates.map((item) => item.Id)).toEqual([id(15_000)]);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ keys: 1, items: 1 });
    const queries = prepare.mock.calls.map(([sql]) => sql);
    expect(
      queries.some(
        (sql) =>
          sql.includes('FROM catalog_keys k CROSS JOIN catalog_items c') &&
          sql.includes('WHERE k.key=?'),
      ),
    ).toBe(true);
    expect(queries.some((sql) => /FROM catalog_items ORDER BY/.test(sql))).toBe(false);
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
  });

  it('atomically rolls back a canceled index build and can subsequently build and read it', async () => {
    const path = fixture(Array.from({ length: 2500 }, (_, index) => movie(index + 1)));
    const controller = new AbortController();
    await expect(
      buildJellyfinCatalogIndex(path, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow('canceled');
    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name IN ('catalog_keys','catalog_index')",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
    await buildJellyfinCatalogIndex(path);
    expect(await readJellyfinCatalogCandidates(path, [movie(123)])).toHaveLength(1);
  });

  it('preserves the previously completed index when rebuilding is canceled', async () => {
    const path = fixture(Array.from({ length: 1200 }, (_, index) => movie(index + 1)));
    await buildJellyfinCatalogIndex(path);
    const controller = new AbortController();
    await expect(
      buildJellyfinCatalogIndex(path, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow('canceled');
    expect(await readJellyfinCatalogCandidates(path, [movie(999)])).toHaveLength(1);
  });

  it('cancels during a large collision bucket without returning partial candidates', async () => {
    const path = fixture(Array.from({ length: 2500 }, (_, index) => movie(index + 1, 'shared')));
    await buildJellyfinCatalogIndex(path);
    const controller = new AbortController();
    const progress = vi.fn((value: { items: number }) => {
      if (value.items > 0) controller.abort();
    });
    await expect(
      readJellyfinCatalogCandidates(
        path,
        [{ Id: 'source', Type: 'Movie', ProviderIds: { Tmdb: 'shared' } }],
        [],
        { signal: controller.signal, onProgress: progress },
      ),
    ).rejects.toThrow('canceled');
    expect(progress.mock.calls.some(([value]) => value.items > 0 && value.items <= 1000)).toBe(
      true,
    );
  });

  it('fails rather than truncating item or byte limits, including parent-series dependencies', async () => {
    const target = [
      { Id: id(1), Type: 'Episode', ProviderIds: { Tvdb: 'episode' }, SeriesId: id(2) },
      { Id: id(2), Type: 'Series', ProviderIds: { Tvdb: 'series' } },
    ];
    const path = fixture(target);
    await buildJellyfinCatalogIndex(path);
    const source = [{ Id: 'source', Type: 'Episode', ProviderIds: { Tvdb: 'episode' } }];
    await expect(readJellyfinCatalogCandidates(path, source, [], { maxItems: 1 })).rejects.toThrow(
      'account size',
    );
    await expect(readJellyfinCatalogCandidates(path, source, [], { maxBytes: 10 })).rejects.toThrow(
      'account size',
    );
    await expect(
      readJellyfinCatalogCandidates(path, source, [], { maxItems: 200001 }),
    ).rejects.toThrow('invalid');
    await expect(
      readJellyfinCatalogCandidates(path, source, [], { maxBytes: 64 * 1024 * 1024 + 1 }),
    ).rejects.toThrow('invalid');
  });

  it('accepts empty catalogs and histories without scans or synthetic items', async () => {
    const path = fixture([]);
    expect(await buildJellyfinCatalogIndex(path)).toEqual({ rows: 0, keys: 0 });
    expect(await readJellyfinCatalogCandidates(path, [])).toEqual([]);
    expect(await readJellyfinCatalogCandidates(path, [movie(1)])).toEqual([]);
  });

  it('retains supported Unicode paths whose encoded keys exceed 32 KiB', async () => {
    const target = { Id: id(1), Type: 'Video', Path: `/synthetic/${'界'.repeat(12000)}.mkv` };
    const path = fixture([target]);
    await buildJellyfinCatalogIndex(path);
    expect(await readJellyfinCatalogCandidates(path, [{ ...target, Id: 'source' }])).toEqual([
      target,
    ]);
  });

  it('does not let failed progress observers change an index or candidate result', async () => {
    const path = fixture([movie(1)]);
    const observer = () => {
      throw new Error('synthetic observer failure');
    };
    await expect(buildJellyfinCatalogIndex(path, { onProgress: observer })).resolves.toEqual({
      rows: 1,
      keys: 2,
    });
    await expect(
      readJellyfinCatalogCandidates(path, [movie(1)], [], { onProgress: observer }),
    ).resolves.toEqual([movie(1)]);
  });

  it('rejects a parent dependency which is not a series even when already selected', async () => {
    const target = [
      { Id: id(1), Type: 'Episode', ProviderIds: { Tvdb: 'episode' }, SeriesId: id(2) },
      movie(2),
    ];
    const path = fixture(target);
    await buildJellyfinCatalogIndex(path);
    await expect(readJellyfinCatalogCandidates(path, target)).rejects.toThrow('invalid');
  });

  it.each([
    { Id: id(1), Type: 'Movie', UserData: { Played: true } },
    { Id: id(1), Type: 'Movie', ApiKey: 'synthetic-private-key' },
    { Id: id(1), Type: 'Movie', Path: 'synthetic\u0000private-path' },
    { Id: id(1), Type: 'Movie', SeriesId: 'invalid' },
    { Id: id(1), Type: 'UnknownType' },
  ])('rejects malformed or personal fields with a fixed safe error', async (item) => {
    const path = fixture([item]);
    await expect(buildJellyfinCatalogIndex(path)).rejects.toThrow(
      'The saved Jellyfin matching index is invalid. Import its backup again.',
    );
  });

  it('rejects unindexed, non-STRICT and symbolic-link projections', async () => {
    const path = fixture([movie(1)]);
    await expect(readJellyfinCatalogCandidates(path, [movie(1)])).rejects.toThrow('invalid');
    const link = join(directories.at(-1)!, 'link.db');
    symlinkSync(path, link);
    await expect(buildJellyfinCatalogIndex(link)).rejects.toThrow('invalid');
    const database = new DatabaseSync(path);
    database.exec(
      'ALTER TABLE catalog_items RENAME TO old_items; CREATE TABLE catalog_items(id TEXT PRIMARY KEY,item TEXT NOT NULL);',
    );
    database.close();
    await expect(buildJellyfinCatalogIndex(path)).rejects.toThrow('invalid');
  });
});
