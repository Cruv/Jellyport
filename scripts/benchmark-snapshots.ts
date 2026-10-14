import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { projectLibrary, readSnapshotItems } from '../server/emby-snapshot-reader.js';

// Synthetic-only benchmark. There is deliberately no source path, URL, or
// production-data option. Keep the fixture and run count bounded.
if (process.argv.length > 2) throw new Error('This benchmark accepts no arguments.');
const CATALOG_ITEMS = 100_000;
const USERS = 100;
const STATE_ROWS_PER_USER = 5_000;
const RUNS = 5;
const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-snapshot-benchmark-'));
const rawPath = join(directory, 'raw.db');
const projectedPath = join(directory, 'projected.db');
const fullIndexPath = join(directory, 'previous-index.db');
const identities = Object.fromEntries(
  Array.from({ length: USERS }, (_, index) => [
    (index + 1).toString(16).padStart(32, '0'),
    index + 2,
  ]),
);
let database: DatabaseSync | undefined;
try {
  const fixtureStart = performance.now();
  database = new DatabaseSync(rawPath);
  database.exec(
    readFileSync(new URL('../tests-ts/fixtures/emby-4.10.1.0-schema.sql', import.meta.url), 'utf8'),
  );
  database.exec(`
    BEGIN;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${CATALOG_ITEMS})
    INSERT INTO UserDataKeys2(Id,UserDataKey) SELECT x,CAST(x AS TEXT) FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${CATALOG_ITEMS})
    INSERT INTO MediaItems(Id,type,Path,Name,ProviderIds,UserDataKeyId)
    SELECT x,5,'/synthetic/media-'||x||'.mkv','Synthetic '||x,'Tmdb='||x,${CATALOG_ITEMS + 1}-x FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${STATE_ROWS_PER_USER}),
      u(y) AS (VALUES(2) UNION ALL SELECT y+1 FROM u WHERE y<${USERS + 1})
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
  const fixtureMs = performance.now() - fixtureStart;
  const projectionStart = performance.now();
  projectLibrary(rawPath, projectedPath);
  const projectionMs = performance.now() - projectionStart;

  // Only this generated private projection is changed. Both variants retain
  // every table row; the partial index omits empty states from its lookup tree.
  copyFileSync(projectedPath, fullIndexPath);
  database = new DatabaseSync(fullIndexPath);
  database.exec(`
    DROP INDEX JellyportUserDataUser;
    CREATE INDEX JellyportUserDataUser ON UserDatas(userId,UserDataKeyId);
  `);
  database.close();
  database = undefined;

  const strategies = [
    { name: 'previous_sql_sort_full_index', path: fullIndexPath, legacy: true },
    { name: 'bounded_sort_full_index', path: fullIndexPath, legacy: false },
    { name: 'bounded_sort_partial_index', path: projectedPath, legacy: false },
  ] as const;
  const results = strategies.map((strategy) => {
    const timings: number[] = [];
    let checksum: string | undefined;
    let query: string | undefined;
    let returnedItems = 0;
    const prepare = DatabaseSync.prototype.prepare;
    // Reuse identical normalization/validation and byte ceilings. Only the
    // query strategy is changed for the baseline, so data semantics cannot
    // accidentally differ between separate benchmark implementations.
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql.includes('FROM UserDatas ud CROSS JOIN MediaItems m')) {
        if (strategy.legacy)
          sql = sql
            .replace('CROSS JOIN MediaItems m', 'JOIN MediaItems m')
            .replace('LIMIT ?', 'ORDER BY m.Id LIMIT ?');
        query = sql;
      }
      return prepare.call(this, sql);
    };
    try {
      for (let run = 0; run < RUNS; run++) {
        const started = performance.now();
        const hash = createHash('sha256');
        returnedItems = 0;
        for (const id of Object.keys(identities)) {
          const items = readSnapshotItems(strategy.path, id, identities);
          if (items.length !== 500) throw new Error('Unexpected synthetic history row count.');
          returnedItems += items.length;
          hash.update(JSON.stringify(items));
        }
        const currentChecksum = hash.digest('hex');
        timings.push(performance.now() - started);
        if (checksum && currentChecksum !== checksum)
          throw new Error('History output changed between benchmark runs.');
        checksum = currentChecksum;
      }
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    if (!query) throw new Error('The benchmark did not observe a history query.');
    database = new DatabaseSync(strategy.path, { readOnly: true });
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(2, 100_001)
      .map((row) => String(row.detail));
    database.close();
    database = undefined;
    const sorted = [...timings].sort((left, right) => left - right);
    return {
      strategy: strategy.name,
      runs: RUNS,
      returned_items: returnedItems,
      checksum,
      history_reads_and_checksum_ms: timings.map((value) => Math.round(value * 10) / 10),
      median_ms: Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10,
      query_plan: plan,
    };
  });
  if (new Set(results.map((result) => result.checksum)).size !== 1)
    throw new Error('History output differs between query/index strategies.');
  console.log(
    JSON.stringify(
      {
        event: 'synthetic_snapshot_benchmark',
        environment: {
          node: process.version,
          sqlite: process.versions.sqlite,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        fixture: {
          catalog_items: CATALOG_ITEMS,
          users: USERS,
          user_state_rows: USERS * STATE_ROWS_PER_USER,
          meaningful_rows: 50_000,
          generation_ms: Math.round(fixtureMs * 10) / 10,
          projection_ms: Math.round(projectionMs * 10) / 10,
          source_bytes: statSync(rawPath).size,
          partial_index_projection_bytes: statSync(projectedPath).size,
          full_index_projection_bytes: statSync(fullIndexPath).size,
        },
        results,
        limitations:
          'Local synthetic history extraction only; includes database open/validation, normalization, bounded sorting and checksum. All strategies use the same SQLite cache settings and final bounded JavaScript sort. Excludes backup generation by Emby, decryption, child-process startup, matching and destination API writes. Sequential runs can benefit from filesystem caches; this is not an end-to-end migration estimate or a memory benchmark.',
      },
      null,
      2,
    ),
  );
} finally {
  database?.close();
  rmSync(directory, { recursive: true, force: true });
}
