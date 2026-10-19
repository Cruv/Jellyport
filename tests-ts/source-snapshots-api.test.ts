import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type JellyportApp } from '../server/main.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';

const resources: Array<{ app: JellyportApp; directory: string }> = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function setup(demo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-snapshot-api-'));
  const identity = {
    serverId: 'fixture-server',
    userId: 'fixture-admin',
    username: 'admin',
    accessToken: 'private-interactive-token',
  };
  let authorized = true;
  const authClient: JellyfinAuthentication = {
    authenticate: async () => identity,
    validateSession: async () => {
      if (!authorized) throw new JellyfinAuthError('Administrator access revoked.', 403);
      return identity;
    },
    signOut: async () => {},
    validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'fixture-key' }),
  };
  let app = await createApp({
    dataDir: directory,
    demo,
    demoPassword: 'fixture-password',
    authClient,
  });
  const resource = { app, directory };
  resources.push(resource);
  if (!demo) {
    const state = app.jellyport.store.authState();
    if (state?.kind !== 'pending') throw new Error('Expected pending fixture setup.');
    app.jellyport.store.completeAuth(
      state.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example',
        serverId: identity.serverId,
        apiKeyName: 'fixture-key',
      },
      (settings) => ({
        ...settings,
        jellyfin_url: 'https://jellyfin.example',
        jellyfin_api_key: 'private-service-key',
      }),
    );
  }
  async function signIn() {
    const anonymous = await app.inject('/api/session');
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `${anonymous.cookies[0].name}=${anonymous.cookies[0].value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'admin', password: 'fixture-password' },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      'x-csrf-token': response.json().csrf_token as string,
    };
  }
  const headers = await signIn();
  return {
    app,
    headers,
    revoke: () => {
      authorized = false;
    },
    restart: async () => {
      await app.close();
      app = await createApp({
        dataDir: directory,
        demo,
        demoPassword: 'fixture-password',
        authClient,
      });
      resource.app = app;
      return { app, headers: await signIn() };
    },
  };
}

async function schedule(app: JellyportApp) {
  return {
    enabled: false,
    hour: 3,
    minute: 15,
    time_zone: 'Etc/UTC',
    scope: 'complete' as const,
    expected_revision: (await app.jellyport.service.sourceSnapshots.status()).config.revision,
  };
}

it('requires current administrator authorization for snapshot status and every mutation', async () => {
  const { app, headers, revoke } = await setup();
  const manager = app.jellyport.service.sourceSnapshots;
  const state = await manager.status();
  const configure = vi.spyOn(manager, 'configure').mockResolvedValue(state);
  const refresh = vi.spyOn(manager, 'refresh').mockResolvedValue(state);
  const clear = vi.spyOn(manager, 'clear').mockResolvedValue(state);
  const requests = [
    { method: 'GET' as const, url: '/api/source-snapshots' },
    { method: 'PUT' as const, url: '/api/source-snapshots/schedule', payload: await schedule(app) },
    { method: 'POST' as const, url: '/api/source-snapshots/refresh' },
    { method: 'DELETE' as const, url: '/api/source-snapshots' },
  ];
  for (const request of requests) {
    expect((await app.inject(request)).statusCode).toBe(401);
    if (request.method !== 'GET') {
      expect(
        (await app.inject({ ...request, headers: { cookie: headers.cookie } })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            ...request,
            headers: { ...headers, origin: 'https://attacker.example' },
          })
        ).statusCode,
      ).toBe(403);
    }
  }
  const status = await app.inject({ url: '/api/source-snapshots', headers });
  expect(status.statusCode).toBe(200);
  expect(status.headers['cache-control']).toBe('no-store');
  expect(status.json()).toEqual(state);
  expect(status.body).not.toMatch(/private-service-key|private-interactive-token|fixture-password/);
  expect(configure).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  revoke();
  for (const request of requests)
    expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  expect(configure).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

it('forwards a strictly typed schedule and rejects unknown or coerced fields before mutation', async () => {
  const { app, headers } = await setup();
  const manager = app.jellyport.service.sourceSnapshots;
  const state = await manager.status();
  const configure = vi.spyOn(manager, 'configure').mockResolvedValue(state);
  const input = { ...(await schedule(app)), enabled: true, scope: 'watched_only' };
  const response = await app.inject({
    method: 'PUT',
    url: '/api/source-snapshots/schedule',
    headers,
    payload: input,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(state);
  expect(configure).toHaveBeenCalledExactlyOnceWith(input);
  configure.mockClear();
  const invalid = [
    { enabled: 'true' },
    { enabled: null },
    { hour: -1 },
    { hour: 24 },
    { hour: 1.5 },
    { hour: '3' },
    { minute: -1 },
    { minute: 60 },
    { minute: '15' },
    { time_zone: '' },
    { time_zone: null },
    { time_zone: 'x'.repeat(129) },
    { scope: 'played' },
    { scope: true },
    { expected_revision: null },
    { expected_revision: '' },
    { api_key: 'private-submitted-secret' },
  ];
  for (const override of invalid) {
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/source-snapshots/schedule',
      headers,
      payload: { ...input, ...override },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).not.toContain('private-submitted-secret');
  }
  for (const omitted of Object.keys(input)) {
    const missing = { ...input } as Record<string, unknown>;
    delete missing[omitted];
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/source-snapshots/schedule',
          headers,
          payload: missing,
        })
      ).statusCode,
    ).toBe(422);
  }
  expect(configure).not.toHaveBeenCalled();
});

it('returns asynchronous refresh status and clear status without accepting arbitrary data', async () => {
  const { app, headers } = await setup();
  const manager = app.jellyport.service.sourceSnapshots;
  const state = await manager.status();
  const refresh = vi.spyOn(manager, 'refresh').mockResolvedValue({ ...state, running: true });
  const clear = vi.spyOn(manager, 'clear').mockResolvedValue(state);
  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/source-snapshots/refresh',
    headers,
  });
  expect(refreshed.statusCode).toBe(202);
  expect(refreshed.json()).toEqual({ ...state, running: true });
  expect(refresh).toHaveBeenCalledExactlyOnceWith();
  const cleared = await app.inject({ method: 'DELETE', url: '/api/source-snapshots', headers });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json()).toEqual(state);
  expect(clear).toHaveBeenCalledExactlyOnceWith();
  refresh.mockClear();
  clear.mockClear();
  for (const request of [
    { method: 'POST' as const, url: '/api/source-snapshots/refresh' },
    { method: 'DELETE' as const, url: '/api/source-snapshots' },
  ]) {
    const rejected = await app.inject({
      ...request,
      headers,
      payload: { api_key: 'private-submitted-secret' },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).not.toContain('private-submitted-secret');
  }
  expect(refresh).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

it('keeps demonstration snapshot status readable and refuses every real mutation', async () => {
  const { app, headers } = await setup(true);
  expect((await app.inject({ url: '/api/source-snapshots', headers })).statusCode).toBe(200);
  for (const request of [
    { method: 'PUT' as const, url: '/api/source-snapshots/schedule', payload: await schedule(app) },
    { method: 'POST' as const, url: '/api/source-snapshots/refresh' },
    { method: 'DELETE' as const, url: '/api/source-snapshots' },
  ]) {
    const result = await app.inject({ ...request, headers });
    expect(result.statusCode).toBe(400);
    expect(result.json().detail).toEqual(expect.any(String));
  }
  expect((await app.jellyport.service.sourceSnapshots.status()).config.enabled).toBe(false);
  expect(app.jellyport.store.jobs()).toHaveLength(0);
});

it.each(
  [undefined, false, true].flatMap((useSnapshots) =>
    [undefined, 'complete', 'watched_only'].map((migrationScope) => ({
      useSnapshots,
      migrationScope,
    })),
  ),
)(
  'narrows preview scope $migrationScope with snapshot selection $useSnapshots to watched-only',
  async ({ useSnapshots, migrationScope }) => {
    const { app, headers } = await setup();
    const preview = vi.spyOn(app.jellyport.service, 'preview').mockResolvedValue({
      users: [],
      mode: 'merge',
      migration_scope: 'watched_only',
    });
    const started = await app.inject({
      method: 'POST',
      url: '/api/migrations/preview',
      headers,
      payload: {
        source_user_ids: ['fixture-source'],
        ...(useSnapshots === undefined ? {} : { use_snapshots: useSnapshots }),
        ...(migrationScope === undefined ? {} : { migration_scope: migrationScope }),
      },
    });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview).toHaveBeenCalledWith(
      ['fixture-source'],
      expect.objectContaining({
        migration_scope: 'watched_only',
        use_snapshots: useSnapshots ?? false,
      }),
    );
  },
);

it.each([undefined, 'complete', 'watched_only'] as const)(
  'forwards approved snapshot generations with legacy scope %s narrowed to watched-only',
  async (migrationScope) => {
    const { app, headers } = await setup();
    const migrate = vi.spyOn(app.jellyport.service, 'migrateUsers').mockResolvedValue({
      id: 'fixture-job',
      kind: 'migration',
      status: 'queued',
      created_at: '2026-10-08T12:00:00.000Z',
      updated_at: '2026-10-08T12:00:00.000Z',
      progress: { processed: 0, total: 2 },
      results: [],
    });
    const source_snapshot_ids = {
      'fixture-source-a': '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80',
      'fixture-source-b': '99b59955-98ea-453d-9d25-a2b3f3cbac0b',
    };
    const discord_recipients = { 'fixture-source-a': '123456789' };
    const mapping_revisions = { 'fixture-source-a': 'fixture-revision', 'fixture-source-b': null };
    const response = await app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers,
      payload: {
        source_user_ids: ['fixture-source-a', 'fixture-source-b'],
        ...(migrationScope === undefined ? {} : { migration_scope: migrationScope }),
        source_snapshot_ids,
        discord_recipients,
        mapping_revisions,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(migrate).toHaveBeenCalledExactlyOnceWith(
      ['fixture-source-a', 'fixture-source-b'],
      discord_recipients,
      mapping_revisions,
      'watched_only',
      source_snapshot_ids,
      undefined,
    );
  },
);

it('rejects malformed snapshot selection and incomplete pins before execution starts', async () => {
  const { app, headers } = await setup();
  const preview = vi.spyOn(app.jellyport.service, 'preview');
  const migrate = vi.spyOn(app.jellyport.service, 'migrateUsers');
  for (const url of ['/api/migrations/preview', '/api/migrations']) {
    for (const fields of [
      { use_snapshots: 'true' },
      { use_snapshots: 1 },
      { use_snapshots: null },
      { source_snapshot_ids: null },
      { source_snapshot_ids: {} },
      { source_snapshot_ids: [] },
      { source_snapshot_ids: { 'fixture-source': 'not-a-generation' } },
      { source_snapshot_ids: { 'fixture-source': true } },
      { source_snapshot_ids: { ['x'.repeat(129)]: '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80' } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { source_user_ids: ['fixture-source'], ...fields },
      });
      expect(response.statusCode).toBe(422);
    }
  }
  for (const source_snapshot_ids of [
    { 'another-source': '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80' },
    {
      'fixture-source': '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80',
      'another-source': '99b59955-98ea-453d-9d25-a2b3f3cbac0b',
    },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers,
      payload: { source_user_ids: ['fixture-source'], source_snapshot_ids },
    });
    expect(response.statusCode).toBe(400);
  }
  const unpinned = await app.inject({
    method: 'POST',
    url: '/api/migrations',
    headers,
    payload: { source_user_ids: ['fixture-source'], use_snapshots: true },
  });
  expect(unpinned.statusCode).toBe(400);
  expect(unpinned.json().detail).toContain('Review');
  const clientChosenPreview = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: {
      source_user_ids: ['fixture-source'],
      source_snapshot_ids: { 'fixture-source': '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80' },
    },
  });
  expect(clientChosenPreview.statusCode).toBe(400);
  expect(preview).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
});

it('protects saved destination catalog status and mutations with admin revalidation and CSRF', async () => {
  const { app, headers, revoke } = await setup();
  const manager = app.jellyport.service.destinationSnapshots;
  const state = await manager.status();
  const refresh = vi.spyOn(manager, 'refresh').mockResolvedValue(state);
  const clear = vi.spyOn(manager, 'clear').mockResolvedValue(state);
  expect((await app.inject('/api/destination-catalog')).statusCode).toBe(401);
  for (const [method, url] of [
    ['POST', '/api/destination-catalog/refresh'],
    ['DELETE', '/api/destination-catalog'],
  ] as const) {
    expect(
      (await app.inject({ method, url, headers: { cookie: headers.cookie } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method, url, headers, payload: { unexpected: 'private' } })).statusCode,
    ).toBe(422);
  }
  expect(refresh).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(
    (await app.inject({ method: 'GET', url: '/api/destination-catalog', headers })).json(),
  ).toMatchObject({ configured: false, record: null });
  expect(
    (await app.inject({ method: 'POST', url: '/api/destination-catalog/refresh', headers }))
      .statusCode,
  ).toBe(202);
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/destination-catalog', headers })).statusCode,
  ).toBe(200);
  refresh.mockClear();
  clear.mockClear();
  revoke();
  for (const [method, url] of [
    ['GET', '/api/destination-catalog'],
    ['POST', '/api/destination-catalog/refresh'],
    ['DELETE', '/api/destination-catalog'],
  ] as const)
    expect((await app.inject({ method, url, headers })).statusCode).toBe(401);
  expect(refresh).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

it('saves only the strictly typed Jellyfin schedule with current administrator authorization and CSRF', async () => {
  const { app, headers, revoke } = await setup();
  const manager = app.jellyport.service.destinationSnapshots;
  const state = await manager.status();
  const configure = vi.spyOn(manager, 'configure').mockResolvedValue(state);
  const input = {
    enabled: true,
    hour: 3,
    minute: 15,
    time_zone: 'Etc/UTC',
    expected_revision: state.config.revision,
    create_backup: true,
  };
  const request = {
    method: 'PUT' as const,
    url: '/api/destination-catalog/schedule',
    payload: input,
  };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect((await app.inject({ ...request, headers: { cookie: headers.cookie } })).statusCode).toBe(
    403,
  );
  expect(
    (await app.inject({ ...request, headers: { ...headers, origin: 'https://attacker.example' } }))
      .statusCode,
  ).toBe(403);
  const saved = await app.inject({ ...request, headers });
  expect(saved.statusCode).toBe(200);
  expect(saved.headers['cache-control']).toBe('no-store');
  expect(saved.json()).toEqual(state);
  expect(configure).toHaveBeenCalledExactlyOnceWith(input);
  configure.mockClear();
  for (const invalid of [
    { create_backup: 'true' },
    { enabled: 'true' },
    { hour: 24 },
    { hour: 1.5 },
    { hour: '3' },
    { minute: -1 },
    { minute: 60 },
    { time_zone: '' },
    { time_zone: 'x'.repeat(129) },
    { expected_revision: '' },
    { scope: 'complete' },
    { api_key: 'synthetic-private-submitted-secret' },
  ]) {
    const rejected = await app.inject({ ...request, headers, payload: { ...input, ...invalid } });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).not.toContain('synthetic-private-submitted-secret');
  }
  for (const omitted of Object.keys(input).filter((key) => key !== 'create_backup')) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[omitted];
    expect((await app.inject({ ...request, headers, payload: missing })).statusCode).toBe(422);
  }
  expect(configure).not.toHaveBeenCalled();
  revoke();
  expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  expect(configure).not.toHaveBeenCalled();
});

it('requires current administrator access and CSRF before changing Jellyfin backup retention', async () => {
  const { app, headers, revoke } = await setup();
  const manager = app.jellyport.service.destinationSnapshots;
  const before = await manager.status();
  const configure = vi.spyOn(manager, 'configureRetention');
  const request = {
    method: 'PUT' as const,
    url: '/api/destination-catalog/backup-retention',
    payload: {
      enabled: true,
      keep: 7,
      expected_revision: before.backup_cleanup.config.revision,
    },
  };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect((await app.inject({ ...request, headers: { cookie: headers.cookie } })).statusCode).toBe(
    403,
  );
  expect(
    (await app.inject({ ...request, headers: { ...headers, origin: 'https://attacker.example' } }))
      .statusCode,
  ).toBe(403);
  expect(configure).not.toHaveBeenCalled();
  expect((await manager.status()).backup_cleanup.config).toEqual(before.backup_cleanup.config);
  revoke();
  expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  expect(configure).not.toHaveBeenCalled();
  expect((await manager.status()).backup_cleanup.config).toEqual(before.backup_cleanup.config);
});

it('rejects malformed retention policies before mutation without reflecting submitted secrets', async () => {
  const { app, headers } = await setup();
  const manager = app.jellyport.service.destinationSnapshots;
  const before = await manager.status();
  const configure = vi.spyOn(manager, 'configureRetention');
  const input = {
    enabled: true,
    keep: 7,
    expected_revision: before.backup_cleanup.config.revision,
  };
  const request = {
    method: 'PUT' as const,
    url: '/api/destination-catalog/backup-retention',
    headers,
  };
  for (const override of [
    { enabled: 'true' },
    { enabled: 1 },
    { enabled: null },
    { keep: 0 },
    { keep: -1 },
    { keep: 101 },
    { keep: 1.5 },
    { keep: '7' },
    { keep: null },
    { expected_revision: '' },
    { expected_revision: 'not-a-uuid' },
    { expected_revision: null },
    { expected_revision: 1 },
    { directory: '/synthetic-private-backup-path' },
    { api_key: 'synthetic-private-submitted-secret' },
  ]) {
    const rejected = await app.inject({ ...request, payload: { ...input, ...override } });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).not.toMatch(
      /synthetic-private-backup-path|synthetic-private-submitted-secret/,
    );
  }
  for (const omitted of Object.keys(input)) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[omitted];
    expect((await app.inject({ ...request, payload: missing })).statusCode).toBe(422);
  }
  expect((await app.inject({ ...request, payload: [] })).statusCode).toBe(422);
  expect(configure).not.toHaveBeenCalled();
  expect((await manager.status()).backup_cleanup.config).toEqual(before.backup_cleanup.config);
});

it('persists revision-guarded retention changes across restart and never exposes backup paths or credentials', async () => {
  const { app, headers, restart } = await setup();
  const initial = await app.inject({ url: '/api/destination-catalog', headers });
  expect(initial.statusCode).toBe(200);
  expect(initial.json().backup_cleanup.config).toMatchObject({ enabled: false, keep: 7 });
  const revision = initial.json().backup_cleanup.config.revision as string;
  const input = { enabled: true, keep: 1, expected_revision: revision };
  const request = {
    method: 'PUT' as const,
    url: '/api/destination-catalog/backup-retention',
    headers,
  };
  const saved = await app.inject({ ...request, payload: input });
  expect(saved.statusCode).toBe(200);
  expect(saved.headers['cache-control']).toBe('no-store');
  expect(saved.json().backup_cleanup.config).toMatchObject({ enabled: true, keep: 1 });
  expect(saved.json().backup_cleanup.config.revision).not.toBe(revision);
  const configuration = saved.json().backup_cleanup.config;
  const restarted = await restart();
  const restored = await restarted.app.inject({
    url: '/api/destination-catalog',
    headers: restarted.headers,
  });
  expect(restored.statusCode).toBe(200);
  expect(restored.json().backup_cleanup.config).toEqual(configuration);
  const stale = await restarted.app.inject({
    ...request,
    headers: restarted.headers,
    payload: { enabled: false, keep: 100, expected_revision: revision },
  });
  expect(stale.statusCode).toBe(400);
  expect(
    (
      await restarted.app.inject({ url: '/api/destination-catalog', headers: restarted.headers })
    ).json().backup_cleanup.config,
  ).toEqual(configuration);
  const changed = await restarted.app.inject({
    ...request,
    headers: restarted.headers,
    payload: { enabled: false, keep: 100, expected_revision: configuration.revision },
  });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().backup_cleanup.config).toMatchObject({ enabled: false, keep: 100 });
  expect(changed.json().backup_cleanup.config.revision).not.toBe(configuration.revision);
  for (const response of [initial, saved, restored, stale, changed])
    expect(response.body).not.toMatch(
      /private-service-key|private-interactive-token|fixture-password|jellyport-snapshot-api-|\.zip|\/synthetic-private/,
    );
});

it('keeps backup retention readable in demo mode while refusing policy changes', async () => {
  const { app, headers } = await setup(true);
  const state = (await app.inject({ url: '/api/destination-catalog', headers })).json();
  const response = await app.inject({
    method: 'PUT',
    url: '/api/destination-catalog/backup-retention',
    headers,
    payload: {
      enabled: true,
      keep: 7,
      expected_revision: state.backup_cleanup.config.revision,
    },
  });
  expect(response.statusCode).toBe(400);
  expect((await app.jellyport.service.destinationSnapshots.status()).backup_cleanup.config).toEqual(
    state.backup_cleanup.config,
  );
});

it('protects backup confirmation with administrator revalidation, CSRF and a strict attempt-bound body', async () => {
  const { app, headers, revoke } = await setup();
  const manager = app.jellyport.service.destinationSnapshots;
  const state = await manager.status();
  const confirm = vi.spyOn(manager, 'acknowledgeBackup').mockResolvedValue(state);
  const expected_attempt_id = '00112233-4455-4677-8899-aabbccddeeff';
  const request = {
    method: 'POST' as const,
    url: '/api/destination-catalog/backup/acknowledge',
    payload: { expected_attempt_id },
  };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect((await app.inject({ ...request, headers: { cookie: headers.cookie } })).statusCode).toBe(
    403,
  );
  expect(
    (await app.inject({ ...request, headers: { ...headers, origin: 'https://attacker.example' } }))
      .statusCode,
  ).toBe(403);
  for (const payload of [
    {},
    { expected_attempt_id: false },
    { expected_attempt_id: '' },
    { expected_attempt_id, api_key: 'synthetic-private' },
  ]) {
    const response = await app.inject({ ...request, headers, payload });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain('synthetic-private');
  }
  expect(confirm).not.toHaveBeenCalled();
  const response = await app.inject({ ...request, headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expected_attempt_id);
  confirm.mockClear();
  revoke();
  expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  expect(confirm).not.toHaveBeenCalled();
});

it('keeps the Jellyfin schedule readable in demo mode but never enables a real scheduled importer', async () => {
  const { app, headers } = await setup(true);
  const state = (await app.inject({ url: '/api/destination-catalog', headers })).json();
  expect(state).toMatchObject({ config: { enabled: false }, next_run_at: null });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/destination-catalog/schedule',
    headers,
    payload: {
      ...state.config,
      enabled: true,
      expected_revision: state.config.revision,
      revision: undefined,
    },
  });
  expect(response.statusCode).toBe(400);
  expect((await app.jellyport.service.destinationSnapshots.status()).config.enabled).toBe(false);
});
