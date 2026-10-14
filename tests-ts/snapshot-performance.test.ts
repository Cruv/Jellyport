import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  inspectLibrary,
  projectLibrary,
  readSnapshotItems,
} from '../server/emby-snapshot-reader.js';

describe('large local snapshot histories', () => {
  it('projects once and reads 100 isolated users without enumerating each full catalog', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-performance-'));
    const raw = join(directory, 'raw.db');
    const projected = join(directory, 'projected.db');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(raw);
      database.exec(
        readFileSync(new URL('./fixtures/emby-4.10.1.0-schema.sql', import.meta.url), 'utf8'),
      );
      // 100,000 catalog rows; 100 users each have 5,000 state rows, of which
      // 500 are meaningful. Inverted keys exercise deterministic output order
      // without relying on item-ID order in the state lookup index.
      database.exec(`
        BEGIN;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
        INSERT INTO UserDataKeys2(Id,UserDataKey) SELECT x,CAST(x AS TEXT) FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
        INSERT INTO MediaItems(Id,type,Path,Name,ProviderIds,UserDataKeyId)
        SELECT x,5,'/synthetic/media-'||x||'.mkv','Synthetic '||x,'Tmdb='||x,100001-x FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000),
          u(y) AS (VALUES(2) UNION ALL SELECT y+1 FROM u WHERE y<101)
        INSERT INTO UserDatas(UserDataKeyId,userId,rating,played,playCount,isFavorite,
          HideFromResume,playbackPositionTicks,LastPlayedDateInt,RatingLastModified,PlaystateLastModified)
        SELECT x,y,CASE WHEN x%60=50 THEN 0 ELSE NULL END,
          CASE WHEN x%60=0 THEN 1 ELSE 0 END,
          CASE WHEN x%60=10 THEN 3 ELSE 0 END,
          CASE WHEN x%60=20 THEN 1 ELSE 0 END,0,
          CASE WHEN x%60=30 THEN 123456789 ELSE 0 END,
          CASE WHEN x%60=40 THEN 1738555506+y ELSE NULL END,0,0
        FROM n CROSS JOIN u;
        COMMIT;
      `);
      database.close();
      database = undefined;

      const projectionStart = performance.now();
      projectLibrary(raw, projected);
      const projectionMs = performance.now() - projectionStart;
      expect(inspectLibrary(projected)).toMatchObject({
        item_count: 100_000,
        user_data_count: 500_000,
      });
      const identities = Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          (index + 1).toString(16).padStart(32, '0'),
          index + 2,
        ]),
      );
      const readsStart = performance.now();
      let totalItems = 0;
      for (const [id, userId] of Object.entries(identities)) {
        const items = readSnapshotItems(projected, id, identities);
        expect(items).toHaveLength(500);
        expect(items[0]!.Id).toBe('95001');
        expect(items.at(-1)!.Id).toBe('99991');
        const dated = items.find((item) => item.UserData?.LastPlayedDate);
        expect(dated?.UserData?.LastPlayedDate).toBe(
          new Date((1_738_555_506 + userId) * 1000).toISOString(),
        );
        expect(items.some((item) => item.UserData?.Rating === 0)).toBe(true);
        totalItems += items.length;
      }
      const readsMs = performance.now() - readsStart;
      expect(totalItems).toBe(50_000);
      expect(
        readSnapshotItems(projected, Object.keys(identities)[0]!, identities, 'watched_only'),
      ).toHaveLength(83);
      // Reject size overruns rather than truncating/migrating partial history.
      expect(() =>
        readSnapshotItems(projected, Object.keys(identities)[0]!, identities, 'complete', {
          maxItems: 100,
        }),
      ).toThrow('history size');
      expect(() =>
        readSnapshotItems(projected, Object.keys(identities)[0]!, identities, 'complete', {
          maxBytes: 1_024,
        }),
      ).toThrow('history size');
      // Informational timings only: CI hardware and parallel jobs vary. Query
      // plan regressions and resource ceilings are asserted in reader tests.
      console.info(
        JSON.stringify({
          event: 'synthetic_snapshot_performance',
          catalog_items: 100_000,
          user_state_rows: 500_000,
          users: 100,
          returned_items: totalItems,
          projection_ms: Math.round(projectionMs),
          history_reads_ms: Math.round(readsMs),
        }),
      );
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
