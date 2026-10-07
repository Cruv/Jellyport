import { describe, expect, it } from 'vitest';
import { matchItems } from '../server/matching.js';
import type { MediaItem } from '../server/media.js';

const item = (Id: string, fields: Partial<MediaItem> = {}): MediaItem => ({
  Id,
  Type: 'Movie',
  ...fields,
});
describe('conservative media matching', () => {
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
    expect(matchItems([source], [target]).ambiguous).toEqual([{ source, candidates: [target] }]);
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
      ambiguous: [{ source, candidates: [a, b] }],
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
  it('does not accept inherited JavaScript object properties as provider names', () => {
    const source = item('s', { ProviderIds: JSON.parse('{"constructor":"123","__proto__":"42"}') });
    const target = item('t', { ProviderIds: JSON.parse('{"constructor":"123","__proto__":"42"}') });
    expect(matchItems([source], [target]).unmatched).toEqual([source]);
  });
});
