import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type JellyportApp } from '../server/main.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';
import { DemoServers } from '../server/demo.js';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

const resources: Array<{ app: JellyportApp; directory: string }> = [];
const standaloneDirectories: string[] = [];
async function setup(demo = true) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-'));
  const identity = {
    serverId: 'test-server',
    userId: 'test-admin',
    username: 'admin',
    accessToken: 'test-token',
  };
  const authClient: JellyfinAuthentication = {
    authenticate: async (_url, username, password) => {
      if (username !== 'admin' || password !== 'testing-password-long')
        throw new JellyfinAuthError('Incorrect credentials.', 401);
      return identity;
    },
    validateSession: async () => identity,
    signOut: async () => {},
    validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'test API key' }),
  };
  const app = await createApp({
    demoPassword: 'testing-password-long',
    dataDir: directory,
    demo,
    authClient,
  });
  if (!demo) {
    const state = app.jellyport.store.authState();
    if (state?.kind !== 'pending') throw new Error('Expected fresh setup');
    app.jellyport.store.completeAuth(
      state.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example',
        serverId: identity.serverId,
        apiKeyName: 'testing',
      },
      (settings) => ({
        ...settings,
        jellyfin_url: 'https://jellyfin.example',
        jellyfin_api_key: 'service-key',
      }),
    );
  }
  resources.push({ app, directory });
  return app;
}
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
  for (const directory of standaloneDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function session(app: JellyportApp) {
  const response = await app.inject('/api/session');
  return {
    cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    csrf: response.json().csrf_token as string,
  };
}
async function login(app: JellyportApp) {
  const anonymous = await session(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'testing-password-long' },
    headers: { cookie: anonymous.cookie, 'x-csrf-token': anonymous.csrf },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    'x-csrf-token': response.json().csrf_token as string,
  };
}
async function saveSettings(
  app: JellyportApp,
  headers: Awaited<ReturnType<typeof login>>,
  changes: Record<string, unknown>,
) {
  const current = await app.inject({ url: '/api/settings', headers });
  const { field_revisions } = current.json<{ field_revisions: Record<string, string> }>();
  return app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: {
      changes,
      expected_revisions: Object.fromEntries(
        Object.keys(changes).map((key) => [key, field_revisions[key] ?? '0']),
      ),
    },
  });
}
async function readyPreview(
  app: JellyportApp,
  headers: Awaited<ReturnType<typeof login>>,
  sourceUserIds: string[] = ['e-alex'],
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: { source_user_ids: sourceUserIds },
  });
  expect(response.statusCode).toBe(202);
  const id = response.json().id as string;
  let result;
  await vi.waitFor(async () => {
    result = (await app.inject({ url: `/api/migrations/preview/${id}`, headers })).json();
    expect(result.status).toBe('ready');
  });
  return result!;
}
it('preserves authentication, CSRF, redaction, account creation and one-time credentials', async () => {
  const app = await setup();
  expect((await app.inject('/health')).statusCode).toBe(200);
  expect((await app.inject('/api/settings')).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'admin', password: 'testing-password-long' },
      })
    ).statusCode,
  ).toBe(403);
  const headers = await login(app);
  const settings = (await app.inject({ url: '/api/settings', headers })).json();
  expect(settings.emby_api_key).toBeUndefined();
  expect(settings.emby_api_key_set).toBe(true);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { cookie: headers.cookie },
        payload: { username: 'casey' },
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: { username: 'casey' },
  });
  expect(response.statusCode).toBe(202);
  const id = response.json().id as string;
  await app.jellyport.service.jobTasks.get(id);
  const result = (await app.inject({ url: `/api/jobs/${id}`, headers })).json();
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result)).not.toContain('password');
  const credentials = await app.inject({
    method: 'POST',
    url: `/api/jobs/${id}/credentials`,
    headers,
  });
  expect(credentials.json().credentials).toHaveLength(1);
  expect(
    (await app.inject({ method: 'POST', url: `/api/jobs/${id}/credentials`, headers })).json()
      .credentials,
  ).toEqual([]);
  expect((await app.inject({ method: 'POST', url: '/api/logout', headers })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/jobs', headers })).statusCode).toBe(401);
});
it('keeps demo settings read-only', async () => {
  const app = await setup();
  const headers = await login(app);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: { emby_url: 'https://real-server.example' },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().detail).toContain('read-only');
});

