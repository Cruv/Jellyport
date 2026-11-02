import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Service } from '../server/service.js';
import { DemoServers } from '../server/demo.js';
import { DEMO_SETTINGS } from '../server/types.js';
import { WorkflowReadiness } from '../server/workflow-readiness.js';
import { WorkflowReviews } from '../server/workflow-reviews.js';
import type { ClientFactory } from '../server/media.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture(
  change?: (client: ReturnType<DemoServers['factory']>, kind: string | undefined) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-workflow-readiness-'));
  const store = new Store(directory);
  store.saveSettings(structuredClone(DEMO_SETTINGS));
  const servers = new DemoServers();
  const calls: string[] = [];
  const factory: ClientFactory = (url, key, kind) => {
    const client = servers.factory(url, key, kind);
    change?.(client, kind);
    return new Proxy(client, {
      get(target, property) {
        if (
          [
            'migrationItems',
            'playedItems',
            'createUser',
            'setPolicy',
            'setUserData',
            'markPlayed',
          ].includes(String(property))
        )
          throw new Error('Readiness must not read catalogs or mutate accounts');
        const value = Reflect.get(target, property);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              calls.push(`${kind}:${String(property)}`);
              return value.apply(target, args);
            }
          : value;
      },
    });
  };
  const service = new Service(store, { clientFactory: factory });
  const readiness = new WorkflowReadiness(service);
  cleanups.push(async () => {
    await readiness.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, servers, service, readiness, calls };
}

describe('workflow requirements before account tasks', () => {
  it('uses bounded metadata only and keeps local access independent of defaults, mapping, Stripe and Discord', async () => {
    const f = fixture();
    f.store.saveSettings({
      ...f.store.settings(),
      default_role_id: '',
      template_user_id: '',
      discord_enabled: false,
    });
    const result = await f.readiness.snapshot();
    expect(result.actions.create_account.ready).toBe(false);
    expect(result.actions.create_account.blockers.map((item) => item.code)).toContain(
      'account_defaults',
    );
    expect(result.actions.account_access_jellyfin.ready).toBe(true);
    expect(result.actions.account_access_emby.ready).toBe(true);
    expect(result.actions.identity_review.ready).toBe(false);
    expect(f.calls.filter((call) => call.endsWith(':users'))).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(f.store.settings().jellyfin_api_key);
  });
  it('shares overlapping checks and cached work while returning independent snapshots', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.readiness.snapshot(), f.readiness.snapshot()]);
    expect(f.calls.filter((call) => call.endsWith(':systemInfo'))).toHaveLength(2);
    first.actions.create_account.ready = false;
    expect(second.actions.create_account.ready).toBe(true);
    await f.readiness.snapshot();
    expect(f.calls.filter((call) => call.endsWith(':systemInfo'))).toHaveLength(2);
    await f.readiness.snapshot(true);
    expect(f.calls.filter((call) => call.endsWith(':systemInfo'))).toHaveLength(4);
  });
  it('invalidates on settings changes rather than accepting stale default checks', async () => {
    const f = fixture();
    expect((await f.readiness.snapshot()).actions.create_account.ready).toBe(true);
    f.store.saveSettings({ ...f.store.settings(), template_user_id: '' });
    expect((await f.readiness.snapshot()).actions.create_account.ready).toBe(false);
  });
  it('does not block Jellyfin account management when only Emby is unavailable', async () => {
    const f = fixture((client, kind) => {
      if (kind === 'emby')
        client.systemInfo = async () => {
          throw new Error('synthetic-secret-url');
        };
    });
    const value = await f.readiness.snapshot();
    expect(value.actions.account_access_jellyfin.ready).toBe(true);
    expect(value.actions.create_account.ready).toBe(true);
    expect(value.actions.migrate.ready).toBe(false);
    expect(value.sources.emby.available).toBe(false);
    expect(JSON.stringify(value)).not.toContain('synthetic-secret-url');
  });
  it('rejects a protected template before the create form is enabled', async () => {
    const f = fixture();
    const template = f.servers.users.jellyfin.find(
      (user) => user.Id === f.store.settings().template_user_id,
    )!;
    template.Policy = { IsAdministrator: true, IsDisabled: false };
    const value = await f.readiness.snapshot();
    expect(value.actions.create_account.ready).toBe(false);
    expect(value.actions.account_roles.ready).toBe(true);
  });
  it('bounds a stalled source and never follows it with more reads', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { Id: string }) => void;
    const f = fixture((client, kind) => {
      if (kind === 'emby')
        client.systemInfo = () =>
          new Promise((done) => {
            resolve = done;
          });
    });
    const task = f.readiness.snapshot();
    await vi.advanceTimersByTimeAsync(8_001);
    expect((await task).sources.emby.available).toBe(false);
    resolve({ Id: 'demo-emby' });
    await Promise.resolve();
    expect(f.calls.filter((call) => call === 'emby:users')).toHaveLength(0);
  });
});

