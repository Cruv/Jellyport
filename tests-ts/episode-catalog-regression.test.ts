import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildJellyfinCatalogIndex,
  readJellyfinCatalogCandidates,
} from '../server/jellyfin-catalog-index.js';
import { createMatcher, type MatchPlan } from '../server/matching.js';
import { MediaClient, type MediaItem } from '../server/media.js';

const directories: string[] = [];
const id = (value: number) => value.toString(16).padStart(32, '0');
const mappings = [{ source: '/source', target: '/target' }];
const showIds = {
  Tvdb: 'synthetic-show',
  Imdb: 'synthetic-show-imdb',
  Tmdb: 'synthetic-show-tmdb',
};
const episodeIds = { Tvdb: 'synthetic-episode-13', Imdb: 'synthetic-shared-episode-imdb' };
const parent: MediaItem = {
  Id: id(500),
  Type: 'Series',
  Name: 'Synthetic Original Show',
  ProviderIds: showIds,
};

function source(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    Id: 'synthetic-source-episode',
    Type: 'Episode',
    Name: 'Synthetic Revisit Three',
    SeriesName: parent.Name,
    SeriesProviderIds: { ...showIds },
    ProviderIds: { ...episodeIds },
    ParentIndexNumber: 2,
    IndexNumber: 13,
    Path: '/source/tv/Original Show/Season 02/S02E13.mkv',
    UserData: { Played: true },
    ...overrides,
  };
}

function episode(value: number, overrides: Partial<MediaItem> = {}): MediaItem {
  const { UserData: _state, ...identity } = source();
  return {
    ...identity,
    Id: id(value),
    SeriesId: parent.Id,
    Path: '/target/tv/Original Show/Season 02/S02E13.mkv',
    ...overrides,
  };
}

function collision(): MediaItem {
  return episode(10, {
    Name: 'Synthetic Revisit Two',
    IndexNumber: 10,
    ProviderIds: { ...episodeIds, Tvdb: 'synthetic-episode-10' },
    Path: '/target/tv/Original Show/Season 02/S02E10.mkv',
  });
}

