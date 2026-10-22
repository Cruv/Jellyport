import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import type { BotAdapter } from '../server/service.js';
import type {
  IdentityReviewApplyInput,
  IdentityReviewSnapshot,
  IdentityRoster,
} from '../server/identity-review-types.js';
import { JellyfinAuthError } from '../server/jellyfin-auth.js';

const apps: JellyportApp[] = [];
const directories: string[] = [];
const owner = '234567890123456789';
const mediaKey = 'synthetic-identity-http-media-key';
const administratorToken = 'synthetic-identity-http-admin-token';

async function fixture(demo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-identity-http-'));
  directories.push(directory);
  const identity = {
    serverId: 'demo-jellyfin',
    userId: 'admin',
    username: 'admin',
    accessToken: administratorToken,
  };
  let authorized = true;
  const servers = new DemoServers();
  servers.users.emby = [
    { Id: 'emby-crew', Name: 'crew', Policy: { IsAdministrator: false, IsDisabled: false } },
  ];
  servers.users.jellyfin = [];
  const calls: string[] = [];
  const app = await createApp({
    demo,
    dataDir: directory,
    clientFactory: (...args) => {
      const client = servers.factory(...args);
      return new Proxy(client, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return async (...parameters: unknown[]) => {
            calls.push(String(property));
            if (!['users', 'systemInfo', 'close'].includes(String(property)))
              throw new Error('Identity review may only read account lists and server identity.');
            return Reflect.apply(value, target, parameters);
          };
        },
      });
    },
    authClient: {
      authenticate: async () => identity,
      validateSession: async () => {
        if (!authorized) throw new JellyfinAuthError('Synthetic authorization revoked.', 403);
        return identity;
      },
      signOut: async () => {},
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
    },
  });
  apps.push(app);
  const { store, service } = app.jellyport;
  if (!demo) {
    const pending = store.authState();
    if (pending?.kind !== 'pending') throw new Error('Expected isolated setup');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'http://jellyfin.example.test',
        serverId: identity.serverId,
        apiKeyName: 'synthetic',
      },
      (current) => ({
        ...current,
        emby_url: 'http://emby.example.test',
        emby_api_key: mediaKey,
        jellyfin_url: 'http://jellyfin.example.test',
        jellyfin_api_key: mediaKey,
        discord_enabled: true,
        discord_guild_id: '123456789012345678',
        discord_message_events: true,
      }),
    );
  }
  const listIdentityMembers = vi.fn(async (): Promise<IdentityRoster> => ({
    members: [{ id: owner, username: 'crew', roles: [] }],
    complete: true,
    fetched_at: new Date().toISOString(),
  }));
  const sendCredentials = vi.fn(async () => {});
  if (!demo)
    service.bot = {
      status: () => ({ enabled: true, connected: true }),
      recipientIdentity: async (id) => ({ id, username: 'crew' }),
      validateRecipient: async () => {},
      sendCredentials,
      membershipActive: async () => true,
      activeMembers: async () => [],
      listIdentityMembers,
    } satisfies BotAdapter;
  const anonymous = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
      'x-csrf-token': anonymous.json().csrf_token,
    },
    payload: { username: 'admin', password: demo ? 'demo-jellyport' : 'synthetic-password' },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: `jellyport_session=${login.cookies[0]!.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  const snapshot = async () => {
    const response = await app.inject({ url: '/api/identity-review', headers });
    expect(response.statusCode).toBe(200);
    return response.json<IdentityReviewSnapshot>();
  };
  const selection = (value: IdentityReviewSnapshot): IdentityReviewApplyInput => ({
    revision: value.revision,
    selections: [
      {
        row_id: `discord:${owner}`,
        discord_user_id: owner,
        stripe_customer_ids: [],
        accounts: [{ kind: 'emby', id: 'emby-crew', slot: 1 }],
      },
    ],
  });
  return {
    app,
    store,
    servers,
    headers,
    snapshot,
    selection,
    listIdentityMembers,
    sendCredentials,
    calls,
    revoke: () => {
      authorized = false;
    },
  };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('identity review HTTP authorization and validation', () => {
  it('protects inventory reads and both POST routes from anonymous, cross-site and missing-CSRF requests', async () => {
    const { app, headers, listIdentityMembers, store } = await fixture();
    for (const url of [
      '/api/identity-review',
      '/api/identity-review/roles',
      '/api/identity-review/roles/11111111-1111-4111-8111-111111111111',
    ])
      expect((await app.inject(url)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/identity-review',
          headers: { ...headers, origin: 'https://foreign.example.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/identity-review',
          headers: { ...headers, 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
    ).toBe(403);
    for (const url of ['/api/identity-review/refresh', '/api/identity-review/apply']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie: headers.cookie },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, 'x-csrf-token': 'wrong-token' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(listIdentityMembers).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_ownership').get()?.count).toBe(0);
  });

  it('returns private no-store observations without credentials and saves only reviewed existing ownership', async () => {
    const { app, headers, snapshot, selection, store, servers, sendCredentials, calls } =
      await fixture();
    const response = await app.inject({ url: '/api/identity-review', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(mediaKey);
    expect(response.body).not.toContain(administratorToken);
    const value = response.json<IdentityReviewSnapshot>();
    expect(value.sources.emby.complete).toBe(true);
    expect(value.sources.jellyfin.complete).toBe(true);
    expect(value.sources.stripe.complete).toBe(false);
    expect(value.rows.find((row) => row.member?.id === owner)?.gaps).toContain('billing_unknown');
    const before = structuredClone(servers.users);
    const applied = await app.inject({
      method: 'POST',
      url: '/api/identity-review/apply',
      headers,
      payload: selection(value),
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ approved: 1, roles: { status: 'not_configured' } });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_ownership').get()?.count).toBe(1);
    const fresh = await snapshot();
    expect(fresh.rows.find((row) => row.member?.id === owner)?.confirmed_accounts).toMatchObject([
      { kind: 'emby', id: 'emby-crew', owner_discord_id: owner },
    ]);
    expect(servers.users).toEqual(before);
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
    expect(sendCredentials).not.toHaveBeenCalled();
    expect(calls.every((call) => ['users', 'systemInfo', 'close'].includes(call))).toBe(true);
  });

  it('refreshes only inventory and rejects stale approvals without creating remote accounts', async () => {
    const { app, headers, snapshot, selection, servers, store } = await fixture();
    const value = await snapshot();
    servers.users.emby[0]!.Name = 'renamed-crew';
    const response = await app.inject({
      method: 'POST',
      url: '/api/identity-review/apply',
      headers,
      payload: selection(value),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/changed|refresh/i);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_ownership').get()?.count).toBe(0);
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/identity-review/refresh',
      headers,
      payload: {},
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().accounts[0].name).toBe('renamed-crew');
    expect(store.jobs()).toEqual([]);
  });

  it('rejects unknown, coerced, oversized and malformed approval bodies before reading inventory', async () => {
    const { app, headers, listIdentityMembers } = await fixture();
    const entry = {
      row_id: `discord:${owner}`,
      discord_user_id: owner,
      stripe_customer_ids: [],
      accounts: [{ kind: 'emby', id: 'emby-crew', slot: 1 }],
    };
    const base = { revision: 'a'.repeat(64), selections: [entry] };
    const invalid: unknown[] = [
      {},
      null,
      [],
      { ...base, secret: 'synthetic-private-body' },
      { ...base, revision: 'stale' },
      { ...base, revision: 'A'.repeat(64) },
      { ...base, selections: [] },
      { ...base, selections: Array.from({ length: 251 }, () => entry) },
      { ...base, selections: [{ ...entry, unknown: true }] },
      { ...base, selections: [{ ...entry, row_id: 'x'.repeat(301) }] },
      { ...base, selections: [{ ...entry, discord_user_id: 'not-a-snowflake' }] },
      {
        ...base,
        selections: [
          {
            ...entry,
            stripe_customer_ids: Array.from({ length: 11 }, (_, index) => `cus_${index}`),
          },
        ],
      },
      { ...base, selections: [{ ...entry, stripe_customer_ids: ['cus_Same', 'cus_Same'] }] },
      { ...base, selections: [{ ...entry, stripe_customer_ids: ['sub_NotCustomer'] }] },
      {
        ...base,
        selections: [{ ...entry, accounts: Array.from({ length: 7 }, () => entry.accounts[0]) }],
      },
      ...[0, 4, 1.5, '1'].map((slot) => ({
        ...base,
        selections: [{ ...entry, accounts: [{ ...entry.accounts[0], slot }] }],
      })),
      { ...base, selections: [{ ...entry, accounts: [{ ...entry.accounts[0], kind: 'plex' }] }] },
      {
        ...base,
        selections: [{ ...entry, accounts: [{ ...entry.accounts[0], id: 'x'.repeat(129) }] }],
      },
      {
        ...base,
        selections: [{ ...entry, accounts: [{ ...entry.accounts[0], auto_disable: true }] }],
      },
      ...[
        { kind: 'approved', note: '' },
        { kind: 'approved', note: 'x'.repeat(1001) },
        { kind: 'unknown', note: 'Synthetic note' },
        { kind: 'approved', note: 'Synthetic note', auto_disable: true },
      ].map((exception) => ({ ...base, selections: [{ ...entry, exception }] })),
    ];
    for (const payload of invalid) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/identity-review/apply',
        headers,
        payload: payload as object,
      });
      expect(response.statusCode, JSON.stringify(payload).slice(0, 160)).toBe(422);
      expect(response.body).not.toContain('synthetic-private-body');
    }
    // The documented maximum reaches semantic validation; 251 rows are rejected
    // by the HTTP schema above, without scheduling any discovery work.
    const maximum = await app.inject({
      method: 'POST',
      url: '/api/identity-review/apply',
      headers,
      payload: { ...base, selections: Array.from({ length: 250 }, () => entry) },
    });
    expect(maximum.statusCode).toBe(400);
    expect(maximum.json().detail).toMatch(/review.*expired|changed/i);
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/identity-review/apply',
      headers,
      payload: { ...base, private: 'synthetic-private-body' + 'x'.repeat(512 * 1024) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({ detail: 'Request too large.' });
    expect(listIdentityMembers).not.toHaveBeenCalled();
  });

  it('protects role task details and exposes only scoped private aggregate status', async () => {
    const { app, store, headers } = await fixture();
    const id = app.jellyport.identities.roleSync.enqueue([owner]);
    for (const url of ['/api/identity-review/roles', `/api/identity-review/roles/${id}`]) {
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(owner);
      expect(response.body).not.toContain(mediaKey);
      expect(response.body).not.toContain(administratorToken);
      expect(
        (await app.inject({ url, headers: { ...headers, origin: 'https://foreign.example.test' } }))
          .statusCode,
      ).toBe(403);
    }
    expect(
      (await app.inject({ url: `/api/identity-review/roles/${id}`, headers })).json(),
    ).toMatchObject({ status: 'queued', task_id: id });
    expect(
      (await app.inject({ url: '/api/identity-review/roles/not-a-task', headers })).statusCode,
    ).toBe(422);
    store.saveSettings({ ...store.settings(), discord_guild_id: '987654321012345678' });
    expect((await app.inject({ url: '/api/identity-review/roles', headers })).json()).toEqual({
      tasks: [],
    });
    expect(
      (await app.inject({ url: `/api/identity-review/roles/${id}`, headers })).statusCode,
    ).toBe(400);
  });

  it('records an annotation without enqueuing Discord role work or granting account access', async () => {
    const { app, store, headers, snapshot, servers } = await fixture();
    store.saveSettings({ ...store.settings(), discord_emby_role_id: '456789012345678901' });
    const before = structuredClone(servers.users);
    const value = await snapshot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/identity-review/apply',
      headers,
      payload: {
        revision: value.revision,
        selections: [
          {
            row_id: `discord:${owner}`,
            discord_user_id: owner,
            stripe_customer_ids: [],
            accounts: [],
            exception: { kind: 'non_media', note: 'Synthetic community-only member approval' },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ approved: 1, roles: { status: 'not_requested' } });
    expect(
      store.db.prepare('SELECT COUNT(*) AS count FROM identity_role_sync_tasks').get()?.count,
    ).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_ownership').get()?.count).toBe(0);
    expect(servers.users).toEqual(before);
    expect(store.membershipRecords()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.jobs()).toEqual([]);
  });

  it('keeps demonstration observations readable and refuses approval mutations', async () => {
    const { app, headers, snapshot, selection, store, sendCredentials } = await fixture(true);
    const value = await snapshot();
    expect(value.sources.stripe.complete).toBe(false);
    expect(value.sources.discord.complete).toBe(false);
    expect(value.rows.every((row) => row.gaps.includes('billing_unknown'))).toBe(true);
    const response = await app.inject({
      method: 'POST',
      url: '/api/identity-review/apply',
      headers,
      payload: selection(value),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/demo.*read-only/i);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_ownership').get()?.count).toBe(0);
    expect(sendCredentials).not.toHaveBeenCalled();
  });

  it('rejects revoked administrator access before reading identity data', async () => {
    const { app, headers, revoke, listIdentityMembers } = await fixture();
    revoke();
    const response = await app.inject({ url: '/api/identity-review', headers });
    expect(response.statusCode).toBe(401);
    expect(listIdentityMembers).not.toHaveBeenCalled();
  });

  it('does not commit an approval when its administrator signs out during the fresh roster check', async () => {
    const { app, headers, snapshot, selection, listIdentityMembers, store, sendCredentials } =
      await fixture();
    const value = await snapshot();
    let release!: (value: IdentityRoster) => void;
    listIdentityMembers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = app
      .inject({
        method: 'POST',
        url: '/api/identity-review/apply',
        headers,
        payload: selection(value),
      })
      .then((response) => response);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await app.inject({ method: 'POST', url: '/api/logout', headers })).statusCode).toBe(
      200,
    );
    release({
      members: [{ id: owner, username: 'crew', roles: [] }],
      complete: true,
      fetched_at: new Date().toISOString(),
    });
    const response = await pending;
    expect(response.statusCode).toBe(401);
    expect(response.json().detail).toMatch(/sign in again/i);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_ownership').get()?.count).toBe(0);
    expect(store.jobs()).toEqual([]);
    expect(sendCredentials).not.toHaveBeenCalled();
  });
});
