import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectLibrary,
  readSnapshotHistory,
  snapshotHistoryWarnings,
} from '../server/emby-snapshot-reader.js';
import { createMatcher } from '../server/matching.js';
import { migrateItemState, migrationDetails, statePlan } from '../server/migration.js';
import { captureExpectation, evaluateExpectation } from '../server/migration-verification.js';
import type { MediaAPI, MediaItem, MediaUserDataPatch } from '../server/media.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

// Structural cases learned from completed upgraded-server backups. Every value
// here is invented; production IDs, names, paths, providers and state are absent.
describe('completed-backup history migration simulation', () => {
  it('merges saved played flags and favorite-only series without replacing existing Jellyfin state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-favorites-simulation-'));
    const raw = join(directory, 'raw.db');
    const projected = join(directory, 'projected.db');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(raw);
      database.exec(`
        CREATE TABLE MediaItems(Id INTEGER PRIMARY KEY,type INT,Path TEXT,Name TEXT,ProviderIds TEXT,SeriesId INT,
          IndexNumber INT,ParentIndexNumber INT,IndexNumberEnd INT,RunTimeTicks INTEGER,UserDataKeyId INT);
        CREATE TABLE UserDatas(UserDataKeyId INT,userId INT,rating REAL,played INT,playCount INT,isFavorite INT,
          playbackPositionTicks INTEGER,LastPlayedDateInt INT,PRIMARY KEY(UserDataKeyId,userId));
        INSERT INTO MediaItems VALUES
          (1,5,'/synthetic/movie-one.mkv','Synthetic movie one','Tmdb=910001',NULL,NULL,NULL,NULL,1000000000,101),
          (2,6,'/synthetic/series','Synthetic favorite series','Tvdb=910002',NULL,NULL,NULL,NULL,NULL,102),
          (3,5,'/synthetic/movie-three.mkv','Synthetic movie three','Tmdb=910003',NULL,NULL,NULL,NULL,1000000000,103);
        INSERT INTO UserDatas VALUES
          (101,2,NULL,1,4,0,-1,-1),
          (102,2,100,0,-1,1,-1,-1),
          (103,2,NULL,1,5,1,-1,-1);
      `);
      database.close();
      database = undefined;
      // Reuse the existing projection format: no capture schema upgrade or extra
      // source call is necessary to read previously retained favorite-only rows.
      projectLibrary(raw, projected);
      const id = '22'.repeat(16);
      const history = readSnapshotHistory(projected, id, { [id]: 2 }, 'played_favorites');
      expect(history.items).toHaveLength(3);
      expect(history.diagnostics.invalid_resume_positions).toBe(0);
      const newer = {
        PlaybackPositionTicks: 456789012,
        PlayCount: 9,
        LastPlayedDate: '2026-10-30T12:00:00.000Z',
      };
      const state = new Map<string, MediaUserDataPatch>([
        ['destination-1', { Played: false, IsFavorite: true, ...newer }],
        ['destination-2', { Played: false, IsFavorite: false }],
        ['destination-3', { Played: false, IsFavorite: false, ...newer }],
        ['jellyfin-only', { Played: true, IsFavorite: true, ...newer }],
      ]);
      const target = history.items.map(({ UserData: _state, ...metadata }) => ({
        ...metadata,
        Id: `destination-${metadata.Id}`,
        UserData: { ...state.get(`destination-${metadata.Id}`) },
      }));
      const plan = statePlan(history.items, target, DEFAULT_SETTINGS, 'played_favorites');
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
      const expectations: ReturnType<typeof captureExpectation>[] = [];
      const details = migrationDetails();
      await migrateItemState(
        client,
        'synthetic-target',
        plan,
        details,
        () => {},
        () => {},
        {
          migration_scope: 'played_favorites',
          expectation: (item, patch) =>
            expectations.push(captureExpectation(item, patch, 'played_favorites')),
        },
      );
      expect(write.mock.calls.map(([, item, patch]) => [item, patch]).sort()).toEqual([
        ['destination-1', { Played: true }],
        ['destination-2', { IsFavorite: true }],
        ['destination-3', { Played: true, IsFavorite: true }],
      ]);
      expect(details).toMatchObject({ favorites: 2, items_updated: 3, failed_items: 0 });
      expect(state.get('destination-1')).toEqual({ Played: true, IsFavorite: true, ...newer });
      expect(state.get('destination-2')).toEqual({ Played: false, IsFavorite: true });
      expect(state.get('destination-3')).toEqual({ Played: true, IsFavorite: true, ...newer });
      expect(state.get('jellyfin-only')).toEqual({ Played: true, IsFavorite: true, ...newer });
      for (const expectation of expectations)
        expect(
          evaluateExpectation(expectation, {
            ...expectation.item,
            UserData: state.get(expectation.item.Id),
          }).status,
        ).toBe('verified');
      for (const match of plan.matches) match.target.UserData = { ...state.get(match.target.Id) };
      write.mockClear();
      await migrateItemState(
        client,
        'synthetic-target',
        plan,
        migrationDetails(),
        () => {},
        () => {},
        {
          migration_scope: 'played_favorites',
        },
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves valid state through upgraded schemas, damaged optional fields, repeated imports and newer activity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-history-simulation-'));
    const raw = join(directory, 'raw.db');
    const projected = join(directory, 'projected.db');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(raw);
      database.exec(`
        CREATE TABLE MediaItems(Id INTEGER PRIMARY KEY,type INT,Path TEXT,Name TEXT,ProviderIds TEXT,SeriesId INT,
          IndexNumber INT,ParentIndexNumber INT,IndexNumberEnd INT,RunTimeTicks BIGINT,UserDataKeyId INT);
        CREATE TABLE UserDatas(UserDataKeyId INT,userId INT,rating FLOAT,played BIT,playCount INT,isFavorite BIT,
          playbackPositionTicks BIGINT,LastPlayedDateInt INT);
        CREATE UNIQUE INDEX LegacyHistoryKey ON UserDatas(UserDataKeyId,userId);
        INSERT INTO MediaItems VALUES
          (1,5,'/synthetic/movie.mkv','Synthetic'||char(9)||'movie','Tmdb=900001',NULL,NULL,NULL,NULL,1000000000,101),
          (2,8,'/synthetic/episode.mkv','Synthetic episode','Tvdb=900002',3,1,1,NULL,1000000000,102),
          (3,6,'/synthetic/series','Synthetic series','Tvdb=900003',NULL,NULL,NULL,NULL,NULL,103),
          (4,9,NULL,'Synthetic collection','Tmdb=900004',NULL,NULL,NULL,NULL,NULL,104),
          (5,999,NULL,'Unsupported synthetic item',NULL,NULL,NULL,NULL,NULL,NULL,105);
        INSERT INTO UserDatas VALUES
          (101,2,NULL,1,4,1,-1,1738555506),
          (102,2,NULL,0,2,0,123456789,1738555506),
          (103,2,NULL,0,0,1,0,NULL),
          (104,2,NULL,0,0,1,0,NULL),
          (105,2,NULL,0,0,1,0,NULL),
          (106,2,NULL,1,3,0,0,1738555506);
      `);
      database.close();
      database = undefined;
      projectLibrary(raw, projected);
      const id = '11'.repeat(16);
      const history = readSnapshotHistory(projected, id, { [id]: 2 }, 'watched_only');
      expect(history.diagnostics).toEqual({
        unsupported_state_items: 0,
        invalid_resume_positions: 0,
        invalid_display_names: 1,
        orphan_state_items: 1,
      });
      expect(snapshotHistoryWarnings(history.diagnostics)).toHaveLength(2);
      const target: MediaItem[] = history.items.map((item) => {
        const { UserData: _state, ...metadata } = item;
        return {
          ...metadata,
          Id: `destination-${item.Id}`,
          ProviderIds: item.Type === 'BoxSet' ? { TmdbCollection: '900004' } : item.ProviderIds,
        };
      });
      const plan = statePlan(
        history.items,
        target,
        DEFAULT_SETTINGS,
        'watched_only',
        createMatcher(target),
      );
      expect(plan.matches).toHaveLength(1);
      expect(plan.ambiguous).toEqual([]);
      expect(plan.unmatched).toEqual([]);
      const newer: MediaUserDataPatch = {
        Played: true,
        PlayCount: 9,
        LastPlayedDate: '2026-01-01T00:00:00.000Z',
        PlaybackPositionTicks: 345678901,
      };
      const state = new Map<string, MediaUserDataPatch>([
        ['destination-1', { PlaybackPositionTicks: 456789012 }],
        ['destination-2', { ...newer }],
      ]);
      const write = vi.fn(async (_user: string, item: string, patch: MediaUserDataPatch) => {
        state.set(item, { ...state.get(item), ...patch });
      });
      const client = {
        migrationCapabilities: async () => ({ userData: true }),
        userData: async (_user: string, item: string) => ({ ...state.get(item) }),
        updateUserData: write,
      } as unknown as MediaAPI;
      const expectations: ReturnType<typeof captureExpectation>[] = [];
      const details = migrationDetails();
      await migrateItemState(
        client,
        'synthetic-destination',
        plan,
        details,
        () => {},
        () => {},
        { expectation: (item, patch) => expectations.push(captureExpectation(item, patch)) },
      );
      expect(details.failed_items).toBe(0);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('synthetic-destination', 'destination-1', {
        Played: true,
      });
      expect(state.get('destination-1')).toEqual({
        Played: true,
        PlaybackPositionTicks: 456789012,
      });
      expect(state.get('destination-2')).toEqual(newer);
      expect(state.has('destination-3')).toBe(false);
      expect(state.has('destination-4')).toBe(false);
      expect(expectations).toHaveLength(1);
      const observed = { ...plan.matches[0]!.target, UserData: state.get('destination-1') };
      expect(evaluateExpectation(expectations[0]!, observed).status).toBe('verified');
      // A rerun obtains current access-scoped candidate flags, never reuses old state.
      plan.matches[0]!.target.UserData = { ...state.get('destination-1') };
      write.mockClear();
      await migrateItemState(
        client,
        'synthetic-destination',
        plan,
        migrationDetails(),
        () => {},
        () => {},
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