it('recovers a lost credential response only in the session that claimed it', async () => {
  const app = await setup();
  const [first, second] = await Promise.all([login(app), login(app)]);
  const { store } = app.jellyport;
  const timestamp = new Date().toISOString();
  for (const id of ['receipt-demo', 'expired-demo']) {
    store.saveJob({
      id,
      kind: 'create',
      status: 'completed',
      created_at: timestamp,
      updated_at: timestamp,
      progress: { processed: 1, total: 1 },
      results: [],
    });
    store.saveCredentials(id, 'sample-user', 'synthetic-receipt-secret', 'https://media.example');
  }
  const url = '/api/jobs/receipt-demo/credentials';
  const request = (headers: typeof first, path = url) =>
    app.inject({ method: 'POST', url: path, headers, payload: { recoverable: true } });
  const results = await Promise.all([request(first), request(second)]);
  expect(results.map((result) => result.json().credentials.length).sort()).toEqual([0, 1]);
  const claimedByFirst = results[0]!.json().credentials.length === 1;
  const owner = claimedByFirst ? first : second;
  const other = claimedByFirst ? second : first;
  const original = results[claimedByFirst ? 0 : 1]!;
  expect(original.headers['cache-control']).toBe('no-store');
  expect(original.json().credentials[0].password).toBe('synthetic-receipt-secret');
  expect((await app.inject({ url: '/api/session', headers: owner })).json().authenticated).toBe(
    true,
  );
  await app.inject({ method: 'DELETE', url: `${url}/receipt`, headers: other });
  expect((await request(owner)).json()).toEqual(original.json());
  expect((await request(other)).json().credentials).toEqual([]);
  expect((await app.inject({ method: 'POST', url, headers: other })).json().credentials).toEqual(
    [],
  );
  expect((await app.inject({ url: '/api/jobs/receipt-demo', headers: other })).body).not.toContain(
    'synthetic-receipt-secret',
  );
  await app.inject({ method: 'DELETE', url: `${url}/receipt`, headers: owner });
  expect((await request(owner)).json().credentials).toEqual([]);

  const expiryUrl = '/api/jobs/expired-demo/credentials';
  expect((await request(owner, expiryUrl)).json().credentials).toHaveLength(1);
  const systemTime = Date.now();
  const now = vi.spyOn(Date, 'now').mockReturnValue(systemTime + 60_000);
  try {
    expect((await request(owner, expiryUrl)).json().credentials).toHaveLength(1);
    now.mockReturnValue(systemTime + 91_000);
    expect((await request(owner, expiryUrl)).json().credentials).toEqual([]);
    expect((await request(other, expiryUrl)).json().credentials).toEqual([]);
  } finally {
    now.mockRestore();
  }
});
it('does not echo secret input in validation or malformed JSON errors', async () => {
  const app = await setup();
  const anonymous = await session(app);
  const headers = {
    cookie: anonymous.cookie,
    'x-csrf-token': anonymous.csrf,
    'content-type': 'application/json',
  };
  const secret = 's'.repeat(600);
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers,
    payload: { username: 'admin', password: secret },
  });
  expect(response.statusCode).toBe(422);
  expect(response.body).not.toContain(secret);
  const malformed = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers,
    payload: '{"password":"secret-value" broken',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('secret-value');
});
it('rate limits repeated incorrect logins and rotates the successful session', async () => {
  const app = await setup();
  const anonymous = await session(app);
  const headers = { cookie: anonymous.cookie, 'x-csrf-token': anonymous.csrf };
  for (let index = 0; index < 10; index++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers,
          payload: { username: 'admin', password: 'incorrect' },
        })
      ).statusCode,
    ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        headers,
        payload: { username: 'admin', password: 'testing-password-long' },
      })
    ).statusCode,
  ).toBe(429);
});
it('sets security headers and secure session attributes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-'));
  const app = await createApp({
    demoPassword: 'testing-password-long',
    dataDir: directory,
    demo: true,
    secureCookie: true,
  });
  resources.push({ app, directory });
  const response = await app.inject('/api/session');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['content-security-policy']).toContain("script-src 'self'");
  expect(response.headers['set-cookie']).toContain('HttpOnly');
  expect(response.headers['set-cookie']).toContain('Secure');
  expect(response.headers['set-cookie']).toContain('SameSite=Strict');
});
it('validates saved settings and preserves blank secrets without exposing them', async () => {
  const app = await setup(false);
  const headers = await login(app);
  let response = await saveSettings(app, headers, {
    emby_url: 'https://emby.example/',
    emby_api_key: 'secret-key',
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain('secret-key');
  response = await saveSettings(app, headers, { emby_api_key: '' });
  expect(response.statusCode).toBe(200);
  expect(app.jellyport.store.settings().emby_api_key).toBe('secret-key');
  expect(app.jellyport.store.settings().emby_url).toBe('https://emby.example');
  for (const payload of [
    { auto_disable: 'false' },
    { jellyfin_api_key: false },
    { invalid_setting: true },
    { jellyfin_url: 'https://user:password@example.com' },
    { path_mappings: [{ source: '', target: '/media' }] },
  ]) {
    expect((await saveSettings(app, headers, payload)).statusCode).toBe(400);
  }
});

it('merges independent settings drafts and rejects only conflicting fields from a stale tab', async () => {
  const app = await setup(false);
  const [first, second] = await Promise.all([login(app), login(app)]);
  const restart = vi.spyOn(app.jellyport.bot, 'restart');
  const get = (headers: typeof first) => app.inject({ url: '/api/settings', headers });
  const initial = (await get(first)).json().field_revisions;
  const save = (
    headers: typeof first,
    changes: Record<string, unknown>,
    revisions: Record<string, string> = initial,
  ) =>
    app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        changes,
        expected_revisions: Object.fromEntries(
          Object.keys(changes).map((key) => [key, revisions[key] ?? '0']),
        ),
      },
    });
  const responses = await Promise.all([
    save(first, { password_length: 16 }),
    save(second, { bot_message_retention_days: 45 }),
  ]);
  expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
  const result = (await get(second)).json();
  expect(result).toMatchObject({ password_length: 16, bot_message_retention_days: 45 });
  const staleClient = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: second,
    payload: { password_length: 12, bot_message_retention_days: 30 },
  });
  expect(staleClient.statusCode).toBe(400);
  expect(staleClient.json().detail).toContain('current field revisions');
  expect((await get(second)).json()).toMatchObject({
    password_length: 16,
    bot_message_retention_days: 45,
  });
  expect(result.field_revisions.bot_message_retention_days).not.toBe(
    initial.bot_message_retention_days,
  );
  const collided = await save(second, { password_length: 20, password_exclude_ambiguous: false });
  expect(collided.statusCode).toBe(409);
  expect(collided.json()).toMatchObject({
    conflicts: ['password_length'],
    field_revisions: { password_length: result.field_revisions.password_length },
  });
  expect(app.jellyport.store.settings().password_exclude_ambiguous).toBe(true);
  expect((await save(second, { password_length: 20 }, result.field_revisions)).statusCode).toBe(
    200,
  );
  expect(app.jellyport.store.settings()).toMatchObject({
    password_length: 20,
    bot_message_retention_days: 45,
  });
  expect(restart).not.toHaveBeenCalled();
});
it('validates account and migration request shapes without coercion', async () => {
  const app = await setup();
  const headers = await login(app);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers,
        payload: { username: 'casey', discord_user_id: 123456 },
      })
    ).statusCode,
  ).toBe(422);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/migrations/preview',
        headers,
        payload: { source_user_ids: ['one', 'one'] },
      })
    ).statusCode,
  ).toBe(422);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers,
        payload: { username: 'casey', extra: 'secret-value' },
      })
    ).statusCode,
  ).toBe(422);
});
it.each(['complete', 'watched_only'] as const)(
  'normalizes %s preview to watched-only while isolating asynchronous polling and cancellation by session',
  async (migrationScope) => {
    const app = await setup();
    const headers = await login(app);
    const other = await login(app);
    let signal!: AbortSignal;
    const preview = vi
      .spyOn(app.jellyport.service, 'preview')
      .mockImplementation(async (_ids, controls) => {
        signal = controls!.signal!;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
        return {
          users: [],
          mode: 'merge',
          migration_scope: 'watched_only',
          destination_server_id: 'demo-jellyfin',
        };
      });
    const response = await app.inject({
      method: 'POST',
      url: '/api/migrations/preview',
      headers,
      payload: { source_user_ids: ['e-alex'], migration_scope: migrationScope },
    });
    expect(response.statusCode).toBe(202);
    const task = response.json();
    expect(task.status).toBe('running');
    expect(task.preview).toBeUndefined();
    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith(
      ['e-alex'],
      expect.objectContaining({ migration_scope: 'watched_only' }),
    );
    const url = `/api/migrations/preview/${task.id}`;
    expect((await app.inject({ url, headers })).json().status).toBe('running');
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers: other })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url, headers: { cookie: headers.cookie } })).statusCode,
    ).toBe(403);
    expect(signal.aborted).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/logout', headers })).statusCode).toBe(
      200,
    );
    expect(signal.aborted).toBe(true);
    const next = await login(app);
    expect((await app.inject({ url, headers: next })).statusCode).toBe(404);
    expect(app.jellyport.store.jobs()).toHaveLength(0);
  },
);
it.each([
  [undefined, 'played_favorites'],
  ['played_favorites', 'played_favorites'],
  ['complete', 'watched_only'],
  ['watched_only', 'watched_only'],
] as const)(
  'normalizes incoming scope %s for asynchronous preview and queued migration',
  async (scope, expected) => {
    const app = await setup();
    const headers = await login(app);
    const preview = vi.spyOn(app.jellyport.service, 'preview').mockResolvedValue({
      users: [],
      mode: 'merge',
      migration_scope: expected,
      destination_server_id: 'demo-jellyfin',
    });
    const migrate = vi.spyOn(app.jellyport.service, 'migrateUsers').mockResolvedValue({
      id: 'fixture-job',
      kind: 'migration',
      status: 'queued',
      created_at: '2026-10-08T12:00:00.000Z',
      updated_at: '2026-10-08T12:00:00.000Z',
      progress: { processed: 0, total: 1 },
      results: [],
    });
    const payload = { source_user_ids: ['e-alex'], ...(scope ? { migration_scope: scope } : {}) };
    const started = await app.inject({
      method: 'POST',
      url: '/api/migrations/preview',
      headers,
      payload,
    });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview).toHaveBeenCalledWith(
      ['e-alex'],
      expect.objectContaining({ migration_scope: expected }),
    );
    const queued = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
    expect(queued.statusCode).toBe(202);
    expect(migrate).toHaveBeenCalledWith(
      ['e-alex'],
      undefined,
      undefined,
      expected,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  },
);
it('rejects unknown or coerced migration scopes before preview or queue work starts', async () => {
  const app = await setup();
  const headers = await login(app);
  const preview = vi.spyOn(app.jellyport.service, 'preview');
  const migrate = vi.spyOn(app.jellyport.service, 'migrateUsers');
  for (const migrationScope of ['played', 'Watched_only', '', null, true, 1]) {
    for (const url of ['/api/migrations/preview', '/api/migrations']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { source_user_ids: ['e-alex'], migration_scope: migrationScope },
      });
      expect(response.statusCode).toBe(422);
    }
  }
  expect(preview).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
  expect(app.jellyport.store.jobs()).toHaveLength(0);
});