function catalog(items: MediaItem[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-episode-catalog-'));
  directories.push(directory);
  const path = join(directory, 'catalog.db');
  const database = new DatabaseSync(path);
  try {
    database.exec(
      'CREATE TABLE catalog_items(id TEXT PRIMARY KEY,item TEXT NOT NULL) STRICT; BEGIN;',
    );
    const insert = database.prepare('INSERT INTO catalog_items VALUES (?,?)');
    for (const item of items) insert.run(item.Id, JSON.stringify(item));
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  return path;
}

function summary(plan: MatchPlan) {
  return {
    matches: plan.matches.map((match) => ({
      source: match.source.Id,
      target: match.target.Id,
      method: match.method,
    })),
    unmatched: plan.unmatched.map((item) => item.Id),
    ambiguous: plan.ambiguous.map((match) => ({
      source: match.source.Id,
      candidates: match.candidates.map((item) => item.Id).sort(),
      method: match.method,
      reasons: match.reason_codes,
      path_resolution: match.path_resolution,
    })),
  };
}

async function indexedPlan(
  input: MediaItem,
  target: MediaItem[],
  accessibleIds = new Set(target.map((item) => item.Id)),
) {
  const path = catalog(target);
  await buildJellyfinCatalogIndex(path);
  const progress = vi.fn();
  const candidates = await readJellyfinCatalogCandidates(path, [input], mappings, {
    maxItems: 20,
    onProgress: progress,
  });
  const expectedUnion = createMatcher(target, mappings).candidates([input]);
  const unionIds = new Set(expectedUnion.map((item) => item.Id));
  for (const item of expectedUnion)
    if (item.SeriesId && target.some((parent) => parent.Id === item.SeriesId))
      unionIds.add(item.SeriesId);
  expect(new Set(candidates.map((item) => item.Id))).toEqual(unionIds);
  expect(new Set(candidates.map((item) => item.Id)).size).toBe(candidates.length);
  const calls: URL[] = [];
  const client = new MediaClient('https://jellyfin.invalid', 'synthetic-api-key', 'jellyfin', {
    transport: async (address, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = new URL(address);
      calls.push(url);
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status });
      if (url.pathname === '/Users/synthetic-viewer')
        return json({
          Id: 'synthetic-viewer',
          Name: 'Synthetic viewer',
          Policy: { EnableAllFolders: false, EnabledFolders: [], BlockedMediaFolders: [] },
        });
      if (url.pathname === '/Library/VirtualFolders') return json([]);
      const probe = /^\/UserItems\/([^/]+)\/UserData$/.exec(url.pathname);
      if (probe)
        return accessibleIds.has(probe[1]!)
          ? json({ ItemId: probe[1], Played: false })
          : json({}, 404);
      if (url.pathname === '/Users/synthetic-viewer/Items') {
        const ids = url.searchParams.get('Ids')!.split(',');
        expect(ids.every((itemId) => accessibleIds.has(itemId))).toBe(true);
        expect(Number(url.searchParams.get('Limit'))).toBe(ids.length);
        expect(url.searchParams.has('Recursive')).toBe(false);
        expect(url.searchParams.has('SortBy')).toBe(false);
        // Explicit-ID reads are deliberately permissive. If access filtering ever
        // sends a forbidden item, this server would return it rather than hide it.
        return json({
          Items: ids.map((itemId) => ({
            ...target.find((item) => item.Id === itemId),
            UserData: { Played: false },
          })),
        });
      }
      throw new Error('Unexpected synthetic destination request.');
    },
  });
  let scoped: MediaItem[];
  try {
    scoped = await client.destinationItems('synthetic-viewer', candidates);
  } finally {
    await client.close();
  }
  const probes = calls
    .map((url) => /^\/UserItems\/([^/]+)\/UserData$/.exec(url.pathname)?.[1])
    .filter(Boolean);
  expect(probes.sort()).toEqual(candidates.map((item) => item.Id).sort());
  const plan = createMatcher(scoped, mappings)([input]);
  const memoryPlan = createMatcher(
    target.filter((item) => accessibleIds.has(item.Id)),
    mappings,
  )([input]);
  expect(summary(plan)).toEqual(summary(memoryPlan));
  expect(input.UserData).toEqual({ Played: true });
  for (const match of plan.matches) {
    expect(match.source.UserData?.Played).toBe(true);
    expect(match.target.UserData?.Played).toBe(false);
  }
  return { plan, candidates, scoped, progress, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('access-scoped episode identity through a saved destination catalog', () => {
  it('retains the shared-provider collision in the disk union but matches the correct full episode context', async () => {
    const input = source();
    const right = episode(13);
    const unrelated = Array.from({ length: 250 }, (_, index) =>
      episode(1000 + index, {
        ProviderIds: { Tvdb: `unrelated-${index}` },
        ParentIndexNumber: 9,
        IndexNumber: index,
        Path: `/target/unrelated/${index}.mkv`,
      }),
    );
    const { plan, candidates, progress } = await indexedPlan(input, [
      collision(),
      right,
      parent,
      ...unrelated,
    ]);
    expect(candidates.map((item) => item.Id).sort()).toEqual([id(10), id(13), parent.Id].sort());
    expect(progress.mock.lastCall?.[0]).toMatchObject({ items: 3 });
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({
      target: { Id: right.Id },
      method: 'series_episode+provider_id',
    });
  });

  it('cannot select the correct episode when that account cannot access it, nor substitute the colliding ordinal', async () => {
    const wrong = collision();
    const right = episode(13);
    const { plan, scoped, calls } = await indexedPlan(
      source(),
      [wrong, right, parent],
      new Set([wrong.Id, parent.Id]),
    );
    expect(scoped.some((item) => item.Id === right.Id)).toBe(false);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0]!.reason_codes).toContain('numbering_conflict');
    expect(
      calls
        .filter((url) => url.pathname.endsWith('/Items'))
        .every((url) => !url.searchParams.get('Ids')!.split(',').includes(right.Id)),
    ).toBe(true);
  });

  it.each(['hd', '4k', 'both'] as const)(
    'selects only permitted editions with %s library access',
    async (access) => {
      const hd = episode(13);
      const ultra = episode(14, { Path: '/target/tv-4k/Original Show/Season 02/S02E13.mkv' });
      const allowed = new Set([
        parent.Id,
        ...(access !== '4k' ? [hd.Id] : []),
        ...(access !== 'hd' ? [ultra.Id] : []),
      ]);
      const { plan } = await indexedPlan(source(), [collision(), hd, ultra, parent], allowed);
      expect(plan.matches).toHaveLength(1);
      expect(plan.matches[0]!.target.Id).toBe(access === '4k' ? ultra.Id : hd.Id);
      expect(plan.matches[0]!.method).toBe(
        access === 'both' ? 'series_episode+provider_id+path' : 'series_episode+provider_id',
      );
      expect(plan.ambiguous).toEqual([]);
    },
  );

  it('keeps duplicate full ordinals ambiguous when no exact path selects one permitted edition', async () => {
    const first = episode(13);
    const second = episode(14, { Path: '/target/alternate/S02E13.mkv' });
    const { plan } = await indexedPlan(source({ Path: undefined }), [
      collision(),
      first,
      second,
      parent,
    ]);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0]).toMatchObject({
      method: 'series_episode',
      reason_codes: ['duplicate_series_episode'],
      path_resolution: 'missing_source_path',
    });
    expect(plan.ambiguous[0]!.candidates.map((item) => item.Id).sort()).toEqual([
      first.Id,
      second.Id,
    ]);
  });

  it.each([true, false])(
    'never selects a conflicting remake when original access is %s',
    async (originalAccess) => {
      const original = episode(13);
      const remake = episode(14, {
        SeriesName: 'Synthetic Remake',
        SeriesProviderIds: { ...showIds, Tvdb: 'synthetic-remake-show' },
        Path: '/target/remake/S02E13.mkv',
      });
      const allowed = new Set([remake.Id, parent.Id, ...(originalAccess ? [original.Id] : [])]);
      const { plan } = await indexedPlan(source(), [original, remake, parent], allowed);
      expect(plan.matches.some((match) => match.target.Id === remake.Id)).toBe(false);
      if (originalAccess) {
        expect(plan.matches).toHaveLength(1);
        expect(plan.matches[0]!.target.Id).toBe(original.Id);
        expect(plan.ambiguous).toEqual([]);
      } else {
        expect(plan.matches).toEqual([]);
        expect(plan.ambiguous).toHaveLength(1);
        expect(plan.ambiguous[0]!.reason_codes).toContain('provider_conflict');
      }
    },
  );

  it('compares the complete episode range before considering an individual episode provider collision', async () => {
    const input = source({ IndexNumberEnd: 14 });
    const combined = episode(14, { IndexNumberEnd: 14 });
    const single = episode(13);
    const { plan } = await indexedPlan(input, [single, combined, parent]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({
      target: { Id: combined.Id },
      method: 'series_episode+provider_id',
    });
    expect(plan.ambiguous).toEqual([]);
  });

  it('retains own-provider alias conflicts inside an otherwise exact episode context', async () => {
    const contradictory = episode(13, {
      ProviderIds: { ...episodeIds, TheTvdb: 'synthetic-conflicting-alias' },
    });
    const { plan } = await indexedPlan(source(), [collision(), contradictory, parent]);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0]!.reason_codes).toContain('provider_conflict');
  });
});