describe('private one-use membership workflow reviews', () => {
  it('binds proof to its session and settings context and never exposes the private payload', () => {
    const reviews = new WorkflowReviews<{ private: string }>();
    const publicResult = reviews.save('owner', 'context', { private: 'synthetic-evidence' });
    expect(JSON.stringify(publicResult)).not.toContain('synthetic-evidence');
    expect(() => reviews.take('other-owner', 'context', publicResult.review_token)).toThrow(
      /expired|changed/,
    );
    expect(() => reviews.take('owner', 'other-context', publicResult.review_token)).toThrow(
      /expired|changed/,
    );
    expect(reviews.take('owner', 'context', publicResult.review_token)).toEqual({
      private: 'synthetic-evidence',
    });
    expect(() => reviews.take('owner', 'context', publicResult.review_token)).toThrow(
      /expired|changed/,
    );
  });
  it('replaces obsolete same-session proofs and expires/cancels retained data', () => {
    vi.useFakeTimers();
    const reviews = new WorkflowReviews<number>();
    const old = reviews.save('owner', 'context', 1);
    const next = reviews.save('owner', 'context', 2);
    expect(() => reviews.take('owner', 'context', old.review_token)).toThrow();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(() => reviews.take('owner', 'context', next.review_token)).toThrow();
    const canceled = reviews.save('owner', 'context', 3);
    reviews.cancelOwner('owner');
    expect(() => reviews.take('owner', 'context', canceled.review_token)).toThrow();
  });
});

it('bounds an unrelated Discord role lookup without leaving local account actions pending', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.store.saveSettings({
    ...f.store.settings(),
    discord_enabled: true,
    discord_jellyfin_role_id: '123456789012345678',
  });
  const lookup = vi.fn(() => new Promise<never>(() => {}));
  f.service.bot = {
    status: () => ({ connected: true }),
    listTagRoles: lookup,
  } as unknown as NonNullable<Service['bot']>;
  const task = f.readiness.snapshot();
  await vi.advanceTimersByTimeAsync(2_001);
  const result = await task;
  expect(result.actions.account_access_jellyfin.ready).toBe(true);
  expect(result.actions.discord_roles.ready).toBe(false);
  expect(lookup).toHaveBeenCalledOnce();
});

it('catches a changed paired URL even if its metadata reports the original server ID', async () => {
  const f = fixture();
  f.store.ensureAuthState();
  const state = f.store.authState();
  if (state?.kind !== 'pending') throw new Error('Expected synthetic pending setup');
  f.store.completeAuth(
    state.generation,
    {
      kind: 'configured',
      serverId: 'demo-jellyfin',
      serverUrl: f.store.settings().jellyfin_url,
      apiKeyName: 'Synthetic',
    },
    (settings) => settings,
  );
  f.store.saveSettings({
    ...f.store.settings(),
    jellyfin_url: 'http://changed-server.example.test:8096',
  });
  const result = await f.readiness.snapshot();
  expect(result.actions.account_access_jellyfin.ready).toBe(false);
  expect(result.actions.account_access_emby.ready).toBe(false);
});
