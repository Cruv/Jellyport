import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';

const owner = '123456789012345678';
const resources: Array<{ app: JellyportApp; directory: string }> = [];
const writeMethods = new Set([
  'createUser',
  'setPassword',
  'setPolicy',
  'setConfiguration',
  'setDisplayPreferences',
  'markPlayed',
  'markFavorite',
  'updateUserData',
  'createPlaylist',
  'addPlaylistItems',
  'setUserImage',
]);
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
async function fixture(withTarget = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-membership-workflow-http-'));
  const servers = new DemoServers();
  for (const user of servers.users.emby)
    user.Policy = { IsAdministrator: false, IsDisabled: false };
  const reads: Array<{ kind: string; method: string }> = [];
  const writes: string[] = [];
  let beforeRead: ((kind: string, method: string) => Promise<void> | void) | undefined;
  const identity = {
    serverId: 'demo-jellyfin',
    userId: 'admin',
    username: 'admin',
    accessToken: 'synthetic-session',
  };
  const app = await createApp({
    dataDir: directory,
    clientFactory: (...args) => {
      const client = servers.factory(...args),
        kind = args[2] ?? 'jellyfin';
      return new Proxy(client, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return async (...parameters: unknown[]) => {
            const method = String(property);
            if (writeMethods.has(method)) writes.push(method);
            else {
              reads.push({ kind, method });
              await beforeRead?.(kind, method);
            }
            return Reflect.apply(value, target, parameters);
          };
        },
      });
    },
    authClient: {
      authenticate: async () => identity,
      validateSession: async () => identity,
      signOut: async () => {},
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
    },
  });
  resources.push({ app, directory });
  const { store, service } = app.jellyport;
  const state = store.authState();
  if (state?.kind !== 'pending') throw new Error('Expected synthetic first setup');
  store.completeAuth(
    state.generation,
    {
      kind: 'configured',
      serverId: identity.serverId,
      serverUrl: 'http://jellyfin.example.test',
      apiKeyName: 'synthetic',
    },
    (settings) => ({
      ...settings,
      emby_url: 'http://emby.example.test',
      emby_api_key: 'PRIVATE-SYNTHETIC-EMBY',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'PRIVATE-SYNTHETIC-JELLYFIN',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '223456789012345678',
      auto_provision: false,
      auto_disable: false,
    }),
  );
  service.bot = {
    status: () => ({ connected: true }),
    recipientIdentity: vi.fn(async (id) => ({ id, username: 'crew_owner' })),
    validateRecipient: vi.fn(async () => {}),
    sendCredentials: vi.fn(async () => {}),
    membershipActive: async () => true,
    activeMembers: async () => [],
  };
  vi.spyOn(service as unknown as { schedule: () => void }, 'schedule').mockImplementation(() => {});
  if (withTarget)
    service.mediaOwnerships.save(
      [
        {
          kind: 'jellyfin',
          server_id: 'demo-jellyfin',
          account_id: 'j-river',
          username: 'river',
          discord_user_id: owner,
          slot: 1,
        },
      ],
      store.settings(),
    );
  async function login() {
    const anonymous = await app.inject('/api/session');
    const signed = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'admin', password: 'synthetic-password' },
    });
    expect(signed.statusCode).toBe(200);
    return {
      cookie: `jellyport_session=${signed.cookies[0]!.value}`,
      'x-csrf-token': signed.json().csrf_token as string,
    };
  }
  const headers = await login();
  const body = {
    discord_user_id: owner,
    access_mode: 'subscription',
    tier_id: 'sloop',
    provision_jellyfin: withTarget,
  };
  const review = (payload: object = body, customHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/memberships/workflow/review',
      headers: customHeaders,
      payload,
    });
  const accept = (token: string, customHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/memberships/workflow/accept',
      headers: customHeaders,
      payload: { review_token: token },
    });
  return {
    app,
    store,
    service,
    servers,
    headers,
    login,
    review,
    accept,
    body,
    reads,
    writes,
    onRead(callback: typeof beforeRead) {
      beforeRead = callback;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('authenticated membership workflow routes', () => {
  it('returns a private summary and opaque token without saving policy, links, jobs or media writes', async () => {
    const f = await fixture(true);
    const response = await f.review();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      discord_user_id: owner,
      policy_only: false,
      accounts: [{ username: 'river', action: 'manage', target_user_id: 'j-river' }],
    });
    expect(response.json().review_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json()).not.toHaveProperty('input');
    expect(response.json()).not.toHaveProperty('fingerprint');
    expect(response.body).not.toMatch(/PRIVATE-|synthetic-session|api_key|server_url/);
    expect(f.store.links()).toEqual([]);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.jobs()).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it('accepts a same-session policy-only review with job:null and rejects replay', async () => {
    const f = await fixture();
    const review = await f.review();
    expect(review.statusCode).toBe(200);
    expect(review.json().policy_only).toBe(true);
    expect(f.store.jobs()).toEqual([]);
    const response = await f.accept(review.json().review_token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job: null,
      membership: { discord_user_id: owner, provision_jellyfin: false },
    });
    expect(f.service.memberships.get(owner, f.store.settings())?.provision_jellyfin).toBe(false);
    const before = f.service.memberships.get(owner, f.store.settings());
    expect((await f.accept(review.json().review_token)).statusCode).toBe(400);
    expect(f.service.memberships.get(owner, f.store.settings())).toEqual(before);
    expect(f.store.jobs()).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it('atomically queues a confirmed alias and saves its existing ownership relationship on final acceptance', async () => {
    const f = await fixture(true);
    const review = await f.review();
    expect(review.statusCode).toBe(200);
    const response = await f.accept(review.json().review_token);
    expect(response.statusCode).toBe(202);
    expect(response.json().job).toMatchObject({ kind: 'membership', status: 'queued' });
    expect(f.store.link(owner)).toMatchObject({ remote_id: 'j-river', username: 'river' });
    expect(f.store.queuedJobs()[0]?.requests[0]).toMatchObject({
      target_user_id: 'j-river',
      username: 'river',
      access_disabled: false,
      membership_revision: response.json().membership.revision,
    });
    expect(f.writes).toEqual([]);
  });

  it('rejects a foreign session without consuming the legitimate owner’s review token', async () => {
    const f = await fixture();
    const review = await f.review();
    const stranger = await f.login();
    const response = await f.accept(review.json().review_token, stranger);
    expect(response.statusCode).toBe(400);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect((await f.accept(review.json().review_token)).statusCode).toBe(200);
    expect(f.writes).toEqual([]);
  });

  it('rejects missing CSRF before reviewing private identity data or consuming an acceptance token', async () => {
    const f = await fixture(true);
    const missing = { cookie: f.headers.cookie, 'x-csrf-token': '' };
    const first = await f.review(f.body, missing);
    expect(first.statusCode).toBe(403);
    expect(f.service.bot!.recipientIdentity).not.toHaveBeenCalled();
    const review = await f.review();
    const denied = await f.accept(review.json().review_token, missing);
    expect(denied.statusCode).toBe(403);
    expect(f.store.links()).toEqual([]);
    expect((await f.accept(review.json().review_token)).statusCode).toBe(202);
    expect(f.writes).toEqual([]);
  });

  it('requires a fresh review after settings change and leaves policy and links untouched', async () => {
    const f = await fixture(true);
    const review = await f.review();
    f.store.saveSettings({ ...f.store.settings(), template_user_id: 'different-template' });
    const response = await f.accept(review.json().review_token);
    expect(response.statusCode).toBe(400);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.links()).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it('discards a review on logout so it cannot be accepted from a later sign-in', async () => {
    const f = await fixture(true);
    const review = await f.review();
    const logout = await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers });
    expect(logout.statusCode).toBe(200);
    expect((await f.accept(review.json().review_token)).statusCode).toBe(401);
    const signedAgain = await f.login();
    expect((await f.accept(review.json().review_token, signedAgain)).statusCode).toBe(400);
    expect(f.store.links()).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it.each(['review', 'accept'] as const)(
    'stops %s after logout during an awaited read before later reads, policy writes or queued actions',
    async (action) => {
      const f = await fixture(true);
      const ready = action === 'accept' ? await f.review() : null;
      const entered = deferred(),
        release = deferred();
      f.reads.length = 0;
      f.onRead(async (kind, method) => {
        if (kind === 'jellyfin' && method === 'systemInfo') {
          entered.resolve();
          await release.promise;
        }
      });
      const request = action === 'accept' ? f.accept(ready!.json().review_token) : f.review();
      await entered.promise;
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers })).statusCode,
      ).toBe(200);
      release.resolve();
      const response = await request;
      expect(response.statusCode).toBe(401);
      expect(f.reads.filter((call) => call.kind === 'jellyfin').map((call) => call.method)).toEqual(
        ['systemInfo', 'close'],
      );
      expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
      expect(f.store.links()).toEqual([]);
      expect(f.store.jobs()).toEqual([]);
      expect(f.writes).toEqual([]);
    },
  );

  it('rejects a now-protected target during acceptance without persisting the proposed membership', async () => {
    const f = await fixture(true);
    const review = await f.review();
    f.servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
    const response = await f.accept(review.json().review_token);
    expect(response.statusCode).toBe(400);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.links()).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    expect(f.writes).toEqual([]);
  });
});
