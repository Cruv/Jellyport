import { describe, expect, it } from 'vitest';
import {
  createMatcher,
  diagnosticProviderIds,
  matchItems,
  MAX_AMBIGUOUS_CANDIDATES,
  MIGRATABLE_ITEM_TYPES,
} from '../server/matching.js';
import { MediaError } from '../server/errors.js';
import { MAX_CATALOG_ITEMS, type MediaItem } from '../server/media.js';

const item = (Id: string, fields: Partial<MediaItem> = {}): MediaItem => ({
  Id,
  Type: 'Movie',
  ...fields,
});
it.each(['constructor', '__proto__', 'toString'])(
  'does not inherit diagnostic provider allowlists for type %s',
  (type) => {
    expect(
      diagnosticProviderIds(
        item('source', { Type: type, ProviderIds: { Tmdb: '42' } }),
        'ProviderIds',
      ),
    ).toEqual({});
  },
);
const conflictDiagnostic = (method: string, reason_codes: string[]) => ({
  method,
  reason_codes,
  reason: expect.any(String),
  path_resolution: 'conflict_prevents_path_resolution',
});
describe('conservative media matching', () => {
  it('bounds display provider identities and excludes arbitrary plugin fields and objects', () => {
    const variants = Array.from({ length: 16 }, (_, mask) => [
      [...'tmdb'].map((char, index) => (mask & (1 << index) ? char.toUpperCase() : char)).join(''),
      'X'.repeat(300),
    ]);
    const source = item('source', {
      ProviderIds: {
        PrivatePluginCredential: 'PRIVATE',
        Nested: { secret: 'PRIVATE_OBJECT' },
        ...Object.fromEntries(variants),
        Imdb: 'tt42',
      },
    });
    const ids = diagnosticProviderIds(source, 'ProviderIds');
    expect(Object.keys(ids)).toHaveLength(16);
    expect(Object.values(ids).every((value) => value.length === 128)).toBe(true);
    expect(JSON.stringify(ids)).not.toContain('PRIVATE');
    expect(ids.Imdb).toBeUndefined();
  });
  it('explains duplicate provider identities and the actual failed path narrowing', () => {
    const targets = [
      item('first', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/first.mkv' }),
      item('second', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/second.mkv' }),
    ];
    for (const [Path, path_resolution] of [
      [undefined, 'missing_source_path'],
      ['/other/movie.mkv', 'no_candidate_at_path'],
    ] as const) {
      const source = item('source', { ProviderIds: { Imdb: 'tt42' }, Path });
      expect(matchItems([source], targets).ambiguous).toEqual([
        {
          source,
          candidates: targets,
          method: 'provider_id',
          reason_codes: ['duplicate_provider_id'],
          path_resolution,
          reason:
            Path === undefined
              ? 'Several Jellyfin items share a matching provider ID. The source has no file path to select one.'
              : 'Several Jellyfin items share a matching provider ID. None has the source’s exact mapped file path.',
        },
      ]);
    }
    const source = item('source', { ProviderIds: { Imdb: 'tt42' }, Path: targets[0]!.Path });
    expect(matchItems([source], targets).matches).toEqual([
      { source, target: targets[0], method: 'provider_id+path' },
    ]);
  });
  it('does not call independent provider hits a duplicated provider ID', () => {
    const source = item('source', { ProviderIds: { Imdb: 'tt42', Tmdb: '500' } });
    const targets = [
      item('imdb-result', { ProviderIds: { Imdb: 'tt42' } }),
      item('tmdb-result', { ProviderIds: { Tmdb: '500' } }),
    ];
    expect(matchItems([source], targets).ambiguous[0]).toMatchObject({
      source,
      candidates: targets,
      method: 'provider_id',
      reason_codes: ['competing_provider_matches'],
      path_resolution: 'missing_source_path',
      reason:
        'Different matching provider IDs select different Jellyfin items. The source has no file path to select one.',
    });
  });
  it('reports provider and numbering conflicts together even with one exact-path candidate', () => {
    const source = item('episode', {
      Type: 'Episode',
      ProviderIds: { Tvdb: '555' },
      SeriesProviderIds: { Tvdb: '100' },
      ParentIndexNumber: 1,
      IndexNumber: 2,
      Path: '/media/show/episode.mkv',
    });
    const target = item('wrong-episode', {
      ...source,
      Id: 'wrong-episode',
      IndexNumber: 3,
      SeriesProviderIds: { Tvdb: '200' },
    });
    expect(matchItems([source], [target]).ambiguous).toEqual([
      {
        source,
        candidates: [target],
        method: 'provider_id',
        reason_codes: ['numbering_conflict', 'provider_conflict'],
        reason:
          'Provider IDs disagree or contain contradictory aliases; episode or season numbering also disagrees. An exact path cannot override conflicting identity metadata.',
        path_resolution: 'conflict_prevents_path_resolution',
      },
    ]);
  });
  it('stops compatibility diagnostics at the first provider conflict when complete series context is unavailable', () => {
    const source = item('source', {
      Type: 'Episode',
      ProviderIds: { Tvdb: '555' },
      ParentIndexNumber: 1,
      IndexNumber: 2,
    });
    const first = item('first', {
      ...source,
      Id: 'first',
      IndexNumber: 3,
      SeriesProviderIds: { Tvdb: '200' },
    });
    let indexed = false;
    let laterCompatibilityReads = 0;
    const later = item('later', { ...source, Id: 'later' });
    Object.defineProperty(later, 'ProviderIds', {
      enumerable: true,
      get() {
        if (indexed) {
          laterCompatibilityReads++;
          throw new Error('Later collision candidates must not be inspected after a conflict.');
        }
        return { Tvdb: '555' };
      },
    });
    const matcher = createMatcher([first, later]);
    indexed = true;
    const plan = matcher([source]);
    expect(plan.matches).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0]?.source).toBe(source);
    expect(plan.ambiguous[0]?.candidates).toHaveLength(2);
    expect(plan.ambiguous[0]?.candidates[0]).toBe(first);
    expect(plan.ambiguous[0]?.candidates[1]).toBe(later);
    expect(plan.ambiguous[0]?.reason_codes).toEqual(['numbering_conflict']);
    expect(laterCompatibilityReads).toBe(0);
  });
  it('retains the media type conflict guard when a prepared matcher target is mutated', () => {
    const source = item('source', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/movie.mkv' });
    const target = item('target', { ProviderIds: { Imdb: 'tt42' }, Path: source.Path });
    const matcher = createMatcher([target]);
    target.Type = 'Episode';
    expect(matcher([source])).toEqual({
      matches: [],
      unmatched: [],
      ambiguous: [
        {
          source,
          candidates: [target],
          method: 'provider_id',
          reason_codes: ['media_type_conflict'],
          reason:
            'Media types disagree. An exact path cannot override conflicting identity metadata.',
          path_resolution: 'conflict_prevents_path_resolution',
        },
      ],
    });
  });
  it('explains series-plus-number and exact-path collisions without using titles or years', () => {
    for (const Type of ['Episode', 'Season']) {
      const source = item('source', {
        Type,
        Name: 'Same title',
        ProductionYear: 2001,
        SeriesName: 'An identified show',
        SeriesProviderIds: { Tvdb: '100' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
        IndexNumberEnd: 3,
      });
      const targets = [
        item('a', { ...source, Id: 'a' }),
        item('b', { ...source, Id: 'b', ProductionYear: 2024 }),
      ];
      expect(matchItems([source], targets).ambiguous[0]).toMatchObject({
        source,
        candidates: targets,
        method: Type === 'Episode' ? 'series_episode' : 'series_season',
        reason_codes: [Type === 'Episode' ? 'duplicate_series_episode' : 'duplicate_series_season'],
        path_resolution: 'missing_source_path',
      });
    }
    const source = item('path-source', { Path: '/media/movie.mkv' });
    const targets = [item('a', { Path: source.Path }), item('b', { Path: source.Path })];
    expect(matchItems([source], targets).ambiguous[0]).toMatchObject({
      source,
      candidates: targets,
      method: 'path',
      reason_codes: ['duplicate_path'],
      path_resolution: 'multiple_candidates_at_path',
      reason:
        'Several Jellyfin items share the same exact file path. Multiple candidates also share the exact mapped file path.',
    });
  });
  it('retains provider, series and mapped path fallbacks before checking destination access', () => {
    const movie = item('source-movie', {
      ProviderIds: { Imdb: 'tt42' },
      Path: '/emby/movie.mkv',
    });
    const episode = item('source-episode', {
      Type: 'Episode',
      ProviderIds: { Tvdb: '555' },
      SeriesProviderIds: { Tvdb: '100' },
      ParentIndexNumber: 1,
      IndexNumber: 2,
      Path: '/emby/episode.mkv',
    });
    const targets = [
      item('provider-movie', { ProviderIds: movie.ProviderIds }),
      item('path-movie', { Path: '/media/movie.mkv' }),
      item('provider-episode', { Type: 'Episode', ProviderIds: episode.ProviderIds }),
      item('series-episode', {
        Type: 'Episode',
        SeriesProviderIds: episode.SeriesProviderIds,
        ParentIndexNumber: 1,
        IndexNumber: 2,
      }),
      item('path-episode', { Type: 'Episode', Path: '/media/episode.mkv' }),
      item('unrelated', { ProviderIds: { Imdb: 'tt99' } }),
      item('wrong-type', { Type: 'Audio', Path: '/media/movie.mkv' }),
    ];
    const mappings = [{ source: '/emby', target: '/media' }];
    const match = createMatcher(targets, mappings);
    expect(match([movie, episode]).matches.map(({ target }) => target.Id)).toEqual([
      'provider-movie',
      'series-episode',
    ]);
    expect(match.candidates([movie, episode])).toEqual(targets.slice(0, 5));
    const accessible = match
      .candidates([movie, episode])
      .filter((target) => !target.Id.startsWith('provider-'));
    expect(
      createMatcher(
        accessible,
        mappings,
      )([movie, episode]).matches.map(({ target, method }) => [target.Id, method]),
    ).toEqual([
      ['path-movie', 'path'],
      ['series-episode', 'series_episode'],
    ]);
    const onlyPaths = accessible.filter((target) => target.Id.startsWith('path-'));
    expect(createMatcher(onlyPaths, mappings)([episode]).matches[0]?.target.Id).toBe(
      'path-episode',
    );
  });

  it('keeps narrowed, ambiguous and contradictory identity candidates without admitting unrelated items', () => {
    const exact = item('source', {
      ProviderIds: { Imdb: 'tt42' },
      Path: '/media/movie.mkv',
    });
    const targets = [
      item('first', { ProviderIds: exact.ProviderIds, Path: exact.Path }),
      item('second', { ProviderIds: exact.ProviderIds, Path: '/media/movie-4k.mkv' }),
      item('path-only', { Path: exact.Path }),
      item('unrelated', { ProviderIds: { Imdb: 'tt99' } }),
      item('unsupported', { Type: 'Folder', Path: exact.Path }),
    ];
    const match = createMatcher(targets);
    expect(match([exact]).matches[0]?.target.Id).toBe('first');
    expect(match.candidates([exact])).toEqual(targets.slice(0, 3));
    const withoutPath = { ...exact, Path: undefined };
    expect(match([withoutPath]).ambiguous[0]?.candidates).toEqual(targets.slice(0, 2));
    expect(match.candidates([withoutPath])).toEqual(targets.slice(0, 2));
    const contradictory = { ...exact, ProviderIds: { Imdb: 'tt42', Tmdb: '50' } };
    const conflict = item('conflict', {
      ProviderIds: { Imdb: 'tt42', Tmdb: '99' },
      Path: exact.Path,
    });
    const conflicts = createMatcher([conflict, ...targets]);
    expect(conflicts([contradictory]).ambiguous[0]?.candidates).toEqual([
      conflict,
      targets[0],
      targets[1],
    ]);
    expect(conflicts.candidates([contradictory])).toEqual([conflict, ...targets.slice(0, 3)]);
  });

  it('produces the same final plan as a complete user catalog for every candidate-access subset', () => {
    const source = [
      item('movie', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/movie.mkv' }),
      item('episode', {
        Type: 'Episode',
        ProviderIds: { Tvdb: '555' },
        SeriesProviderIds: { Tvdb: '100' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
        Path: '/media/episode.mkv',
      }),
      item('season', {
        Type: 'Season',
        SeriesProviderIds: { Tvdb: '100' },
        IndexNumber: 1,
        Path: '/media/season',
      }),
    ];
    const targets = [
      item('movie-provider', { ProviderIds: source[0]!.ProviderIds }),
      item('movie-path', { Path: source[0]!.Path }),
      item('episode-provider', { Type: 'Episode', ProviderIds: source[1]!.ProviderIds }),
      item('episode-series', { ...source[1], Id: 'episode-series', ProviderIds: {} }),
      item('episode-conflict', { ...source[1], Id: 'episode-conflict', IndexNumber: 3 }),
      item('episode-path', { Type: 'Episode', Path: source[1]!.Path }),
      item('season-series', { ...source[2], Id: 'season-series', Path: undefined }),
      item('season-path', { Type: 'Season', Path: source[2]!.Path }),
      item('unrelated', { Path: '/elsewhere' }),
    ];
    const candidates = createMatcher(targets).candidates(source);
    expect(candidates).toEqual(targets.slice(0, 8));
    for (let mask = 0; mask < 1 << candidates.length; mask++) {
      const allowed = new Set(candidates.filter((_, index) => mask & (1 << index)));
      allowed.add(targets.at(-1)!);
      const completeAccessible = targets.filter((target) => allowed.has(target));
      const selectedAccessible = candidates.filter((target) => allowed.has(target));
      expect(createMatcher(selectedAccessible)(source)).toEqual(
        createMatcher(completeAccessible)(source),
      );
    }
  });

  it('deduplicates candidate work and returns independent arrays in original catalog order', () => {
    const targets = [
      item('first', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/movie.mkv' }),
      item('second', { ProviderIds: { Imdb: 'tt42' } }),
    ];
    const match = createMatcher(targets);
    const source = Array.from({ length: 200 }, (_, index) =>
      item(`source-${index}`, { ProviderIds: { Imdb: 'tt42' }, Path: targets[0]!.Path }),
    );
    expect(match.candidates(source)).toEqual(targets);
    const first = match.candidates(source);
    first.length = 0;
    expect(match.candidates(source)).toEqual(targets);
    expect(match.candidates([])).toEqual([]);
    expect(match.candidates([item('folder', { Type: 'Folder', Path: targets[0]!.Path })])).toEqual(
      [],
    );
  });

  it('bounds retained unique candidates even when all catalog items collide', () => {
    const targets = Array.from({ length: MAX_CATALOG_ITEMS + 1 }, (_, index) =>
      item(`target-${index}`, { ProviderIds: { Imdb: 'same-id' } }),
    );
    const source = [item('source', { ProviderIds: { Imdb: 'same-id' } })];
    expect(createMatcher(targets.slice(0, MAX_CATALOG_ITEMS)).candidates(source)).toHaveLength(
      MAX_CATALOG_ITEMS,
    );
    expect(() => createMatcher(targets).candidates(source)).toThrow(
      'The migration matching candidates exceed the supported item limit.',
    );
  });

  it('retains complete ambiguous results exactly at the aggregate candidate bound', () => {
    const collisionSize = 2_000;
    const targets = Array.from({ length: collisionSize }, (_, index) =>
      item(`target-${index}`, {
        ProviderIds: { Imdb: 'same-id' },
        Path: `/media/${index}.mkv`,
      }),
    );
    const source = Array.from({ length: MAX_AMBIGUOUS_CANDIDATES / collisionSize }, (_, index) =>
      item(`source-${index}`, { ProviderIds: { Imdb: 'same-id' } }),
    );
    const match = createMatcher(targets);
    const plan = match([
      ...source,
      // Matching/path narrowing must remain available after the ambiguity budget is full.
      item('unique', { ProviderIds: { Imdb: 'same-id' }, Path: '/media/0.mkv' }),
    ]);
    expect(plan.ambiguous).toHaveLength(source.length);
    expect(plan.ambiguous.reduce((total, entry) => total + entry.candidates.length, 0)).toBe(
      MAX_AMBIGUOUS_CANDIDATES,
    );
    expect(plan.ambiguous[0]!.candidates).toEqual(targets);
    expect(plan.ambiguous.at(-1)!.candidates).toEqual(targets);
    expect(plan.matches).toEqual([
      {
        source: expect.objectContaining({ Id: 'unique' }),
        target: targets[0],
        method: 'provider_id+path',
      },
    ]);
    // The bound belongs to each plan, not to the reusable destination index.
    expect(match([source[0]!]).ambiguous[0]!.candidates).toEqual(targets);
  });

  it('fails closed when high-collision history would exceed retained ambiguous candidates', () => {
    const collisionSize = 2_000;
    const targets = Array.from({ length: collisionSize }, (_, index) =>
      item(`target-${index}`, { ProviderIds: { Imdb: 'same-id' } }),
    );
    const source = Array.from(
      { length: MAX_AMBIGUOUS_CANDIDATES / collisionSize + 1 },
      (_, index) => item(`source-${index}`, { ProviderIds: { Imdb: 'same-id' } }),
    );
    const match = createMatcher(targets);
    let failure: unknown;
    try {
      match(source);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MediaError);
    expect(failure).toMatchObject({
      message:
        'The migration matching plan contains too many ambiguous candidates. Resolve duplicate media identities before retrying.',
    });
  });

  it('indexes a large destination once across one hundred independent user plans', () => {
    const catalogSize = 85_000;
    const historySize = 250;
    let pathReads = 0;
    let providerReads = 0;
    const targets = Array.from({ length: catalogSize }, (_, index) => ({
      Id: `target-${index}`,
      Type: 'Movie',
      get Path() {
        pathReads++;
        return `/media/${index}.mkv`;
      },
      get ProviderIds() {
        providerReads++;
        return { Imdb: `tt${index}` };
      },
    }));
    const match = createMatcher(targets);
    expect(pathReads).toBe(catalogSize);
    expect(providerReads).toBe(catalogSize);
    for (let user = 0; user < 100; user++) {
      const source = Array.from({ length: historySize }, (_, index) => ({
        Id: `source-${user}-${index}`,
        Type: 'Movie',
        Path: `/media/${index}.mkv`,
        ProviderIds: { Imdb: `tt${index}` },
        UserData: { Played: true },
      }));
      expect(match.candidates(source)).toEqual(targets.slice(0, historySize));
      const plan = match(source);
      expect(plan.matches).toHaveLength(historySize);
      expect(plan.unmatched).toHaveLength(0);
      expect(plan.ambiguous).toHaveLength(0);
      expect(plan.matches[0]!.source.Id).toBe(`source-${user}-0`);
      // Destination metadata is shared, while every plan retains only its own source state.
      expect(plan.matches[0]!.target).toBe(targets[0]);
    }
    expect(pathReads).toBe(catalogSize);
    // A unique lookup checks its one candidate, never rescans the full library.
    expect(providerReads).toBe(catalogSize + 100 * historySize);
  });

  it('reuses destination indexes while keeping independent plans and conservative matches', () => {
    const targets = [
      item('movie', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/film.mkv' }),
      item('movie-4k', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/film-4k.mkv' }),
      item('episode', {
        Type: 'Episode',
        SeriesProviderIds: { Tvdb: '100' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
      }),
      item('photo', { Type: 'Photo', Path: '/media/photo.jpg' }),
    ];
    const mappings = [{ source: '/emby', target: '/media' }];
    const sources = [
      item('exact', { ProviderIds: { Imdb: 'tt42' }, Path: '/emby/film.mkv' }),
      item('ambiguous', { ProviderIds: { Imdb: 'tt42' } }),
      item('episode-source', {
        Type: 'Episode',
        SeriesProviderIds: { TheTvdb: '100' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
      }),
      item('photo-source', { Type: 'Photo', Path: '/emby/photo.jpg' }),
      item('unmatched', { Name: 'Same title', ProviderIds: { Imdb: 'missing' } }),
      item('wrong-type', { Type: 'Audio', ProviderIds: { Imdb: 'tt42' } }),
      item('unsupported', { Type: 'Folder', Path: '/media/photo.jpg' }),
    ];
    const before = structuredClone({ targets, sources, mappings });
    const match = createMatcher(targets, mappings);
    const result = match(sources);
    expect(result).toEqual(matchItems(sources, targets, mappings));
    expect(result.matches.map((entry) => [entry.source.Id, entry.target.Id, entry.method])).toEqual(
      [
        ['exact', 'movie', 'provider_id+path'],
        ['episode-source', 'episode', 'series_episode'],
        ['photo-source', 'photo', 'path'],
      ],
    );
    expect(result.ambiguous[0]?.candidates).toEqual(targets.slice(0, 2));
    expect(result.unmatched.map((entry) => entry.Id)).toEqual([
      'unmatched',
      'wrong-type',
      'unsupported',
    ]);
    expect(match([sources[1]!])).toEqual(matchItems([sources[1]!], targets, mappings));
    result.matches.length = 0;
    result.ambiguous[0]!.candidates.length = 0;
    expect(match(sources).matches).toHaveLength(3);
    expect(match(sources).ambiguous[0]!.candidates).toHaveLength(2);
    expect({ targets, sources, mappings }).toEqual(before);
  });
  it('keeps prepared matchers scoped to their own destination catalog', () => {
    const source = item('source', { ProviderIds: { Imdb: 'tt42' } });
    const firstTarget = item('first-target', {
      ProviderIds: source.ProviderIds,
      UserData: { Played: true },
    });
    const secondTarget = item('second-target', {
      ProviderIds: source.ProviderIds,
      UserData: { Played: false },
    });
    const first = createMatcher([firstTarget]);
    const second = createMatcher([secondTarget]);
    expect(first([source]).matches[0]!.target).toBe(firstTarget);
    expect(second([source]).matches[0]!.target).toBe(secondTarget);
    expect(first([source]).matches[0]!.target.UserData).toEqual({ Played: true });
    expect(second([source]).matches[0]!.target.UserData).toEqual({ Played: false });
  });
  it('retains a prepared catalog order when the caller changes its array', () => {
    const source = item('source', { Path: '/media/film.mkv' });
    const target = item('target', { Path: source.Path });
    const targets = [target];
    const match = createMatcher(targets);
    targets.length = 0;
    expect(match([source]).matches).toEqual([{ source, target, method: 'path' }]);
  });
  it('matches provider identity despite title and server ID differences', () => {
    const source = item('s', { Name: 'Old title', ProviderIds: { IMDb: 'tt42', Tmdb: '17' } });
    const target = item('t', {
      Name: 'New title',
      ProviderIds: { imdb: 'TT42', TheMovieDB: '17' },
    });
    expect(matchItems([source], [target]).matches).toEqual([
      { source, target, method: 'provider_id' },
    ]);
  });
  it('does not guess from identical titles or release years', () => {
    const source = item('s', { Name: 'The Thing', ProductionYear: 1982 });
    expect(
      matchItems([source], [item('t', { Name: 'The Thing', ProductionYear: 1982 })]).unmatched,
    ).toEqual([source]);
  });
  it('ignores collection IDs and cannot cross media types', () => {
    const source = item('s', { ProviderIds: { TmdbCollection: '10', Imdb: 'tt42' } });
    expect(
      matchItems(
        [source],
        [
          item('e', { Type: 'Episode', ProviderIds: { Imdb: 'tt42' } }),
          item('t', { ProviderIds: { TmdbCollection: '10' } }),
        ],
      ).unmatched,
    ).toEqual([source]);
  });
  it('matches episodes by series identity and complete number range including season zero', () => {
    const source = item('s', {
      Type: 'Episode',
      SeriesProviderIds: { Tvdb: '100' },
      ParentIndexNumber: 0,
      IndexNumber: 1,
    });
    const target = item('t', {
      Type: 'Episode',
      SeriesProviderIds: { TheTvdb: '100' },
      ParentIndexNumber: '0',
      IndexNumber: '1',
    });
    const others = [
      item('regular', { ...target, Id: 'regular', ParentIndexNumber: 1 }),
      item('double', { ...target, Id: 'double', IndexNumberEnd: 2 }),
      item('other', { ...target, Id: 'other', SeriesProviderIds: { Tvdb: '200' } }),
    ];
    expect(matchItems([source], [target, ...others]).matches).toEqual([
      { source, target, method: 'series_episode' },
    ]);
  });
  it('keeps contradictory episode numbers ambiguous despite own provider identity', () => {
    const source = item('s', {
      Type: 'Episode',
      ProviderIds: { Tvdb: '555' },
      ParentIndexNumber: 1,
      IndexNumber: 1,
    });
    const target = item('t', { ...source, Id: 't', IndexNumber: 2 });
    expect(matchItems([source], [target]).ambiguous).toEqual([
      {
        source,
        candidates: [target],
        ...conflictDiagnostic('provider_id', ['numbering_conflict']),
      },
    ]);
  });
  it('requires episode numbers rather than only a shared series ID', () => {
    const source = item('s', {
      Type: 'Episode',
      SeriesProviderIds: { Tvdb: '100' },
      ParentIndexNumber: 1,
    });
    expect(matchItems([source], [item('t', { ...source, Id: 't' })]).unmatched).toEqual([source]);
  });
  it('does not treat boolean or negative episode numbers as valid', () => {
    for (const value of [true, false, -1, '1.2']) {
      const source = item('s', {
        Type: 'Episode',
        SeriesProviderIds: { Tvdb: '100' },
        ParentIndexNumber: 1,
        IndexNumber: value,
      });
      expect(matchItems([source], [item('t', { ...source, Id: 't' })]).matches).toEqual([]);
    }
  });
  it('uses exact mapped paths to disambiguate duplicate editions', () => {
    const source = item('s', { ProviderIds: { Imdb: 'tt42' }, Path: '/emby/film.mkv' });
    const a = item('a', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/film.mkv' }),
      b = item('b', { ProviderIds: { Imdb: 'tt42' }, Path: '/media/film-4k.mkv' });
    expect(matchItems([source], [a, b]).ambiguous[0]?.candidates).toEqual([a, b]);
    expect(matchItems([source], [a, b], [{ source: '/emby', target: '/media' }]).matches).toEqual([
      { source, target: a, method: 'provider_id+path' },
    ]);
  });
  it('never allows a path to override contradictory provider IDs', () => {
    const source = item('s', {
      ProviderIds: { Imdb: 'tt42', Tmdb: '50' },
      Path: '/media/film.mkv',
    });
    const a = item('a', { ProviderIds: { Imdb: 'tt42', Tmdb: '99' }, Path: source.Path }),
      b = item('b', { ProviderIds: { Imdb: 'tt77', Tmdb: '50' } });
    expect(matchItems([source], [a, b])).toEqual({
      matches: [],
      unmatched: [],
      ambiguous: [
        { source, candidates: [a, b], ...conflictDiagnostic('provider_id', ['provider_conflict']) },
      ],
    });
  });
  it('uses longest directory-boundary prefix mapping', () => {
    const sources = [
      item('s', { Path: '/emby/tv/a.mkv' }),
      item('s2', { Path: '/emby-other/a.mkv' }),
    ];
    const targets = [
      item('t', { Path: '/shows/a.mkv' }),
      item('t2', { Path: '/media-other/a.mkv' }),
    ];
    const result = matchItems(sources, targets, [
      { source: '/emby', target: '/media' },
      { source: '/emby/tv', target: '/shows' },
    ]);
    expect(result.matches[0]?.target).toEqual(targets[0]);
    expect(result.unmatched).toEqual([sources[1]]);
  });
  it('normalizes slashes, dots and Unicode while preserving path case and input objects', () => {
    const source = item('s', { Path: 'C:\\Media\\folder\\..\\cafe\u0301.mkv' });
    const target = item('t', { Path: '/media/café.mkv' }),
      mappings = [{ source: 'C:\\Media', target: '/media' }];
    const before = structuredClone({ source, target, mappings });
    expect(matchItems([source], [target], mappings).matches[0]?.method).toBe('path');
    expect({ source, target, mappings }).toEqual(before);
    expect(matchItems([item('s', { Path: '/Media/café.mkv' })], [target]).matches).toEqual([]);
  });
  it('keeps duplicate exact paths ambiguous', () => {
    const source = item('s', { Path: '/media/film.mkv' }),
      a = item('a', { Path: source.Path }),
      b = item('b', { Path: source.Path });
    expect(matchItems([source], [a, b]).ambiguous[0]?.candidates).toEqual([a, b]);
  });
  it('rejects unknown providers, booleans and malformed metadata without crashing', () => {
    const source = item('s', { ProviderIds: { Extension: '1', Imdb: true } });
    expect(
      matchItems([source], [item('t', { ProviderIds: { Extension: '1', Imdb: true } })]).unmatched,
    ).toEqual([source]);
  });
  it('rejects rounded numeric provider IDs while retaining exact string identities', () => {
    const unsafe = item('unsafe', { ProviderIds: { Tmdb: Number.MAX_SAFE_INTEGER + 1 } });
    expect(matchItems([unsafe], [item('t', { ...unsafe, Id: 't' })]).unmatched).toEqual([unsafe]);
    const exact = item('exact', { ProviderIds: { Tmdb: '9007199254740992' } });
    expect(matchItems([exact], [item('t', { ...exact, Id: 't' })]).matches).toHaveLength(1);
  });
  it('does not accept inherited JavaScript object properties as provider names', () => {
    const source = item('s', { ProviderIds: JSON.parse('{"constructor":"123","__proto__":"42"}') });
    const target = item('t', { ProviderIds: JSON.parse('{"constructor":"123","__proto__":"42"}') });
    expect(matchItems([source], [target]).unmatched).toEqual([source]);
  });
  it('matches series independently from episodes so series favorites can migrate', () => {
    const source = item('s', { Type: 'Series', ProviderIds: { Tvdb: '100' } });
    const target = item('t', { ...source, Id: 't', Name: 'Renamed show' });
    const episode = item('episode', { ...source, Id: 'episode', Type: 'Episode' });
    expect(matchItems([source], [target, episode]).matches).toEqual([
      { source, target, method: 'provider_id' },
    ]);
  });
  it('matches numbered seasons using a series identity including season zero', () => {
    const source = item('s', {
      Type: 'Season',
      SeriesProviderIds: { Tvdb: '100' },
      IndexNumber: 0,
    });
    const target = item('t', {
      Type: 'Season',
      SeriesProviderIds: { TheTvdb: '100' },
      IndexNumber: '0',
    });
    expect(
      matchItems(
        [source],
        [
          target,
          item('other-season', { ...target, Id: 'other-season', IndexNumber: 1 }),
          item('other-show', { ...target, Id: 'other-show', SeriesProviderIds: { Tvdb: '200' } }),
          item('episode', { ...target, Id: 'episode', Type: 'Episode', ParentIndexNumber: 0 }),
        ],
      ).matches,
    ).toEqual([{ source, target, method: 'series_season' }]);
  });
  it('does not guess seasons from an own provider ID without complete series numbering', () => {
    for (const IndexNumber of [undefined, true, -1, '1.2']) {
      const source = item('s', {
        Type: 'Season',
        ProviderIds: { Tvdb: '100' },
        SeriesProviderIds: { Tvdb: '100' },
        IndexNumber,
      });
      expect(matchItems([source], [item('t', { ...source, Id: 't' })]).unmatched).toEqual([source]);
    }
  });
  it('keeps conflicting season numbers and series IDs ambiguous even on the same path', () => {
    const source = item('s', {
      Type: 'Season',
      SeriesProviderIds: { Tvdb: '100' },
      IndexNumber: 1,
      Path: '/media/show/season',
    });
    for (const fields of [{ IndexNumber: 2 }, { SeriesProviderIds: { Tvdb: '200' } }]) {
      const target = item('t', { ...source, ...fields, Id: 't' });
      expect(matchItems([source], [target]).ambiguous).toEqual([
        {
          source,
          candidates: [target],
          ...conflictDiagnostic('path', [
            'IndexNumber' in fields ? 'numbering_conflict' : 'provider_conflict',
          ]),
        },
      ]);
    }
  });
  it('matches recordings and release tracks without confusing their distinct MusicBrainz IDs', () => {
    for (const ProviderIds of [
      { MusicBrainzRecording: 'recording-id' },
      { MusicBrainzTrack: 'track-id' },
    ]) {
      const source = item('s', { Type: 'Audio', ProviderIds });
      const target = item('t', { ...source, Id: 't', Name: 'Renamed track' });
      expect(matchItems([source], [target]).matches).toEqual([
        { source, target, method: 'provider_id' },
      ]);
    }
    const source = item('s', { Type: 'Audio', ProviderIds: { MusicBrainzRecording: 'shared-id' } });
    const target = item('t', { Type: 'Audio', ProviderIds: { MusicBrainzTrack: 'shared-id' } });
    expect(matchItems([source], [target]).unmatched).toEqual([source]);
  });
  it('accepts release-track aliases but never identifies a song from album or artist metadata', () => {
    const source = item('s', {
      Type: 'Audio',
      ProviderIds: { MusicBrainzReleaseTrack: 'track-id' },
    });
    const target = item('t', { Type: 'Audio', ProviderIds: { musicbrainztrack: 'TRACK-ID' } });
    expect(matchItems([source], [target]).matches[0]?.method).toBe('provider_id');
    for (const provider of [
      'MusicBrainzAlbum',
      'MusicBrainzRelease',
      'MusicBrainzReleaseGroup',
      'MusicBrainzArtist',
      'MusicBrainzAlbumArtist',
      'AudioDbAlbum',
      'AudioDbArtist',
    ]) {
      const audio = item('audio', {
        Type: 'Audio',
        ProviderIds: { [provider]: 'shared-album-id' },
        Name: 'Song',
        IndexNumber: 1,
        ParentIndexNumber: 1,
      });
      expect(matchItems([audio], [item('t', { ...audio, Id: 't' })]).unmatched).toEqual([audio]);
    }
  });
  it('matches album release aliases and release groups only within albums', () => {
    const source = item('s', {
      Type: 'MusicAlbum',
      ProviderIds: { MusicBrainzRelease: 'release-id' },
    });
    const target = item('t', {
      Type: 'MusicAlbum',
      ProviderIds: { MusicBrainzAlbum: 'release-id' },
    });
    expect(matchItems([source], [target]).matches[0]?.method).toBe('provider_id');
    const releaseGroup = item('group', {
      Type: 'MusicAlbum',
      ProviderIds: { MusicBrainzReleaseGroup: 'group-id' },
    });
    expect(
      matchItems([releaseGroup], [item('t', { ...releaseGroup, Id: 't' })]).matches,
    ).toHaveLength(1);
    expect(
      matchItems([source], [item('t', { ...target, Id: 't', Type: 'Audio' })]).matches,
    ).toEqual([]);
    expect(
      matchItems(
        [source],
        [
          item('t', {
            Type: 'MusicAlbum',
            ProviderIds: { MusicBrainzReleaseGroup: 'release-id' },
          }),
        ],
      ).matches,
    ).toEqual([]);
  });
  it('does not let album or recording identity override contradictory release IDs', () => {
    const source = item('s', {
      Type: 'MusicAlbum',
      ProviderIds: { MusicBrainzReleaseGroup: 'group', MusicBrainzAlbum: 'a' },
    });
    const target = item('t', {
      Type: 'MusicAlbum',
      ProviderIds: { MusicBrainzReleaseGroup: 'group', MusicBrainzAlbum: 'b' },
    });
    expect(matchItems([source], [target]).ambiguous).toEqual([
      { source, candidates: [target], ...conflictDiagnostic('provider_id', ['provider_conflict']) },
    ]);
    const audio = item('audio', {
      Type: 'Audio',
      ProviderIds: { MusicBrainzRecording: 'recording', MusicBrainzTrack: 'a' },
    });
    const other = item('other', {
      Type: 'Audio',
      ProviderIds: { MusicBrainzRecording: 'recording', MusicBrainzTrack: 'b' },
    });
    expect(matchItems([audio], [other]).ambiguous).toEqual([
      {
        source: audio,
        candidates: [other],
        ...conflictDiagnostic('provider_id', ['provider_conflict']),
      },
    ]);
  });
  it('matches artist and AudioDB identities without using an artist ID for an album', () => {
    const source = item('s', {
      Type: 'MusicArtist',
      ProviderIds: { MusicBrainzAlbumArtist: 'artist' },
    });
    const target = item('t', { Type: 'MusicArtist', ProviderIds: { MusicBrainzArtist: 'artist' } });
    expect(matchItems([source], [target]).matches[0]?.method).toBe('provider_id');
    for (const [Type, provider] of [
      ['MusicAlbum', 'AudioDbAlbum'],
      ['MusicArtist', 'AudioDbArtist'],
    ]) {
      const source = item('s', { Type, ProviderIds: { [provider!]: '10' } });
      expect(matchItems([source], [item('t', { ...source, Id: 't' })]).matches).toHaveLength(1);
    }
    const album = item('album', {
      Type: 'MusicAlbum',
      ProviderIds: { MusicBrainzArtist: 'artist' },
    });
    expect(matchItems([album], [item('t', { ...album, Id: 't' })]).unmatched).toEqual([album]);
  });
  it('matches collection IDs only for BoxSet items', () => {
    const source = item('s', { Type: 'BoxSet', ProviderIds: { TmdbCollection: '100' } });
    const target = item('t', { ...source, Id: 't' });
    expect(matchItems([source], [target]).matches).toEqual([
      { source, target, method: 'provider_id' },
    ]);
    const movie = item('movie', { ProviderIds: source.ProviderIds });
    expect(matchItems([movie], [item('t', { ...movie, Id: 't' })]).matches).toEqual([]);
  });
  it('canonicalizes Tmdb collection IDs only inside BoxSet identity without needing a path', () => {
    const source = item('source-set', { Type: 'BoxSet', ProviderIds: { Tmdb: '100' } });
    const target = item('target-set', { Type: 'BoxSet', ProviderIds: { TmdbCollection: '100' } });
    const movie = item('movie', { Type: 'Movie', ProviderIds: { Tmdb: '100' } });
    expect(matchItems([source], [target, movie]).matches).toEqual([
      { source, target, method: 'provider_id' },
    ]);
    expect(matchItems([target], [source, movie]).matches).toEqual([
      { source: target, target: source, method: 'provider_id' },
    ]);
    expect(matchItems([source], [movie]).unmatched).toEqual([source]);
    expect(matchItems([movie], [source, target]).unmatched).toEqual([movie]);
  });
  it('keeps contradictory Tmdb and TmdbCollection aliases ambiguous in either direction', () => {
    const source = item('source-set', {
      Type: 'BoxSet',
      Path: '/same',
      ProviderIds: { Tmdb: '100', TmdbCollection: '200' },
    });
    const target = item('target-set', {
      Type: 'BoxSet',
      Path: '/same',
      ProviderIds: { TmdbCollection: '100' },
    });
    expect(matchItems([source], [target]).ambiguous).toEqual([
      { source, candidates: [target], ...conflictDiagnostic('provider_id', ['provider_conflict']) },
    ]);
    expect(matchItems([target], [source]).ambiguous).toEqual([
      {
        source: target,
        candidates: [source],
        ...conflictDiagnostic('provider_id', ['provider_conflict']),
      },
    ]);
  });
  it('matches book metadata while keeping case-sensitive Google Books IDs distinct', () => {
    for (const ProviderIds of [{ ISBN: '978-1-4028-9462-6' }, { ComicVine: '123' }]) {
      const source = item('s', { Type: 'Book', ProviderIds });
      const target = item('t', { ...source, Id: 't' });
      expect(matchItems([source], [target]).matches).toHaveLength(1);
    }
    const book = item('book', { Type: 'Book', ProviderIds: { ISBN: '978-1-4028-9462-6' } });
    expect(
      matchItems(
        [book],
        [
          item('t', {
            Type: 'Book',
            ProviderIds: { ISBN13: '9781402894626' },
          }),
        ],
      ).matches,
    ).toHaveLength(1);
    const source = item('s', { Type: 'Book', ProviderIds: { GoogleBooks: 'AbC123' } });
    expect(
      matchItems(
        [source],
        [
          item('t', {
            Type: 'Book',
            ProviderIds: { GoogleBooks: 'abc123' },
          }),
        ],
      ).unmatched,
    ).toEqual([source]);
    expect(matchItems([source], [item('t', { ...source, Id: 't' })]).matches).toHaveLength(1);
  });
  it('uses exact mapped paths for every supported type without cross-type matching', () => {
    for (const Type of MIGRATABLE_ITEM_TYPES) {
      const source = item('s', { Type, Path: '/emby/item' });
      const target = item('t', { Type, Path: '/jellyfin/item' });
      const otherType = Type === 'Photo' ? 'Movie' : 'Photo';
      const other = item('other', { Type: otherType, Path: target.Path });
      expect(
        matchItems([source], [target, other], [{ source: '/emby', target: '/jellyfin' }]).matches,
      ).toEqual([{ source, target, method: 'path' }]);
      expect(
        matchItems([source], [other], [{ source: '/emby', target: '/jellyfin' }]).unmatched,
      ).toEqual([source]);
    }
  });
  it('leaves playlists and unsupported item types to their separate migration strategy', () => {
    const playlist = item('s', { Type: 'Playlist', Path: '/shared/playlist' });
    const folder = item('folder', { Type: 'Folder', Path: '/shared/folder' });
    expect(
      matchItems(
        [playlist, folder],
        [item('t', { ...playlist, Id: 't' }), item('t2', { ...folder, Id: 't2' })],
      ).unmatched,
    ).toEqual([playlist, folder]);
  });
  it('keeps contradictory provider aliases ambiguous instead of overwriting either value', () => {
    for (const Type of ['Movie', 'Series', 'MusicAlbum']) {
      const aliases =
        Type === 'MusicAlbum'
          ? { MusicBrainzAlbum: 'a', MusicBrainzRelease: 'b' }
          : { Tmdb: '1', TheMovieDB: '2' };
      const provider = Type === 'MusicAlbum' ? { MusicBrainzAlbum: 'a' } : { Tmdb: '1' };
      const source = item('s', { Type, ProviderIds: aliases, Path: '/same' });
      const target = item('t', { Type, ProviderIds: provider, Path: '/same' });
      expect(matchItems([source], [target]).ambiguous).toEqual([
        {
          source,
          candidates: [target],
          ...conflictDiagnostic('provider_id', ['provider_conflict']),
        },
      ]);
      expect(matchItems([target], [source]).ambiguous).toEqual([
        {
          source: target,
          candidates: [source],
          ...conflictDiagnostic('provider_id', ['provider_conflict']),
        },
      ]);
    }
  });
});
