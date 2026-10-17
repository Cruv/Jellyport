import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';
import { createApp, type JellyportApp } from '../server/main.js';
import type { Job } from '../server/service.js';

const resources: Array<{ app: JellyportApp; directory: string }> = [];
const cleanupUrl = '/api/jobs/cleanup';

afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-job-history-http-'));
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
    authClient,
    clientFactory,
    allowedHosts: ['jellyport.example'],
  });
  resources.push({ app, directory });
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
    servers,
    headers,
    authClient,
    clientFactory,
    signIn,
    revoke: () => {
      authorized = false;
    },
  };
}

function historicalJob(id: string, status = 'completed'): Job {
  return {
    id,
    kind: 'migration',
    status,
    created_at: '2026-10-01T12:00:00.000Z',
    updated_at: '2026-10-01T12:01:00.000Z',
    finished_at: '2026-10-01T12:01:00.000Z',
    progress: { processed: 1, total: 1 },
    results: [
      {
        username: 'PRIVATE-ACCOUNT-NAME',
        status: status === 'failed' ? 'failed' : 'completed',
        unmatched_items: [{ id: 'private-item', name: 'PRIVATE-PLAYBACK-TITLE', type: 'Movie' }],
        warnings: ['PRIVATE-REPORT-WARNING'],
      },
    ],
  };
}

