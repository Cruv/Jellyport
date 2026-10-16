import { describe, expect, it } from 'vitest';
import type { MediaItem, MediaUserDataPatch } from '../server/media.js';
import { ServiceError } from '../server/errors.js';
import {
  captureExpectation,
  evaluateExpectation,
  USER_DATA_FIELDS,
} from '../server/migration-verification.js';

const before = '2025-01-01T00:00:00.000Z';
const imported = '2026-01-01T00:00:00.000Z';
const after = '2026-01-01T00:00:01.000Z';
const data: MediaUserDataPatch = {
  Played: true,
  IsFavorite: true,
  Likes: false,
  PlaybackPositionTicks: 40,
  PlayCount: 5,
  LastPlayedDate: imported,
  Rating: 8,
};
const item = (
  UserData: MediaUserDataPatch = {},
  overrides: Partial<MediaItem> = {},
): MediaItem => ({
  Id: 'target-id',
  Type: 'Movie',
  Path: '/synthetic/movie.mkv',
  ProviderIds: { Tmdb: '123', Imdb: 'tt456' },
  UserData: { ...UserData },
  ...overrides,
});

describe('capturing bounded migration expectations', () => {
  it('preserves all seven existing detailed fields for a no-op match', () => {
    const expected = captureExpectation(item(data), {});
    expect(expected.state).toEqual(data);
    expect(Object.keys(expected.state).sort()).toEqual([...USER_DATA_FIELDS].sort());
    expect(evaluateExpectation(expected, item(data))).toEqual({
      status: 'verified',
      fields: [],
      unsupported_fields: [],
    });
  });

  it('overlays intended fields on the fresh state without retaining labels or DTO data', () => {
    const target = item(
      { ...data, LastPlayedDate: before },
      { Name: 'Private label', RunTimeTicks: 1000, Unrelated: { token: 'synthetic-private' } },
    );
    const expected = captureExpectation(target, {
      PlaybackPositionTicks: 60,
      LastPlayedDate: imported,
    });
    expect(expected.state).toEqual({ ...data, PlaybackPositionTicks: 60 });
    expect(expected.item).toEqual({
      Id: target.Id,
      Type: target.Type,
      Path: target.Path,
      ProviderIds: target.ProviderIds,
    });
    expect(JSON.stringify(expected.item)).not.toContain('Private label');
    expect(JSON.stringify(expected.item)).not.toContain('synthetic-private');
    target.UserData!.PlaybackPositionTicks = 99;
    target.ProviderIds!.Tmdb = 'different';
    expect(expected.state.PlaybackPositionTicks).toBe(60);
    expect(expected.item.ProviderIds).toEqual({ Tmdb: '123', Imdb: 'tt456' });
  });

  it('preserves false Likes, zero rating and an intentional cleared resume position', () => {
    const expected = captureExpectation(item(data), {
      Likes: false,
      Rating: 0,
      PlaybackPositionTicks: 0,
    });
    expect(expected.state).toMatchObject({ Likes: false, Rating: 0, PlaybackPositionTicks: 0 });
    expect(evaluateExpectation(expected, item(expected.state)).status).toBe('verified');
  });

  it('keeps watched-only verification within the selected migration scope', () => {
    const expected = captureExpectation(item(data), {}, 'watched_only');
    expect(expected.state).toEqual({ Played: true, LastPlayedDate: imported });
    expect(
      evaluateExpectation(expected, item({ Played: true, LastPlayedDate: imported })).status,
    ).toBe('verified');
  });

  it.each([
    'Series',
    'Season',
    'MusicAlbum',
    'MusicArtist',
    'Photo',
    'PhotoAlbum',
    'BoxSet',
    'Playlist',
  ])(
    'verifies personal favorites and ratings rather than derived container activity for %s',
    (Type) => {
      const expected = captureExpectation(item(data, { Type }), {});
      expect(expected.state).toEqual({ IsFavorite: true, Likes: false, Rating: 8 });
      expect(
        evaluateExpectation(expected, item({ IsFavorite: true, Likes: false, Rating: 8 }, { Type }))
          .status,
      ).toBe('verified');
    },
  );

  it('accounts explicitly for unsupported attempted fields without retaining their values', () => {
    const expected = captureExpectation(item(data), {
      UnsupportedFlag: 'private-value',
      PlayedPercentage: 20,
    });
    expect(expected.unsupported_fields).toEqual(['UnsupportedFlag', 'PlayedPercentage']);
    expect(expected.state).toEqual(data);
    const result = evaluateExpectation(expected, item(data));
    expect(result).toEqual({
      status: 'verified',
      fields: [],
      unsupported_fields: ['UnsupportedFlag', 'PlayedPercentage'],
    });
    expect(JSON.stringify(expected)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('target-id');
  });

  it('accounts for attempted out-of-scope or derived fields and sanitizes unknown field names', () => {
    const expected = captureExpectation(item(data, { Type: 'Series' }), {
      PlaybackPositionTicks: 10,
      'bad\nfield': 'private',
    });
    expect(expected.unsupported_fields).toEqual(['PlaybackPositionTicks', '(invalid field name)']);
    expect(expected.state.PlaybackPositionTicks).toBeUndefined();
    expect(
      captureExpectation(item(data), { IsFavorite: true }, 'watched_only').unsupported_fields,
    ).toEqual(['IsFavorite']);
  });

  it.each([
    { Played: 'true' },
    { PlaybackPositionTicks: -1 },
    { PlaybackPositionTicks: Number.MAX_SAFE_INTEGER + 1 },
    { PlayCount: 2_147_483_648 },
    { LastPlayedDate: 'invalid date' },
    { Rating: 11 },
  ])('rejects invalid intended state instead of falsely verifying it (%j)', (patch) => {
    expect(() => captureExpectation(item(), patch as MediaUserDataPatch)).toThrow(ServiceError);
  });

  it('normalizes equal date representations', () => {
    const expected = captureExpectation(item(), { LastPlayedDate: '2025-12-31T19:00:00-05:00' });
    expect(expected.state.LastPlayedDate).toBe(imported);
    expect(evaluateExpectation(expected, item({ LastPlayedDate: imported })).status).toBe(
      'verified',
    );
  });
});

describe('independent history readback', () => {
  it('catches the equal-date regression when a date applies but its resume position is ignored', () => {
    const expected = captureExpectation(
      item({ LastPlayedDate: before, PlaybackPositionTicks: 5 }),
      {
        LastPlayedDate: imported,
        PlaybackPositionTicks: 40,
      },
    );
    expect(
      evaluateExpectation(expected, item({ LastPlayedDate: imported, PlaybackPositionTicks: 5 })),
    ).toEqual({
      status: 'mismatch',
      fields: ['PlaybackPositionTicks'],
      unsupported_fields: [],
    });
  });

  it('accepts strictly newer concurrent resume activity without scheduling any repair', () => {
    const expected = captureExpectation(item(data), {});
    expect(
      evaluateExpectation(
        expected,
        item({ ...data, LastPlayedDate: after, PlaybackPositionTicks: 1, PlayCount: 6 }),
      ),
    ).toEqual({
      status: 'preserved_newer',
      fields: [],
      unsupported_fields: [],
    });
  });

  it.each([undefined, null, -1, '40', Number.MAX_SAFE_INTEGER + 1])(
    'does not treat malformed or absent resume state as a valid concurrent position (%j)',
    (PlaybackPositionTicks) => {
      const expected = captureExpectation(item(data), {});
      expect(
        evaluateExpectation(
          expected,
          item({ ...data, LastPlayedDate: after, PlaybackPositionTicks } as MediaUserDataPatch),
        ),
      ).toMatchObject({
        status: 'mismatch',
        fields: ['PlaybackPositionTicks'],
      });
    },
  );

  it('does not let a newer date conceal lost flags, lower counts or changed fill-only ratings', () => {
    const expected = captureExpectation(item(data), {});
    const result = evaluateExpectation(
      expected,
      item({
        ...data,
        LastPlayedDate: after,
        PlaybackPositionTicks: 2,
        Played: false,
        IsFavorite: false,
        PlayCount: 4,
        Likes: true,
        Rating: 9,
      }),
    );
    expect(result.status).toBe('mismatch');
    expect(result.fields).toEqual(['Played', 'IsFavorite', 'Likes', 'PlayCount', 'Rating']);
  });

  it('accepts additive destination flags and greater counts', () => {
    const expected = captureExpectation(
      item({ Played: false, IsFavorite: false, PlayCount: 2 }),
      {},
    );
    expect(
      evaluateExpectation(expected, item({ Played: true, IsFavorite: true, PlayCount: 4 })),
    ).toEqual({
      status: 'verified',
      fields: [],
      unsupported_fields: [],
    });
  });

  it.each([undefined, before, 'invalid'])(
    'rejects a missing, older or malformed date (%j)',
    (LastPlayedDate) => {
      const expected = captureExpectation(item(data), {});
      expect(evaluateExpectation(expected, item({ ...data, LastPlayedDate }))).toMatchObject({
        status: 'mismatch',
        fields: ['LastPlayedDate'],
      });
    },
  );

  it('counts missing items and missing state rather than assuming defaults', () => {
    const expected = captureExpectation(item(data), {});
    expect(evaluateExpectation(expected).status).toBe('missing');
    expect(evaluateExpectation(expected, { ...item(data), UserData: undefined }).status).toBe(
      'missing',
    );
    expect(evaluateExpectation(expected, item({}))).toMatchObject({
      status: 'mismatch',
      fields: [...USER_DATA_FIELDS],
    });
  });

  it.each([
    { Id: 'another-id' },
    { Type: 'Episode' },
    { Path: '/synthetic/another.mkv' },
    { ProviderIds: { Tmdb: '999' } },
    { SeriesId: 'another-series' },
    { IndexNumber: 2 },
    { Type: undefined },
  ])('rejects a wrong or malformed identity even when state matches (%j)', (overrides) => {
    const expected = captureExpectation(item(data), {});
    expect(evaluateExpectation(expected, item(data, overrides))).toEqual({
      status: 'mismatch',
      fields: [],
      unsupported_fields: [],
      identity_mismatch: true,
    });
  });

  it('normalizes provider order and numeric identifiers without confusing identity with labels', () => {
    const expected = captureExpectation(item(data), {});
    const observed = item(data, {
      Name: 'Changed label',
      ProviderIds: { Imdb: 'tt456', Tmdb: 123 },
    });
    expect(evaluateExpectation(expected, observed).status).toBe('verified');
  });

  it('supports one target read with every expectation retained for sequential source editions', () => {
    const ledger = new Map<string, ReturnType<typeof captureExpectation>[]>();
    const initial = item({ LastPlayedDate: before, PlaybackPositionTicks: 1 });
    ledger.set(initial.Id, [
      captureExpectation(initial, {
        Played: true,
        PlayCount: 2,
        LastPlayedDate: imported,
        PlaybackPositionTicks: 40,
      }),
    ]);
    const afterFirst = item(ledger.get(initial.Id)![0]!.state);
    ledger
      .get(initial.Id)!
      .push(captureExpectation(afterFirst, { IsFavorite: true, PlayCount: 5 }));
    expect(ledger.size).toBe(1);
    const final = ledger.get(initial.Id)!.at(-1)!;
    expect(final.state).toEqual({
      Played: true,
      IsFavorite: true,
      PlayCount: 5,
      LastPlayedDate: imported,
      PlaybackPositionTicks: 40,
    });
    const observed = item(final.state);
    expect(
      ledger.get(initial.Id)!.map((expected) => evaluateExpectation(expected, observed).status),
    ).toEqual(['verified', 'verified']);
  });

  it('does not lose an ignored resume write when a later source edition only changes favorites', () => {
    const first = captureExpectation(item({ LastPlayedDate: before, PlaybackPositionTicks: 1 }), {
      LastPlayedDate: imported,
      PlaybackPositionTicks: 40,
    });
    const freshAfterIgnoredResume = item({ LastPlayedDate: imported, PlaybackPositionTicks: 1 });
    const second = captureExpectation(freshAfterIgnoredResume, { IsFavorite: true });
    const final = item({ ...freshAfterIgnoredResume.UserData, IsFavorite: true });
    expect(evaluateExpectation(second, final).status).toBe('verified');
    expect(evaluateExpectation(first, final)).toMatchObject({
      status: 'mismatch',
      fields: ['PlaybackPositionTicks'],
    });
  });

  it('requires a comparable prior date before accepting a different resume as newer activity', () => {
    const expected = captureExpectation(item({ PlaybackPositionTicks: 1 }), {
      PlaybackPositionTicks: 40,
    });
    expect(
      evaluateExpectation(expected, item({ LastPlayedDate: after, PlaybackPositionTicks: 2 })),
    ).toMatchObject({
      status: 'mismatch',
      fields: ['PlaybackPositionTicks'],
    });
  });

  it('reports known capability losses separately and never calls unsupported fields verified', () => {
    const expected = captureExpectation(item(data), {});
    expected.unsupported_fields = ['Rating', 'Likes', 'Rating'];
    expect(
      evaluateExpectation(expected, item({ ...data, Rating: undefined, Likes: undefined })),
    ).toEqual({
      status: 'verified',
      fields: [],
      unsupported_fields: ['Rating', 'Likes'],
    });
  });
});

it.each(['Played', 'IsFavorite'] as const)(
  'never verifies an expected false %s flag from a missing or malformed readback',
  (field) => {
    const expected = captureExpectation(item({ [field]: false }), {});
    for (const value of [undefined, 'false', 0, null]) {
      const observed = item({ [field]: value } as unknown as MediaUserDataPatch);
      expect(evaluateExpectation(expected, observed)).toMatchObject({
        status: 'mismatch',
        fields: [field],
      });
    }
    expect(evaluateExpectation(expected, item({ [field]: true })).status).toBe('verified');
  },
);