it('passes protected-account pins only from the session-owned review and rejects client pins', async () => {
  const app = await setup();
  const headers = await login(app);
  const other = await login(app);
  const preview = await app.jellyport.service.preview(['e-alex']);
  const pin = {
    target_user_id: 'protected-destination',
    target_username: 'Existing administrator',
    server_id: 'reviewed-server',
    administrator: true,
    template: false,
    template_user_id: 'template',
  };
  vi.spyOn(app.jellyport.service, 'preview').mockResolvedValue({
    ...preview,
    users: [
      {
        ...preview.users[0]!,
        history_only: true,
        username: pin.target_username,
        target_user_id: pin.target_user_id,
        target_exists: true,
      },
    ],
    history_only_targets: { 'e-alex': pin },
  });
  const stamp = new Date().toISOString();
  const migrate = vi.spyOn(app.jellyport.service, 'migrateUsers').mockResolvedValue({
    id: 'synthetic-reviewed-job',
    kind: 'migrate',
    status: 'queued',
    created_at: stamp,
    updated_at: stamp,
    progress: { processed: 0, total: 1 },
    results: [],
  });
  const review = await readyPreview(app, headers);
  const payload = { source_user_ids: ['e-alex'], preview_id: review.id };
  expect(
    (await app.inject({ method: 'POST', url: '/api/migrations', headers: other, payload }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/migrations',
        headers,
        payload: {
          ...payload,
          history_only_targets: { 'e-alex': { ...pin, target_user_id: 'client-forged' } },
        },
      })
    ).statusCode,
  ).toBe(422);
  expect(migrate).not.toHaveBeenCalled();
  // A browser can edit its received JSON, but the server retains its own pin.
  review.preview.history_only_targets['e-alex'].target_user_id = 'client-edited';
  const accepted = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
  expect(accepted.statusCode).toBe(202);
  expect(migrate).toHaveBeenCalledExactlyOnceWith(
    ['e-alex'],
    undefined,
    { 'e-alex': null },
    'played_favorites',
    undefined,
    expect.objectContaining({ preview_id: review.id }),
    { 'e-alex': pin },
    undefined,
    undefined,
    expect.any(Function),
    undefined,
    undefined,
    {
      'e-alex': {
        server_id: preview.destination_server_id,
        target_user_id: pin.target_user_id,
        username: pin.target_username,
        source_username: preview.users[0]!.source_username,
      },
    },
  );
  expect(
    (await app.inject({ url: `/api/migrations/preview/${review.id}`, headers })).statusCode,
  ).toBe(404);
});

