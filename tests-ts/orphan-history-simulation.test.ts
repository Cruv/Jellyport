import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectLibrary,
  projectLibrary,
  readSnapshotHistory,
  readUserIdentities,
} from '../server/emby-snapshot-reader.js';
import { createMatcher } from '../server/matching.js';
import { migrateItemState, migrationDetails, statePlan } from '../server/migration.js';
import { captureExpectation, evaluateExpectation } from '../server/migration-verification.js';
import type { MediaAPI, MediaItem, MediaUserDataPatch } from '../server/media.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

const schema = readFileSync(
  new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url),
  'utf8',
);
const publicUser = '22'.repeat(16);
const movieGuid = '0123456789abcdef0123456789abcdef';
const episodeGuid = '102132435465768798a9bacbdcedfe0f';
const playedGuid = '89abcdef0123456789abcdef01234567';
const ambiguousGuid = 'fedcba9876543210fedcba9876543210';

// Invented media and state only. The raw identity bytes are explicit .NET GUID
// encodings so the fixture does not reproduce the adapter's conversion helper.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-orphan-simulation-'));
  const raw = join(directory, 'raw.db');
  const projected = join(directory, 'projected.db');
  const database = new DatabaseSync(raw);
  try {
    database.exec(schema);
    const key = database.prepare('INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (?,?)');
    for (const [id, value] of [
      [110, 'canonical-movie'],
      [111, 'canonical-series'],
      [113, 'canonical-episode'],
      [114, 'canonical-played-movie'],
      [120, 'canonical-ambiguous-a'],
      [121, 'canonical-ambiguous-b'],
      [124, 'canonical-provider-movie'],
      [130, 'canonical-numeric-decoy'],
      [210, movieGuid],
      [211, movieGuid.toUpperCase()],
      [213, episodeGuid.toUpperCase()],
      [214, playedGuid],
      [220, ambiguousGuid],
      [230, '230'],
      [231, 'Tmdb=990024'],
      [232, 'tt990024'],
    ] as const)
      key.run(id, value);
    const item = database.prepare(`
      INSERT INTO MediaItems(Id,guid,type,UserDataKeyId,Name,Path,ProviderIds,SeriesId,
        ParentIndexNumber,IndexNumber,RunTimeTicks)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    item.run(
      10,
      Buffer.from('67452301ab89efcd0123456789abcdef', 'hex'),
      5,
      110,
      'Synthetic film',
      '/synthetic/film.mkv',
      'Tmdb=990010',
      null,
      null,
      null,
      1_000_000_000,
    );
    item.run(
      11,
      null,
      6,
      111,
      'Synthetic show',
      '/synthetic/show',
      'Tvdb=990011',
      null,
      null,
      null,
      null,
    );
    item.run(
      13,
      Buffer.from('433221106554877698a9bacbdcedfe0f', 'hex'),
      8,
      113,
      'Synthetic episode',
      '/synthetic/show/s01e02.mkv',
      null,
      11,
      1,
      2,
      1_000_000_000,
    );
    item.run(
      14,
      Buffer.from('efcdab892301674589abcdef01234567', 'hex'),
      5,
      114,
      'Already watched film',
      '/synthetic/already.mkv',
      'Tmdb=990014',
      null,
      null,
      null,
      1_000_000_000,
    );
    for (const id of [20, 21])
      item.run(
        id,
        Buffer.from('98badcfe54761032fedcba9876543210', 'hex'),
        5,
        100 + id,
        `Ambiguous synthetic film ${id}`,
        `/synthetic/ambiguous-${id}.mkv`,
        `Tmdb=${990000 + id}`,
        null,
        null,
        null,
        null,
      );
    item.run(
      24,
      Buffer.alloc(16, 0xbb),
      5,
      124,
      'Provider decoy',
      '/synthetic/provider.mkv',
      'Tmdb=990024|Imdb=tt990024',
      null,
      null,
      null,
      null,
    );
    item.run(
      230,
      Buffer.alloc(16, 0xaa),
      5,
      130,
      'Numeric decoy',
      '/synthetic/numeric.mkv',
      'Tmdb=990230',
      null,
      null,
      null,
      null,
    );
    const state = database.prepare(`
      INSERT INTO UserDatas(UserDataKeyId,userId,rating,played,playCount,isFavorite,
        HideFromResume,playbackPositionTicks,LastPlayedDateInt,RatingLastModified,PlaystateLastModified)
      VALUES (?,7,NULL,?,0,0,0,0,NULL,0,0)`);
    state.run(110, 0);
    state.run(114, 1);
    for (const id of [210, 211, 213, 214, 220, 230, 231, 232]) state.run(id, 1);
    database
      .prepare('INSERT INTO LocalUsersv2(Id,guid,data) VALUES (7,?,?)')
      .run(Buffer.alloc(16, 0x22), '{}');
  } finally {
    database.close();
  }
  return { directory, raw, projected };
}

function destination(): MediaItem[] {
  return [
    { Id: 'target-film', Type: 'Movie', Path: '/target/film.mkv', ProviderIds: { Tmdb: '990010' } },
    {
      Id: 'target-episode',
      Type: 'Episode',
      Path: '/target/show/s01e02.mkv',
      SeriesProviderIds: { Tvdb: '990011' },
      ParentIndexNumber: 1,
      IndexNumber: 2,
    },
    { Id: 'target-played', Type: 'Movie', ProviderIds: { Tmdb: '990014' } },
  ];
}

describe('strict orphan history recovery simulation', () => {
  it('recovers current movies and episodes once and preserves all destination state around additive writes', async () => {
    const f = fixture();
    try {
      projectLibrary(f.raw, f.projected);
      expect(inspectLibrary(f.projected)).toMatchObject({ orphan_identity_version: 1 });
      const history = readSnapshotHistory(
        f.projected,
        publicUser,
        readUserIdentities(f.raw),
        'watched_only',
      );
      expect(history.diagnostics).toMatchObject({
        recovered_orphan_state_items: 4,
        orphan_state_items: 4,
      });
      expect(history.items.map((item) => item.Id)).toEqual(['10', '13', '14']);
      expect(history.items.map((item) => item.UserData)).toEqual([
        { Played: true },
        { Played: true },
        { Played: true },
      ]);
      expect(history.items.find((item) => item.Id === '13')).toMatchObject({
        Name: 'Synthetic episode',
        Type: 'Episode',
        SeriesName: 'Synthetic show',
        SeriesProviderIds: { Tvdb: '990011' },
        ParentIndexNumber: 1,
        IndexNumber: 2,
      });

      const state = new Map<string, MediaUserDataPatch>([
        [
          'target-film',
          {
            Played: false,
            PlaybackPositionTicks: 123_456_789,
            PlayCount: 12,
            LastPlayedDate: '2026-10-15T20:00:00.000Z',
            IsFavorite: false,
            Rating: 8,
          },
        ],
        [
          'target-episode',
          {
            Played: false,
            PlaybackPositionTicks: 456_789_012,
            PlayCount: 9,
            LastPlayedDate: '2026-10-16T00:00:00.000Z',
            IsFavorite: true,
          },
        ],
        [
          'target-played',
          {
            Played: true,
            PlaybackPositionTicks: 234_567_890,
            PlayCount: 20,
            LastPlayedDate: '2026-10-16T01:00:00.000Z',
            IsFavorite: true,
          },
        ],
      ]);
      const before = structuredClone(state);
      const target = destination().map((item) => ({
        ...item,
        UserData: { ...state.get(item.Id) },
      }));
      const plan = statePlan(
        history.items,
        target,
        DEFAULT_SETTINGS,
        'watched_only',
        createMatcher(target),
      );
      expect(plan.matches).toHaveLength(3);
      expect(plan.unmatched).toEqual([]);
      expect(plan.ambiguous).toEqual([]);
      const write = vi.fn(async (_user: string, item: string, patch: MediaUserDataPatch) => {
        state.set(item, { ...state.get(item), ...patch });
      });
      const client = {
        migrationCapabilities: async () => ({ userData: true }),
        updateUserData: write,
      } as unknown as MediaAPI;
      const expected: ReturnType<typeof captureExpectation>[] = [];
      const details = migrationDetails();
      await migrateItemState(
        client,
        'synthetic-target-user',
        plan,
        details,
        () => {},
        () => {},
        {
          expectation: (item, patch) => expected.push(captureExpectation(item, patch)),
        },
      );
      expect(write).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledWith('synthetic-target-user', 'target-film', { Played: true });
      expect(write).toHaveBeenCalledWith('synthetic-target-user', 'target-episode', {
        Played: true,
      });
      expect(details).toMatchObject({ items_updated: 2, failed_items: 0 });
      for (const item of target) {
        expect(state.get(item.Id)).toEqual({ ...before.get(item.Id), Played: true });
        const expectation = expected.find((value) => value.item.Id === item.Id)!;
        expect(
          evaluateExpectation(expectation, { ...item, UserData: state.get(item.Id) }).status,
        ).toBe('verified');
      }

      // Re-import and a fresh access-scoped read must not replay either write.
      const repeated = readSnapshotHistory(
        f.projected,
        publicUser,
        { [publicUser]: 7 },
        'watched_only',
      );
      expect(repeated).toEqual(history);
      const freshTarget = target.map((item) => ({ ...item, UserData: { ...state.get(item.Id) } }));
      const repeatedPlan = statePlan(
        repeated.items,
        freshTarget,
        DEFAULT_SETTINGS,
        'watched_only',
        createMatcher(freshTarget),
      );
      write.mockClear();
      await migrateItemState(
        client,
        'synthetic-target-user',
        repeatedPlan,
        migrationDetails(),
        () => {},
        () => {},
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it('keeps recovered current items unresolved when the destination catalog is restricted or has no identity hit', async () => {
    const f = fixture();
    try {
      projectLibrary(f.raw, f.projected);
      const history = readSnapshotHistory(
        f.projected,
        publicUser,
        { [publicUser]: 7 },
        'watched_only',
      );
      const allowed = destination().slice(0, 1);
      const restricted = statePlan(
        history.items,
        allowed,
        DEFAULT_SETTINGS,
        'watched_only',
        createMatcher(allowed),
      );
      expect(restricted.matches.map((match) => match.source.Id)).toEqual(['10']);
      expect(restricted.unmatched.map((item) => item.Id)).toEqual(['13', '14']);
      expect(restricted.ambiguous).toEqual([]);
      expect(history.diagnostics.orphan_state_items).toBe(4);

      const sameTitleDifferentIdentity: MediaItem[] = [
        {
          Id: 'unrelated-film',
          Name: 'Synthetic film',
          Type: 'Movie',
          ProviderIds: { Tmdb: '111111' },
          Path: '/unrelated/film.mkv',
        },
      ];
      const missing = statePlan(
        history.items,
        sameTitleDifferentIdentity,
        DEFAULT_SETTINGS,
        'watched_only',
        createMatcher(sameTitleDifferentIdentity),
      );
      expect(missing.matches).toEqual([]);
      expect(missing.ambiguous).toEqual([]);
      expect(missing.unmatched.map((item) => item.Id)).toEqual(['10', '13', '14']);
      const write = vi.fn();
      await migrateItemState(
        {
          migrationCapabilities: async () => ({ userData: true }),
          updateUserData: write,
        } as unknown as MediaAPI,
        'synthetic-target-user',
        missing,
        migrationDetails(),
        () => {},
        () => {},
      );
      expect(write).not.toHaveBeenCalled();
      expect(history.items).toHaveLength(3);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});
