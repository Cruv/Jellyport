import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaAPI, MediaItem, MediaPlaylist, MediaUserDataPatch } from '../server/media.js';
import { MediaError, ServiceError } from '../server/errors.js';
import {
  hasPersonalState,
  mergeUserData,
  migrateItemState,
  migratePlaylists,
  migrationDetails,
  migrationWarning,
  playedDate,
  portableConfiguration,
  readMigrationSource,
  statePlan,
  type SourcePlaylist,
} from '../server/migration.js';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';

const oldDate = '2025-01-01T00:00:00.000Z';
const newDate = '2026-01-01T00:00:00.000Z';
const settings: Settings = {
  ...DEFAULT_SETTINGS,
  emby_url: 'http://emby.example.test',
  jellyfin_url: 'http://jellyfin.example.test',
};
const media = (Id: string, UserData: MediaUserDataPatch = {}, Type = 'Movie'): MediaItem => ({
  Id,
  Type,
  Path: `/library/${Id}`,
  UserData,
});
const client = (overrides: Partial<MediaAPI> = {}): MediaAPI => ({
  close: async () => {},
  systemInfo: async () => ({ Version: '12.2' }),
  users: async () => [],
  user: async (Id) => ({ Id, Name: 'alice' }),
  items: async () => [],
  createUser: async (Name) => ({ Id: 'new-user', Name }),
  setPassword: async () => {},
  setPolicy: async () => {},
  setConfiguration: async () => {},
  markPlayed: async () => {},
  ...overrides,
});
const directories: string[] = [];
const stores: Store[] = [];
function store(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-migration-'));
  directories.push(directory);
  const value = new Store(directory);
  stores.push(value);
  return value;
}
afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const playlistKey = (
  sourceId = 'source-user',
  targetId = 'target-user',
  playlistId = 'source-list',
) =>
  createHash('sha256')
    .update(
      JSON.stringify([settings.emby_url, sourceId, playlistId, settings.jellyfin_url, targetId]),
    )
    .digest('hex');

function playlistFixture(count = 2, duplicates = false) {
  const source = Array.from({ length: count }, (_, index) => ({
    Id: `source-${index}`,
    Type: 'Audio',
    Path: `/music/${index}.mp3`,
    MediaType: 'Audio',
  }));
  const target = source.map((item, index) => ({ ...item, Id: `target-${index}` }));
  const sourcePlaylists: SourcePlaylist[] = [
    {
      playlist: { Id: 'source-list', Name: 'My private mix', Type: 'Playlist', MediaType: 'Audio' },
      items: duplicates ? [source[1]!, source[0]!, source[1]!] : source,
    },
  ];
  let current: MediaItem[] = [];
  const createPlaylist = vi.fn(
    async (_userId: string, name: string, mediaType?: string, ids: string[] = []) => {
      current = ids.map((Id) => ({ Id, Type: 'Audio' }));
      return { Id: 'target-list', Name: name, Type: 'Playlist', MediaType: mediaType };
    },
  );
  const playlistItems = vi.fn(async () => structuredClone(current));
  const addPlaylistItems = vi.fn(async (_playlistId: string, _userId: string, ids: string[]) => {
    current.push(...ids.map((Id) => ({ Id, Type: 'Audio' })));
  });
  const api = client({
    migrationCapabilities: async () => ({
      userData: true,
      privatePlaylists: true,
      playlistDuplicates: true,
      version: '12.2',
    }),
    playlists: async () => [],
    playlistItems,
    createPlaylist,
    addPlaylistItems,
  });
  return {
    source,
    target,
    sourcePlaylists,
    api,
    createPlaylist,
    playlistItems,
    addPlaylistItems,
    current: () => current,
    setCurrent: (items: MediaItem[]) => {
      current = structuredClone(items);
    },
  };
}

const migrate = (
  database: Store,
  fixture: ReturnType<typeof playlistFixture>,
  details = migrationDetails(),
  stopped = () => {},
) =>
  migratePlaylists(
    database,
    settings,
    'source-user',
    'target-user',
    fixture.sourcePlaylists,
    fixture.target,
    fixture.api,
    details,
    stopped,
    () => {},
  );