it.each([
  { source: 'e-alex', name: 'alex', reviewedTarget: null },
  { source: 'e-river', name: 'river', reviewedTarget: 'j-river' },
])(
  'requires a new review when same-name destination $name changes before acceptance',
  async ({ source, name, reviewedTarget }) => {
    const app = await setup();
    const headers = await login(app);
    const servers = new DemoServers();
    app.jellyport.service.clientFactory = servers.factory;
    const review = await readyPreview(app, headers, [source]);
    expect(review.preview.users[0].target_user_id).toBe(reviewedTarget);
    servers.users.jellyfin = [
      ...servers.users.jellyfin.filter((user) => user.Name !== name),
      {
        Id: 'unreviewed-replacement',
        Name: name,
        Policy: { IsAdministrator: false, IsDisabled: false },
      },
    ];
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers,
      payload: { source_user_ids: [source], preview_id: review.id },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().detail).toMatch(/destination changed.*new migration review/i);
    expect(app.jellyport.store.jobs()).toEqual([]);
    expect(servers.played['unreviewed-replacement']).toBeUndefined();
  },
);

it('passes household ownership only from its session-owned review and rejects client-supplied household proofs', async () => {
  const app = await setup();
  const headers = await login(app);
  const preview = await app.jellyport.service.preview(['e-alex']);
  const proof = {
    source_username: 'alex_2',
    discord_user_id: '123456789012345678',
    discord_username: 'alex',
    slot: 2,
    server_id: 'synthetic-emby',
  };
  vi.spyOn(app.jellyport.service, 'preview').mockResolvedValue({
    ...preview,
    household_targets: { 'e-alex': proof },
  });
  const stamp = new Date().toISOString();
  const migrate = vi.spyOn(app.jellyport.service, 'migrateUsers').mockResolvedValue({
    id: 'synthetic-household-job',
    kind: 'migrate',
    status: 'queued',
    created_at: stamp,
    updated_at: stamp,
    progress: { processed: 0, total: 1 },
    results: [],
  });
  const review = await readyPreview(app, headers);
  const payload = { source_user_ids: ['e-alex'], preview_id: review.id };
  const forged = await app.inject({
    method: 'POST',
    url: '/api/migrations',
    headers,
    payload: { ...payload, household_targets: { 'e-alex': { ...proof, slot: 3 } } },
  });
  expect(forged.statusCode).toBe(422);
  expect(migrate).not.toHaveBeenCalled();
  review.preview.household_targets['e-alex'].discord_user_id = '223456789012345678';
  const accepted = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
  expect(accepted.statusCode).toBe(202);
  expect(migrate).toHaveBeenCalledExactlyOnceWith(
    ['e-alex'],
    undefined,
    { 'e-alex': null },
    'played_favorites',
    undefined,
    expect.objectContaining({ preview_id: review.id }),
    undefined,
    { 'e-alex': proof },
    undefined,
    expect.any(Function),
    undefined,
    undefined,
    {
      'e-alex': {
        server_id: preview.destination_server_id,
        target_user_id: null,
        username: 'alex',
        source_username: 'alex',
      },
    },
  );
});

