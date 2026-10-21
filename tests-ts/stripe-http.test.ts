import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import type { StripeSnapshot } from '../server/stripe-client.js';

const directories: string[] = [];
const apps: JellyportApp[] = [];
const member = '234567890123456789';
const key = 'rk_test_syntheticKeyOnly123';
async function fixture(demo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-http-'));
  directories.push(directory);
  const identity = {
    serverId: 'test-jellyfin',
    userId: 'admin',
    username: 'admin',
    accessToken: 'synthetic-admin-token',
  };
  const servers = new DemoServers();
  const snapshot = vi.fn(async (): Promise<StripeSnapshot> => ({
    mode: 'test',
    completed_at: new Date().toISOString(),
    products: [],
    subscriptions: [
      {
        id: 'sub_Crew',
        customer_id: 'cus_Crew',
        customer_email: 'synthetic@example.test',
        status: 'active',
        collection_method: 'charge_automatically',
        cancel_at_period_end: false,
        pause_collection: false,
        items: [],
        identity_candidates: [
          { discord_user_id: member, source: 'subscription_metadata', field: 'discord_user_id' },
        ],
      },
    ],
  }));
  const app = await createApp({
    demo,
    dataDir: directory,
    clientFactory: servers.factory,
    authClient: {
      authenticate: async () => identity,
      validateSession: async () => identity,
      signOut: async () => {},
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
    },
    stripeClientFactory: () => ({
      mode: 'test',
      snapshot,
      checkoutIdentityCandidates: async () => [],
    }),
  });
  apps.push(app);
  const { store, service } = app.jellyport;
  if (!demo) {
    const pending = store.authState();
    if (pending?.kind !== 'pending') throw new Error('Isolated setup expected');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example.test',
        serverId: identity.serverId,
        apiKeyName: 'synthetic',
      },
      (current) => ({
        ...current,
        jellyfin_url: 'https://jellyfin.example.test',
        jellyfin_api_key: 'synthetic-media-key',
        discord_enabled: true,
        discord_guild_id: '123456789012345678',
      }),
    );
  }
  service.bot = {
    status: () => ({ connected: true }),
    recipientIdentity: async (id) => ({ id, username: 'synthetic-member' }),
    validateRecipient: async () => {},
    sendCredentials: async () => {},
    membershipActive: async () => true,
    activeMembers: async () => [],
  };
  const session = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${session.cookies[0]!.value}`,
      'x-csrf-token': session.json().csrf_token,
    },
    payload: { username: 'admin', password: demo ? 'demo-jellyport' : 'synthetic-password' },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: `jellyport_session=${login.cookies[0]!.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  const revision = () => app.jellyport.stripe.status().revision;
  const configure = () =>
    app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers,
      payload: { api_key: key, sync_enabled: false, expected_revision: revision() },
    });
  return { app, store, headers, revision, configure, snapshot };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('private Stripe integration HTTP boundary', () => {
  it('requires an administrator and CSRF for sensitive reads and changes', async () => {
    const { app, headers, revision } = await fixture();
    for (const url of ['/api/stripe/status', '/api/stripe/subscriptions'])
      expect((await app.inject(url)).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers: { cookie: headers.cookie },
      payload: { api_key: key, sync_enabled: false, expected_revision: revision() },
    });
    expect(response.statusCode).toBe(403);
    expect(app.jellyport.stripe.status().configured).toBe(false);
    expect(
      (
        await app.inject({
          url: '/api/stripe/status',
          headers: { ...headers, origin: 'https://foreign.example.test' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('saves encrypted credentials, shares read-only sync, and approves only current member links', async () => {
    const { app, store, headers, revision, configure, snapshot } = await fixture();
    const saved = await configure();
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(key);
    expect(saved.json()).toMatchObject({ configured: true, review_only: true });
    const sync = await app.inject({ method: 'POST', url: '/api/stripe/sync', headers });
    expect(sync.statusCode).toBe(202);
    await vi.waitFor(() => expect(app.jellyport.stripe.status().running).toBe(false));
    expect(snapshot).toHaveBeenCalledTimes(1);
    const status = await app.inject({ url: '/api/stripe/status', headers });
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).not.toContain('synthetic@example.test');
    const rows = await app.inject({ url: '/api/stripe/subscriptions', headers });
    expect(rows.json().subscriptions[0]).toMatchObject({
      customer_id: 'cus_Crew',
      linked_discord_id: null,
    });
    const suggested = await app.inject({
      method: 'POST',
      url: '/api/stripe/resolve-candidate',
      headers,
      payload: { customer_id: 'cus_Crew', expected_revision: revision() },
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.json().member).toEqual({
      id: member,
      username: 'synthetic-member',
      display_name: null,
      nickname: null,
      membership_active: null,
    });
    expect(app.jellyport.stripe.subscriptions()[0]!.linked_discord_id).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/stripe/links',
          headers,
          payload: { customer_id: 'cus_Crew', discord_user_id: member, expected_revision: 'stale' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/stripe/links',
          headers,
          payload: {
            customer_id: 'cus_Crew',
            discord_user_id: member,
            expected_revision: revision(),
          },
        })
      ).statusCode,
    ).toBe(200);
    const linked = await app.inject({ url: '/api/stripe/subscriptions', headers });
    expect(linked.json().subscriptions[0].linked_discord_id).toBe(member);
    const settings = await app.inject({ url: '/api/settings', headers });
    expect(settings.body).not.toContain(key);
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
  });
  it('blocks demo credentials and rejects unknown configuration fields', async () => {
    const { app, headers, configure } = await fixture(true);
    expect((await configure()).statusCode).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers,
      payload: {
        api_key: key,
        sync_enabled: false,
        expected_revision: 'review',
        auto_disable: true,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(app.jellyport.stripe.status().configured).toBe(false);
  });
});
