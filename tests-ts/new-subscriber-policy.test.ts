import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewSubscriberPolicy } from '../server/new-subscriber-policy.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { validateSettings } from '../server/settings.js';
import type { Settings } from '../server/types.js';

describe('persisted new-subscriber activation boundary', () => {
  let directory: string, store: Store, policy: NewSubscriberPolicy;
  const enabled = (): Settings => ({
    ...structuredClone(DEFAULT_SETTINGS),
    discord_enabled: true,
    discord_bot_token: 'synthetic-bot-key',
    discord_guild_id: '123456789',
    discord_message_events: true,
    discord_subscription_channel_id: '234567890',
    discord_subscription_bot_id: '345678901',
    emby_url: 'http://emby.example',
    jellyfin_url: 'http://jellyfin.example',
    auto_provision: true,
    auto_create_new_subscribers: true,
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
    directory = mkdtempSync(join(tmpdir(), 'jellyport-new-subscriber-policy-'));
    store = new Store(directory);
    policy = new NewSubscriberPolicy(store);
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });
  it('defaults off and does not invent a boundary for legacy settings', () => {
    expect(store.settings().auto_create_new_subscribers).toBe(false);
    store.db
      .prepare('INSERT INTO settings VALUES (1,?)')
      .run(store.encrypt({ auto_provision: true }));
    expect(store.settings().auto_create_new_subscribers).toBe(false);
    expect(policy.activation(store.settings())).toBeNull();
    expect(store.db.prepare('SELECT * FROM new_subscriber_policy').all()).toEqual([]);
  });
  it('captures server time once, persists across restart, and keeps unrelated saves from resetting it', () => {
    store.saveSettings(enabled());
    const original = policy.activation(store.settings())!;
    expect(original.enabled_at).toBe('2026-10-22T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
    store.saveSettings({ ...store.settings(), password_length: 15 });
    expect(policy.activation(store.settings())).toEqual(original);
    store.close();
    store = new Store(directory);
    policy = new NewSubscriberPolicy(store);
    expect(policy.activation(store.settings())).toEqual(original);
    expect(() => policy.assertActive(store.settings(), original.revision)).not.toThrow();
  });
  it('starts a new boundary on re-enable and invalidates the previous approval generation', () => {
    store.saveSettings(enabled());
    const original = policy.activation(store.settings())!;
    const stale = store.settings();
    store.saveSettings({ ...stale, auto_create_new_subscribers: false });
    expect(policy.activation(store.settings())).toBeNull();
    expect(() => policy.assertActive(stale, original.revision)).toThrow('policy changed');
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    store.saveSettings(enabled());
    expect(policy.activation(store.settings())).toMatchObject({
      enabled_at: '2026-10-24T12:00:00.000Z',
    });
    expect(policy.activation(store.settings())!.revision).not.toBe(original.revision);
  });
  it('can save the policy while automatic provisioning is paused without granting creation authority', () => {
    store.saveSettings({ ...enabled(), auto_provision: false });
    const activation = policy.activation(store.settings())!;
    expect(activation).toBeTruthy();
    expect(() => policy.assertActive(store.settings(), activation.revision)).toThrow(
      'policy changed',
    );
    store.saveSettings({ ...store.settings(), auto_provision: true });
    expect(policy.activation(store.settings())).toEqual(activation);
    const stale = store.settings();
    store.saveSettings({ ...stale, auto_provision: false });
    expect(() => policy.assertActive(stale, activation.revision)).toThrow('policy changed');
  });
  it.each(['discord_guild_id', 'emby_url', 'jellyfin_url'] as const)(
    'starts a fresh boundary when %s changes',
    (field) => {
      store.saveSettings(enabled());
      const original = policy.activation(store.settings())!;
      vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
      store.saveSettings({
        ...store.settings(),
        [field]: field === 'discord_guild_id' ? '987654321' : 'http://replacement.example',
      });
      expect(policy.activation(store.settings())!.revision).not.toBe(original.revision);
      expect(policy.activation(store.settings())!.enabled_at).toBe('2026-10-25T12:00:00.000Z');
    },
  );
  it('does not reuse a boundary after the paired server identity changes', () => {
    store.saveSettings(enabled());
    const original = policy.activation(store.settings())!;
    store.db.prepare('INSERT INTO auth_state VALUES(1,?)').run(
      store.encrypt({
        kind: 'configured',
        serverUrl: 'http://jellyfin.example',
        serverId: 'new-server',
        apiKeyName: 'synthetic',
      }),
    );
    expect(policy.activation(store.settings())).toBeNull();
    expect(() => policy.assertActive(store.settings(), original.revision)).toThrow(
      'policy changed',
    );
    store.saveSettings(store.settings());
    expect(policy.activation(store.settings())!.revision).not.toBe(original.revision);
  });
  it('rolls back settings together with a failed activation write', () => {
    store.db.exec(`CREATE TRIGGER reject_policy BEFORE INSERT ON new_subscriber_policy
      BEGIN SELECT RAISE(ABORT, 'synthetic policy write failure'); END`);
    expect(() => store.saveSettings(enabled())).toThrow('synthetic policy write failure');
    expect(store.settings().auto_create_new_subscribers).toBe(false);
    expect(policy.activation(store.settings())).toBeNull();
  });
  it('preserves an outer transaction and its rollback', () => {
    store.db.exec('BEGIN');
    store.saveSettings(enabled());
    expect(policy.activation(store.settings())).not.toBeNull();
    store.db.exec('ROLLBACK');
    expect(store.settings().auto_create_new_subscribers).toBe(false);
    expect(policy.activation(store.settings())).toBeNull();
  });
  it('requires trusted message events and rejects browser-supplied activation timestamps', () => {
    expect(() => validateSettings(enabled())).not.toThrow();
    expect(() => validateSettings({ ...enabled(), discord_message_events: false })).toThrow(
      'configured Stripe or trusted subscription message source',
    );
    expect(() => validateSettings({ ...enabled(), auto_create_new_subscribers: 'yes' })).toThrow(
      'must be a boolean',
    );
    expect(() =>
      validateSettings({ ...enabled(), new_subscriber_enabled_at: '2000-01-01' }),
    ).toThrow('Unknown setting');
  });
  it('fails closed when saved activation metadata is invalid', () => {
    store.saveSettings(enabled());
    store.db.prepare('UPDATE new_subscriber_policy SET encrypted=?').run(
      store.encrypt({
        enabled_at: 'invalid',
        revision: 'invalid',
        scope: 'invalid',
      }),
    );
    expect(() => policy.activation(store.settings())).toThrow('could not be verified');
  });
});