it('persists trusted whole-review preparation plus accepted job duration without dividing bulk review time', async () => {
  const app = await setup();
  const headers = await login(app);
  const review = await readyPreview(app, headers, ['e-alex', 'e-river']);
  const response = await app.inject({
    method: 'POST',
    url: '/api/migrations',
    headers,
    payload: { source_user_ids: ['e-alex', 'e-river'], preview_id: review.id },
  });
  expect(response.statusCode).toBe(202);
  const accepted = response.json();
  expect(accepted.preview_timing).toEqual({
    preview_id: review.id,
    started_at: review.started_at,
    finished_at: review.finished_at,
    elapsed_ms: review.elapsed_ms,
    user_count: 2,
  });
  expect(accepted.workflow_elapsed_ms).toBeUndefined();
  await app.jellyport.service.jobTasks.get(accepted.id);
  const finished = (await app.inject({ url: `/api/jobs/${accepted.id}`, headers })).json();
  expect(finished.workflow_elapsed_ms).toBe(review.elapsed_ms + finished.elapsed_ms);
  expect(finished.results).toHaveLength(2);
  expect(
    finished.results.every(
      (result: { data: { verification: { mismatched: number } } }) =>
        result.data.verification.mismatched === 0,
    ),
  ).toBe(true);
  expect(
    (await app.inject({ url: `/api/migrations/preview/${review.id}`, headers })).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/migrations',
        headers,
        payload: { source_user_ids: ['e-alex', 'e-river'], preview_id: review.id },
      })
    ).statusCode,
  ).toBe(400);
  const directory = resources.find((resource) => resource.app === app)!.directory;
  const persisted = new Store(directory, { demo: true });
  try {
    expect(persisted.job(accepted.id)?.preview_timing).toEqual(accepted.preview_timing);
    expect(persisted.job(accepted.id)?.workflow_elapsed_ms).toBe(finished.workflow_elapsed_ms);
  } finally {
    persisted.close();
  }
});

it('keeps direct migration timing explicitly separate when no trusted review is supplied', async () => {
  const app = await setup();
  const headers = await login(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/migrations',
    headers,
    payload: { source_user_ids: ['e-sam'] },
  });
  expect(response.statusCode).toBe(202);
  await app.jellyport.service.jobTasks.get(response.json().id);
  const finished = app.jellyport.store.job(response.json().id)!;
  expect(finished.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(finished.preview_timing).toBeUndefined();
  expect(finished.workflow_elapsed_ms).toBeUndefined();
});

it('rejects fabricated, foreign, changed, and malformed review timing before queuing migration work', async () => {
  const app = await setup();
  const headers = await login(app);
  const other = await login(app);
  const review = await readyPreview(app, headers);
  for (const [requestHeaders, payload, status] of [
    [
      headers,
      { source_user_ids: ['e-alex'], preview_id: '00000000-0000-4000-8000-000000000000' },
      400,
    ],
    [other, { source_user_ids: ['e-alex'], preview_id: review.id }, 400],
    [headers, { source_user_ids: ['e-sam'], preview_id: review.id }, 400],
    [
      headers,
      {
        source_user_ids: ['e-alex'],
        preview_id: review.id,
        mapping_revisions: { 'e-alex': 'invented-revision' },
      },
      400,
    ],
    [
      headers,
      {
        source_user_ids: ['e-alex'],
        preview_id: review.id,
        source_snapshot_ids: { 'e-alex': '00000000-0000-4000-8000-000000000000' },
      },
      400,
    ],
    [headers, { source_user_ids: ['e-alex'], preview_id: review.id, preview_elapsed_ms: 0 }, 422],
    [
      headers,
      { source_user_ids: ['e-alex'], preview_id: review.id, preview_timing: { elapsed_ms: 0 } },
      422,
    ],
    [headers, { source_user_ids: ['e-alex'], preview_id: 123 }, 422],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers: requestHeaders,
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(app.jellyport.store.jobs()).toHaveLength(0);
  }
});

it('rejects a running review and preserves retry after accepted preflight fails', async () => {
  const app = await setup();
  const headers = await login(app);
  let release!: () => void;
  const original = app.jellyport.service.preview.bind(app.jellyport.service);
  const preview = vi
    .spyOn(app.jellyport.service, 'preview')
    .mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
  const started = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: { source_user_ids: ['e-alex'] },
  });
  const payload = { source_user_ids: ['e-alex'], preview_id: started.json().id };
  expect(
    (await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })).statusCode,
  ).toBe(400);
  release();
  await vi.waitFor(async () =>
    expect(
      (await app.inject({ url: `/api/migrations/preview/${payload.preview_id}`, headers })).json()
        .status,
    ).toBe('ready'),
  );
  const migrate = vi
    .spyOn(app.jellyport.service, 'migrateUsers')
    .mockRejectedValueOnce(new Error('Synthetic preflight failure'));
  expect(
    (await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })).statusCode,
  ).toBe(500);
  expect(
    (await app.inject({ url: `/api/migrations/preview/${payload.preview_id}`, headers })).json()
      .status,
  ).toBe('ready');
  expect(
    (await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })).statusCode,
  ).toBe(202);
  migrate.mockRestore();
  preview.mockRestore();
});

