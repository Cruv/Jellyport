import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Service, type Job } from '../server/service.js';
import { DemoServers } from '../server/demo.js';
import { DEFAULT_SETTINGS } from '../server/types.js';
import { MediaError } from '../server/errors.js';

const report = (id: string, status = 'completed', username = 'member'): Job => ({
  id,
  kind: 'migrate',
  status,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:01Z',
  progress: { processed: 1, total: 1 },
  results: [{ username, status, applied: 12 }],
});

describe('local activity and report cleanup', () => {
  let path: string;
  let store: Store;
  let service: Service;
  const clientFactory = vi.fn(() => {
    throw new Error('Report cleanup must never contact a media server.');
  });
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'jellyport-history-cleanup-'));
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

  it.each(['completed', 'partial', 'failed', 'interrupted', 'canceled', 'cancelled'])(
    'clears selected %s reports and expired credentials, preserving unselected reports',
    (status) => {
      store.saveJob(report('selected', status));
      store.saveJob(report('unselected', status));
      store.saveCredentials('selected', 'member', 'expired-synthetic', 'https://example.invalid');
      store.db.prepare('UPDATE credentials SET expires=0 WHERE job_id=?').run('selected');
      expect(service.clearJobHistory(['selected'])).toEqual({
        removed_ids: ['selected'],
        skipped: [],
      });
      expect(store.job('selected')).toBeNull();
      expect(store.job('unselected')).toEqual(report('unselected', status));
      expect(store.takeCredentials('selected')).toEqual([]);
      expect(clientFactory).not.toHaveBeenCalled();
      expect(service.clearJobHistory(['selected'])).toEqual({
        removed_ids: [],
        skipped: [{ id: 'selected', reason: 'not_found' }],
      });
    },
  );

  it('protects queued, running, unknown, finalizing and unrevealed-credential reports together', () => {
    store.saveQueuedJob(report('queued', 'queued'), [{ username: 'member' }], store.settings());
    store.saveJob(report('running', 'running'));
    store.saveJob(report('future-status', 'resuming'));
    store.saveJob(report('stale-queue', 'completed'));
    store.db
      .prepare('INSERT INTO job_queue VALUES (?,?)')
      .run(
        'stale-queue',
        store.encrypt({ requests: [{ username: 'member' }], settings: store.settings() }),
      );
    store.saveJob(report('finalizing', 'completed'));
    service.jobTasks.set('finalizing', Promise.resolve());
    store.saveJob({ ...report('cancel-unwinding', 'canceled'), cancel_requested: true });
    service.jobTasks.set('cancel-unwinding', Promise.resolve());
    store.saveJob(report('credentials', 'completed'));
    store.saveCredentials(
      'credentials',
      'member',
      'unrevealed-synthetic',
      'https://example.invalid',
    );
    store.saveJob(report('removable'));
    const ids = [
      'queued',
      'running',
      'future-status',
      'stale-queue',
      'finalizing',
      'cancel-unwinding',
      'credentials',
      'missing',
      'removable',
    ];
    expect(service.clearJobHistory(ids)).toEqual({
      removed_ids: ['removable'],
      skipped: [
        { id: 'queued', reason: 'not_finished' },
        { id: 'running', reason: 'not_finished' },
        { id: 'future-status', reason: 'not_finished' },
        { id: 'stale-queue', reason: 'not_finished' },
        { id: 'finalizing', reason: 'active' },
        { id: 'cancel-unwinding', reason: 'active' },
        { id: 'credentials', reason: 'pending_credentials' },
        { id: 'missing', reason: 'not_found' },
      ],
    });
    expect(store.queuedJobs()).toHaveLength(2);
    expect(store.takeCredentials('credentials')[0]?.password).toBe('unrevealed-synthetic');
    expect(service.clearJobHistory(['credentials']).removed_ids).toEqual(['credentials']);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each(['uncertain', 'provisioning'])(
    'retains recovery evidence for a Unicode-normalized %s account until resolved',
    (status) => {
      store.saveJob(report('recovery', 'failed', 'STRASSE'));
      store.saveAccount('Straße', 'destination-1', status, 'synthetic-password');
      const journal = store.account('Straße');
      expect(service.clearJobHistory(['recovery'])).toEqual({
        removed_ids: [],
        skipped: [{ id: 'recovery', reason: 'recovery_required' }],
      });
      expect(store.account('Straße')).toEqual(journal);
      store.saveAccount('Straße', 'destination-1', 'ready');
      expect(service.clearJobHistory(['recovery']).removed_ids).toEqual(['recovery']);
      expect(store.account('Straße')?.status).toBe('ready');
    },
  );

  it('detaches settled subscription reports while preserving deduplication, status and processing waits', async () => {
    const statuses = ['applied', 'failed', 'pending', 'ignored', 'processing'];
    for (const status of statuses) {
      store.saveJob(report(`job-${status}`));
      store.saveSubscription({
        id: `event-${status}`,
        action: 'subscribe',
        status,
        created_at: '2026-10-01',
        discord_user_id: '123456',
        job_id: `job-${status}`,
        result: 'Existing subscription outcome',
      });
    }
    expect(service.clearJobHistory(statuses.map((status) => `job-${status}`))).toEqual({
      removed_ids: ['job-applied', 'job-failed', 'job-pending', 'job-ignored'],
      skipped: [{ id: 'job-processing', reason: 'subscription_processing' }],
    });
    for (const status of statuses.slice(0, 4)) {
      const event = store.subscription(`event-${status}`)!;
      expect(event).toMatchObject({ status, report_cleared: true });
      expect(event.job_id).toBeUndefined();
      expect(event.result).toBe('Existing subscription outcome');
      expect(
        await service.recordSubscription({
          id: event.id,
          action: 'subscribe',
          discord_user_id: event.discord_user_id,
        }),
      ).toEqual(event);
    }
    expect(store.subscription('event-processing')).toMatchObject({
      job_id: 'job-processing',
      status: 'processing',
    });
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM subscriptions
      WHERE json_extract(payload,'$.job_id')=?
        AND json_extract(payload,'$.status')='processing' LIMIT 1`,
      )
      .all('job-processing');
    expect(plan.some((step) => String(step.detail).includes('subscriptions_job_id'))).toBe(true);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('retains operational identity, recovery, playlist, membership and alert state across restart', async () => {
    store.saveJob(report('removable'));
    store.saveAccount('member', 'destination-1', 'ready', 'synthetic-password');
    store.saveLink('123456', 'member', 'destination-1');
    store.setLinkPending('123456', true);
    store.savePlaylistImport('playlist-journal', {
      name: 'Synthetic playlist',
      status: 'uncertain',
    });
    store.saveAccountRoleRecord('role', { name: 'Synthetic role' });
    store.saveAccountRoleAssignmentRecord('assignment', { role_id: 'role' });
    store.saveMembershipRecord('membership', { discord_user_id: '123456' });
    store.saveAccountProfileRecord('profile', { family: true, note: 'Synthetic family owner' });
    store.db
      .prepare('INSERT INTO user_mappings VALUES (?,?)')
      .run(
        'mapping',
        store.encrypt({ source_user_id: 'source-1', target_user_id: 'destination-1' }),
      );
    store.saveSubscription({
      id: 'dedupe',
      action: 'expire',
      status: 'ignored',
      created_at: '2026-10-01',
    });
    store.baselineAdminAlerts('test-generation');
    const tables = [
      'accounts',
      'links',
      'migration_playlists',
      'user_mappings',
      'account_roles',
      'account_role_assignments',
      'memberships',
      'account_profiles',
      'subscriptions',
      'admin_alert_receipts',
    ];
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]),
      );
    const before = snapshot();
    expect(service.clearJobHistory(['removable']).removed_ids).toEqual(['removable']);
    expect(snapshot()).toEqual(before);
    await service.stop();
    store.close();
    store = new Store(path);
    service = new Service(store, { clientFactory });
    expect(store.job('removable')).toBeNull();
    expect(snapshot()).toEqual(before);
    expect(store.pendingAdminAlertCount('test-generation')).toBe(0);
    expect(store.playlistImport('playlist-journal')?.status).toBe('uncertain');
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rolls back all report, subscription and expired-credential deletions after a transaction error', () => {
    store.saveJob(report('first'));
    store.saveJob(report('second'));
    store.saveCredentials('first', 'member', 'expired-synthetic', 'https://example.invalid');
    store.db.prepare('UPDATE credentials SET expires=0').run();
    store.saveSubscription({
      id: 'subscription',
      action: 'subscribe',
      status: 'applied',
      created_at: '2026-10-01',
      job_id: 'first',
    });
    store.db.exec(`CREATE TRIGGER simulate_cleanup_error BEFORE DELETE ON jobs
      WHEN OLD.id='second' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    expect(() => service.clearJobHistory(['first', 'second'])).toThrow('synthetic failure');
    expect(store.jobs()).toHaveLength(2);
    expect(store.subscription('subscription')?.job_id).toBe('first');
    expect(store.subscription('subscription')?.report_cleared).toBeUndefined();
    expect(store.db.prepare('SELECT job_id FROM credentials').get()?.job_id).toBe('first');
  });

  it('clears at most 1000 exact reviewed IDs without loading or deserializing catalog diagnostics', () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `selected-${index}`);
    for (const id of ids)
      store.saveJob({
        ...report(id),
        results: [{ ...report(id).results[0]!, error: 'Synthetic diagnostic '.repeat(100) }],
      });
    store.saveJob({
      ...report(ids[0]!),
      results: Array.from({ length: 64 }, (_, index) => ({
        username: `synthetic-${index}`,
        status: 'completed',
        error: 'Synthetic large diagnostic '.repeat(2500),
      })),
    });
    store.saveJob(report('unreviewed-new-report'));
    const allJobs = vi.spyOn(store, 'jobs').mockImplementation(() => {
      throw new Error('Do not load all reports for cleanup.');
    });
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error('Do not deserialize report diagnostics for cleanup.');
    });
    const cleared = service.clearJobHistory(ids);
    parse.mockRestore();
    allJobs.mockRestore();
    expect(cleared).toEqual({ removed_ids: ids, skipped: [] });
    expect(JSON.stringify(cleared).length).toBeLessThan(20_000);
    expect(store.jobs().map((job) => job.id)).toEqual(['unreviewed-new-report']);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each(
    [
      [],
      ['duplicate', 'duplicate'],
      ['invalid/identifier'],
      ['x'.repeat(129)],
      Array.from({ length: 1001 }, (_, index) => `job-${index}`),
    ].map((ids) => ({ ids })),
  )('rejects invalid or oversized cleanup batches before deleting anything', ({ ids }) => {
    store.saveJob(report('preserved'));
    expect(() => service.clearJobHistory(ids)).toThrow('1 and 1000 distinct');
    expect(store.job('preserved')).not.toBeNull();
  });

  it('protects a terminal job during its final save and permits cleanup only after finalization and credential reveal', async () => {
    const servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-key',
      template_user_id: 'template',
    });
    service.clientFactory = servers.factory;
    const save = store.saveJob.bind(store);
    let terminalGuard = false;
    vi.spyOn(store, 'saveJob').mockImplementation((job) => {
      save(job);
      if (job.status === 'completed') {
        expect(service.clearJobHistory([job.id])).toEqual({
          removed_ids: [],
          skipped: [{ id: job.id, reason: 'active' }],
        });
        terminalGuard = true;
      }
    });
    const job = await service.createAccount('synthetic-member');
    await service.jobTasks.get(job.id);
    expect(terminalGuard).toBe(true);
    expect(service.clearJobHistory([job.id]).skipped).toEqual([
      { id: job.id, reason: 'pending_credentials' },
    ]);
    expect(store.takeCredentials(job.id)).toHaveLength(1);
    expect(service.clearJobHistory([job.id]).removed_ids).toEqual([job.id]);
    await Promise.resolve();
    expect(store.job(job.id)).toBeNull();
    expect(servers.users.jellyfin.some((user) => user.Name === 'synthetic-member')).toBe(true);
    expect(store.account('synthetic-member')?.status).toBe('ready');
  });

  it('preserves an unresolved account journal and its failed report after an uncertain creation', async () => {
    const servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-key',
      template_user_id: 'template',
    });
    const create = vi.fn(async () => {
      throw new MediaError('Synthetic timeout.');
    });
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.createUser = create;
      return client;
    };
    const job = await service.createAccount('synthetic-uncertain');
    await service.jobTasks.get(job.id);
    expect(service.getJob(job.id).status).toBe('failed');
    expect(service.clearJobHistory([job.id])).toEqual({
      removed_ids: [],
      skipped: [{ id: job.id, reason: 'recovery_required' }],
    });
    expect(store.account('synthetic-uncertain')?.status).toBe('uncertain');
    const retry = await service.createAccount('synthetic-uncertain');
    await service.jobTasks.get(retry.id);
    expect(create).toHaveBeenCalledOnce();
  });
});
