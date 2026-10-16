import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MediaClient, type MediaItem } from '../server/media.js';
import { createMatcher } from '../server/matching.js';
import { MigrationCatalogCache } from '../server/migration-catalog.js';
import { mergeUserData, statePlan } from '../server/migration.js';
import { DEFAULT_SETTINGS } from '../server/store.js';

// Synthetic-only: no production URL, path, credential or external input is accepted.
// The injected transport below cannot contact a media server or perform a mutation.
if (process.argv.length > 2) throw new Error('This benchmark accepts no arguments.');
const CATALOG_ITEMS = 100_000;
const USERS = 100;
const ITEMS_PER_USER = 200;
const PREVIOUS_PAGE_SIZE = 500;
const CATALOG_PAGE_SIZE = 100;
const fixtureStarted = performance.now();
const fixture: MediaItem[] = Array.from({ length: CATALOG_ITEMS }, (_, index) => ({
  Id: (index + 1).toString(16).padStart(32, '0'),
  Name: `Synthetic movie ${index + 1}`,
  Type: 'Movie',
  Path: `/synthetic/library/movie-${index + 1}.mkv`,
  ProviderIds: { Tmdb: String(index + 1) },
}));
const byId = new Map(fixture.map((item) => [item.Id, item]));
const fixtureMs = performance.now() - fixtureStarted;
let catalogCalls = 0;
let stateCalls = 0;
let returnedCatalogItems = 0;
let returnedStateItems = 0;
let maxStateBatch = 0;
let maxCatalogBatch = 0;
let cacheHits = 0;
const client = new MediaClient('http://synthetic.invalid', 'synthetic-benchmark-key', 'jellyfin', {
  catalogIdleMs: 0,
  transport: async (address, options) => {
    assert.equal(options.method, 'GET', 'The benchmark must remain read-only.');
    const url = new URL(address);
    assert.equal(url.hostname, 'synthetic.invalid');
    let Items: MediaItem[];
    if (url.pathname === '/Items') {
      catalogCalls++;
      assert.equal(url.searchParams.get('EnableUserData'), 'false');
      assert.equal(url.searchParams.get('EnableTotalRecordCount'), 'false');
      assert.equal(url.searchParams.get('CollapseBoxSetItems'), 'false');
      const start = Number(url.searchParams.get('StartIndex'));
      const limit = Number(url.searchParams.get('Limit'));
      assert.equal(limit, CATALOG_PAGE_SIZE);
      maxCatalogBatch = Math.max(maxCatalogBatch, limit);
      Items = fixture.slice(start, start + limit);
      returnedCatalogItems += Items.length;
    } else {
      assert.match(url.pathname, /^\/Users\/synthetic-user-\d+\/Items$/);
      stateCalls++;
      assert.equal(url.searchParams.has('Recursive'), false);
      assert.equal(url.searchParams.has('SortBy'), false);
      assert.equal(url.searchParams.has('StartIndex'), false);
      assert.equal(url.searchParams.get('EnableTotalRecordCount'), 'false');
      const ids = url.searchParams.get('Ids')!.split(',');
      assert.ok(ids.length <= 100, 'State requests must remain bounded to 100 IDs.');
      assert.equal(Number(url.searchParams.get('Limit')), ids.length);
      maxStateBatch = Math.max(maxStateBatch, ids.length);
      Items = ids.map((id) => ({
        ...byId.get(id)!,
        UserData: {
          Played: true,
          PlayCount: 9,
          LastPlayedDate: '2026-10-02T12:00:00.000Z',
          PlaybackPositionTicks: 40_000_000,
        },
      }));
      returnedStateItems += Items.length;
    }
    return Response.json({ Items });
  },
});
const cache = new MigrationCatalogCache({
  hit: () => cacheHits++,
  reuseTtlFromCompletion: true,
});
const key = MigrationCatalogCache.key(
  'http://synthetic.invalid',
  'synthetic-benchmark-key',
  'synthetic-server',
  'synthetic-version',
);
try {
  const started = performance.now();
  const catalogStarted = performance.now();
  const catalog = await cache.get(key, () => client.catalogItems());
  assert.equal(catalog.items.length, CATALOG_ITEMS);
  assert.ok(catalog.items.every((item) => !Object.hasOwn(item, 'UserData')));
  const catalogMs = performance.now() - catalogStarted;
  const matchingStarted = performance.now();
  const matcher = createMatcher(catalog.items, []);
  const matchingMs = performance.now() - matchingStarted;
  let matched = 0;
  let proposedChanges = 0;
  for (let user = 0; user < USERS; user++) {
    assert.equal(await cache.get(key, () => client.catalogItems()), catalog);
    const source: MediaItem[] = Array.from({ length: ITEMS_PER_USER }, (_, index) => ({
      ...fixture[user * ITEMS_PER_USER + index]!,
      Id: `source-${user}-${index}`,
      UserData: {
        Played: true,
        PlayCount: 4,
        LastPlayedDate: '2026-10-01T12:00:00.000Z',
        PlaybackPositionTicks: 0,
      },
    }));
    const candidates = matcher.candidates(source);
    assert.equal(candidates.length, ITEMS_PER_USER);
    const destination = await client.destinationItems(`synthetic-user-${user}`, candidates);
    const plan = statePlan(source, destination, DEFAULT_SETTINGS);
    assert.equal(plan.matches.length, ITEMS_PER_USER);
    assert.equal(plan.ambiguous.length, 0);
    assert.equal(plan.unmatched.length, 0);
    matched += plan.matches.length;
    proposedChanges += plan.matches.filter(
      ({ source: from, target: to }) => Object.keys(mergeUserData(from, to)).length,
    ).length;
  }
  assert.equal(catalogCalls, CATALOG_ITEMS / CATALOG_PAGE_SIZE + 1);
  assert.equal(stateCalls, USERS * (ITEMS_PER_USER / 100));
  assert.equal(returnedCatalogItems, CATALOG_ITEMS);
  assert.equal(returnedStateItems, USERS * ITEMS_PER_USER);
  assert.equal(cacheHits, USERS);
  assert.equal(proposedChanges, 0, 'Newer destination activity must remain unchanged.');
  const baselinePages = USERS * Math.ceil(CATALOG_ITEMS / PREVIOUS_PAGE_SIZE);
  console.log(
    JSON.stringify(
      {
        scope:
          'Synthetic matching and destination reads only; excludes source snapshot I/O and writes.',
        network: 'Injected in-memory transport; no media servers contacted.',
        catalog_items: CATALOG_ITEMS,
        users: USERS,
        relevant_items_per_user: ITEMS_PER_USER,
        observed: {
          catalog_api_calls: catalogCalls,
          destination_state_api_calls: stateCalls,
          total_api_calls: catalogCalls + stateCalls,
          metadata_items_returned: returnedCatalogItems,
          largest_catalog_batch: maxCatalogBatch,
          user_state_items_returned: returnedStateItems,
          largest_state_batch: maxStateBatch,
          cache_hits: cacheHits,
          matches: matched,
          proposed_changes_to_newer_history: proposedChanges,
        },
        calculated_previous_migration: {
          note: 'One full destination catalog per user; preview reads would add another pass.',
          catalog_api_calls: baselinePages,
          user_state_items_returned: USERS * CATALOG_ITEMS,
        },
        synthetic_timing_ms: {
          fixture: Number(fixtureMs.toFixed(1)),
          catalog: Number(catalogMs.toFixed(1)),
          matcher_build: Number(matchingMs.toFixed(1)),
          total: Number((performance.now() - started).toFixed(1)),
        },
        limitations:
          'Production catalog pacing is disabled for this synthetic run. Local timings do not predict production response time, memory peaks or playback impact.',
      },
      null,
      2,
    ),
  );
} finally {
  cache.clear();
  await client.close();
}
