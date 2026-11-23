import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { get } from 'node:http';
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
    expect((await app.inject({ url: '/api/jobs', headers })).json()).toEqual({
      jobs: [],
      total: 0,
      overall: 0,
      active: 0,
    });
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

it('pages and filters projected activity, with a bounded idle feed and full diagnostics only on demand', async () => {
  const { app, headers, clientFactory } = await fixture();
  for (let index = 0; index < 31; index++) {
    const job = historicalJob(
      `summary-${index.toString().padStart(2, '0')}`,
      index % 2 ? 'failed' : 'completed',
    );
    job.results[0]!.username = index % 2 ? 'Synthetic matching member' : 'Other member';
    app.jellyport.store.saveJob(job);
  }
  const page = await app.inject({
    url: '/api/jobs?limit=5&offset=5&status=failed&query=MATCHING',
    headers,
  });
  expect(page.statusCode).toBe(200);
  expect(page.json()).toMatchObject({ active: 0, total: 15, overall: 31 });
  expect(page.json().jobs.map(({ id }: Job) => id)).toEqual([
    'summary-19',
    'summary-17',
    'summary-15',
    'summary-13',
    'summary-11',
  ]);
  expect(page.body).not.toMatch(/PRIVATE-PLAYBACK-TITLE|PRIVATE-REPORT-WARNING/);
  expect((await app.inject({ url: '/api/jobs?limit=101', headers })).statusCode).toBe(422);
  const detail = await app.inject({ url: '/api/jobs/summary-19', headers });
  expect(detail.body).toContain('PRIVATE-PLAYBACK-TITLE');

  const idle = await app.inject({ url: '/api/jobs/live', headers });
  expect(idle.json()).toMatchObject({ active: [], active_count: 0, total: 31 });
  app.jellyport.store.saveJob(historicalJob('other-tab', 'queued'));
  const live = await app.inject({ url: '/api/jobs/live', headers });
  expect(live.json().active).toMatchObject([{ id: 'other-tab' }]);
  expect(live.json().revision).not.toBe(idle.json().revision);
  expect(live.json().recent).toHaveLength(6);
  expect(live.body).not.toContain('PRIVATE-PLAYBACK-TITLE');
  expect(clientFactory).not.toHaveBeenCalled();

  const overview = await app.inject({ url: '/api/overview', headers });
  expect(overview.json().recent_jobs).toHaveLength(6);
  expect(overview.body).not.toContain('PRIVATE-PLAYBACK-TITLE');
  await app.inject({ url: '/api/overview', headers });
  expect(clientFactory).toHaveBeenCalledTimes(1);
  await app.inject({ url: '/api/overview?fresh=1', headers });
  expect(clientFactory).toHaveBeenCalledTimes(2);
});

it('reports missing imports, retained delivery uncertainty, and session-scoped reveal availability', async () => {
  const { app, headers, signIn } = await fixture();
  const { store, service } = app.jellyport;
  store.saveSettings({ ...store.settings(), bot_message_retention_days: 0 });
  const job = historicalJob('pending-synthetic-delivery');
  store.saveJob(job);
  store.saveCredentials(
    job.id,
    'Synthetic account',
    'PRIVATE-REVEAL-CREDENTIAL',
    'https://jellyfin.example',
  );
  store.saveBotMessage(job.id, {
    id: 'old-uncertain-delivery',
    kind: 'credentials',
    status: 'uncertain',
    recipient_id: '100000',
    membership_slot: 1,
    account_username: 'Synthetic account',
    content: 'PRIVATE-DISCORD-DELIVERY',
    created_at: '2020-01-01T00:00:00Z',
  });
  const imported = '2026-11-17T01:00:00Z';
  const next = '2026-11-19T01:00:00Z';
  const destination = await service.destinationSnapshots.status();
  vi.spyOn(service.destinationSnapshots, 'status').mockResolvedValue({
    ...destination,
    configured: true,
    available: true,
    usable: false,
    last_successful_at: imported,
    next_run_at: next,
  });
  const inspect = (credentials = headers) =>
    app.inject({ url: '/api/overview', headers: credentials });
  const first = await inspect();
  expect(first.json().inbox).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        repair: 'jellyfin_history',
        attention: true,
        last_successful_at: imported,
        next_run_at: next,
      }),
      expect.objectContaining({ title: 'Check credential delivery', job_id: job.id }),
      expect.objectContaining({
        title: 'Credentials await delivery',
        detail: expect.stringContaining('available to reveal in this session'),
      }),
    ]),
  );
  const claim = await app.inject({
    method: 'POST',
    url: `/api/jobs/${job.id}/credentials`,
    headers,
    payload: { recoverable: true },
  });
  expect(claim.json().credentials).toHaveLength(1);
  const otherLogin = await signIn();
  const cookie = otherLogin.cookies[0]!;
  const other = {
    ...headers,
    cookie: `${cookie.name}=${cookie.value}`,
    'x-csrf-token': otherLogin.json().csrf_token as string,
  };
  const otherInbox = await inspect(other);
  expect(otherInbox.json().inbox).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: 'Credential reveal claimed',
        detail: '1 claimed in another session.',
        job_id: job.id,
      }),
    ]),
  );
  const ownReport = await app.inject({ url: `/api/jobs/${job.id}`, headers });
  const otherReport = await app.inject({ url: `/api/jobs/${job.id}`, headers: other });
  expect(ownReport.json().credential_availability).toEqual({ available: 1, claimed_elsewhere: 0 });
  expect(otherReport.json().credential_availability).toEqual({
    available: 0,
    claimed_elsewhere: 1,
  });
  expect(first.body + otherInbox.body + ownReport.body + otherReport.body).not.toMatch(
    /PRIVATE-(REVEAL|DISCORD)/,
  );
});

