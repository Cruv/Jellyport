import { describe, expect, it } from 'vitest';
import { createMatcher, matchItems, MAX_AMBIGUOUS_CANDIDATES } from '../server/matching.js';
import type { MediaItem } from '../server/media.js';

const episode = (Id: string, fields: Partial<MediaItem> = {}): MediaItem => ({
  Id,
  Type: 'Episode',
  Name: 'Synthetic episode title',
  SeriesName: 'Synthetic series',
  ParentIndexNumber: 2,
  IndexNumber: 13,
  SeriesProviderIds: { Tvdb: 'series-100', Imdb: 'series-imdb', Tmdb: 'series-tmdb' },
  ProviderIds: { Imdb: 'episode-imdb', Tvdb: 'episode-tvdb' },
  ...fields,
});
const source = () => episode('source', { Path: '/source/tv/series/season-2/episode-13.mkv' });
const correct = () => episode('correct', { Path: '/media/tv/series/season-2/episode-13.mkv' });
const wrong = () =>
  episode('wrong', {
    Name: 'A different episode',
    IndexNumber: 10,
    ProviderIds: { Imdb: 'episode-imdb', Tvdb: 'different-episode-tvdb' },
    Path: '/media/tv/series/season-2/episode-10.mkv',
  });
const mappings = [{ source: '/source/tv', target: '/media/tv' }];