it('prevents concurrent acceptance from queuing duplicate work for the same review', async () => {
  const app = await setup();
  const headers = await login(app);
  const review = await readyPreview(app, headers);
  let release!: () => void;
  const original = app.jellyport.service.migrateUsers.bind(app.jellyport.service);
  const migrate = vi
    .spyOn(app.jellyport.service, 'migrateUsers')
    .mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
  const payload = { source_user_ids: ['e-alex'], preview_id: review.id };
  const accepting = app
    .inject({ method: 'POST', url: '/api/migrations', headers, payload })
    .then((result) => result);
  await vi.waitFor(() => expect(migrate).toHaveBeenCalledOnce());
  const duplicate = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
  expect(duplicate.statusCode).toBe(400);
  expect(duplicate.json().detail).toContain('already being accepted');
  expect(migrate).toHaveBeenCalledOnce();
  release();
  expect((await accepting).statusCode).toBe(202);
  expect(app.jellyport.store.jobs()).toHaveLength(1);
  migrate.mockRestore();
});

it('requires a new review when destination configuration changes during accepted preflight', async () => {
  const app = await setup();
  const headers = await login(app);
  const review = await readyPreview(app, headers);
  let release!: () => void;
  const validation = vi
    .spyOn(app.jellyport.service.bot!, 'validateRecipient')
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
  const payload = {
    source_user_ids: ['e-alex'],
    preview_id: review.id,
    discord_recipients: { 'e-alex': '123456789' },
  };
  const pending = app
    .inject({ method: 'POST', url: '/api/migrations', headers, payload })
    .then((result) => result);
  await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
  app.jellyport.store.saveSettings({
    ...app.jellyport.store.settings(),
    jellyfin_url: 'http://different-jellyfin',
  });
  release();
  const response = await pending;
  expect(response.statusCode).toBe(400);
  expect(response.json().detail).toContain('Prepare a new review');
  expect(app.jellyport.store.jobs()).toEqual([]);
  expect(
    (await app.inject({ url: `/api/migrations/preview/${review.id}`, headers })).statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })).statusCode,
  ).toBe(400);
  const refreshed = await readyPreview(app, headers);
  expect(refreshed.id).not.toBe(review.id);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/migrations',
        headers,
        payload: { source_user_ids: ['e-alex'], preview_id: refreshed.id },
      })
    ).statusCode,
  ).toBe(202);
  validation.mockRestore();
});
it('discards ready history previews when integration settings change', async () => {
  const app = await setup(false);
  const headers = await login(app);
  vi.spyOn(app.jellyport.service, 'preview').mockResolvedValue({
    users: [],
    mode: 'merge',
    migration_scope: 'watched_only',
    destination_server_id: 'test-server',
  });
  const started = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: { source_user_ids: ['source'] },
  });
  const url = `/api/migrations/preview/${started.json().id}`;
  await vi.waitFor(async () =>
    expect((await app.inject({ url, headers })).json().status).toBe('ready'),
  );
  const updated = await saveSettings(app, headers, { emby_url: 'https://emby.example' });
  expect(updated.statusCode).toBe(200);
  expect((await app.inject({ url, headers })).statusCode).toBe(404);
});
it('starts production setup without a local administrator password or bootstrap code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-'));
  const app = await createApp({ demo: false, dataDir: directory });
  resources.push({ app, directory });
  const response = await app.inject('/api/session');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ authenticated: false, setup_required: true });
  expect(response.json()).not.toHaveProperty('setup_protection');
  expect(response.json()).not.toHaveProperty('setup_code');
  expect(app.jellyport.store.authState()).not.toHaveProperty('setupCode');
});

it('protects encoded API route aliases with the same authentication and CSRF checks', async () => {
  const app = await setup();
  for (const url of ['/%61pi/settings', '/a%70i/jobs', '/%61%70%69/subscriptions'])
    expect((await app.inject(url)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/%61pi/login',
        payload: { username: 'admin', password: 'testing-password-long' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/%61pi/accounts',
        payload: { username: 'intruder' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ method: 'POST', url: '/%61pi/jobs/unknown/credentials' })).statusCode,
  ).toBe(401);
  const headers = await login(app);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/%61pi/accounts',
        headers: { cookie: headers.cookie },
        payload: { username: 'member' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject({ url: '/%61pi/settings', headers })).statusCode).toBe(200);
  expect(app.jellyport.store.jobs()).toEqual([]);
});

