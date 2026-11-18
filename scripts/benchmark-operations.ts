import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { MediaKind, MediaUser } from '../server/media.js';
import type { Job, Service } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import { UserOrganization } from '../server/user-organization.js';

if (process.argv.length > 2) throw new Error('This synthetic benchmark accepts no arguments.');
const polls = 5;
const histories = 1_000;
const owners = 4_000;
const events = 20_000;
const reads = 100;
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const settings = {
  ...DEFAULT_SETTINGS,
  emby_url: 'http://emby.invalid',
  jellyfin_url: 'http://jellyfin.invalid',
  emby_api_key: 'synthetic-emby',
  jellyfin_api_key: 'synthetic-jellyfin',
};
const directory = mkdtempSync(join(tmpdir(), 'jellyport-benchmark-operations-'));
const store = new Store(directory);
const list = Array.from({ length: owners }, (_, index) => ({
  discord_user_id: String(10_000 + index),
  base_username: `Member ${index}`,
  access_mode: 'subscription',
  account_limit: 1,
}));
try {
  const items = Array.from({ length: 120 }, (_, index) => ({
    id: `synthetic-${index}`,
    name: `Fixture item ${index}`,
    type: 'Movie',
    path: `/synthetic/${'directory/'.repeat(10)}${index}.mkv`,
  }));
  for (let index = 0; index < histories; index++) {
    const time = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    store.saveJob({
      id: `synthetic-job-${index}`,
      kind: 'migrate',
      status: index >= histories - 3 ? 'running' : 'partial',
      created_at: time,
      updated_at: time,
      progress: { processed: 1, total: 1 },
      results: [{ username: `Member ${index}`, status: 'partial', unmatched_items: items }],
    } satisfies Job);
  }
  const indexedJobs = typeof store.jobSummaries === 'function';
  let bytes = 0;
  let pollMs = 0;
  for (let index = 0; index < polls; index++) {
    const started = performance.now();
    const response = indexedJobs
      ? {
          active: store.jobSummaries({ status: 'active', limit: 12 }).jobs,
          active_count: store.activeJobCount(),
          recent: store.jobSummaries({ limit: 6 }).jobs,
          total: store.jobCount(),
          revision: store.jobSummaryRevision(),
        }
      : { jobs: store.jobs() };
    bytes = Buffer.byteLength(JSON.stringify(response));
    pollMs += performance.now() - started;
    assert.equal(
      indexedJobs ? response.active?.length : response.jobs?.length,
      indexedJobs ? 3 : histories,
    );
  }
  const media = {
    emby: list.map((member, index): MediaUser => ({
      Id: `emby-${index}`,
      Name: member.base_username,
      Policy: { IsAdministrator: false },
    })),
    jellyfin: list.map((member, index): MediaUser => ({
      Id: `jellyfin-${index}`,
      Name: member.base_username,
      Policy: { IsAdministrator: false },
    })),
  };
  const verified = list.flatMap((member, index) =>
    (['emby', 'jellyfin'] as const).map((kind) => ({
      kind,
      account_id: media[kind][index]!.Id,
      discord_user_id: member.discord_user_id,
    })),
  );
  const service = {
    store: { settings: () => settings, authState: () => null, links: () => [] },
    memberships: { list: () => list },
    mappings: { list: () => [] },
    mediaOwnerships: { list: () => verified },
    profiles: { get: () => null },
    client: (_: unknown, kind: MediaKind) => ({
      users: async () => media[kind],
      systemInfo: async () => ({ Id: kind }),
      close: async () => {},
    }),
  } as unknown as Service;
  const organization = new UserOrganization(service);
  const directoryStarted = performance.now();
  const roster = await organization.directory();
  const directoryMs = performance.now() - directoryStarted;
  assert.equal(roster.users.length, owners);
  assert.ok(roster.users.every((row) => row.emby.length === 1 && row.jellyfin.length === 1));

  for (let index = 0; index < events; index++)
    store.saveSubscription({
      id: `synthetic-event-${index}`,
      discord_user_id: list[index % owners]!.discord_user_id,
      action: 'expire',
      source: 'stripe_verified',
      status: 'ignored',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
  const indexedEvents = typeof store.subscriptionsForMember === 'function';
  const reconciliationStarted = performance.now();
  for (let index = 0; index < reads; index++) {
    const id = list[index]!.discord_user_id;
    const rows = indexedEvents
      ? store.subscriptionsForMember(id, 'stripe_verified')
      : store
          .subscriptions()
          .filter((event) => event.discord_user_id === id && event.source === 'stripe_verified');
    assert.equal(rows.length, events / owners);
  }
  const reconciliationMs = performance.now() - reconciliationStarted;
  console.log(
    JSON.stringify(
      {
        revision,
        runtime: process.version,
        platform: `${process.platform}/${process.arch}`,
        reports: histories,
        diagnostic_items_per_report: items.length,
        polls,
        poll_bytes_each: bytes,
        poll_sync_ms_mean: Number((pollMs / polls).toFixed(3)),
        directory_owners: owners,
        directory_accounts: owners * 2,
        directory_ms: Number(directoryMs.toFixed(3)),
        reconciliation_events: events,
        owner_lookups: reads,
        reconciliation_lookup_ms: Number(reconciliationMs.toFixed(3)),
      },
      null,
      2,
    ),
  );
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