describe('complete episode identity precedes stray episode-provider hits', () => {
  it.each([false, true])(
    'matches the full-context episode despite a reused IMDb on another number (reversed=%s)',
    (reverse) => {
      const from = source();
      const right = correct();
      const other = wrong();
      const targets = reverse ? [right, other] : [other, right];
      const matcher = createMatcher(targets, mappings);
      expect(matcher([from])).toEqual({
        matches: [{ source: from, target: right, method: 'series_episode+provider_id' }],
        unmatched: [],
        ambiguous: [],
      });
      // Candidate collection retains every identity hit for later access filtering.
      expect(matcher.candidates([from])).toEqual(targets);
    },
  );

  it('uses validated series identity and the full number range even when the contextual target has no own episode IDs', () => {
    const from = source();
    const right = correct();
    right.ProviderIds = {};
    expect(matchItems([from], [wrong(), right], mappings)).toEqual({
      matches: [{ source: from, target: right, method: 'series_episode' }],
      unmatched: [],
      ambiguous: [],
    });
  });

  it('does not inspect irrelevant wrong-number provider metadata after finding the complete context', () => {
    const from = source();
    const other = wrong();
    let indexed = false;
    Object.defineProperty(other, 'ProviderIds', {
      get() {
        if (indexed)
          throw new Error('An irrelevant wrong-number provider hit must not poison this context.');
        return { Imdb: 'episode-imdb', Tvdb: 'different-episode-tvdb' };
      },
    });
    const right = correct();
    const matcher = createMatcher([other, right], mappings);
    indexed = true;
    expect(matcher([from]).matches[0]?.target).toBe(right);
  });

  it('preserves own episode-ID conflicts inside the selected context despite an agreeing provider and exact path', () => {
    const from = source();
    const right = correct();
    right.ProviderIds = { Imdb: 'conflicting-imdb', Tvdb: 'episode-tvdb' };
    const plan = matchItems([from], [wrong(), right], mappings);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toEqual([
      expect.objectContaining({
        source: from,
        candidates: [right],
        method: 'series_episode',
        reason_codes: ['provider_conflict'],
        path_resolution: 'conflict_prevents_path_resolution',
      }),
    ]);
  });

  it.each(['source', 'target'])(
    'preserves contradictory own episode aliases on the %s even at the exact mapped path',
    (side) => {
      const from = source();
      const right = correct();
      (side === 'source' ? from : right).ProviderIds = {
        Tvdb: 'episode-tvdb',
        TheTvdb: 'conflicting-tvdb',
      };
      const plan = matchItems([from], [right], mappings);
      expect(plan.matches).toEqual([]);
      expect(plan.ambiguous[0]).toMatchObject({
        method: 'series_episode',
        reason_codes: ['provider_conflict'],
      });
    },
  );

  it.each(['source', 'target'])(
    'preserves contradictory series aliases on the %s instead of claiming complete context',
    (side) => {
      const from = source();
      const right = correct();
      (side === 'source' ? from : right).SeriesProviderIds = {
        Tvdb: 'series-100',
        TheTvdb: 'other-series',
      };
      const plan = matchItems([from], [right], mappings);
      expect(plan.matches).toEqual([]);
      expect(plan.ambiguous[0]).toMatchObject({
        method: 'provider_id',
        reason_codes: ['provider_conflict'],
      });
    },
  );

  it('does not resolve conflicting series IDs or a remake using a matching title, episode ID, number or path', () => {
    const from = source();
    for (const SeriesProviderIds of [
      { Tvdb: 'series-100', Imdb: 'other-show', Tmdb: 'series-tmdb' },
      { Tvdb: 'remake-series', Imdb: 'remake-imdb', Tmdb: 'remake-tmdb' },
    ]) {
      const other = { ...correct(), SeriesProviderIds };
      expect(matchItems([from], [other], mappings)).toMatchObject({
        matches: [],
        ambiguous: [expect.objectContaining({ reason_codes: ['provider_conflict'] })],
      });
    }
  });

  it('does not let a contradictory wrong-show hit defeat a separate verified same-show candidate', () => {
    const from = source();
    const other = {
      ...correct(),
      Id: 'other-show',
      SeriesProviderIds: { Tvdb: 'series-100', Imdb: 'other-show' },
    };
    const right = correct();
    expect(matchItems([from], [other, right], mappings).matches).toEqual([
      { source: from, target: right, method: 'series_episode+provider_id' },
    ]);
  });

  it('does not infer series identity from a show name, episode title or season/episode numbers alone', () => {
    const from = { ...source(), ProviderIds: {}, SeriesProviderIds: {}, Path: undefined };
    const other = { ...correct(), ProviderIds: {}, SeriesProviderIds: {} };
    expect(matchItems([from], [other], mappings)).toEqual({
      matches: [],
      unmatched: [from],
      ambiguous: [],
    });
  });

  it('uses validated identity despite renamed metadata or a differing filename caption', () => {
    const from = source();
    const right = { ...correct(), Name: 'A changed display title', SeriesName: 'A renamed show' };
    expect(matchItems([from], [wrong(), right], mappings).matches[0]).toEqual({
      source: from,
      target: right,
      method: 'series_episode+provider_id',
    });
  });

  it('keeps alternate edition duplicates ambiguous and uses exact mapped path only to narrow the verified context', () => {
    const from = source();
    const right = correct();
    const edition = {
      ...correct(),
      Id: '4k-edition',
      Path: '/media/tv-4k/series/season-2/episode-13.mkv',
    };
    const withoutPath = { ...from, Path: undefined };
    expect(
      matchItems([withoutPath], [wrong(), right, edition], mappings).ambiguous[0],
    ).toMatchObject({
      method: 'series_episode',
      reason_codes: ['duplicate_series_episode'],
      candidates: [right, edition],
    });
    expect(matchItems([from], [wrong(), right, edition], mappings).matches).toEqual([
      { source: from, target: right, method: 'series_episode+provider_id+path' },
    ]);
    right.ProviderIds = {};
    edition.ProviderIds = {};
    expect(matchItems([from], [wrong(), right, edition], mappings).matches[0]?.method).toBe(
      'series_episode+path',
    );
  });

  it('does not silently discard same-context contradictions to choose a convenient edition', () => {
    const from = source();
    const right = correct();
    const conflictingEdition = {
      ...correct(),
      Id: 'conflicting-edition',
      Path: '/media/other-edition.mkv',
      ProviderIds: { Imdb: 'other-episode' },
    };
    expect(matchItems([from], [wrong(), right, conflictingEdition], mappings)).toMatchObject({
      matches: [],
      ambiguous: [
        expect.objectContaining({
          candidates: [right, conflictingEdition],
          reason_codes: ['provider_conflict'],
        }),
      ],
    });
  });

  it('preserves distinct episode-order conflicts even when an own ID occurs at another numbered episode', () => {
    const from = source();
    const sameNumberDifferentOrder = {
      ...correct(),
      ProviderIds: { Imdb: 'different-order-episode', Tvdb: 'different-order-tvdb' },
    };
    expect(matchItems([from], [wrong(), sameNumberDifferentOrder], mappings)).toMatchObject({
      matches: [],
      ambiguous: [
        expect.objectContaining({
          candidates: [sameNumberDifferentOrder],
          reason_codes: ['provider_conflict'],
        }),
      ],
    });
    expect(matchItems([from], [wrong()], mappings).ambiguous[0]?.reason_codes).toEqual([
      'numbering_conflict',
      'provider_conflict',
    ]);
  });

  it('requires the complete multi-episode range and supports zero-numbered specials', () => {
    const from = { ...source(), ParentIndexNumber: 0, IndexNumber: 0, IndexNumberEnd: 2 };
    const right = { ...correct(), ParentIndexNumber: '0', IndexNumber: '0', IndexNumberEnd: '2' };
    const onlyFirst = { ...right, Id: 'single-episode', IndexNumberEnd: undefined };
    const shorter = { ...right, Id: 'shorter-range', IndexNumberEnd: 1 };
    expect(matchItems([from], [onlyFirst, shorter, right], mappings).matches).toEqual([
      { source: from, target: right, method: 'series_episode+provider_id' },
    ]);
  });

  it.each([undefined, true, -1, '1.2'])(
    'does not claim complete context with missing or malformed episode number %s',
    (IndexNumber) => {
      const from = { ...source(), IndexNumber };
      const right = correct();
      expect(matchItems([from], [right], mappings).matches[0]?.method).toBe('provider_id');
    },
  );

  it.each(['source', 'target'])(
    'does not claim the stronger context when the %s explicitly contains a malformed range end',
    (side) => {
      const from = source();
      const right: MediaItem = { ...correct(), ProviderIds: {} };
      (side === 'source' ? from : right).IndexNumberEnd = 'invalid-end';
      expect(matchItems([from], [wrong(), right], mappings)).toMatchObject({
        matches: [],
        ambiguous: [expect.any(Object)],
      });
    },
  );

  it('retains legacy matching when series identities are absent and never replaces a numbering conflict with a guess', () => {
    const from = { ...source(), SeriesProviderIds: {} };
    const right = { ...correct(), SeriesProviderIds: {} };
    expect(matchItems([from], [right], mappings).matches[0]?.method).toBe('provider_id');
    expect(matchItems([from], [wrong(), right], mappings)).toMatchObject({
      matches: [],
      ambiguous: [expect.objectContaining({ method: 'provider_id' })],
    });
  });

  it('preserves the media-type guard if a prepared context candidate changes type', () => {
    const from = source();
    const right = correct();
    const matcher = createMatcher([right], mappings);
    right.Type = 'Movie';
    expect(matcher([from])).toMatchObject({
      matches: [],
      ambiguous: [expect.objectContaining({ reason_codes: ['media_type_conflict'] })],
    });
  });

  it('keeps every lower-priority candidate so final matching remains equivalent for every access subset', () => {
    const from = source();
    const targets = [
      wrong(),
      correct(),
      {
        ...correct(),
        Id: 'alternate-edition',
        Path: '/media/tv-4k/series/season-2/episode-13.mkv',
      },
      { ...correct(), Id: 'path-only', ProviderIds: {}, SeriesProviderIds: {} },
      {
        ...correct(),
        Id: 'conflicting-show',
        SeriesProviderIds: { Tvdb: 'series-100', Imdb: 'other-show' },
      },
      {
        ...correct(),
        Id: 'unrelated',
        ProviderIds: {},
        SeriesProviderIds: { Tvdb: 'other-series' },
        Path: '/media/unrelated.mkv',
      },
    ];
    const candidates = createMatcher(targets, mappings).candidates([from]);
    expect(candidates).toEqual(targets.slice(0, 5));
    for (let mask = 0; mask < 1 << targets.length; mask++) {
      const allowed = new Set(targets.filter((_, index) => mask & (1 << index)));
      expect(
        createMatcher(
          candidates.filter((item) => allowed.has(item)),
          mappings,
        )([from]),
      ).toEqual(
        createMatcher(
          targets.filter((item) => allowed.has(item)),
          mappings,
        )([from]),
      );
    }
  });

  it('indexes series once and inspects only contextual candidates across one hundred user plans', () => {
    const size = 20_000;
    const historySize = 50;
    let pathReads = 0;
    let seriesReads = 0;
    const targets = Array.from({ length: size }, (_, index) => ({
      Id: `target-${index}`,
      Type: 'Episode',
      ProviderIds: { Tvdb: `episode-${index}` },
      ParentIndexNumber: Math.floor((index % 100) / 10) + 1,
      IndexNumber: (index % 10) + 1,
      get SeriesProviderIds() {
        seriesReads++;
        return { Tvdb: `series-${Math.floor(index / 100)}` };
      },
      get Path() {
        pathReads++;
        return `/media/series/episode-${index}.mkv`;
      },
    }));
    const matcher = createMatcher(targets);
    expect(pathReads).toBe(size);
    expect(seriesReads).toBe(size);
    for (let user = 0; user < 100; user++) {
      const history = Array.from({ length: historySize }, (_, index) => ({
        Id: `history-${user}-${index}`,
        Type: 'Episode',
        ProviderIds: { Tvdb: `episode-${index}` },
        SeriesProviderIds: { Tvdb: 'series-0' },
        ParentIndexNumber: Math.floor(index / 10) + 1,
        IndexNumber: (index % 10) + 1,
      }));
      expect(matcher.candidates(history)).toEqual(targets.slice(0, historySize));
      expect(matcher(history).matches).toHaveLength(historySize);
    }
    expect(pathReads).toBe(size);
    expect(seriesReads).toBe(size + 2 * 100 * historySize);
  });

  it('preserves the aggregate ambiguity bound for duplicate complete episode identities', () => {
    const collisionSize = 1000;
    // One series provider proves complete context; this case exercises the full
    // candidate budget, while the smaller cases above cover provider aliases.
    const targets = Array.from({ length: collisionSize }, (_, index) =>
      episode(`target-${index}`, { ProviderIds: {}, SeriesProviderIds: { Tvdb: 'series-100' } }),
    );
    const history = Array.from(
      { length: MAX_AMBIGUOUS_CANDIDATES / collisionSize + 1 },
      (_, index) =>
        episode(`source-${index}`, { ProviderIds: {}, SeriesProviderIds: { Tvdb: 'series-100' } }),
    );
    const matcher = createMatcher(targets);
    expect(matcher(history.slice(0, -1)).ambiguous).toHaveLength(history.length - 1);
    expect(() => matcher(history)).toThrow('too many ambiguous candidates');
  });

  it('does not repeatedly expand a shared stale episode-ID bucket when unique complete contexts exist', () => {
    const size = 1000;
    const targets = Array.from({ length: size }, (_, index) =>
      episode(`target-${index}`, {
        IndexNumber: index,
        ProviderIds: { Imdb: 'reused-episode-id', Tvdb: `episode-${index}` },
      }),
    );
    const history = targets.map((target, index) => ({ ...target, Id: `source-${index}` }));
    const matcher = createMatcher(targets);
    expect(matcher.candidates(history)).toEqual(targets);
    // Count operations without a mock retaining a million invocation records.
    // Before context-first lookup, this case expanded the same 1000-item own-ID
    // bucket for every source episode, despite unique complete series identities.
    const add = Set.prototype.add;
    let additions = 0;
    let plan: ReturnType<typeof matcher>;
    Set.prototype.add = function <T>(this: Set<T>, value: T): Set<T> {
      additions++;
      return add.call(this, value) as Set<T>;
    };
    try {
      plan = matcher(history);
    } finally {
      Set.prototype.add = add;
    }
    expect(plan.matches).toHaveLength(size);
    expect(plan.ambiguous).toEqual([]);
    expect(additions).toBeLessThan(size * 40);
  });
});
