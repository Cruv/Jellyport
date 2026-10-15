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
import type { MediaAPI, MediaItem, MediaUserDataPatch } from '../server/media.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

// Structural cases learned from completed upgraded-server backups. Every value
// here is invented; production IDs, names, paths, providers and state are absent.
describe('completed-backup history migration simulation', () => {
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
      const history = readSnapshotHistory(projected, id, { [id]: 2 });
      expect(history.diagnostics).toEqual({
        unsupported_state_items: 1,
        invalid_resume_positions: 1,
        invalid_display_names: 1,
        orphan_state_items: 1,
      });
      expect(snapshotHistoryWarnings(history.diagnostics)).toHaveLength(4);
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
        'complete',
        createMatcher(target),
      );
      expect(plan.matches).toHaveLength(4);
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
      const details = migrationDetails();
      await migrateItemState(
        client,
        'synthetic-destination',
        plan,
        details,
        () => {},
        () => {},
      );
      expect(details.failed_items).toBe(0);
      expect(write).toHaveBeenCalledTimes(3);
      expect(state.get('destination-1')).toEqual({
        Played: true,
        PlayCount: 4,
        IsFavorite: true,
        LastPlayedDate: '2025-02-03T04:05:06.000Z',
        PlaybackPositionTicks: 456789012,
      });
      expect(state.get('destination-2')).toEqual(newer);
      expect(state.get('destination-3')).toEqual({ IsFavorite: true });
      expect(state.get('destination-4')).toEqual({ IsFavorite: true });
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
