import { describe, expect, it, vi } from 'vitest';
import { migrateItemState, migrationDetails, statePlan } from '../server/migration.js';
import { createMatcher } from '../server/matching.js';
import { DEFAULT_SETTINGS } from '../server/types.js';
import {
  captureExpectation,
  evaluateExpectation,
  type VerificationExpectation,
} from '../server/migration-verification.js';
import type { MediaAPI, MediaItem, MediaUserDataPatch } from '../server/media.js';
import { MediaError, ServiceError } from '../server/errors.js';

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
const plan = (count: number) => ({
  matches: Array.from({ length: count }, (_, index) => ({
    source: media(`source-${index}`, { Played: true }),
    target: media(`target-${index}`, { Played: false }),
    method: 'provider',
  })),
  unmatched: [],
  ambiguous: [],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('strict public played-flag writer', () => {
  it.each([undefined, 'watched_only', 'complete'] as const)(
    'only posts Played:true and preserves every other field for scope %s',
    async (scope) => {
      const source = media('source', {
        Played: true,
        IsFavorite: true,
        Likes: true,
        Rating: 9,
        PlayCount: 99,
        PlaybackPositionTicks: 500,
        LastPlayedDate: '2027-01-01T00:00:00Z',
      });
      const original = {
        Played: false,
        IsFavorite: false,
        Likes: false,
        Rating: 3,
        PlayCount: 2,
        PlaybackPositionTicks: 42,
        LastPlayedDate: '2026-01-01T00:00:00Z',
      };
      let current = { ...original };
      const userData = vi.fn(async () => {
        throw new Error('Single-item chronology reads are unnecessary');
      });
      const updateUserData = vi.fn(
        async (_user: string, _id: string, patch: MediaUserDataPatch) => {
          current = { ...current, ...patch };
        },
      );
      const markPlayed = vi.fn(async () => {}),
        markFavorite = vi.fn(async () => {});
      const details = migrationDetails();
      const expectations: VerificationExpectation[] = [];
      expect(
        await migrateItemState(
          client({ userData, updateUserData, markPlayed, markFavorite }),
          'user',
          {
            matches: [{ source, target: media('target', original), method: 'provider' }],
            unmatched: [],
            ambiguous: [],
          },
          details,
          () => {},
          () => {},
          {
            migration_scope: scope,
            expectation: (target, patch) =>
              expectations.push(captureExpectation(target, patch, scope)),
          },
        ),
      ).toBe(1);
      expect(updateUserData).toHaveBeenCalledExactlyOnceWith('user', 'target', { Played: true });
      expect(current).toEqual({ ...original, Played: true });
      expect(userData).not.toHaveBeenCalled();
      expect(markPlayed).not.toHaveBeenCalled();
      expect(markFavorite).not.toHaveBeenCalled();
      expect(details).toMatchObject({
        items_updated: 1,
        favorites: 0,
        resume_positions: 0,
        play_counts: 0,
        last_played_dates: 0,
        ratings: 0,
        history_dates_missing: 0,
        failed_items: 0,
      });
      expect(details.warnings).toEqual([]);
      expect(details.write_metrics).toMatchObject({
        attempts: 1,
        succeeded: 1,
        failed: 0,
        peak_in_flight: 1,
      });
      expect(details.write_metrics!.cumulative_ms).toBeGreaterThanOrEqual(0);
      expect(details.write_metrics!.max_ms).toBe(details.write_metrics!.cumulative_ms);
      expect(details.failed_updates).toBeUndefined();
      expect(expectations[0]!.state).toEqual({ Played: true });
      expect(evaluateExpectation(expectations[0]!, media('target', current)).status).toBe(
        'verified',
      );
    },
  );

  it('never unwatches existing destination activity and ignores all non-played/container-only source data', async () => {
    const selected = plan(4);
    selected.matches[0]!.source.UserData = {
      Played: false,
      IsFavorite: true,
      PlaybackPositionTicks: 5,
    };
    selected.matches[0]!.target.UserData = { Played: true };
    selected.matches[1]!.source.UserData = { Played: true };
    selected.matches[1]!.target.UserData = { Played: true };
    selected.matches[2]!.source.Type = 'Series';
    selected.matches[3]!.source.Type = 'Playlist';
    const updateUserData = vi.fn(async () => {}),
      expectation = vi.fn();
    const details = migrationDetails();
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected,
        details,
        () => {},
        () => {},
        { migration_scope: 'complete', expectation },
      ),
    ).toBe(0);
    expect(updateUserData).not.toHaveBeenCalled();
    expect(expectation).toHaveBeenCalledExactlyOnceWith(selected.matches[1]!.target, {}, []);
    expect(details.failed_items).toBe(0);
    expect(details.write_metrics).toEqual({
      attempts: 0,
      succeeded: 0,
      failed: 0,
      cumulative_ms: 0,
      max_ms: 0,
      peak_in_flight: 0,
    });
  });

  it.each(['Movie', 'Episode', 'Audio', 'MusicVideo', 'Video', 'Book', 'AudioBook', 'Trailer'])(
    'supports the played flag for %s',
    async (Type) => {
      const selected = plan(1);
      selected.matches[0]!.source.Type = Type;
      selected.matches[0]!.target.Type = Type;
      const updateUserData = vi.fn(async () => {});
      expect(
        await migrateItemState(
          client({ updateUserData }),
          'user',
          selected,
          migrationDetails(),
          () => {},
          () => {},
        ),
      ).toBe(1);
      expect(updateUserData).toHaveBeenCalledWith('user', 'target-0', { Played: true });
    },
  );

  it.each(['legacy capability', 'missing writer', 'capability failure'] as const)(
    'refuses unsafe updates without a legacy fallback (%s)',
    async (condition) => {
      const updateUserData = vi.fn(async () => {}),
        markPlayed = vi.fn(async () => {}),
        markFavorite = vi.fn(async () => {}),
        expectation = vi.fn();
      const api = client({ updateUserData, markPlayed, markFavorite });
      if (condition === 'legacy capability')
        api.migrationCapabilities = async () => ({
          userData: false,
          privatePlaylists: false,
          playlistDuplicates: false,
        });
      if (condition === 'missing writer') delete api.updateUserData;
      if (condition === 'capability failure')
        api.migrationCapabilities = async () => {
          throw new Error('PRIVATE_RAW_FAILURE');
        };
      const details = migrationDetails();
      expect(
        await migrateItemState(
          api,
          'user',
          plan(1),
          details,
          () => {},
          () => {},
          { expectation },
        ),
      ).toBe(0);
      expect(updateUserData).not.toHaveBeenCalled();
      expect(markPlayed).not.toHaveBeenCalled();
      expect(markFavorite).not.toHaveBeenCalled();
      expect(details.failed_items).toBe(1);
      expect(details.write_metrics).toMatchObject({ attempts: 0, succeeded: 0, failed: 0 });
      expect(details.failed_updates).toEqual([
        {
          target_id: 'target-0',
          item_type: 'Movie',
          error: expect.stringContaining('partial user-data'),
        },
      ]);
      expect(details.warnings.join(' ')).toContain('partial user-data');
      expect(details.warnings.join(' ')).not.toContain('PRIVATE_RAW_FAILURE');
      expect(expectation).toHaveBeenCalledWith(expect.anything(), { Played: true }, ['Played']);
    },
  );

  it('deduplicates source editions to one mutation per destination and still captures every expectation', async () => {
    const selected = plan(100);
    selected.matches.forEach((match, index) => {
      match.target.Id = `target-${index % 10}`;
    });
    const updateUserData = vi.fn(
        async (_user: string, _id: string, _patch: MediaUserDataPatch) => {},
      ),
      expectation = vi.fn(),
      progress = vi.fn();
    const details = migrationDetails();
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected,
        details,
        () => {},
        () => {},
        { expectation, progress },
      ),
    ).toBe(10);
    expect(updateUserData).toHaveBeenCalledTimes(10);
    expect(new Set(updateUserData.mock.calls.map((call) => call[1])).size).toBe(10);
    expect(expectation).toHaveBeenCalledTimes(100);
    expect(progress).toHaveBeenLastCalledWith(100, 100, 10);
    expect(selected.matches.every((match) => match.target.UserData?.Played === false)).toBe(true);
    expect(details.write_metrics).toMatchObject({ attempts: 10, succeeded: 10, failed: 0 });
  });

  it('does not replay an uncertain mutation through another source edition', async () => {
    const selected = plan(2);
    selected.matches[1]!.target.Id = selected.matches[0]!.target.Id;
    const updateUserData = vi.fn(async () => {
      throw new MediaError('Jellyfin request timed out.');
    });
    const expectation = vi.fn(),
      details = migrationDetails();
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        selected,
        details,
        () => {},
        () => {},
        { expectation },
      ),
    ).toBe(0);
    expect(updateUserData).toHaveBeenCalledOnce();
    expect(expectation).toHaveBeenCalledTimes(2);
    expect(details.failed_items).toBe(2);
    expect(details.warnings.join(' ')).toContain('No duplicate mutation was sent');
    expect(details.write_metrics).toMatchObject({ attempts: 1, succeeded: 0, failed: 1 });
    expect(details.failed_updates).toHaveLength(2);
    expect(details.failed_updates!.map((failure) => failure.target_id)).toEqual([
      'target-0',
      'target-0',
    ]);
  });

  it.each([undefined, 1, 4, 6])(
    'bounds independent mutations to the chosen ceiling and reports every completed match (%s)',
    async (concurrency) => {
      const limit = concurrency ?? 6;
      const total = limit * 2;
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      let active = 0,
        maximum = 0,
        calls = 0;
      const updateUserData = vi.fn(async () => {
        active++;
        maximum = Math.max(maximum, active);
        if (++calls === limit) started();
        await gate;
        await tick();
        active--;
      });
      const details = migrationDetails();
      const progress = vi.fn(),
        saved = vi.fn();
      const operation = migrateItemState(
        client({ updateUserData }),
        'user',
        plan(total),
        details,
        () => {},
        saved,
        { concurrency, progress },
      );
      await writing;
      expect(active).toBe(limit);
      expect(calls).toBe(limit);
      release();
      expect(await operation).toBe(total);
      expect(maximum).toBe(limit);
      expect(active).toBe(0);
      expect(saved).toHaveBeenCalledTimes(total);
      expect(progress.mock.calls.map(([processed, total]) => [processed, total])).toEqual(
        Array.from({ length: total }, (_, index) => [index + 1, total]),
      );
      expect(progress.mock.calls.every(([processed, , updated]) => updated <= processed)).toBe(
        true,
      );
      expect(details.write_metrics).toMatchObject({
        attempts: total,
        succeeded: total,
        failed: 0,
        peak_in_flight: limit,
      });
      expect(details.write_metrics!.cumulative_ms).toBeGreaterThan(0);
      expect(details.write_metrics!.max_ms).toBeGreaterThan(0);
      expect(details.write_metrics!.max_ms).toBeLessThanOrEqual(
        details.write_metrics!.cumulative_ms,
      );
    },
  );

  it('drains an already-issued mutation before propagating a changed guard and never starts queued targets', async () => {
    let release!: () => void, started!: () => void, guardFailed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      guardFailed = resolve;
    });
    let changed = false,
      settled = false;
    const failure = new ServiceError('Synthetic mapping changed.');
    const updateUserData = vi.fn(async () => {
      changed = true;
      started();
      await gate;
    });
    const details = migrationDetails();
    const operation = migrateItemState(
      client({ updateUserData }),
      'user',
      plan(3),
      details,
      () => {
        if (changed) {
          guardFailed();
          throw failure;
        }
      },
      () => {},
      { concurrency: 2 },
    ).finally(() => {
      settled = true;
    });
    const rejected = expect(operation).rejects.toBe(failure);
    await writing;
    await stopped;
    await tick();
    expect(settled).toBe(false);
    expect(updateUserData).toHaveBeenCalledOnce();
    release();
    await rejected;
    expect(settled).toBe(true);
    expect(details.write_metrics).toMatchObject({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      peak_in_flight: 1,
    });
  });

  it('isolates an ordinary target failure while keeping accurate processed and updated counts', async () => {
    const details = migrationDetails(),
      progress = vi.fn();
    const updateUserData = vi.fn(async (_user: string, id: string) => {
      if (id === 'target-1') throw new MediaError('Jellyfin request timed out.');
    });
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        plan(4),
        details,
        () => {},
        () => {},
        { progress },
      ),
    ).toBe(3);
    expect(details).toMatchObject({ items_updated: 3, failed_items: 1 });
    expect(progress).toHaveBeenLastCalledWith(4, 4, 3);
    expect(details.warnings).toEqual(['Jellyfin request timed out.']);
    expect(details.write_metrics).toMatchObject({ attempts: 4, succeeded: 3, failed: 1 });
    expect(details.failed_updates).toEqual([
      { target_id: 'target-1', item_type: 'Movie', error: 'Jellyfin request timed out.' },
    ]);
  });

  it('caps authenticated failure details without dropping totals or exposing raw errors', async () => {
    const details = migrationDetails();
    const updateUserData = vi.fn(async () => {
      throw new Error('PRIVATE_RAW_FAILURE');
    });
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'user',
        plan(205),
        details,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(updateUserData).toHaveBeenCalledTimes(205);
    expect(details.failed_items).toBe(205);
    expect(details.failed_updates).toHaveLength(200);
    expect(new Set(details.failed_updates!.map((failure) => failure.target_id)).size).toBe(200);
    expect(
      details.failed_updates!.every(
        (failure) =>
          failure.item_type === 'Movie' &&
          failure.error === 'An item could not be updated. Review the migration and retry.',
      ),
    ).toBe(true);
    expect(details.write_metrics).toMatchObject({ attempts: 205, succeeded: 0, failed: 205 });
    expect(details.warnings.join(' ')).toContain('limited to 200');
    expect(JSON.stringify(details)).not.toContain('PRIVATE_RAW_FAILURE');
  });

  it('yields a large already-watched history so timer cancellation can run', async () => {
    const selected = plan(10_000);
    selected.matches.forEach((match) => {
      match.target.UserData = { Played: true };
    });
    const updateUserData = vi.fn(async () => {});
    let canceled = false,
      processed = 0;
    const failure = new ServiceError('Synthetic canceled');
    const timer = setTimeout(() => {
      canceled = true;
    }, 0);
    try {
      await expect(
        migrateItemState(
          client({ updateUserData }),
          'user',
          selected,
          migrationDetails(),
          () => {
            if (canceled) throw failure;
          },
          () => {},
          {
            progress: (value) => {
              processed = value;
            },
          },
        ),
      ).rejects.toBe(failure);
    } finally {
      clearTimeout(timer);
    }
    expect(processed).toBeGreaterThanOrEqual(250);
    expect(processed).toBeLessThanOrEqual(1000);
    expect(updateUserData).not.toHaveBeenCalled();
  });

  it.each([0, 7, 1.5, NaN])(
    'rejects invalid worker concurrency before server calls (%s)',
    async (concurrency) => {
      const migrationCapabilities = vi.fn();
      await expect(
        migrateItemState(
          client({ migrationCapabilities }),
          'user',
          plan(1),
          migrationDetails(),
          () => {},
          () => {},
          { concurrency },
        ),
      ).rejects.toThrow('between 1 and 6');
      expect(migrationCapabilities).not.toHaveBeenCalled();
    },
  );
});