describe('conservative migration merge policy', () => {
  it('handles playlist personal state through its imported copy instead of guessing a library identity', async () => {
    const fixture = playlistFixture();
    fixture.sourcePlaylists[0]!.playlist.UserData = { IsFavorite: true, Likes: true, Rating: 8 };
    const userData = vi.fn(async () => ({ IsFavorite: false }));
    const updateUserData = vi.fn(async () => {});
    fixture.api.userData = userData;
    fixture.api.updateUserData = updateUserData;
    expect(statePlan([fixture.sourcePlaylists[0]!.playlist], fixture.target, settings)).toEqual({
      matches: [],
      unmatched: [],
      ambiguous: [],
    });
    const details = migrationDetails();
    await migrate(store(), fixture, details);
    expect(userData).toHaveBeenCalledWith('target-user', 'target-list');
    expect(updateUserData).toHaveBeenCalledWith('target-user', 'target-list', {
      IsFavorite: true,
      Likes: true,
      Rating: 8,
    });
    expect(details).toMatchObject({ favorites: 1, ratings: 1, playlists_created: 1 });
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
  });
  it('unions watched and favorite flags without undoing Jellyfin state', () => {
    expect(
      mergeUserData(
        media('a', { Played: false, IsFavorite: false }),
        media('b', { Played: true, IsFavorite: true }),
      ),
    ).toEqual({});
    expect(mergeUserData(media('a', { Played: true, IsFavorite: true }), media('b'))).toEqual({
      Played: true,
      IsFavorite: true,
    });
  });

  it('uses maximum play count instead of adding histories and retains existing ratings', () => {
    expect(
      mergeUserData(
        media('a', { PlayCount: 5, Likes: true, Rating: 9 }),
        media('b', { PlayCount: 8, Likes: false, Rating: 0 }),
      ),
    ).toEqual({});
    expect(
      mergeUserData(
        media('a', { PlayCount: 12, Likes: false, Rating: 7.5 }),
        media('b', { PlayCount: 8 }),
      ),
    ).toEqual({ PlayCount: 12, Likes: false, Rating: 7.5 });
  });

  it('replaces resume progress only when both dates prove Emby is newer', () => {
    const from = media('a', { PlaybackPositionTicks: 20, LastPlayedDate: newDate });
    const to = {
      ...media('b', { PlaybackPositionTicks: 40, LastPlayedDate: oldDate }),
      RunTimeTicks: 100,
    };
    expect(mergeUserData(from, to)).toEqual({ PlaybackPositionTicks: 20, LastPlayedDate: newDate });
    expect(
      mergeUserData(
        media('a', { PlaybackPositionTicks: 0, Played: true, LastPlayedDate: newDate }),
        to,
      ),
    ).toEqual({ PlaybackPositionTicks: 0, Played: true, LastPlayedDate: newDate });
  });

  it.each([
    [newDate, newDate],
    [oldDate, newDate],
    [undefined, newDate],
    [undefined, undefined],
    [newDate, undefined],
  ])(
    'preserves existing Jellyfin resume when date ordering is uncertain or older (%s / %s)',
    (sourceDate, targetDate) => {
      const patch = mergeUserData(
        media('a', {
          PlaybackPositionTicks: 20,
          ...(sourceDate ? { LastPlayedDate: sourceDate } : {}),
        }),
        media('b', {
          PlaybackPositionTicks: 40,
          ...(targetDate ? { LastPlayedDate: targetDate } : {}),
        }),
      );
      expect(patch).not.toHaveProperty('PlaybackPositionTicks');
    },
  );

  it('fills a missing Jellyfin resume but respects dated or already played Jellyfin state', () => {
    expect(mergeUserData(media('a', { PlaybackPositionTicks: 20 }), media('b'))).toEqual({
      PlaybackPositionTicks: 20,
    });
    expect(
      mergeUserData(media('a', { PlaybackPositionTicks: 20, LastPlayedDate: newDate }), media('b')),
    ).toEqual({ PlaybackPositionTicks: 20, LastPlayedDate: newDate });
    expect(
      mergeUserData(media('a', { PlaybackPositionTicks: 20 }), media('b', { Played: true })),
    ).toEqual({});
    expect(
      mergeUserData(
        media('a', { PlaybackPositionTicks: 20 }),
        media('b', { LastPlayedDate: newDate }),
      ),
    ).toEqual({});
  });

  it('rejects malformed counts, ratings and positions and does not resume beyond a target runtime', () => {
    expect(
      mergeUserData(
        media('a', {
          PlaybackPositionTicks: Number.MAX_SAFE_INTEGER + 1,
          PlayCount: -2,
          Rating: 99,
        }),
        media('b'),
      ),
    ).toEqual({});
    expect(
      mergeUserData(media('a', { PlaybackPositionTicks: 100, LastPlayedDate: newDate }), {
        ...media('b', { LastPlayedDate: oldDate }),
        RunTimeTicks: 100,
      }),
    ).toEqual({ LastPlayedDate: newDate });
    expect(
      mergeUserData(
        media('a', { PlaybackPositionTicks: 1.5, PlayCount: 2_147_483_648 }),
        media('b'),
      ),
    ).toEqual({});
  });

  it.each(['Series', 'Season', 'MusicAlbum', 'MusicArtist', 'BoxSet', 'Photo'])(
    'copies only explicit favorites and ratings for %s containers',
    (type) => {
      const from = media(
        'a',
        {
          Played: true,
          PlayCount: 9,
          LastPlayedDate: newDate,
          PlaybackPositionTicks: 60,
          IsFavorite: true,
          Likes: true,
          Rating: 8,
        },
        type,
      );
      expect(mergeUserData(from, media('b', {}, type))).toEqual({
        IsFavorite: true,
        Likes: true,
        Rating: 8,
      });
      expect(
        hasPersonalState(
          media(
            'a',
            { Played: true, PlayCount: 9, LastPlayedDate: newDate, PlaybackPositionTicks: 60 },
            type,
          ),
        ),
      ).toBe(false);
    },
  );

  it('plans favorites and partial progress even when they have never been played', () => {
    const source = [
      media('favorite', { IsFavorite: true }),
      media('resume', { PlaybackPositionTicks: 30 }),
      media('untouched'),
      media('watched', { Played: true }),
    ];
    const target = source.map((item) => ({ ...item, Id: `target-${item.Id}`, UserData: {} }));
    expect(statePlan(source, target, settings).matches.map((match) => match.source.Id)).toEqual([
      'favorite',
      'resume',
      'watched',
    ]);
    expect(hasPersonalState(media('a', { Played: false, IsFavorite: false, PlayCount: 0 }))).toBe(
      false,
    );
  });

  it('does not guess identity from titles for user-state writes', () => {
    const source = {
      Id: 'source',
      Name: 'Same title',
      Type: 'Movie',
      UserData: { IsFavorite: true },
    };
    const target = { Id: 'target', Name: 'Same title', Type: 'Movie' };
    expect(statePlan([source], [target], settings)).toMatchObject({
      matches: [],
      unmatched: [source],
    });
  });

  it('normalizes valid dates and ignores invalid source values', () => {
    expect(playedDate('2026-01-01T01:00:00+01:00')).toBe(newDate);
    for (const value of [undefined, null, 7, 'yesterday', '2026-01-01', '2026-99-99T00:00:00Z'])
      expect(playedDate(value)).toBeUndefined();
  });

  it('copies only portable settings and keeps template library and security configuration', () => {
    const template = {
      AudioLanguagePreference: 'eng',
      OrderedViews: ['target-library'],
      HiddenViews: ['target-hidden'],
      EnableLocalPassword: false,
      Nested: { retained: true },
    };
    const source = {
      AudioLanguagePreference: 'fra',
      SubtitleLanguagePreference: 'eng',
      SubtitleMode: 'Smart',
      PlayDefaultAudioTrack: false,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: false,
      OrderedViews: ['source-library'],
      HiddenViews: ['source-hidden'],
      EnableLocalPassword: true,
      IsAdministrator: true,
      api_key: 'private-value',
    };
    const result = portableConfiguration(source, template);
    expect(result.configuration).toEqual({
      ...template,
      AudioLanguagePreference: 'fra',
      SubtitleLanguagePreference: 'eng',
      SubtitleMode: 'Smart',
      PlayDefaultAudioTrack: false,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: false,
    });
    expect(result.copied).toEqual(
      expect.arrayContaining([
        'AudioLanguagePreference',
        'SubtitleLanguagePreference',
        'SubtitleMode',
        'PlayDefaultAudioTrack',
        'RememberSubtitleSelections',
        'EnableNextEpisodeAutoPlay',
      ]),
    );
    expect(result.copied).not.toContain('OrderedViews');
    expect(result.configuration).not.toHaveProperty('api_key');
    expect(result.configuration).not.toHaveProperty('IsAdministrator');
    expect(result.configuration.Nested).not.toBe(template.Nested);
    expect(template.AudioLanguagePreference).toBe('eng');
  });

  it('ignores malformed portable settings and bounds warning storage', () => {
    expect(
      portableConfiguration(
        {
          AudioLanguagePreference: 'x'.repeat(65),
          SubtitleLanguagePreference: 'eng\n',
          SubtitleMode: 'Unknown',
          RememberAudioSelections: 'true',
        },
        { SubtitleMode: 'Default' },
      ).configuration,
    ).toEqual({ SubtitleMode: 'Default' });
    const details = migrationDetails();
    migrationWarning(details, 'same');
    migrationWarning(details, 'same');
    expect(details.warnings).toEqual(['same']);
    for (let index = 0; index < 100; index++) migrationWarning(details, `warning-${index}`);
    expect(details.warnings).toHaveLength(50);
    expect(migrationDetails().warnings).toEqual([]);
  });
});

