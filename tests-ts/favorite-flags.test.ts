import { describe, expect, it, vi } from 'vitest';
import { migrateItemState, migrationDetails, readMigrationSource } from '../server/migration.js';
import {
  captureExpectation,
  evaluateExpectation,
  type VerificationExpectation,
} from '../server/migration-verification.js';
import { MediaError, ServiceError } from '../server/errors.js';
import type { MediaAPI, MediaItem, MediaUserDataPatch } from '../server/media.js';

const media = (Id: string, UserData: MediaUserDataPatch = {}, Type = 'Movie'): MediaItem => ({
  Id,
  Type,
  UserData,
});
const client = (overrides: Partial<MediaAPI> = {}): MediaAPI => ({
  close: async () => {},
  systemInfo: async () => ({ Version: '12.2' }),
  users: async () => [],
  user: async (Id) => ({ Id, Name: 'synthetic' }),
  items: async () => [],
  createUser: async (Name) => ({ Id: 'new', Name }),
  setPassword: async () => {},
  setPolicy: async () => {},
  setConfiguration: async () => {},
  markPlayed: async () => {},
  migrationCapabilities: async () => ({
    userData: true,
    privatePlaylists: true,
    playlistDuplicates: true,
  }),
  ...overrides,
});
const selected = (sources: MediaItem[], target: MediaItem) => ({
  matches: sources.map((source) => ({ source, target, method: 'provider' })),
  unmatched: [],
  ambiguous: [],
});