describe('episode identity collisions through played-state migration', () => {
  function episodeFixture(alreadyPlayed = false) {
    const source: MediaItem = {
      Id: 'source-episode-13',
      Type: 'Episode',
      SeriesName: 'Workshop Rescue',
      Name: 'The third check-in',
      ParentIndexNumber: 2,
      IndexNumber: 13,
      SeriesProviderIds: { Tvdb: '770000', Imdb: 'tt7700000' },
      ProviderIds: { Tvdb: '770013', Imdb: 'tt7700013' },
      Path: '/source-tv/Workshop Rescue/Season 02/episode-13.mkv',
      UserData: { Played: true, IsFavorite: true, PlayCount: 99, PlaybackPositionTicks: 500 },
    };
    const correct: MediaItem = {
      ...source,
      Id: 'target-episode-13',
      Path: '/target-tv/Workshop Rescue/Season 02/episode-13.mkv',
      UserData: {
        Played: alreadyPlayed,
        IsFavorite: false,
        PlayCount: 2,
        PlaybackPositionTicks: 42,
        LastPlayedDate: '2026-10-17T01:00:00Z',
      },
    };
    const wrong: MediaItem = {
      ...correct,
      Id: 'target-episode-10',
      Name: 'The second check-in',
      IndexNumber: 10,
      ProviderIds: { Tvdb: '770010', Imdb: 'tt7700013' },
      Path: '/target-tv/Workshop Rescue/Season 02/episode-10.mkv',
      UserData: { Played: false, PlaybackPositionTicks: 7, IsFavorite: true },
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      path_mappings: [{ source: '/source-tv', target: '/target-tv' }],
    };
    return { source, correct, wrong, settings };
  }

  it.each([false, true])(
    'writes only the correct same-show episode despite a reused ID (reversed=%s)',
    async (reversed) => {
      const { source, correct, wrong, settings } = episodeFixture();
      const targets = reversed ? [correct, wrong] : [wrong, correct];
      const selected = statePlan([source], targets, settings, 'watched_only');
      expect(selected.matches.map((match) => match.target.Id)).toEqual([correct.Id]);
      expect(selected.ambiguous).toEqual([]);
      const originalCorrect = structuredClone(correct.UserData);
      const originalWrong = structuredClone(wrong.UserData);
      const states = new Map(
        targets.map((target) => [target.Id, structuredClone(target.UserData)]),
      );
      const updateUserData = vi.fn(async (_user: string, id: string, patch: MediaUserDataPatch) => {
        states.set(id, { ...states.get(id), ...patch });
      });
      const expectations: VerificationExpectation[] = [];
      expect(
        await migrateItemState(
          client({ updateUserData }),
          'synthetic-recipient',
          selected,
          migrationDetails(),
          () => {},
          () => {},
          { expectation: (target, patch) => expectations.push(captureExpectation(target, patch)) },
        ),
      ).toBe(1);
      expect(updateUserData).toHaveBeenCalledExactlyOnceWith('synthetic-recipient', correct.Id, {
        Played: true,
      });
      expect(states.get(correct.Id)).toEqual({ ...originalCorrect, Played: true });
      expect(states.get(wrong.Id)).toEqual(originalWrong);
      expect(
        evaluateExpectation(expectations[0]!, { ...correct, UserData: states.get(correct.Id) })
          .status,
      ).toBe('verified');
      expect(
        evaluateExpectation(expectations[0]!, {
          ...wrong,
          Id: correct.Id,
          UserData: { Played: true },
        }),
      ).toMatchObject({ status: 'mismatch', identity_mismatch: true });
    },
  );

  it('keeps newer destination state and avoids a write for an already played correct episode', async () => {
    const { source, correct, wrong, settings } = episodeFixture(true);
    const before = structuredClone([correct, wrong]);
    const updateUserData = vi.fn(async () => {});
    const selected = statePlan([source], [wrong, correct], settings, 'watched_only');
    expect(selected.matches.map((match) => match.target.Id)).toEqual([correct.Id]);
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'synthetic-recipient',
        selected,
        migrationDetails(),
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(updateUserData).not.toHaveBeenCalled();
    expect([correct, wrong]).toEqual(before);
  });

  it('never substitutes the wrong numbered episode when the correct candidate is inaccessible', async () => {
    const { source, correct, wrong, settings } = episodeFixture();
    const neutral = createMatcher([wrong, correct], settings.path_mappings);
    expect(neutral.candidates([source]).map((item) => item.Id)).toEqual([wrong.Id, correct.Id]);
    const accessible = [wrong];
    const selected = statePlan([source], accessible, settings, 'watched_only');
    expect(selected.matches).toEqual([]);
    expect(selected.ambiguous).toHaveLength(1);
    const updateUserData = vi.fn(async () => {});
    expect(
      await migrateItemState(
        client({ updateUserData }),
        'synthetic-recipient',
        selected,
        migrationDetails(),
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(updateUserData).not.toHaveBeenCalled();
  });
});