it('refreshes inbox status from local evidence and newer server observations without media probes', async () => {
  const { app, headers, clientFactory } = await fixture();
  const { service } = app.jellyport;
  const pathname = '/api/overview/inbox';
  expect(
    (await app.inject({ url: pathname, headers: { host: 'jellyport.example' } })).statusCode,
  ).toBe(401);

  let present = true;
  let serverId = 'synthetic-jellyfin';
  const reads = { systemInfo: 0, users: 0 };
  service.clientFactory = (...args) => {
    const client = clientFactory(...args);
    const users = client.users.bind(client);
    client.systemInfo = async () => {
      reads.systemInfo++;
      return { Id: serverId };
    };
    client.users = async () => {
      reads.users++;
      return users();
    };
    return client;
  };
  const destination = await service.destinationSnapshots.status();
  const status = vi
    .spyOn(service.destinationSnapshots, 'status')
    .mockImplementation(async (observed) => ({
      ...destination,
      configured: true,
      available: true,
      usable: present && observed?.id === 'synthetic-jellyfin',
    }));
  const inspect = async (attention: boolean) => {
    const result = await app.inject({ url: pathname, headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).not.toHaveProperty('connections');
    expect(result.json().inbox).toContainEqual(
      expect.objectContaining({
        repair: 'jellyfin_history',
        attention,
      }),
    );
  };
  expect((await app.inject({ url: '/api/overview', headers })).statusCode).toBe(200);
  clientFactory.mockClear();
  await inspect(false);
  present = false;
  await inspect(true);
  expect(clientFactory).not.toHaveBeenCalled();
  expect(reads).toEqual({ systemInfo: 1, users: 1 });

  present = true;
  serverId = 'replacement-jellyfin';
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/workflow-readiness/refresh',
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  clientFactory.mockClear();
  await inspect(true);
  expect(clientFactory).not.toHaveBeenCalled();
  expect(reads).toEqual({ systemInfo: 2, users: 1 });
  expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'replacement-jellyfin' }));
});