describe('additive played and favorite flag transfer', () => {
  it('coalesces duplicate editions and both positive flags into one partial update without touching newer destination state', async () => {
    const original = {
      Played: false,
      IsFavorite: false,
      PlayCount: 9,
      PlaybackPositionTicks: 500,
      LastPlayedDate: '2027-01-01T00:00:00Z',
      Likes: false,
      Rating: 3,
    };
    let current = { ...original };
    const target = media('target', original);
    const updateUserData = vi.fn(async (_user: string, _id: string, patch: MediaUserDataPatch) => {
      current = { ...current, ...patch };
    });
    const markPlayed = vi.fn(),
      markFavorite = vi.fn(),
      userData = vi.fn();
    const details = migrationDetails();
    const expectations: VerificationExpectation[] = [];
    const progress = vi.fn();
    const source = [
      media('played-edition', {
        Played: true,
        PlayCount: 1,
        PlaybackPositionTicks: 10,
        LastPlayedDate: '2025-01-01T00:00:00Z',
      }),
      media('favorite-edition', { IsFavorite: true }),
      media('duplicate-favorite', { Played: true, IsFavorite: true }),
    ];
    expect(
      await migrateItemState(
        client({ updateUserData, markPlayed, markFavorite, userData }),
        'user',
        selected(source, target),
        details,
        () => {},
        () => {},
        {
          migration_scope: 'played_favorites',
          progress,
          expectation: (item, patch) =>
            expectations.push(captureExpectation(item, patch, 'played_favorites')),
        },
      ),
    ).toBe(1);
    expect(updateUserData).toHaveBeenCalledExactlyOnceWith('user', 'target', {
      Played: true,
      IsFavorite: true,
    });
    expect(current).toEqual({ ...original, Played: true, IsFavorite: true });
    expect(target.UserData).toEqual(original);
    expect(markPlayed).not.toHaveBeenCalled();
    expect(markFavorite).not.toHaveBeenCalled();
    expect(userData).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      items_updated: 1,
      favorites: 1,
      failed_items: 0,
      resume_positions: 0,
      play_counts: 0,
      last_played_dates: 0,
      ratings: 0,
    });
    expect(details.write_metrics).toMatchObject({ attempts: 1, succeeded: 1, failed: 0 });
    expect(expectations).toHaveLength(3);
    expect(
      expectations.every(
        (value) => evaluateExpectation(value, media('target', current)).status === 'verified',
      ),
    ).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(3, 3, 1);
  });

  it.each([
    'Movie',
    'Episode',
    'Series',
    'Season',
    'Audio',
    'MusicAlbum',
    'MusicArtist',
    'MusicVideo',
    'Video',
    'Book',
    'AudioBook',
    'Photo',
    'PhotoAlbum',
    'BoxSet',
    'Trailer',
  ])('imports an unwatched favorite %s without marking it played', async (Type) => {
    const updateUserData = vi.fn(async () => {});
    const details = migrationDetails();
    const target = media('target', { Played: false, IsFavorite: false }, Type);
    const source = media('source', { Played: false, IsFavorite: true }, Type);
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected([source], target),
        details,
        () => {},
        () => {},
        { migration_scope: 'played_favorites' },
      ),
    ).toBe(1);
    expect(updateUserData).toHaveBeenCalledExactlyOnceWith('user', 'target', { IsFavorite: true });
    expect(details.favorites).toBe(1);
  });

  it('preserves Jellyfin-only favorites and played flags and makes reruns a no-op', async () => {
    const target = media('target', { Played: true, IsFavorite: true });
    const updateUserData = vi.fn(async () => {}),
      expectation = vi.fn();
    const details = migrationDetails();
    const source = [
      media('played', { Played: true, IsFavorite: false }),
      media('favorite', { Played: false, IsFavorite: true }),
    ];
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected(source, target),
        details,
        () => {},
        () => {},
        { migration_scope: 'played_favorites', expectation },
      ),
    ).toBe(0);
    expect(updateUserData).not.toHaveBeenCalled();
    expect(expectation).toHaveBeenCalledTimes(2);
    expect(details).toMatchObject({ favorites: 0, items_updated: 0, failed_items: 0 });
  });

  it('does not import playlist, unknown type, resume-only or negative-only state', async () => {
    const updateUserData = vi.fn(async () => {});
    const source = [
      media('playlist', { IsFavorite: true }, 'Playlist'),
      media('unknown', { IsFavorite: true }, 'Unknown'),
      media('resume', { PlaybackPositionTicks: 10 }),
      media('negative', { Played: false, IsFavorite: false }),
    ];
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected(source, media('target')),
        migrationDetails(),
        () => {},
        () => {},
        { migration_scope: 'played_favorites' },
      ),
    ).toBe(0);
    expect(updateUserData).not.toHaveBeenCalled();
  });

  it('refuses legacy favorite endpoints when partial user-data updates are unavailable', async () => {
    const markPlayed = vi.fn(),
      markFavorite = vi.fn(),
      updateUserData = vi.fn();
    const details = migrationDetails();
    expect(
      await migrateItemState(
        client({
          markPlayed,
          markFavorite,
          updateUserData,
          migrationCapabilities: async () => ({
            userData: false,
            privatePlaylists: false,
            playlistDuplicates: false,
          }),
        }),
        'user',
        selected([media('source', { IsFavorite: true }, 'Series')], media('target', {}, 'Series')),
        details,
        () => {},
        () => {},
        { migration_scope: 'played_favorites' },
      ),
    ).toBe(0);
    expect(updateUserData).not.toHaveBeenCalled();
    expect(markPlayed).not.toHaveBeenCalled();
    expect(markFavorite).not.toHaveBeenCalled();
    expect(details.failed_items).toBe(1);
    expect(details.warnings.join(' ')).toContain('partial user-data');
  });

  it('never replays an uncertain combined mutation through a duplicate source edition', async () => {
    const updateUserData = vi.fn(async () => {
      throw new MediaError('Synthetic timeout.');
    });
    const details = migrationDetails();
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected(
          [media('played', { Played: true }), media('favorite', { IsFavorite: true })],
          media('target', { Played: false, IsFavorite: false }),
        ),
        details,
        () => {},
        () => {},
        { migration_scope: 'played_favorites' },
      ),
    ).toBe(0);
    expect(updateUserData).toHaveBeenCalledExactlyOnceWith('user', 'target', {
      Played: true,
      IsFavorite: true,
    });
    expect(details.write_metrics).toMatchObject({ attempts: 1, succeeded: 0, failed: 1 });
    expect(details.failed_items).toBe(2);
    expect(details.warnings.join(' ')).toContain('No duplicate mutation was sent');
  });

  it('drains bounded favorite workers before propagating cancellation', async () => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0,
      inFlight = 0,
      stopped = false;
    const updateUserData = vi.fn(async () => {
      inFlight++;
      if (++calls === 6) entered();
      await waiting;
      inFlight--;
    });
    const matches = Array.from({ length: 100 }, (_, index) => ({
      source: media(`source-${index}`, { IsFavorite: true }),
      target: media(`target-${index}`, { IsFavorite: false }),
      method: 'provider',
    }));
    const details = migrationDetails();
    const operation = migrateItemState(
      client({ updateUserData }),
      'user',
      { matches, unmatched: [], ambiguous: [] },
      details,
      () => {
        if (stopped) throw new ServiceError('Canceled.');
      },
      () => {},
      { migration_scope: 'played_favorites' },
    );
    const finished = expect(operation).rejects.toThrow('Canceled.');
    await started;
    expect(inFlight).toBe(6);
    stopped = true;
    release();
    await finished;
    expect(inFlight).toBe(0);
    expect(updateUserData).toHaveBeenCalledTimes(6);
    expect(details.write_metrics?.peak_in_flight).toBe(6);
  });

  it('never reads source playlists in played-and-favorites scope', async () => {
    const playlists = vi.fn(async () => []),
      playlistItems = vi.fn(async () => []);
    const source = [media('favorite', { IsFavorite: true }, 'Series')];
    const result = await readMigrationSource(
      client({ playlists, playlistItems }),
      'user',
      'played_favorites',
      source,
    );
    expect(result.items).toBe(source);
    expect(result.playlists).toEqual([]);
    expect(playlists).not.toHaveBeenCalled();
    expect(playlistItems).not.toHaveBeenCalled();
  });
});
