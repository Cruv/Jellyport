import { describe, expect, it } from 'vitest';
import { createMatcher, matchItems, MIGRATABLE_ITEM_TYPES } from '../server/matching.js';
import type { MediaItem } from '../server/media.js';

const item = (Id: string, fields: Partial<MediaItem> = {}): MediaItem => ({
  Id,
  Type: 'Movie',
  ...fields,
});
describe('conservative media matching', () => {
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
      expect(matchItems([source], [target]).ambiguous).toEqual([{ source, candidates: [target] }]);
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
    expect(matchItems([source], [target]).ambiguous).toEqual([{ source, candidates: [target] }]);
    const audio = item('audio', {
      Type: 'Audio',
      ProviderIds: { MusicBrainzRecording: 'recording', MusicBrainzTrack: 'a' },
    });
    const other = item('other', {
      Type: 'Audio',
      ProviderIds: { MusicBrainzRecording: 'recording', MusicBrainzTrack: 'b' },
    });
    expect(matchItems([audio], [other]).ambiguous).toEqual([
      { source: audio, candidates: [other] },
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
      expect(matchItems([source], [target]).ambiguous).toEqual([{ source, candidates: [target] }]);
      expect(matchItems([target], [source]).ambiguous).toEqual([
        { source: target, candidates: [source] },
      ]);
    }
  });
});
