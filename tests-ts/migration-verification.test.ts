import { describe, expect, it } from 'vitest';
import type { MediaItem, MediaUserDataPatch } from '../server/media.js';
import { ServiceError } from '../server/errors.js';
import {
  captureExpectation,
  evaluateExpectation,
  USER_DATA_FIELDS,
} from '../server/migration-verification.js';

const personal: MediaUserDataPatch = {
  Played: true,
  IsFavorite: true,
  Likes: false,
  Rating: 8,
  PlaybackPositionTicks: 40,
  PlayCount: 5,
  LastPlayedDate: '2026-01-01T00:00:00Z',
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

describe('watched-flag expectations', () => {
  it.each([undefined, 'watched_only', 'complete'] as const)(
    'captures only Played even for legacy scope %s',
    (scope) => {
      const expected = captureExpectation(item(personal), {}, scope);
      expect(expected.state).toEqual({ Played: true });
      expect(USER_DATA_FIELDS).toEqual(['Played']);
      expect(expected.item.UserData).toBeUndefined();
    },
  );

  it('overlays the intended flag and retains matching identity without labels or unrelated DTO data', () => {
    const target = item(
      { ...personal, Played: false },
      { Name: 'Private label', RunTimeTicks: 1000, Unrelated: { token: 'synthetic-secret' } },
    );
    const expected = captureExpectation(target, { Played: true });
    expect(expected.state).toEqual({ Played: true });
    expect(expected.item).toEqual({
      Id: target.Id,
      Type: target.Type,
      Path: target.Path,
      ProviderIds: target.ProviderIds,
    });
    target.ProviderIds!.Tmdb = 'changed';
    expect(expected.item.ProviderIds?.Tmdb).toBe('123');
    expect(JSON.stringify(expected)).not.toContain('Private label');
    expect(JSON.stringify(expected)).not.toContain('synthetic-secret');
  });

  it('accounts for excluded attempted fields without adopting their values', () => {
    const expected = captureExpectation(item(personal), {
      Played: true,
      Rating: 0,
      LastPlayedDate: 'private-date',
      UnknownFlag: 'private-value',
      'bad\nfield': 'private-value',
    });
    expect(expected.state).toEqual({ Played: true });
    expect(expected.unsupported_fields).toEqual([
      'Rating',
      'LastPlayedDate',
      'UnknownFlag',
      '(invalid field name)',
    ]);
    expect(JSON.stringify(expected)).not.toContain('private-value');
    expect(JSON.stringify(expected)).not.toContain('private-date');
  });

  it.each(['true', 1, {}, []])('rejects an invalid intended Played value (%j)', (Played) => {
    expect(() => captureExpectation(item(), { Played } as MediaUserDataPatch)).toThrow(
      ServiceError,
    );
  });

  it('rejects oversized verification patches', () => {
    expect(() =>
      captureExpectation(
        item(),
        Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`Unknown${index}`, true])),
      ),
    ).toThrow(ServiceError);
  });
});

describe('independent watched-flag readback', () => {
  it('detects a silently ignored flag after an acknowledged write', () => {
    const expected = captureExpectation(item({ Played: false }), { Played: true });
    expect(evaluateExpectation(expected, item({ Played: false }))).toEqual({
      status: 'mismatch',
      fields: ['Played'],
      unsupported_fields: [],
    });
  });

  it('does not let dates or unrelated state disguise a missing played flag', () => {
    const expected = captureExpectation(item(personal), {});
    const observed = item({
      Played: false,
      IsFavorite: false,
      Rating: 0,
      PlayCount: 99,
      PlaybackPositionTicks: 1,
      LastPlayedDate: '2027-01-01T00:00:00Z',
    });
    expect(evaluateExpectation(expected, observed).status).toBe('mismatch');
  });

  it('ignores unrelated personal-state changes when the intended flag is correct', () => {
    const expected = captureExpectation(item(personal), {});
    expect(evaluateExpectation(expected, item({ Played: true }))).toEqual({
      status: 'verified',
      fields: [],
      unsupported_fields: [],
    });
  });

  it('preserves a watched flag already present in Jellyfin', () => {
    const expected = captureExpectation(item({ Played: false }), {});
    expect(evaluateExpectation(expected, item({ Played: true })).status).toBe('verified');
  });

  it.each([undefined, null, 'false', 0])(
    'cannot verify an expected false flag from absent or malformed state (%j)',
    (Played) => {
      const expected = captureExpectation(item({ Played: false }), {});
      expect(evaluateExpectation(expected, item({ Played } as MediaUserDataPatch))).toMatchObject({
        status: 'mismatch',
        fields: ['Played'],
      });
    },
  );

  it('reports missing items and missing state instead of supplying default flags', () => {
    const expected = captureExpectation(item(personal), {});
    expect(evaluateExpectation(expected, { ...item(personal), UserData: undefined }).status).toBe(
      'missing',
    );
    expect(evaluateExpectation(expected).status).toBe('missing');
  });

  it('still checks an unsupported played update and reports its capability loss explicitly', () => {
    const expected = captureExpectation(item({ Played: false }), { Played: true });
    expected.unsupported_fields = ['Played', 'Played'];
    expect(evaluateExpectation(expected, item({ Played: false }))).toEqual({
      status: 'mismatch',
      fields: ['Played'],
      unsupported_fields: ['Played'],
    });
  });

  it.each([
    { Id: 'different' },
    { Type: 'Episode' },
    { Type: undefined },
    { Path: '/different.mkv' },
    { ProviderIds: { Tmdb: '999' } },
    { SeriesId: 'different-series' },
    { IndexNumber: 2 },
  ])('rejects changed or malformed matching identity (%j)', (overrides) => {
    const expected = captureExpectation(item(personal), {});
    expect(evaluateExpectation(expected, item({ Played: true }, overrides))).toEqual({
      status: 'mismatch',
      fields: [],
      unsupported_fields: [],
      identity_mismatch: true,
    });
  });

  it('normalizes provider order/numeric IDs and ignores review labels', () => {
    const expected = captureExpectation(item(personal), {});
    expect(
      evaluateExpectation(
        expected,
        item(
          { Played: true },
          { Name: 'Changed label', ProviderIds: { Imdb: 'tt456', Tmdb: 123 } },
        ),
      ).status,
    ).toBe('verified');
  });
});