describe('administrator activity cleanup HTTP endpoint', () => {
  it('requires a current administrator session and never exposes reports to rejected callers', async () => {
    const { app, headers, authClient, signIn, revoke, clientFactory } = await fixture();
    const job = historicalJob('private-report');
    app.jellyport.store.saveJob(job);
    const anonymous = await app.inject({
      method: 'POST',
      url: cleanupUrl,
      headers: { host: headers.host },
      payload: { job_ids: [job.id] },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect((await signIn('ordinary-member')).statusCode).toBe(403);
    expect(app.jellyport.store.job(job.id)).toEqual(job);
    revoke();
    const revoked = await app.inject({
      method: 'POST',
      url: cleanupUrl,
      headers,
      payload: { job_ids: [job.id] },
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.headers['cache-control']).toBe('no-store');
    expect(authClient.validateSession).toHaveBeenCalled();
    expect(authClient.signOut).toHaveBeenCalled();
    expect(app.jellyport.store.job(job.id)).toEqual(job);
    expect(clientFactory).not.toHaveBeenCalled();
    for (const response of [anonymous, revoked])
      expect(response.body).not.toMatch(/PRIVATE-|private-report/);
  });

  it('rejects missing or invalid CSRF, untrusted hosts and cross-site requests before deletion', async () => {
    const { app, headers, clientFactory } = await fixture();
    const job = historicalJob('protected-report');
    app.jellyport.store.saveJob(job);
    for (const invalid of [
      { host: headers.host, cookie: headers.cookie },
      { ...headers, 'x-csrf-token': 'wrong-token' },
      { ...headers, host: 'attacker.example' },
      { ...headers, origin: 'https://attacker.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: cleanupUrl,
        headers: invalid,
        payload: { job_ids: [job.id] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE-');
      expect(app.jellyport.store.job(job.id)).toEqual(job);
    }
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects coerced, duplicate, excessive and unknown request fields without deleting any records', async () => {
    const { app, headers, clientFactory } = await fixture();
    const job = historicalJob('kept-report');
    app.jellyport.store.saveJob(job);
    for (const payload of [
      {},
      { job_ids: [] },
      { job_ids: null },
      { job_ids: job.id },
      { job_ids: [1] },
      { job_ids: [''] },
      { job_ids: ['x'.repeat(129)] },
      { job_ids: [job.id, job.id] },
      { job_ids: Array.from({ length: 1001 }, (_, index) => `job-${index}`) },
      { job_ids: [job.id], api_key: 'PRIVATE-SUBMITTED-KEY' },
    ]) {
      const response = await app.inject({ method: 'POST', url: cleanupUrl, headers, payload });
      expect(response.statusCode).toBe(422);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toMatch(/PRIVATE-|PRIVATE-SUBMITTED-KEY/);
      expect(app.jellyport.store.job(job.id)).toEqual(job);
    }
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('clears old reports locally while preserving accounts, recovery secrets, links and played state', async () => {
    const { app, servers, headers, clientFactory } = await fixture();
    const { store } = app.jellyport;
    const completed = historicalJob('completed-report');
    const failed = historicalJob('failed-report', 'failed');
    store.saveJob(completed);
    store.saveJob(failed);
    store.saveAccount('recovery-user', 'j-river', 'provisioning', 'PRIVATE-RECOVERY-PASSWORD');
    store.saveLink('123456789', 'recovery-user', 'j-river');
    store.savePlaylistImport('playlist-ledger', {
      name: 'PRIVATE-PLAYLIST',
      targetId: 'playlist-id',
      status: 'complete',
    });
    const accountBefore = store.account('recovery-user');
    const settingsBefore = store.settings();
    const linksBefore = store.links();
    const authBefore = store.authState();
    const usersBefore = structuredClone(servers.users);
    const playedBefore = structuredClone(servers.played);
    const response = await app.inject({
      method: 'POST',
      url: cleanupUrl,
      headers: { ...headers, origin: 'https://jellyport.example' },
      payload: { job_ids: [completed.id, failed.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ removed_ids: [completed.id, failed.id], skipped: [] });
    expect(response.body).not.toMatch(/PRIVATE-|username|results|password|token|unmatched_items/);
    expect(store.jobs()).toEqual([]);
    expect((await app.inject({ url: '/api/jobs', headers })).json()).toEqual({ jobs: [] });
    const removedReport = await app.inject({ url: `/api/jobs/${completed.id}`, headers });
    expect(removedReport.statusCode).toBe(400);
    expect(removedReport.body).not.toContain('PRIVATE-');
    expect(store.settings()).toEqual(settingsBefore);
    expect(store.authState()).toEqual(authBefore);
    expect(store.account('recovery-user')).toEqual(accountBefore);
    expect(store.accountPassword(store.account('recovery-user')!)).toBe(
      'PRIVATE-RECOVERY-PASSWORD',
    );
    expect(store.links()).toEqual(linksBefore);
    expect(store.playlistImport('playlist-ledger')).toEqual({
      name: 'PRIVATE-PLAYLIST',
      targetId: 'playlist-id',
      status: 'complete',
    });
    expect(servers.users).toEqual(usersBefore);
    expect(servers.played).toEqual(playedBefore);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('skips active jobs and unclaimed credentials while allowing terminal reports in the same request', async () => {
    const { app, headers, clientFactory } = await fixture();
    const { store } = app.jellyport;
    const queued = historicalJob('queued-job', 'queued');
    const running = historicalJob('running-job', 'running');
    const pendingCredentials = historicalJob('credentials-job');
    const done = historicalJob('done-job');
    store.saveQueuedJob(queued, [], store.settings());
    store.saveJob(running);
    store.saveJob(pendingCredentials);
    store.saveJob(done);
    store.saveCredentials(
      pendingCredentials.id,
      'PRIVATE-CREDENTIAL-USER',
      'PRIVATE-PENDING-PASSWORD',
      'https://jellyfin.example',
    );
    const response = await app.inject({
      method: 'POST',
      url: cleanupUrl,
      headers,
      payload: { job_ids: [queued.id, running.id, pendingCredentials.id, done.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ removed_ids: [done.id] });
    expect(response.json().skipped).toEqual([
      { id: queued.id, reason: 'not_finished' },
      { id: running.id, reason: 'not_finished' },
      { id: pendingCredentials.id, reason: 'pending_credentials' },
    ]);
    for (const skipped of response.json().skipped) {
      expect(Object.keys(skipped).sort()).toEqual(['id', 'reason']);
      expect(skipped.reason).toEqual(expect.any(String));
    }
    expect(response.body).not.toMatch(/PRIVATE-|username|results|password|token|unmatched_items/);
    expect(store.job(queued.id)).toEqual(queued);
    expect(store.queuedJobs().map((value) => value.job.id)).toEqual([queued.id]);
    expect(store.job(running.id)).toEqual(running);
    expect(store.job(pendingCredentials.id)).toEqual(pendingCredentials);
    expect(store.job(done.id)).toBeNull();
    expect(store.takeCredentials(pendingCredentials.id)).toEqual([
      {
        username: 'PRIVATE-CREDENTIAL-USER',
        password: 'PRIVATE-PENDING-PASSWORD',
        server_url: 'https://jellyfin.example',
      },
    ]);
    const afterReveal = await app.inject({
      method: 'POST',
      url: cleanupUrl,
      headers,
      payload: { job_ids: [pendingCredentials.id] },
    });
    expect(afterReveal.statusCode).toBe(200);
    expect(afterReveal.json()).toEqual({ removed_ids: [pendingCredentials.id], skipped: [] });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('handles repeated cleanup and missing IDs without touching unrelated reports', async () => {
    const { app, headers, clientFactory } = await fixture();
    const { store } = app.jellyport;
    const selected = historicalJob('selected-report');
    const unselected = historicalJob('unselected-report');
    store.saveJob(selected);
    store.saveJob(unselected);
    const payload = { job_ids: [selected.id, 'missing-report'] };
    const first = await app.inject({ method: 'POST', url: cleanupUrl, headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      removed_ids: [selected.id],
      skipped: [{ id: 'missing-report', reason: 'not_found' }],
    });
    const again = await app.inject({ method: 'POST', url: cleanupUrl, headers, payload });
    expect(again.statusCode).toBe(200);
    expect(again.headers['cache-control']).toBe('no-store');
    expect(again.json()).toMatchObject({
      removed_ids: [],
      skipped: [
        { id: selected.id, reason: 'not_found' },
        { id: 'missing-report', reason: 'not_found' },
      ],
    });
    expect(store.jobs()).toEqual([unselected]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('accepts the bounded maximum batch and 128-character historical IDs', async () => {
    const { app, headers, clientFactory } = await fixture();
    const jobIds = [
      'x'.repeat(128),
      ...Array.from({ length: 999 }, (_, index) => `missing-${index}`),
    ];
    const response = await app.inject({
      method: 'POST',
      url: cleanupUrl,
      headers,
      payload: { job_ids: jobIds },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      removed_ids: [],
      skipped: jobIds.map((id) => ({ id, reason: 'not_found' })),
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