it.each(['configured', 'legacy', 'blank-with-user-records'] as const)(
  'refuses demo startup with %s production data before replacing settings or exposing records',
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-isolation-'));
    standaloneDirectories.push(directory);
    const store = new Store(directory);
    if (kind !== 'blank-with-user-records')
      store.saveSettings({
        ...DEFAULT_SETTINGS,
        jellyfin_url: 'https://private-jellyfin.example',
        jellyfin_api_key: 'private-service-key',
      });
    if (kind === 'configured') {
      const state = store.ensureAuthState();
      if (state.kind !== 'pending') throw new Error('Expected fixture pending state');
      store.completeAuth(
        state.generation,
        {
          kind: 'configured',
          serverUrl: 'https://private-jellyfin.example',
          serverId: 'private-server-id',
          apiKeyName: 'private-key-name',
        },
        (settings) => settings,
      );
    }
    store.saveJob({
      id: 'private-job',
      kind: 'create',
      status: 'running',
      created_at: '2026-10-07',
      updated_at: '2026-10-07',
      progress: { processed: 0, total: 1 },
      results: [],
    });
    store.saveAccount('private-member', 'private-id', 'provisioning', 'private-password');
    const before = {
      settings: store.db.prepare('SELECT * FROM settings').all(),
      auth: store.db.prepare('SELECT * FROM auth_state').all(),
      jobs: store.db.prepare('SELECT * FROM jobs').all(),
      accounts: store.db.prepare('SELECT * FROM accounts').all(),
    };
    store.close();
    let unexpectedApp: JellyportApp | undefined;
    try {
      await expect(
        createApp({ dataDir: directory, demo: true }).then((app) => {
          unexpectedApp = app;
          return app;
        }),
      ).rejects.toThrow('Demo mode requires a separate empty data directory');
    } finally {
      await unexpectedApp?.close();
    }
    const db = new DatabaseSync(join(directory, 'jellyport.db'), { readOnly: true });
    try {
      expect({
        settings: db.prepare('SELECT * FROM settings').all(),
        auth: db.prepare('SELECT * FROM auth_state').all(),
        jobs: db.prepare('SELECT * FROM jobs').all(),
        accounts: db.prepare('SELECT * FROM accounts').all(),
      }).toEqual(before);
    } finally {
      db.close();
    }
  },
);

it('supports a fresh isolated demo and repeat startup without consulting production authentication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-isolated-demo-'));
  standaloneDirectories.push(directory);
  const rejectAuthentication = vi.fn(async () => {
    throw new Error('No remote authentication is allowed in this fixture.');
  });
  const authClient: JellyfinAuthentication = {
    authenticate: rejectAuthentication,
    validateSession: rejectAuthentication,
    signOut: rejectAuthentication,
    validateApiKey: rejectAuthentication,
  };
  let app = await createApp({
    dataDir: directory,
    demo: true,
    demoPassword: 'testing-password-long',
    authClient,
  });
  try {
    expect((await app.inject('/api/session')).json()).toMatchObject({
      demo: true,
      authenticated: false,
      setup_required: false,
    });
    const headers = await login(app);
    expect((await app.inject({ url: '/api/users', headers })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
  app = await createApp({
    dataDir: directory,
    demo: true,
    demoPassword: 'testing-password-long',
    authClient,
  });
  resources.push({ app, directory });
  const headers = await login(app);
  expect((await app.inject({ url: '/api/settings', headers })).json()).toMatchObject({
    emby_url: 'http://demo-emby',
    jellyfin_url: 'http://demo-jellyfin',
  });
  expect(rejectAuthentication).not.toHaveBeenCalled();
});

it('keeps server tokens, saved secrets and the session cookie out of ordinary API response bodies', async () => {
  const app = await setup(false);
  // Inject in-memory media fixtures before using routes that inspect media servers.
  app.jellyport.service.clientFactory = new DemoServers().factory;
  app.jellyport.store.saveSettings({
    ...app.jellyport.store.settings(),
    emby_url: 'https://emby.example',
    emby_api_key: 'private-emby-key',
    discord_bot_token: 'private-discord-token',
  });
  const fixtureJob = {
    id: 'private-fixture-job',
    kind: 'create',
    status: 'completed',
    created_at: '2026-10-07',
    updated_at: '2026-10-07',
    progress: { processed: 1, total: 1 },
    results: [],
  };
  app.jellyport.store.saveJob(fixtureJob);
  app.jellyport.store.saveCredentials(
    fixtureJob.id,
    'fixture-member',
    'private-member-password',
    'https://jellyfin.example',
    'Private welcome: private-member-password',
  );
  const secrets = [
    'test-token',
    'service-key',
    'private-emby-key',
    'private-discord-token',
    'private-member-password',
    'Private welcome: private-member-password',
    'testing-password-long',
  ];
  const anonymous = await app.inject('/api/session');
  expect(anonymous.json()).toMatchObject({ authenticated: false, setup_required: false });
  expect(anonymous.json()).not.toHaveProperty('user');
  for (const secret of [...secrets, anonymous.cookies[0].value])
    expect(anonymous.body).not.toContain(secret);
  for (const url of [
    '/api/settings',
    '/api/users',
    '/api/jobs',
    `/api/jobs/${fixtureJob.id}`,
    '/api/subscriptions',
    '/api/overview',
  ]) {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(401);
    for (const secret of [...secrets, fixtureJob.id, 'fixture-member'])
      expect(response.body).not.toContain(secret);
  }
  const headers = await login(app);
  const sessionCookie = headers.cookie.split('=')[1]!;
  for (const url of [
    '/api/session',
    '/api/settings',
    '/api/users',
    '/api/jobs',
    `/api/jobs/${fixtureJob.id}`,
    '/api/subscriptions',
    '/api/overview',
  ]) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    for (const secret of [...secrets, sessionCookie]) expect(response.body).not.toContain(secret);
  }
  const revealed = await app.inject({
    method: 'POST',
    url: `/api/jobs/${fixtureJob.id}/credentials`,
    headers,
  });
  expect(revealed.json().credentials).toEqual([
    {
      username: 'fixture-member',
      password: 'private-member-password',
      server_url: 'https://jellyfin.example',
      message: 'Private welcome: private-member-password',
    },
  ]);
  expect(revealed.headers['cache-control']).toContain('no-store');
  for (const secret of secrets.filter((secret) => !secret.includes('private-member-password')))
    expect(revealed.body).not.toContain(secret);
  expect(
    (
      await app.inject({ method: 'POST', url: `/api/jobs/${fixtureJob.id}/credentials`, headers })
    ).json().credentials,
  ).toEqual([]);
});

