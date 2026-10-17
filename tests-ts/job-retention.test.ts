import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/types.js';
import { validateActivityRetentionDays } from '../server/settings.js';
import { jobRetentionTimestamp } from '../server/job-retention.js';
import { DemoServers } from '../server/demo.js';

const now = Date.parse('2026-10-17T12:00:00.000Z');
const day = 86_400_000;
const old = new Date(now - 31 * day).toISOString();
const report = (id: string, status = 'completed', finished = old): Job => ({
  id,
  kind: 'migrate',
  status,
  created_at: old,
  updated_at: old,
  finished_at: finished,
  progress: { processed: 1, total: 1 },
  results: [{ username: `member-${id}`, status, applied: 3 }],
});

describe('automatic local activity retention', () => {
  let path: string;
  let store: Store;
  let service: Service;
  const clientFactory = vi.fn(() => {
    throw new Error('Retention must not contact a media server.');
  });
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'jellyport-retention-'));
    store = new Store(path);
    clientFactory.mockClear();
    service = new Service(store, { clientFactory });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.stop();
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  async function reopen() {
    await service.stop();
    store.close();
    store = new Store(path);
    service = new Service(store, { clientFactory });
  }

  it('defaults to disabled for existing installations and enabling saves independently without inline cleanup', async () => {
    const settings = store.settings();
    store.saveJob(report('legacy'));
    expect(service.jobRetentionStatus()).toEqual({
      retention_days: 0,
      interval_seconds: 60,
      batch_limit: 100,
      last_run_at: null,
      last_removed: 0,
      last_kept: 0,
      error: null,
    });
    expect(service.runJobRetention(now).last_run_at).toBeNull();
    expect(store.job('legacy')).not.toBeNull();
    expect(service.setJobRetention(30)).toMatchObject({ retention_days: 30, last_run_at: null });
    expect(store.settings()).toEqual(settings);
    expect(store.job('legacy')).not.toBeNull();
    await reopen();
    expect(service.jobRetentionStatus()).toMatchObject({ retention_days: 30, last_run_at: null });
    expect(store.settings()).toEqual(settings);
    expect(service.runJobRetention(now).last_removed).toBe(1);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '30', -1, 3651, 1.5, NaN, Infinity, true])(
    'rejects invalid retention policy %s without changing existing configuration',
    (value) => {
      service.setJobRetention(30);
      expect(() => validateActivityRetentionDays(value)).toThrow('whole number');
      expect(() => service.setJobRetention(value as number)).toThrow('whole number');
      expect(store.jobRetentionDays()).toBe(30);
    },
  );
  it.each([0, 1, 30, 3650])('accepts the supported retention policy %s', (value) => {
    expect(() => validateActivityRetentionDays(value)).not.toThrow();
    expect(service.setJobRetention(value).retention_days).toBe(value);
  });

  it('expires every supported terminal status with a strict cutoff and the preferred completion timestamp', () => {
    service.setJobRetention(30);
    const statuses = ['completed', 'partial', 'failed', 'interrupted', 'canceled', 'cancelled'];
    for (const status of statuses) store.saveJob(report(status, status));
    store.saveJob(report('boundary', 'completed', new Date(now - 30 * day).toISOString()));
    store.saveJob(report('one-ms-old', 'completed', new Date(now - 30 * day - 1).toISOString()));
    store.saveJob(report('recent-finished', 'failed', new Date(now - day).toISOString()));
    store.saveJob(report('future-finished', 'partial', new Date(now + day).toISOString()));
    store.saveJob({ ...report('updated-fallback'), finished_at: undefined });
    store.saveJob({
      ...report('created-fallback'),
      finished_at: '',
      updated_at: '',
    });
    const status = service.runJobRetention(now);
    expect(status).toMatchObject({
      last_run_at: new Date(now).toISOString(),
      last_removed: 9,
      last_kept: 0,
      error: null,
    });
    expect(
      store
        .jobs()
        .map((job) => job.id)
        .sort(),
    ).toEqual(['boundary', 'future-finished', 'recent-finished']);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-date',
    '2026-02-30T00:00:00.000Z',
    '2025-02-29T00:00:00Z',
    '2026-09-01T24:00:00Z',
    '09/01/2026',
    '2026-09-01T00:00:00',
    '2026-09-01T00:00:00+25:00',
  ])(
    'keeps invalid or ambiguous preferred timestamps %s despite valid older fallbacks',
    (value) => {
      service.setJobRetention(30);
      store.saveJob(report('invalid', 'completed', value));
      expect(service.runJobRetention(now).last_removed).toBe(0);
      expect(store.job('invalid')).not.toBeNull();
      expect(
        store.db.prepare('SELECT age_ms FROM job_retention WHERE job_id=?').get('invalid')?.age_ms,
      ).toBeNull();
    },
  );
  it.each([
    ['2024-02-29T00:00:00.000Z', '2024-02-29T00:00:00.000Z'],
    ['2026-09-01', '2026-09-01T00:00:00.000Z'],
    ['2026-09-01T05:00:00.123456+05:00', '2026-09-01T00:00:00.123Z'],
  ])('accepts unambiguous legacy ISO timestamp %s', (value, equivalent) => {
    expect(jobRetentionTimestamp({ status: 'completed', finished_at: value })).toBe(
      Date.parse(equivalent),
    );
  });

  it('shares manual cleanup safeguards while preserving local journals, subscription dedupe and media state', async () => {
    service.setJobRetention(30);
    const ids = [
      'queued',
      'running',
      'unknown',
      'active',
      'credentials',
      'recovery',
      'processing',
      'removable',
    ];
    for (const id of ids) store.saveJob(report(id));
    store.saveQueuedJob(report('queued', 'queued'), [{ username: 'member' }], store.settings());
    store.saveJob(report('running', 'running'));
    store.saveJob(report('unknown', 'future-status'));
    service.jobTasks.set('active', Promise.resolve());
    store.saveCredentials('credentials', 'member', 'synthetic-password', 'https://example.invalid');
    store.db.prepare('UPDATE credentials SET expires=?').run(now / 1000 + day / 1000);
    store.saveAccount('member-recovery', null, 'uncertain', 'synthetic-recovery');
    const account = store.account('member-recovery');
    store.saveLink('123456', 'member-removable', 'destination-1');
    store.savePlaylistImport('playlist', { name: 'Synthetic playlist', status: 'uncertain' });
    store.saveSubscription({
      id: 'processing-event',
      action: 'subscribe',
      status: 'processing',
      created_at: old,
      job_id: 'processing',
    });
    store.saveSubscription({
      id: 'settled-event',
      action: 'subscribe',
      status: 'applied',
      created_at: old,
      job_id: 'removable',
    });
    store.baselineAdminAlerts('generation');
    expect(service.runJobRetention(now)).toMatchObject({
      last_removed: 1,
      last_kept: 4,
      error: null,
    });
    expect(store.job('removable')).toBeNull();
    expect(store.account('member-recovery')).toEqual(account);
    expect(store.link('123456')?.remote_id).toBe('destination-1');
    expect(store.playlistImport('playlist')?.status).toBe('uncertain');
    expect(store.subscription('processing-event')?.job_id).toBe('processing');
    const settled = store.subscription('settled-event')!;
    expect(settled).toMatchObject({ status: 'applied', report_cleared: true });
    expect(settled.job_id).toBeUndefined();
    expect(await service.recordSubscription({ id: settled.id, action: 'subscribe' })).toEqual(
      settled,
    );
    expect(store.pendingAdminAlertCount('generation')).toBe(0);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('advances past an entire protected oldest batch, bounds each tick, and revisits resolved guards', () => {
    service.setJobRetention(30);
    for (let index = 0; index < 350; index++) {
      const id = `job-${String(index).padStart(4, '0')}`;
      store.saveJob(report(id, index % 2 ? 'failed' : 'completed'));
      if (index < 100) {
        store.saveCredentials(id, 'member', 'synthetic-password', 'https://example.invalid');
        store.db
          .prepare('UPDATE credentials SET expires=? WHERE job_id=?')
          .run(now / 1000 + day / 1000, id);
      }
    }
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 0, last_kept: 100 });
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 100, last_kept: 0 });
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 100, last_kept: 0 });
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 50, last_kept: 0 });
    expect(store.jobs()).toHaveLength(100);
    store.db.prepare('DELETE FROM credentials').run();
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 100, last_kept: 0 });
    expect(store.jobs()).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM job_retention').get()?.count).toBe(0);
  });

  it('uses indexed narrow keyset pages without retaining full migration diagnostics', () => {
    service.setJobRetention(30);
    for (let index = 0; index < 110; index++) store.saveJob(report(`job-${index}`));
    store.saveJob({
      ...report('job-0'),
      results: Array.from({ length: 64 }, (_, index) => ({
        username: `synthetic-${index}`,
        status: 'completed',
        error: 'Synthetic migration diagnostic '.repeat(2500),
      })),
    });
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT job_id AS id,age_ms FROM job_retention
      WHERE age_ms<? AND (age_ms,job_id)>(?,?) ORDER BY age_ms,job_id LIMIT ?`,
      )
      .all(now, now - 40 * day, 'start', 100);
    expect(
      plan.some((step) => String(step.detail).includes('COVERING INDEX job_retention_age')),
    ).toBe(true);
    expect(plan.some((step) => String(step.detail).includes('TEMP B-TREE'))).toBe(false);
    const all = vi.spyOn(store, 'jobs').mockImplementation(() => {
      throw new Error('No full report list.');
    });
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error('No report JSON parsing.');
    });
    const status = service.runJobRetention(now);
    parse.mockRestore();
    all.mockRestore();
    expect(status).toMatchObject({ last_removed: 100, last_kept: 0, error: null });
    expect(JSON.stringify(status).length).toBeLessThan(512);
    expect(store.jobs()).toHaveLength(10);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rechecks timestamps and credentials immediately before each atomic removal', () => {
    service.setJobRetention(30);
    store.saveJob(report('changed-date'));
    store.saveJob(report('new-credentials'));
    const clear = store.clearJobHistory.bind(store);
    vi.spyOn(store, 'clearJobHistory').mockImplementation((ids, active, retention) => {
      store.saveJob(report('changed-date', 'completed', new Date(now - day).toISOString()));
      store.saveCredentials(
        'new-credentials',
        'member',
        'synthetic-password',
        'https://example.invalid',
      );
      store.db.prepare('UPDATE credentials SET expires=?').run(now / 1000 + day / 1000);
      return clear(ids, active, retention);
    });
    expect(service.runJobRetention(now)).toMatchObject({
      last_removed: 0,
      last_kept: 2,
      error: null,
    });
    expect(store.job('changed-date')).not.toBeNull();
    expect(store.job('new-credentials')).not.toBeNull();
  });

  it('backs up metadata once for legacy rows and preserves the independent policy across restarts', async () => {
    service.setJobRetention(30);
    store.db
      .prepare('INSERT INTO jobs VALUES (?,?)')
      .run('legacy', JSON.stringify(report('legacy')));
    store.db
      .prepare('INSERT INTO jobs VALUES (?,?)')
      .run('invalid', JSON.stringify(report('invalid', 'failed', 'bad-date')));
    await reopen();
    expect(
      store.db.prepare('SELECT age_ms FROM job_retention WHERE job_id=?').get('legacy')?.age_ms,
    ).toBe(Date.parse(old));
    expect(
      store.db.prepare('SELECT age_ms FROM job_retention WHERE job_id=?').get('invalid')?.age_ms,
    ).toBeNull();
    // Existing metadata is not regenerated on every startup. Invalid-date sentinels
    // also count as backfilled rows instead of repeatedly parsing those reports.
    store.db.prepare('UPDATE job_retention SET age_ms=? WHERE job_id=?').run(123, 'legacy');
    await reopen();
    expect(
      store.db.prepare('SELECT age_ms FROM job_retention WHERE job_id=?').get('legacy')?.age_ms,
    ).toBe(123);
    expect(store.jobRetentionDays()).toBe(30);
    expect(service.runJobRetention(now).last_removed).toBe(1);
    expect(store.job('invalid')).not.toBeNull();
  });

  it('keeps report and metadata writes atomic inside and outside queue transactions', () => {
    store.saveJob(report('existing'));
    const before = store.job('existing');
    store.db.exec(`CREATE TRIGGER simulate_metadata_error BEFORE INSERT ON job_retention
      WHEN NEW.job_id IN ('existing','queued') BEGIN SELECT RAISE(ABORT,'synthetic metadata failure'); END`);
    expect(() => store.saveJob(report('existing', 'partial'))).toThrow(
      'synthetic metadata failure',
    );
    expect(store.job('existing')).toEqual(before);
    expect(() =>
      store.saveQueuedJob(report('queued', 'queued'), [{ username: 'member' }], store.settings()),
    ).toThrow('synthetic metadata failure');
    expect(store.job('queued')).toBeNull();
    expect(store.queuedJobs()).toEqual([]);
    expect(service.clearJobHistory(['existing']).removed_ids).toEqual(['existing']);
    expect(store.db.prepare('SELECT job_id FROM job_retention').all()).toEqual([]);
  });

  it('invalidates metadata for writes from older versions and rebuilds only those rows on re-upgrade', async () => {
    service.setJobRetention(30);
    store.saveJob(report('previously-active', 'queued'));
    store.saveJob(report('updated-recently'));
    store.saveJob(report('deleted'));
    // Earlier Jellyport releases know only the jobs table. Database triggers keep
    // their writes compatible without requiring those versions to know this cache.
    store.db
      .prepare('UPDATE jobs SET payload=? WHERE id=?')
      .run(JSON.stringify(report('previously-active')), 'previously-active');
    store.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)')
      .run(
        'updated-recently',
        JSON.stringify(report('updated-recently', 'completed', new Date(now - day).toISOString())),
      );
    store.db.prepare('DELETE FROM jobs WHERE id=?').run('deleted');
    expect(store.db.prepare('SELECT * FROM job_retention').all()).toEqual([]);
    await reopen();
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 1, error: null });
    expect(store.job('previously-active')).toBeNull();
    expect(store.job('updated-recently')).not.toBeNull();
    expect(store.job('deleted')).toBeNull();
  });

  it('resets the cursor and transient status on policy changes and remains disabled until a later pass', async () => {
    service.setJobRetention(30);
    for (let index = 0; index < 101; index++) store.saveJob(report(`job-${index}`));
    expect(service.runJobRetention(now).last_removed).toBe(100);
    expect(service.setJobRetention(0)).toMatchObject({
      retention_days: 0,
      last_run_at: null,
      last_removed: 0,
    });
    expect(service.runJobRetention(now).last_run_at).toBeNull();
    expect(store.jobs()).toHaveLength(1);
    await reopen();
    expect(service.jobRetentionStatus().retention_days).toBe(0);
    expect(service.setJobRetention(90).last_run_at).toBeNull();
    expect(service.runJobRetention(now).last_removed).toBe(0);
    expect(service.setJobRetention(30).last_run_at).toBeNull();
    expect(store.jobs()).toHaveLength(1);
    expect(service.runJobRetention(now).last_removed).toBe(1);
  });

  it('handles manual cleanup between retention pages without recreating deleted reports', () => {
    service.setJobRetention(30);
    for (let index = 0; index < 150; index++)
      store.saveJob(report(`job-${String(index).padStart(3, '0')}`));
    expect(service.runJobRetention(now).last_removed).toBe(100);
    expect(service.clearJobHistory(['job-100', 'job-149']).removed_ids).toHaveLength(2);
    expect(service.runJobRetention(now).last_removed).toBe(48);
    expect(store.jobs()).toEqual([]);
    expect(service.runJobRetention(now).last_removed).toBe(0);
  });

  it('reports constant safe errors and retries failed batches without losing reports or journals', () => {
    service.setJobRetention(30);
    store.saveJob(report('first'));
    store.saveJob(report('second'));
    store.saveSubscription({
      id: 'event',
      action: 'subscribe',
      status: 'applied',
      created_at: old,
      job_id: 'first',
    });
    store.db.exec(`CREATE TRIGGER simulate_retention_error BEFORE DELETE ON jobs
      WHEN OLD.id='second' BEGIN SELECT RAISE(ABORT,'sensitive synthetic SQL detail'); END`);
    const failed = service.runJobRetention(now);
    expect(failed).toMatchObject({ last_removed: 0, last_kept: 0 });
    expect(failed.error).toContain('retry');
    expect(JSON.stringify(failed)).not.toContain('sensitive');
    expect(store.jobs()).toHaveLength(2);
    expect(store.subscription('event')?.job_id).toBe('first');
    store.db.exec('DROP TRIGGER simulate_retention_error');
    expect(service.runJobRetention(now)).toMatchObject({ last_removed: 2, error: null });
    expect(store.jobs()).toEqual([]);
  });

  it('does not interrupt in-flight account creation when retention policy changes', async () => {
    const servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-key',
      template_user_id: 'template',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began = false;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      const create = client.createUser.bind(client);
      client.createUser = async (...input) => {
        began = true;
        await gate;
        return create(...input);
      };
      return client;
    };
    const settings = store.settings();
    const job = await service.createAccount('synthetic-inflight');
    try {
      await vi.waitFor(() => expect(began).toBe(true));
      service.setJobRetention(30);
      expect(store.settings()).toEqual(settings);
      expect(service.runJobRetention(now).last_removed).toBe(0);
    } finally {
      release();
    }
    await service.jobTasks.get(job.id);
    expect(service.getJob(job.id).status).toBe('completed');
    expect(store.account('synthetic-inflight')?.status).toBe('ready');
  });

  it('does not run after stop or in demos and rejects demo takeover of retention-only data', async () => {
    store.saveJob(report('preserved'));
    service.setJobRetention(30);
    await service.stop();
    expect(service.runJobRetention(now).last_run_at).toBeNull();
    expect(store.job('preserved')).not.toBeNull();
    const demo = new Service(store, { demo: true, clientFactory });
    expect(() => demo.setJobRetention(30)).toThrow('read-only');
    expect(demo.runJobRetention(now).last_run_at).toBeNull();
    await demo.stop();
    service.clearJobHistory(['preserved']);
    store.close();
    expect(() => new Store(path, { demo: true })).toThrow('separate empty data directory');
    store = new Store(path);
    expect(store.jobRetentionDays()).toBe(30);
  });
});
