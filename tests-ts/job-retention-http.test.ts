import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';
import { createApp, type JellyportApp } from '../server/main.js';
import { Service, type Job } from '../server/service.js';
import { Store } from '../server/store.js';

const resources: Array<{ app: JellyportApp; directory: string; closed: boolean }> = [];
const retentionUrl = '/api/jobs/retention';

afterEach(async () => {
  try {
    for (const resource of resources.splice(0)) {
      if (!resource.closed) await resource.app.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

async function fixture(demo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-job-retention-http-'));
  const servers = new DemoServers();
  const clientFactory = vi.fn(servers.factory);
  const identity = {
    serverId: 'synthetic-jellyfin',
    userId: 'synthetic-administrator',
    username: 'admin',
    accessToken: 'PRIVATE-INTERACTIVE-SESSION',
  };
  let authorized = true;
  const authClient: JellyfinAuthentication = {
    authenticate: vi.fn(async (_url, username) => {
      if (username !== 'admin')
        throw new JellyfinAuthError('An enabled administrator account is required.', 403);
      return identity;
    }),
    validateSession: vi.fn(async () => {
      if (!authorized) throw new JellyfinAuthError('Administrator access revoked.', 403);
      return identity;
    }),
    signOut: vi.fn(async () => {}),
    validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'fixture-key' }),
  };
  const app = await createApp({
    dataDir: directory,
    demo,
    demoPassword: 'PRIVATE-ADMIN-PASSWORD',
    authClient,
    clientFactory,
    allowedHosts: ['jellyport.example'],
  });
  const resource = { app, directory, closed: false };
  resources.push(resource);
  if (!demo) {
    const pending = app.jellyport.store.authState();
    if (pending?.kind !== 'pending') throw new Error('Expected isolated first-time fixture.');
    app.jellyport.store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example',
        serverId: identity.serverId,
        apiKeyName: 'fixture-key',
      },
      (settings) => ({
        ...settings,
        jellyfin_url: 'https://jellyfin.example',
        jellyfin_api_key: 'PRIVATE-MANAGED-API-KEY',
      }),
    );
  }
  async function signIn(username = 'admin') {
    const anonymous = await app.inject({
      url: '/api/session',
      headers: { host: 'jellyport.example' },
    });
    const cookie = anonymous.cookies[0]!;
    return app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        host: 'jellyport.example',
        cookie: `${cookie.name}=${cookie.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username, password: 'PRIVATE-ADMIN-PASSWORD' },
    });
  }
  const login = await signIn();
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies[0]!;
  const headers = {
    host: 'jellyport.example',
    cookie: `${cookie.name}=${cookie.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  clientFactory.mockClear();
  return {
    app,
    directory,
    headers,
    authClient,
    clientFactory,
    servers,
    signIn,
    revoke: () => {
      authorized = false;
    },
    close: async () => {
      await app.close();
      resource.closed = true;
    },
  };
}

function oldReport(): Job {
  return {
    id: 'old-private-report',
    kind: 'migrate',
    status: 'completed',
    created_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-02T00:00:00.000Z',
    finished_at: '2000-01-02T00:00:00.000Z',
    progress: { processed: 1, total: 1 },
    results: [
      {
        username: 'PRIVATE-ACCOUNT-NAME',
        status: 'completed',
        unmatched_items: [{ id: 'private-item', name: 'PRIVATE-PLAYBACK-TITLE', type: 'Movie' }],
      },
    ],
  };
}

describe('administrator activity retention HTTP endpoints', () => {
  it('returns only policy and aggregate worker status without exposing reports or credentials', async () => {
    const { app, headers, clientFactory } = await fixture();
    const report = oldReport();
    app.jellyport.store.saveJob(report);
    app.jellyport.store.saveCredentials(
      report.id,
      'PRIVATE-CREDENTIAL-USER',
      'PRIVATE-PENDING-PASSWORD',
      'https://jellyfin.example',
    );
    const response = await app.inject({ url: retentionUrl, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      retention_days: 0,
      interval_seconds: 60,
      batch_limit: 100,
      last_run_at: null,
      last_removed: 0,
      last_kept: 0,
      error: null,
    });
    expect(response.body).not.toMatch(
      /PRIVATE-|username|results|password|token|old-private-report|unmatched_items/,
    );
    expect(app.jellyport.store.job(report.id)).toEqual(report);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('denies anonymous, nonadministrator and revoked sessions for status and policy changes', async () => {
    const { app, headers, authClient, signIn, revoke, clientFactory } = await fixture();
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: retentionUrl,
        headers: { host: headers.host },
        ...(method === 'PUT' ? { payload: { retention_days: 7 } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE-');
    }
    expect((await signIn('ordinary-member')).statusCode).toBe(403);
    revoke();
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: retentionUrl,
        headers,
        ...(method === 'PUT' ? { payload: { retention_days: 7 } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE-');
    }
    expect(authClient.validateSession).toHaveBeenCalled();
    expect(authClient.signOut).toHaveBeenCalled();
    expect(app.jellyport.service.jobRetentionStatus().retention_days).toBe(0);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects invalid CSRF, untrusted hosts and cross-site access before changing the policy', async () => {
    const { app, headers, clientFactory } = await fixture();
    for (const invalid of [
      { host: headers.host, cookie: headers.cookie },
      { ...headers, 'x-csrf-token': 'wrong-token' },
      { ...headers, host: 'attacker.example' },
      { ...headers, origin: 'https://attacker.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: retentionUrl,
        headers: invalid,
        payload: { retention_days: 7 },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const invalid of [
      { ...headers, host: 'attacker.example' },
      { ...headers, origin: 'https://attacker.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await app.inject({ url: retentionUrl, headers: invalid });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(app.jellyport.service.jobRetentionStatus().retention_days).toBe(0);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects coerced, missing, out-of-range and unknown fields without changing persisted policy', async () => {
    const { app, headers, clientFactory } = await fixture();
    const before = app.jellyport.store.settings();
    for (const payload of [
      {},
      { retention_days: null },
      { retention_days: '30' },
      { retention_days: true },
      { retention_days: -1 },
      { retention_days: 3651 },
      { retention_days: 1.5 },
      { retention_days: [30] },
      { retention_days: 30, api_key: 'PRIVATE-SUBMITTED-KEY' },
      { activity_retention_days: 30 },
    ]) {
      const response = await app.inject({ method: 'PUT', url: retentionUrl, headers, payload });
      expect(response.statusCode).toBe(422);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE-');
      expect(app.jellyport.store.settings()).toEqual(before);
      expect(app.jellyport.service.jobRetentionStatus().retention_days).toBe(0);
    }
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('persists only the independent policy, accepts its boundaries and never runs cleanup inline', async () => {
    const { app, headers, directory, close, clientFactory, servers } = await fixture();
    const { store, service, bot } = app.jellyport;
    const report = oldReport();
    store.saveJob(report);
    store.saveSettings({
      ...store.settings(),
      emby_url: 'https://emby.example',
      emby_api_key: 'PRIVATE-EMBY-KEY',
      discord_bot_token: 'PRIVATE-BOT-TOKEN',
    });
    const before = store.settings();
    const usersBefore = structuredClone(servers.users);
    const playedBefore = structuredClone(servers.played);
    const worker = vi.spyOn(service, 'runJobRetention');
    const restartBot = vi.spyOn(bot, 'restart');
    for (const retention_days of [1, 3650, 0, 30]) {
      const response = await app.inject({
        method: 'PUT',
        url: retentionUrl,
        headers: { ...headers, origin: 'https://jellyport.example' },
        payload: { retention_days },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        retention_days,
        last_run_at: null,
        last_removed: 0,
        last_kept: 0,
      });
      expect(response.body).not.toMatch(/PRIVATE-|username|results|password|token/);
      expect(store.settings()).toEqual(before);
      expect(store.job(report.id)).toEqual(report);
    }
    expect(worker).not.toHaveBeenCalled();
    expect(restartBot).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(servers.users).toEqual(usersBefore);
    expect(servers.played).toEqual(playedBefore);
    await close();
    const reopened = new Store(directory);
    const reopenedService = new Service(reopened, { clientFactory });
    try {
      expect(reopenedService.jobRetentionStatus().retention_days).toBe(30);
      expect(reopened.settings()).toEqual(before);
      expect(reopened.job(report.id)).toEqual(report);
    } finally {
      await reopenedService.stop();
      reopened.close();
    }
  });

  it('keeps general Settings saves independent of retention and rejects unknown policy fields', async () => {
    const { app, headers } = await fixture();
    const saved = await app.inject({
      method: 'PUT',
      url: retentionUrl,
      headers,
      payload: { retention_days: 30 },
    });
    expect(saved.statusCode).toBe(200);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { jellyfin_public_url: 'https://watch.example' },
    });
    expect(response.statusCode).toBe(200);
    expect(app.jellyport.store.settings()).toMatchObject({
      jellyfin_public_url: 'https://watch.example',
    });
    expect(app.jellyport.store.settings()).not.toHaveProperty('activity_retention_days');
    expect(app.jellyport.service.jobRetentionStatus().retention_days).toBe(30);
    for (const activity_retention_days of [0, '30', null, true, -1, 3651, 1.5]) {
      const rejected = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: { activity_retention_days },
      });
      expect(rejected.statusCode).toBe(400);
      expect(app.jellyport.service.jobRetentionStatus().retention_days).toBe(30);
    }
  });

  it('keeps demo policy readable and refuses retention mutation', async () => {
    const { app, headers, clientFactory } = await fixture(true);
    const worker = vi.spyOn(app.jellyport.service, 'runJobRetention');
    const initial = await app.inject({ url: retentionUrl, headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ retention_days: 0 });
    const rejected = await app.inject({
      method: 'PUT',
      url: retentionUrl,
      headers,
      payload: { retention_days: 30 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.headers['cache-control']).toBe('no-store');
    expect(app.jellyport.service.jobRetentionStatus().retention_days).toBe(0);
    expect(worker).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('runs the bounded worker on its sixty-second timer and stops that timer before store close', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { app, headers, close, clientFactory } = await fixture();
    const { store, service } = app.jellyport;
    const worker = vi.spyOn(service, 'runJobRetention');
    const report = oldReport();
    store.saveJob(report);
    const saved = await app.inject({
      method: 'PUT',
      url: retentionUrl,
      headers,
      payload: { retention_days: 30 },
    });
    expect(saved.statusCode).toBe(200);
    expect(worker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(worker).not.toHaveBeenCalled();
    expect(store.job(report.id)).toEqual(report);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(store.job(report.id)).toBeNull();
    const status = await app.inject({ url: retentionUrl, headers });
    expect(status.json()).toMatchObject({
      retention_days: 30,
      last_removed: 1,
      last_kept: 0,
      last_run_at: expect.any(String),
      error: null,
    });
    expect(status.body).not.toMatch(/PRIVATE-|old-private-report/);
    await close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('never runs scheduled retention for a demonstration or an unpaired installation', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const demo = await fixture(true);
    const demoWorker = vi.spyOn(demo.app.jellyport.service, 'runJobRetention');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demoWorker).not.toHaveBeenCalled();
    await demo.close();
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-unpaired-retention-http-'));
    const app = await createApp({ dataDir: directory });
    resources.push({ app, directory, closed: false });
    expect(app.jellyport.store.authState()?.kind).toBe('pending');
    const unpairedWorker = vi.spyOn(app.jellyport.service, 'runJobRetention');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unpairedWorker).not.toHaveBeenCalled();
  });
});