it('observes retained catalog providers at most once per five minutes without delaying inbox replies', async () => {
  const { app, headers, clientFactory } = await fixture();
  const { store, service } = app.jellyport;
  store.saveSettings({
    ...store.settings(),
    emby_url: 'https://emby.example',
    emby_api_key: 'SYNTHETIC-EMBY-KEY',
  });
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let replaced = false;
  const reads = {
    emby: { systemInfo: 0, users: 0 },
    jellyfin: { systemInfo: 0, users: 0 },
  };
  service.clientFactory = (...args) => {
    const client = clientFactory(...args);
    const kind = args[2] ?? 'jellyfin';
    const users = client.users.bind(client);
    client.systemInfo = async (options) => {
      reads[kind].systemInfo++;
      if (replaced) {
        expect(options).toMatchObject({ retry: false, signal: expect.any(AbortSignal) });
        await stalled;
      }
      return { Id: `${replaced ? 'replacement' : 'synthetic'}-${kind}` };
    };
    client.users = async () => {
      reads[kind].users++;
      return users();
    };
    return client;
  };
  const source = await service.sourceSnapshots.status();
  const target = await service.destinationSnapshots.status();
  const saved = {
    configured: true,
    available: true,
    last_successful_at: new Date(time - 60_000).toISOString(),
  };
  vi.spyOn(service.sourceSnapshots, 'status').mockImplementation(async (observed) => ({
    ...source,
    ...saved,
    usable: observed?.id === 'synthetic-emby',
  }));
  vi.spyOn(service.destinationSnapshots, 'status').mockImplementation(async (observed) => ({
    ...target,
    ...saved,
    usable: observed?.id === 'synthetic-jellyfin',
  }));
  const inbox = () => app.inject({ url: '/api/overview/inbox', headers });
  const catalogStates = (response: Awaited<ReturnType<typeof inbox>>) =>
    response
      .json()
      .inbox.filter(({ repair }: { repair: string }) =>
        ['emby_history', 'jellyfin_history'].includes(repair),
      )
      .map(({ attention }: { attention: boolean }) => attention);
  expect((await app.inject({ url: '/api/overview', headers })).statusCode).toBe(200);
  time += 299_999;
  expect(catalogStates(await inbox())).toEqual([false, false]);
  expect(reads).toEqual({
    emby: { systemInfo: 1, users: 1 },
    jellyfin: { systemInfo: 1, users: 1 },
  });
  time++;
  replaced = true;
  try {
    // Both replies must finish while the upstream checks are still stalled.
    expect(catalogStates(await inbox())).toEqual([false, false]);
    expect(catalogStates(await inbox())).toEqual([false, false]);
    expect(reads).toEqual({
      emby: { systemInfo: 2, users: 1 },
      jellyfin: { systemInfo: 2, users: 1 },
    });
  } finally {
    release();
  }
  await vi.waitFor(async () => expect(catalogStates(await inbox())).toEqual([true, true]));
  expect(reads).toEqual({
    emby: { systemInfo: 2, users: 1 },
    jellyfin: { systemInfo: 2, users: 1 },
  });
});

it.each([
  ['/api/jobs/live', 'active'],
  ['/api/overview/inbox', 'inbox'],
])(
  'revalidates Jellyfin authority on every %s read and rejects a revoked session',
  async (url, privateField) => {
    const { app, headers, authClient, revoke } = await fixture();
    vi.mocked(authClient.validateSession).mockClear();
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    expect(authClient.validateSession).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(authClient.validateSession)
        .mock.calls.every((call) => call[4] instanceof AbortSignal),
    ).toBe(true);
    revoke();
    const rejected = await app.inject({ url, headers });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).not.toHaveProperty(privateField);
    expect(authClient.validateSession).toHaveBeenCalledTimes(3);
    expect((await app.inject({ url, headers })).statusCode).toBe(401);
    expect(authClient.validateSession).toHaveBeenCalledTimes(3);
  },
);

function stallAuthorization(authClient: JellyfinAuthentication) {
  let begin!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>((resolve) => {
    begin = resolve;
  });
  let stop!: () => void;
  const pending = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new JellyfinAuthError('Jellyfin authorization paused.', 502));
  });
  vi.mocked(authClient.validateSession).mockImplementationOnce(
    async (_url, _token, _serverId, _userId, signal) => {
      begin(signal);
      signal?.addEventListener('abort', stop, { once: true });
      try {
        return await pending;
      } finally {
        signal?.removeEventListener('abort', stop);
      }
    },
  );
  return { started, stop };
}

it('ends a stalled Overview inbox authorization at the live status deadline without revoking the session', async () => {
  const { app, headers, authClient } = await fixture();
  const stalled = stallAuthorization(authClient);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = Promise.resolve(app.inject({ url: '/api/overview/inbox', headers }));
  try {
    const signal = await stalled.started;
    await vi.advanceTimersByTimeAsync(7499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const rejected = await response;
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json()).not.toHaveProperty('inbox');
  } finally {
    vi.useRealTimers();
    stalled.stop();
    await response;
  }
  expect(authClient.signOut).not.toHaveBeenCalled();
  expect((await app.inject({ url: '/api/overview/inbox', headers })).statusCode).toBe(200);
});

it('cancels a disconnected Overview inbox authorization without canceling another status request', async () => {
  const { app, headers, authClient } = await fixture();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const stalled = stallAuthorization(authClient);
  const receive = vi.fn();
  const request = get(`${address}/api/overview/inbox`, { headers, agent: false }, receive);
  request.on('error', () => {});
  const closed = new Promise<void>((resolve) => request.once('close', resolve));
  try {
    const signal = await stalled.started;
    const another = await app.inject({ url: '/api/jobs/live', headers });
    expect(another.statusCode).toBe(200);
    request.destroy();
    await closed;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(receive).not.toHaveBeenCalled();
  } finally {
    request.destroy();
    stalled.stop();
    await closed;
  }
  expect(authClient.signOut).not.toHaveBeenCalled();
  expect((await app.inject({ url: '/api/overview/inbox', headers })).statusCode).toBe(200);
});