describe('user-state application and reporting', () => {
  it('re-reads target user data so later Jellyfin progress wins over the preview snapshot', async () => {
    const from = media('a', {
      IsFavorite: true,
      PlaybackPositionTicks: 20,
      LastPlayedDate: oldDate,
    });
    const target = { ...media('b'), Path: from.Path };
    const updateUserData = vi.fn(async () => {});
    const userData = vi.fn(async () => ({ PlaybackPositionTicks: 40, LastPlayedDate: newDate }));
    const api = client({
      migrationCapabilities: async () => ({
        userData: true,
        privatePlaylists: false,
        playlistDuplicates: false,
      }),
      userData,
      updateUserData,
    });
    const details = migrationDetails();
    await migrateItemState(
      api,
      'target-user',
      statePlan([from], [target], settings),
      details,
      () => {},
      () => {},
    );
    expect(userData).toHaveBeenCalledWith('target-user', 'b');
    expect(updateUserData).toHaveBeenCalledWith('target-user', 'b', { IsFavorite: true });
    expect(details).toMatchObject({ favorites: 1, resume_positions: 0, items_updated: 1 });
  });

  it('prevents a write if the recipient guard changes while fresh user data is being read', async () => {
    const from = media('a', { IsFavorite: true }),
      target = { ...media('b'), Path: from.Path };
    let releaseRead!: () => void, markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let recipientChanged = false;
    const changed = new ServiceError(
      'The account mapping changed. Review the recipient before retrying.',
    );
    const updateUserData = vi.fn(async () => {}),
      saved = vi.fn();
    const api = client({
      migrationCapabilities: async () => ({
        userData: true,
        privatePlaylists: false,
        playlistDuplicates: false,
      }),
      userData: async () => {
        markReading();
        await released;
        return {};
      },
      updateUserData,
    });
    const details = migrationDetails();
    const operation = migrateItemState(
      api,
      'former-recipient',
      statePlan([from], [target], settings),
      details,
      () => {
        if (recipientChanged) throw changed;
      },
      saved,
    );
    await reading;
    recipientChanged = true;
    releaseRead();
    await expect(operation).rejects.toBe(changed);
    expect(updateUserData).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(details).toMatchObject({ items_updated: 0, favorites: 0, failed_items: 0 });
  });

  it('rechecks the recipient guard between separate legacy played and favorite mutations', async () => {
    const from = media('a', { Played: true, IsFavorite: true }),
      target = { ...media('b'), Path: from.Path };
    let recipientChanged = false;
    const changed = new ServiceError('The account mapping changed.');
    const markPlayed = vi.fn(async () => {
      recipientChanged = true;
    });
    const markFavorite = vi.fn(async () => {});
    const details = migrationDetails();
    await expect(
      migrateItemState(
        client({ markPlayed, markFavorite }),
        'former-recipient',
        statePlan([from], [target], settings),
        details,
        () => {
          if (recipientChanged) throw changed;
        },
        () => {},
      ),
    ).rejects.toBe(changed);
    expect(markPlayed).toHaveBeenCalledOnce();
    expect(markFavorite).not.toHaveBeenCalled();
  });

  it('uses historical played dates and favorites on legacy clients with an explicit warning for unsupported data', async () => {
    const from = media('a', {
      Played: true,
      IsFavorite: true,
      PlayCount: 4,
      LastPlayedDate: oldDate,
      PlaybackPositionTicks: 20,
    });
    const target = { ...media('b'), Path: from.Path };
    const markPlayed = vi.fn(async () => {}),
      markFavorite = vi.fn(async () => {});
    const api = client({ markPlayed, markFavorite });
    const details = migrationDetails();
    expect(
      await migrateItemState(
        api,
        'target-user',
        statePlan([from], [target], settings),
        details,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(markPlayed).toHaveBeenCalledWith('target-user', 'b', oldDate);
    expect(markFavorite).toHaveBeenCalledWith('target-user', 'b');
    expect(details).toMatchObject({ favorites: 1, resume_positions: 0, play_counts: 0 });
    expect(details.warnings.join(' ')).toMatch(/limited|10\.9/);
  });

  it('does not report unsupported-only state as updated on legacy servers', async () => {
    const from = media('a', { PlaybackPositionTicks: 20 }),
      target = { ...media('b'), Path: from.Path };
    const markPlayed = vi.fn(async () => {});
    const details = migrationDetails();
    await migrateItemState(
      client({ markPlayed }),
      'target-user',
      statePlan([from], [target], settings),
      details,
      () => {},
      () => {},
    );
    expect(markPlayed).not.toHaveBeenCalled();
    expect(details.items_updated).toBe(0);
    expect(details.warnings.join(' ')).toMatch(/limited|10\.9/);
  });

  it('does not mutate a target when fresh user data cannot be read', async () => {
    const from = media('a', { IsFavorite: true }),
      target = { ...media('b'), Path: from.Path };
    const updateUserData = vi.fn(async () => {});
    const api = client({
      migrationCapabilities: async () => ({
        userData: true,
        privatePlaylists: false,
        playlistDuplicates: false,
      }),
      userData: async () => {
        throw new MediaError('Jellyfin request timed out.');
      },
      updateUserData,
    });
    const details = migrationDetails();
    await migrateItemState(
      api,
      'target-user',
      statePlan([from], [target], settings),
      details,
      () => {},
      () => {},
    );
    expect(updateUserData).not.toHaveBeenCalled();
    expect(details.failed_items).toBe(1);
    expect(details.warnings).toEqual(['Jellyfin request timed out.']);
  });
});

describe('private playlist migration and durable retries', () => {
  it('keeps ordered duplicates on supported Jellyfin and completes only after readback', async () => {
    const database = store(),
      fixture = playlistFixture(2, true),
      details = migrationDetails();
    await migrate(database, fixture, details);
    expect(fixture.createPlaylist).toHaveBeenCalledWith(
      'target-user',
      expect.stringContaining('My private mix'),
      'Audio',
      ['target-1', 'target-0', 'target-1'],
    );
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-1', 'target-0', 'target-1']);
    expect(fixture.playlistItems.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(database.playlistImport(playlistKey())).toMatchObject({
      targetId: 'target-list',
      status: 'complete',
    });
    expect(details).toMatchObject({
      playlists_created: 1,
      playlist_items_added: 3,
      playlist_duplicates_skipped: 0,
    });
  });

  it('reports old-server duplicate losses while keeping first occurrences and order', async () => {
    const database = store(),
      fixture = playlistFixture(2, true),
      details = migrationDetails();
    fixture.api.migrationCapabilities = async () => ({
      userData: true,
      privatePlaylists: true,
      playlistDuplicates: false,
      version: '10.11.10',
    });
    await migrate(database, fixture, details);
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-1', 'target-0']);
    expect(details.playlist_duplicates_skipped).toBe(1);
    expect(details.warnings.join(' ')).toMatch(/duplicate/);
  });

  it('reuses an unchanged completed import without any additional playlist writes', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    await migrate(database, fixture);
    await migrate(database, fixture, details);
    expect(fixture.createPlaylist).toHaveBeenCalledOnce();
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-0', 'target-1']);
    expect(details.playlists_existing).toBe(1);
    expect(details.playlists_created).toBe(0);
  });

  it('fails closed when private playlists are unavailable', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    fixture.api.migrationCapabilities = async () => ({
      userData: false,
      privatePlaylists: false,
      playlistDuplicates: false,
    });
    await migrate(database, fixture, details);
    expect(fixture.createPlaylist).not.toHaveBeenCalled();
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(database.playlistImport(playlistKey())).toBeNull();
    expect(details.warnings.join(' ')).toMatch(/private|Private/);
  });

  it('skips missing and ambiguous playlist entries instead of guessing', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    fixture.target.splice(1, 1);
    fixture.target.push({ ...fixture.target[0]!, Id: 'duplicate-target' });
    await migrate(database, fixture, details);
    expect(fixture.current()).toEqual([]);
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(details.playlist_items_skipped).toBe(2);
    expect(details.warnings.join(' ')).toMatch(/missing|ambiguous/);
  });

  it('persists uncertainty before creation and avoids duplicate creation after timeout', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    fixture.createPlaylist.mockImplementation(async () => {
      expect(database.playlistImport(playlistKey())).toMatchObject({ status: 'uncertain' });
      throw new MediaError(
        'Jellyfin request timed out. The operation may have been applied; check before retrying.',
      );
    });
    await migrate(database, fixture, details);
    await migrate(database, fixture, migrationDetails());
    expect(fixture.createPlaylist).toHaveBeenCalledOnce();
    expect(database.playlistImport(playlistKey())).toMatchObject({ status: 'uncertain' });
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
  });

  it('recovers a known creation by readback after a temporary read failure without further writes', async () => {
    const database = store(),
      fixture = playlistFixture(102);
    fixture.playlistItems.mockRejectedValueOnce(new MediaError('Jellyfin request timed out.'));
    await migrate(database, fixture);
    expect(fixture.current()).toHaveLength(102);
    expect(database.playlistImport(playlistKey())).toMatchObject({
      targetId: 'target-list',
      status: 'ready',
    });
    await migrate(database, fixture);
    expect(fixture.createPlaylist).toHaveBeenCalledOnce();
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(fixture.current().map((item) => item.Id)).toEqual(fixture.target.map((item) => item.Id));
    expect(database.playlistImport(playlistKey())).toMatchObject({ status: 'complete' });
  });

  it('does not repair partial creation through later append writes', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    fixture.createPlaylist.mockImplementation(async (_userId, name, mediaType) => {
      fixture.setCurrent([{ Id: 'target-0', Type: 'Audio' }]);
      return { Id: 'target-list', Name: name, Type: 'Playlist', MediaType: mediaType };
    });
    await migrate(database, fixture, details);
    await migrate(database, fixture, details);
    expect(fixture.createPlaylist).toHaveBeenCalledOnce();
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-0']);
    expect(database.playlistImport(playlistKey())?.status).not.toBe('complete');
    expect(details.warnings.length).toBeGreaterThan(0);
  });

  it('preserves existing contents when a resumed target was edited', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    database.savePlaylistImport(playlistKey(), {
      name: 'Imported',
      targetId: 'target-list',
      status: 'ready',
    });
    fixture.setCurrent([{ Id: 'target-1', Type: 'Audio' }]);
    await migrate(database, fixture, details);
    expect(fixture.createPlaylist).not.toHaveBeenCalled();
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-1']);
    expect(details.warnings.join(' ')).toMatch(/edited|differs|preserved/);
  });

  it('preserves a completed import when Emby changes instead of appending to potentially shared content', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    await migrate(database, fixture);
    fixture.sourcePlaylists[0]!.items.push({
      Id: 'source-new',
      Type: 'Audio',
      Path: '/music/new.mp3',
    });
    fixture.target.push({
      Id: 'target-new',
      Type: 'Audio',
      Path: '/music/new.mp3',
      MediaType: 'Audio',
    });
    await migrate(database, fixture, details);
    expect(fixture.createPlaylist).toHaveBeenCalledOnce();
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-0', 'target-1']);
    expect(details.warnings.length).toBeGreaterThan(0);
  });

  it('does not restore entries deleted from a completed Jellyfin import', async () => {
    const database = store(),
      fixture = playlistFixture(),
      details = migrationDetails();
    await migrate(database, fixture);
    fixture.setCurrent([{ Id: 'target-0', Type: 'Audio' }]);
    fixture.addPlaylistItems.mockClear();
    await migrate(database, fixture, details);
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(fixture.current().map((item) => item.Id)).toEqual(['target-0']);
    expect(details.warnings.join(' ')).toMatch(/edited|preserved|changed/);
  });

  it('infers video playlist media type when source playlist metadata omits it', async () => {
    const database = store(),
      fixture = playlistFixture(1);
    fixture.source[0]!.Type = 'Movie';
    fixture.source[0]!.MediaType = 'Video';
    fixture.target[0]!.Type = 'Movie';
    fixture.target[0]!.MediaType = 'Video';
    delete fixture.sourcePlaylists[0]!.playlist.MediaType;
    await migrate(database, fixture);
    expect(fixture.createPlaylist).toHaveBeenCalledWith(
      'target-user',
      expect.any(String),
      'Video',
      ['target-0'],
    );
  });

  it('propagates application shutdown after atomic creation and avoids later writes', async () => {
    const database = store(),
      fixture = playlistFixture(102);
    let stop = false;
    const shutdown = new ServiceError('Application is stopping.');
    const original = fixture.createPlaylist.getMockImplementation()!;
    fixture.createPlaylist.mockImplementation(async (...args) => {
      const created = await original(...args);
      stop = true;
      return created;
    });
    await expect(
      migrate(database, fixture, migrationDetails(), () => {
        if (stop) throw shutdown;
      }),
    ).rejects.toBe(shutdown);
    expect(fixture.current()).toHaveLength(102);
    expect(fixture.addPlaylistItems).not.toHaveBeenCalled();
    expect(database.playlistImport(playlistKey())?.status).not.toBe('complete');
  });
});