it('returns only browser-required user fields rather than forwarding private upstream DTO fields', async () => {
  const app = await setup(false);
  const factory = new DemoServers().factory;
  app.jellyport.service.clientFactory = (url, key, kind) => {
    const client = factory(url, key, kind);
    const users = client.users.bind(client);
    client.users = async () =>
      (await users()).map((user) => ({
        ...user,
        AccessToken: 'private-upstream-token',
        Password: 'private-upstream-password',
        Sessions: [{ Id: 'private-upstream-session' }],
        Configuration: { Token: 'private-upstream-configuration' },
        Policy: { ...user.Policy, PluginSecret: 'private-upstream-policy' },
      }));
    return client;
  };
  app.jellyport.store.saveSettings({
    ...app.jellyport.store.settings(),
    emby_url: 'http://demo-emby',
    emby_api_key: 'demo',
  });
  const headers = await login(app);
  const response = await app.inject({ url: '/api/users', headers });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain('private-upstream');
  for (const user of [...response.json().emby, ...response.json().jellyfin]) {
    expect(Object.keys(user).sort()).toEqual(['Id', 'Name', 'Policy']);
    expect(
      Object.keys(user.Policy).every((key) => ['IsAdministrator', 'IsDisabled'].includes(key)),
    ).toBe(true);
    expect(user.Id).toBeTruthy();
    expect(user.Name).toBeTruthy();
  }
});

it('looks up the original reviewed migration after a lost response and refuses altered replays', async () => {
  const app = await setup();
  const headers = await login(app);
  const review = await readyPreview(app, headers);
  const payload = {
    source_user_ids: ['e-alex'],
    preview_id: review.id,
    submission_receipt: review.id,
  };
  const submit = () => app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
  const accepted = await submit();
  expect(accepted.statusCode).toBe(202);
  const job = accepted.json();
  const lookUp = async (value: string, sessionHeaders = headers) =>
    app.inject({ url: `/api/migrations/receipts/${value}`, headers: sessionHeaders });
  expect((await lookUp(review.id)).json()).toEqual({ job_id: job.id });
  expect((await lookUp('latest', await login(app))).json()).toEqual({ job_id: job.id });
  expect((await submit()).json().id).toBe(job.id);
  expect(app.jellyport.store.jobCount()).toBe(1);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/migrations',
        headers,
        payload: { ...payload, migration_scope: 'watched_only' },
      })
    ).statusCode,
  ).toBe(409);
  expect((await app.inject(`/api/migrations/receipts/${review.id}`)).statusCode).toBe(401);
});

it('uses recorded source identities for a fresh follow-up and excludes successful accounts', async () => {
  const app = await setup();
  const headers = await login(app);
  const store = app.jellyport.store;
  const timestamp = new Date().toISOString();
  const job = {
    id: 'synthetic-follow-up',
    kind: 'migrate',
    status: 'queued',
    created_at: timestamp,
    updated_at: timestamp,
    progress: { processed: 0, total: 3 },
    migration_scope: 'played_favorites' as const,
    results: [],
  };
  store.saveQueuedJob(
    job,
    [
      { username: 'Same display name', source_user_id: 'finished-source' },
      { username: 'Same display name', source_user_id: 'partial-source' },
      { username: 'Never started', source_user_id: 'unstarted-source' },
    ],
    store.settings(),
    undefined,
    { key: 'synthetic-opaque-key', owner: 'synthetic-owner-key', requestHash: 'synthetic-proof' },
    'original-source-scope',
  );
  expect(store.claimQueuedJob(job.id)).toBe(true);
  store.saveJob({
    ...job,
    status: 'partial',
    results: [
      { username: 'Same display name', source_user_id: 'finished-source', status: 'completed' },
      { username: 'Same display name', source_user_id: 'partial-source', status: 'partial' },
    ],
  });
  expect(store.latestMigrationSubmission('synthetic-owner-key')).toBe(job.id);
  const response = await app.inject({ url: `/api/jobs/${job.id}/follow-up`, headers });
  expect(response.statusCode).toBe(200);
  const selection = response.json<{
    source_user_ids: string[];
    migration_scope: string;
    use_snapshots: boolean;
  }>();
  expect(selection).toEqual({
    source_user_ids: ['partial-source', 'unstarted-source'],
    migration_scope: 'played_favorites',
    use_snapshots: false,
  });
  const invalidReview = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: {
      ...selection,
      source_user_ids: ['finished-source', 'partial-source'],
      follow_up_job_id: job.id,
    },
  });
  expect(invalidReview.statusCode).toBe(400);
  expect(invalidReview.json().detail).toContain('selection changed');
  const changedSource = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: { ...selection, follow_up_job_id: job.id },
  });
  expect(changedSource.statusCode).toBe(400);
  expect(changedSource.json().detail).toContain('original Emby server changed');
  expect(store.jobCount()).toBe(1);
});
