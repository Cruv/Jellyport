import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAlerts } from '../server/admin-alerts.js';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';
import type { Job, SubscriptionEvent } from '../server/service.js';

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-alerts-'));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  const settings: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    jellyfin_url: 'https://private-media.example',
    discord_enabled: true,
    discord_guild_id: '123456789012345678',
    discord_bot_token: 'private-token',
  };
  store.saveSettings(settings);
  const state = store.ensureAuthState();
  if (state.kind !== 'pending') throw new Error('Unexpected fixture state');
  store.completeAuth(
    state.generation,
    {
      kind: 'configured',
      serverUrl: settings.jellyfin_url,
      serverId: 'private-server-identity',
      apiKeyName: 'fixture',
    },
    (current) => current,
  );
  const alerts = new AdminAlerts(store);
  const recipient = {
    guild_id: settings.discord_guild_id,
    user_id: '222222222222222222',
    username: 'private_admin_username',
  };
  return { directory, store, settings, alerts, recipient };
}
function job(id: string, status = 'completed'): Job {
  return {
    id,
    kind: 'migration',
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: { processed: 1, total: 1 },
    results: [
      {
        username: 'PRIVATE_USERNAME',
        status,
        delivery_error: 'PASSWORD SECRET_SESSION',
        error: 'http://private-host/private?token=SECRET_TOKEN',
      },
    ],
  };
}
function subscription(id: string, status = 'pending'): SubscriptionEvent {
  return {
    id,
    action: 'subscribe',
    status,
    created_at: new Date().toISOString(),
    username: 'PRIVATE_USERNAME',
    discord_user_id: '333333333333333333',
    detail: 'PRIVATE_FAMILY_NOTE',
    error: 'SECRET_SESSION',
  };
}
describe('private administrator notification outbox', () => {
  it('defaults to disabled and has a narrowly projected status', () => {
    const { alerts, settings } = fixture();
    expect(alerts.status(settings)).toEqual({
      enabled: false,
      recipient_username: null,
      recipient_id: null,
      revision: null,
      last_sent_at: null,
      last_error: null,
      pending_count: 0,
    });
  });
  it('baselines existing terminal jobs and subscription review states without sending history', async () => {
    const { alerts, store, settings, recipient } = fixture();
    store.saveJob(job('old-job'));
    store.saveSubscription(subscription('old-event'));
    store.saveSubscription(subscription('old-failed-event', 'failed'));
    const status = alerts.enable(recipient, settings);
    expect(status).toMatchObject({
      enabled: true,
      pending_count: 0,
      recipient_id: recipient.user_id,
    });
    const send = vi.fn();
    await alerts.flush(settings, send);
    expect(send).not.toHaveBeenCalled();
  });
  it('notifies a job already in progress when enabled only after it finishes', async () => {
    const { alerts, store, settings, recipient } = fixture();
    store.saveJob(job('running-job', 'running'));
    alerts.enable(recipient, settings);
    const send = vi.fn(async (_id: string, _content: string) => {});
    await alerts.flush(settings, send);
    expect(send).not.toHaveBeenCalled();
    store.saveJob(job('running-job', 'completed'));
    expect(alerts.status(settings).pending_count).toBe(1);
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledWith(
      recipient.user_id,
      expect.stringContaining('1 completed'),
      expect.any(Function),
    );
    expect(alerts.status(settings)).toMatchObject({
      pending_count: 0,
      last_sent_at: expect.any(String),
    });
  });
  it('sends only fixed counts and no upstream fields, IDs, usernames, credentials, notes, or URLs', async () => {
    const { alerts, store, settings, recipient } = fixture();
    alerts.enable(recipient, settings);
    for (const status of ['completed', 'partial', 'failed', 'interrupted', 'cancelled'])
      store.saveJob(job(`PRIVATE_ID-${status}`, status));
    store.saveSubscription(subscription('PRIVATE_ID-pending'));
    store.saveSubscription(subscription('PRIVATE_ID-failed', 'failed'));
    const send = vi.fn(async (_id: string, _content: string) => {});
    await alerts.flush(settings, send);
    const content = send.mock.calls[0]![1] as string;
    expect(content).toContain('1 completed, 1 need review, 1 failed, 1 interrupted, 1 cancelled');
    expect(content).toContain('Subscription events awaiting review: 1.');
    expect(content).toContain('Subscription actions that failed: 1.');
    expect(content).not.toMatch(/PRIVATE|PASSWORD|SECRET|https?:|333333333333333333/);
    expect(content.length).toBeLessThan(1900);
  });
  it('deduplicates repeated saves and persists accepted delivery across restarts', async () => {
    const { alerts, store, settings, recipient, directory } = fixture();
    alerts.enable(recipient, settings);
    store.saveJob(job('same-job'));
    const send = vi.fn(async (_id: string, _content: string) => {});
    await alerts.flush(settings, send);
    store.saveJob(job('same-job'));
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(directory);
    stores.push(reopened);
    await new AdminAlerts(reopened).flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('notifies a new failed state for a subscription already baselined as pending', async () => {
    const { alerts, store, settings, recipient } = fixture();
    store.saveSubscription(subscription('event'));
    alerts.enable(recipient, settings);
    store.saveSubscription(subscription('event', 'failed'));
    const send = vi.fn(async (_id: string, _content: string) => {});
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
    store.saveSubscription(subscription('event', 'applied'));
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps failed delivery pending, sanitizes errors, and backs retries off for one then five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const { alerts, store, settings, recipient } = fixture();
    alerts.enable(recipient, settings);
    store.saveJob(job('failed-delivery'));
    const send = vi.fn(async () => {
      throw new Error('SECRET_TOKEN PRIVATE_USERNAME');
    });
    await alerts.flush(settings, send);
    expect(alerts.status(settings)).toMatchObject({
      pending_count: 1,
      last_sent_at: null,
      last_error: expect.stringContaining('could not be delivered'),
    });
    expect(JSON.stringify(alerts.status(settings))).not.toMatch(/SECRET_TOKEN|PRIVATE_USERNAME/);
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(299_999);
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    const recovered = vi.fn(async () => {});
    await alerts.flush(settings, recovered);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(alerts.status(settings)).toMatchObject({ pending_count: 0, last_error: null });
  });
  it('bounds every digest to 100 events and delivers the rest in a subsequent digest', async () => {
    const { alerts, store, settings, recipient } = fixture();
    alerts.enable(recipient, settings);
    for (let i = 0; i < 103; i++) store.saveJob(job(`job-${i}`));
    const send = vi.fn(async (_id: string, _content: string) => {});
    await alerts.flush(settings, send);
    expect(send.mock.calls[0]![1]).toContain('100 completed');
    expect(alerts.status(settings).pending_count).toBe(3);
    await alerts.flush(settings, send);
    expect(send.mock.calls[1]![1]).toContain('3 completed');
    expect(alerts.status(settings).pending_count).toBe(0);
  });
  it('prevents overlapping flushes while a Discord request is outstanding', async () => {
    const { alerts, store, settings, recipient } = fixture();
    alerts.enable(recipient, settings);
    store.saveJob(job('job'));
    let finish!: () => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = alerts.flush(settings, send);
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(alerts.status(settings).pending_count).toBe(0);
  });
  it('does not persist an old delivery after disabling during the send', async () => {
    const { alerts, store, settings, recipient } = fixture();
    alerts.enable(recipient, settings);
    store.saveJob(job('job'));
    await alerts.flush(settings, async (_id, _content, stillCurrent) => {
      expect(stillCurrent()).toBe(true);
      alerts.disable(recipient.user_id);
      expect(stillCurrent()).toBe(false);
    });
    expect(alerts.status(settings)).toMatchObject({
      enabled: false,
      revision: null,
      pending_count: 0,
    });
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM admin_alert_receipts').get()!.count,
    ).toBe(0);
  });
  it('pins the selected recipient generation and never redirects an old backlog to a replacement admin', async () => {
    const { alerts, store, settings, recipient } = fixture();
    const before = alerts.enable(recipient, settings);
    store.saveJob(job('job'));
    const replacement = { ...recipient, user_id: '444444444444444444', username: 'other_admin' };
    await alerts.flush(settings, async (id, _content, stillCurrent) => {
      expect(id).toBe(recipient.user_id);
      alerts.enable(replacement, settings);
      expect(stillCurrent()).toBe(false);
    });
    const after = alerts.status(settings);
    expect(after).toMatchObject({
      recipient_id: replacement.user_id,
      pending_count: 0,
      last_sent_at: null,
    });
    expect(after.revision).not.toBe(before.revision);
    const send = vi.fn(async () => {});
    await alerts.flush(settings, send);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['guild', 'server', 'identity', 'disabled'])(
    'pauses delivery when the pinned %s changes',
    async (change) => {
      const { alerts, store, settings, recipient } = fixture();
      alerts.enable(recipient, settings);
      store.saveJob(job('job'));
      if (change === 'guild')
        store.saveSettings({ ...settings, discord_guild_id: '555555555555555555' });
      if (change === 'server')
        store.saveSettings({ ...settings, jellyfin_url: 'https://other.example' });
      if (change === 'disabled') store.saveSettings({ ...settings, discord_enabled: false });
      if (change === 'identity')
        store.db
          .prepare('UPDATE auth_state SET encrypted=? WHERE id=1')
          .run(
            store.encrypt({
              kind: 'configured',
              serverUrl: settings.jellyfin_url,
              serverId: 'replacement',
              apiKeyName: 'fixture',
            }),
          );
      const send = vi.fn(async () => {});
      await alerts.flush(settings, send);
      expect(send).not.toHaveBeenCalled();
      expect(alerts.status(store.settings())).toMatchObject({
        enabled: false,
        recipient_id: null,
        pending_count: 0,
      });
    },
  );
  it('freshly checks scope after each awaited send before acknowledging delivery', async () => {
    const { alerts, store, settings, recipient } = fixture();
    alerts.enable(recipient, settings);
    store.saveJob(job('job'));
    await alerts.flush(settings, async (_id, _content, stillCurrent) => {
      store.saveSettings({ ...settings, discord_guild_id: '555555555555555555' });
      expect(stillCurrent()).toBe(false);
    });
    store.saveSettings(settings);
    expect(alerts.status(settings)).toMatchObject({ last_sent_at: null, pending_count: 1 });
  });
  it('requires the selected administrator for Discord disable and rejects stale web disable revisions', () => {
    const { alerts, settings, recipient } = fixture();
    const status = alerts.enable(recipient, settings);
    expect(() => alerts.disable('444444444444444444')).toThrow(
      'selected notification administrator',
    );
    expect(() => alerts.disable(undefined, 'stale')).toThrow('changed');
    expect(alerts.status(settings).enabled).toBe(true);
    alerts.disable(undefined, status.revision!);
    expect(alerts.status(settings).enabled).toBe(false);
  });
  it('re-enabling the same recipient preserves outstanding events and resets delivery backoff', async () => {
    const { alerts, store, settings, recipient } = fixture();
    const status = alerts.enable(recipient, settings);
    store.saveJob(job('job'));
    await alerts.flush(settings, async () => {
      throw new Error('blocked');
    });
    const updated = alerts.enable({ ...recipient, username: 'renamed_admin' }, settings);
    expect(updated).toMatchObject({
      revision: status.revision,
      pending_count: 1,
      last_error: null,
      recipient_username: 'renamed_admin',
    });
    const send = vi.fn(async () => {});
    await alerts.flush(settings, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid recipients and stale configurations without enabling delivery', () => {
    const { alerts, store, settings, recipient } = fixture();
    for (const invalid of [
      { user_id: '0' },
      { user_id: 'bad-id' },
      { username: '' },
      { username: 'bad\nname' },
      { guild_id: '999999999999999999' },
    ])
      expect(() => alerts.enable({ ...recipient, ...invalid }, settings)).toThrow('Verify');
    store.saveSettings({ ...settings, discord_guild_id: '999999999999999999' });
    expect(() => alerts.enable(recipient, settings)).toThrow('Verify');
    expect(alerts.status(settings).enabled).toBe(false);
  });
  it('encrypts recipient identity and scope metadata in the database and WAL', () => {
    const { alerts, settings, recipient, directory } = fixture();
    alerts.enable(recipient, settings);
    for (const filename of ['jellyport.db', 'jellyport.db-wal']) {
      const bytes = readFileSync(join(directory, filename));
      for (const secret of [
        recipient.user_id,
        recipient.username,
        recipient.guild_id,
        settings.jellyfin_url,
        'private-server-identity',
      ])
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });
  it.each(['config', 'receipt'])(
    'rejects demo mode when only private alert %s data exists',
    (kind) => {
      const { store, directory } = fixture();
      store.db.exec('DELETE FROM settings; DELETE FROM auth_state');
      if (kind === 'config') store.saveAdminAlertConfig({ private: 'operator data' });
      else store.saveAdminAlertReceipt('private-id', { private: 'operator data' });
      store.close();
      stores.splice(stores.indexOf(store), 1);
      expect(() => new Store(directory, { demo: true })).toThrow('Demo mode requires a separate');
    },
  );
});