describe('source snapshot scope, bounds and safe errors', () => {
  it('uses broad reads for the selected user and keeps playlist failures separate from library data', async () => {
    const migrationItems = vi.fn(async () => [media('one', { IsFavorite: true })]);
    const items = vi.fn(async () => []);
    const playlistItems = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('private-source-api-key');
      return [media('song', {}, 'Audio')];
    });
    const source = client({
      migrationItems,
      items,
      playlists: async () => [
        { Id: 'good', Name: 'Good' },
        { Id: 'bad', Name: 'Bad' },
      ],
      playlistItems,
    });
    const snapshot = await readMigrationSource(source, 'selected-user');
    expect(migrationItems).toHaveBeenCalledWith('selected-user');
    expect(items).not.toHaveBeenCalled();
    expect(playlistItems).toHaveBeenCalledWith('good', 'selected-user');
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.playlists[1]).toMatchObject({ items: [], error: expect.any(String) });
    expect(JSON.stringify(snapshot)).not.toContain('private-source-api-key');
  });

  it('retains watched-only source compatibility with an explicit playlist warning', async () => {
    const items = vi.fn(async () => [media('one', { Played: true })]);
    const snapshot = await readMigrationSource(client({ items }), 'selected-user');
    expect(items).toHaveBeenCalledWith('selected-user');
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.warnings.join(' ')).toMatch(/playlist/);
  });

  it('bounds playlist counts for a single user snapshot', async () => {
    const playlistItems = vi.fn(async () => []);
    const playlists: MediaPlaylist[] = Array.from({ length: 501 }, (_, index) => ({
      Id: `list-${index}`,
      Name: `List ${index}`,
    }));
    const snapshot = await readMigrationSource(
      client({ playlists: async () => playlists, playlistItems }),
      'selected-user',
    );
    expect(playlistItems.mock.calls.length).toBeLessThanOrEqual(500);
    expect(snapshot.playlists.length).toBeLessThanOrEqual(500);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });

  it('bounds cumulative playlist entries across one user snapshot', async () => {
    const one = media('song', {}, 'Audio');
    const playlistItems = vi.fn(async (id: string) =>
      Array.from({ length: id === 'one' ? 60_000 : 50_000 }, () => one),
    );
    const snapshot = await readMigrationSource(
      client({
        playlists: async () => [
          { Id: 'one', Name: 'One' },
          { Id: 'two', Name: 'Two' },
        ],
        playlistItems,
      }),
      'selected-user',
    );
    expect(
      snapshot.playlists.reduce((total, entry) => total + entry.items.length, 0),
    ).toBeLessThanOrEqual(100_000);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });
});
