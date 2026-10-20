import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import type { JellyfinAuthentication } from '../server/jellyfin-auth.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

describe('private reviewed account cloning HTTP API', () => {
  let app: JellyportApp, directory: string, servers: DemoServers;
  let headers: Record<string, string>;
  const input = () => ({
    source_user_id: 'j-river',
    expected_source_username: 'river',
    accounts: [
      { username: 'child_one', family: true },
      { username: 'child_two', family: false },
    ],
  });
  async function login() {
    const session = await app.inject('/api/session');
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `${session.cookies[0]!.name}=${session.cookies[0]!.value}`,
        'x-csrf-token': session.json().csrf_token,
      },
      payload: { username: 'admin', password: 'synthetic-login-password' },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: `${response.cookies[0]!.name}=${response.cookies[0]!.value}`,
      'x-csrf-token': response.json().csrf_token as string,
    };
  }
  const post = (url: string, payload: Record<string, unknown>, requestHeaders = headers) =>
    app.inject({ method: 'POST', url, payload, headers: requestHeaders });
  async function review() {
    const response = await post('/api/accounts/clone/review', input());
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-clone-http-'));
    servers = new DemoServers();
    const identity = {
      serverId: 'demo-jellyfin',
      userId: 'synthetic-admin',
      username: 'admin',
      accessToken: 'synthetic-session-token',
    };
    const authClient: JellyfinAuthentication = {
      authenticate: async () => identity,
      validateSession: async () => identity,
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
      signOut: async () => {},
    };
    app = await createApp({
      dataDir: directory,
      demo: false,
      secureCookie: false,
      clientFactory: servers.factory,
      authClient,
    });
    const pending = app.jellyport.store.authState();
    if (pending?.kind !== 'pending') throw new Error('Expected isolated pending setup');
    app.jellyport.store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverId: identity.serverId,
        serverUrl: 'http://synthetic-jellyfin',
        apiKeyName: 'synthetic',
      },
      () => ({
        ...DEFAULT_SETTINGS,
        jellyfin_url: 'http://synthetic-jellyfin',
        jellyfin_api_key: 'synthetic-service-key',
        template_user_id: 'template',
      }),
    );
    headers = await login();
  });
  afterEach(async () => {
    await app?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(['/api/accounts/clone/review', '/api/accounts/clone', '/api/accounts/rename'])(
    'requires an authenticated session and CSRF for %s',
    async (url) => {
      expect((await post(url, {}, {})).statusCode).toBe(401);
      expect((await post(url, {}, { cookie: headers.cookie! })).statusCode).toBe(403);
      expect(
        (await post(url, {}, { ...headers, origin: 'https://untrusted.invalid' })).statusCode,
      ).toBe(403);
      expect(servers.users.jellyfin).toHaveLength(2);
    },
  );
  it('reviews without reading history or creating accounts, and returns no private source parameters', async () => {
    const create = vi.fn(),
      history = vi.fn();
    const factory = app.jellyport.service.clientFactory;
    app.jellyport.service.clientFactory = (...args) => {
      const client = factory(...args);
      client.createUser = create;
      client.clonePlayedItems = history;
      return client;
    };
    const response = await review();
    expect(response).toEqual({
      id: expect.any(String),
      source_user_id: 'j-river',
      source_username: 'river',
      accounts: input().accounts,
      warnings: expect.any(Array),
      expires_at: expect.any(String),
    });
    expect(JSON.stringify(response)).not.toMatch(
      /password|token|parameters|synthetic-service-key|userData|server_id/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/api/jobs', headers })).json().jobs).toEqual([]);
  });
  it('creates distinct accounts once and delivers credentials only through the one-time reveal endpoint', async () => {
    const source = structuredClone(servers.users.jellyfin[1]);
    const response = await post('/api/accounts/clone', { review_id: (await review()).id });
    expect(response.statusCode).toBe(202);
    const jobId = response.json().id;
    await app.jellyport.service.jobTasks.get(jobId);
    const report = await app.inject({ url: `/api/jobs/${jobId}`, headers });
    expect(report.json()).toMatchObject({
      kind: 'clone',
      status: 'completed',
      results: [
        { username: 'child_one', created: true, cloned_from_user_id: 'j-river' },
        { username: 'child_two', created: true, cloned_from_user_id: 'j-river' },
      ],
    });
    expect(report.body).not.toMatch(/password|synthetic-session-token|synthetic-service-key/);
    expect(servers.users.jellyfin.find((user) => user.Id === 'j-river')).toEqual(source);
    expect(servers.played['j-river']).toEqual(new Set(['1']));
    const credentials = (await post(`/api/jobs/${jobId}/credentials`, {})).json().credentials;
    expect(credentials).toHaveLength(2);
    expect(new Set(credentials.map((row: { password: string }) => row.password)).size).toBe(2);
    expect((await post(`/api/jobs/${jobId}/credentials`, {})).json().credentials).toEqual([]);
  });
  it('binds reviews to their administrator session and rejects replay after acceptance', async () => {
    const reviewed = await review();
    const other = await login();
    expect((await post('/api/accounts/clone', { review_id: reviewed.id }, other)).statusCode).toBe(
      400,
    );
    const accepted = await post('/api/accounts/clone', { review_id: reviewed.id });
    expect(accepted.statusCode).toBe(202);
    expect((await post('/api/accounts/clone', { review_id: reviewed.id })).statusCode).toBe(400);
    await app.jellyport.service.jobTasks.get(accepted.json().id);
    expect(servers.users.jellyfin).toHaveLength(4);
  });
  it('invalidates a reviewed source when settings change', async () => {
    const reviewed = await review();
    app.jellyport.store.saveSettings({
      ...app.jellyport.store.settings(),
      template_user_id: 'j-river',
    });
    expect((await post('/api/accounts/clone', { review_id: reviewed.id })).statusCode).toBe(400);
    expect(servers.users.jellyfin).toHaveLength(2);
  });
  it('expires a review after ten minutes without keeping a background job', async () => {
    const reviewed = await review();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(reviewed.expires_at) + 1);
    try {
      expect((await post('/api/accounts/clone', { review_id: reviewed.id })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/jobs', headers })).json().jobs).toEqual([]);
      expect(servers.users.jellyfin).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('replaces the previous review for the same administrator session', async () => {
    const old = await review();
    const latest = await review();
    expect(old.id).not.toBe(latest.id);
    expect((await post('/api/accounts/clone', { review_id: old.id })).statusCode).toBe(400);
    const accepted = await post('/api/accounts/clone', { review_id: latest.id });
    expect(accepted.statusCode).toBe(202);
    await app.jellyport.service.jobTasks.get(accepted.json().id);
    expect(servers.users.jellyfin).toHaveLength(4);
  });
  it.each([
    {
      ...input(),
      accounts: [{ username: 'child_one', family: true, policy: { IsAdministrator: true } }],
    },
    { ...input(), accounts: [] },
    {
      ...input(),
      accounts: Array.from({ length: 11 }, (_, i) => ({ username: `child_${i}`, family: true })),
    },
    { ...input(), parameters: { policy: { EnableAllFolders: true } } },
  ])('rejects unsupported client review fields and invalid account counts', async (payload) => {
    expect((await post('/api/accounts/clone/review', payload)).statusCode).toBe(422);
    expect(servers.users.jellyfin).toHaveLength(2);
  });
  it('accepts only the server-held review ID, with no client destination or policy replacement', async () => {
    const reviewed = await review();
    expect(
      (
        await post('/api/accounts/clone', {
          review_id: reviewed.id,
          accounts: [{ username: 'intruder', family: true }],
        })
      ).statusCode,
    ).toBe(422);
    expect(servers.users.jellyfin).toHaveLength(2);
  });
  it('drops private reviews on logout', async () => {
    const reviewed = await review();
    expect((await post('/api/logout', {})).statusCode).toBe(200);
    headers = await login();
    expect((await post('/api/accounts/clone', { review_id: reviewed.id })).statusCode).toBe(400);
    expect(servers.users.jellyfin).toHaveLength(2);
  });
  it('renames the exact source account without replacing preferences or modifying history', async () => {
    servers.users.jellyfin[1]!.Configuration = {
      SubtitleMode: 'Smart',
      RememberSubtitleSelections: true,
    };
    const source = structuredClone(servers.users.jellyfin[1]);
    const response = await post('/api/accounts/rename', {
      user_id: 'j-river',
      expected_username: 'river',
      username: 'child_three',
    });
    expect(response.statusCode).toBe(200);
    expect(servers.users.jellyfin[1]).toEqual({ ...source, Name: 'child_three' });
    expect(servers.played['j-river']).toEqual(new Set(['1']));
    expect(
      (
        await post('/api/accounts/rename', {
          user_id: 'j-river',
          expected_username: 'river',
          username: 'child_four',
        })
      ).statusCode,
    ).toBe(400);
    expect(servers.users.jellyfin[1]!.Name).toBe('child_three');
  });
  it('offers private exact-ID confirmation after a lost rename readback, without repeating the rename', async () => {
    let blockReadback = false,
      writes = 0;
    const factory = app.jellyport.service.clientFactory;
    app.jellyport.service.clientFactory = (...args) => {
      const client = factory(...args);
      const rename = client.renameUser!.bind(client),
        user = client.user.bind(client);
      client.renameUser = async (...values) => {
        writes++;
        await rename(...values);
        blockReadback = true;
      };
      client.user = async (id) => {
        if (blockReadback) throw new MediaError('Synthetic unavailable readback');
        return user(id);
      };
      return client;
    };
    const request = { user_id: 'j-river', expected_username: 'river', username: 'child_three' };
    expect((await post('/api/accounts/rename', request)).statusCode).toBe(400);
    blockReadback = false;
    const url = '/api/accounts/rename/recovery?user_id=j-river';
    expect((await app.inject(url)).statusCode).toBe(401);
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pending: { ...request, can_confirm: true } });
    expect(response.body).not.toMatch(/configuration|hash|password|token/);
    expect((await post('/api/accounts/rename', request)).statusCode).toBe(200);
    expect(writes).toBe(1);
    expect((await app.inject({ url, headers })).json()).toEqual({ pending: null });
  });
});
