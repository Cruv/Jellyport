import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';
import type { ClientFactory } from '../server/media.js';
import { Store } from '../server/store.js';

const SERVER_URL = 'http://jellyfin:8096';
const SERVER_ID = 'jellyfin-server-id';
const API_KEY = 'user-owned-service-secret';
const JELLYFIN_PASSWORD = 'actual-Jellyfin-administrator-password!42';
const apps = new Set<JellyportApp>();
const directories = new Set<string>();
type Browser = { cookie: string; csrf: string };
type Response = Awaited<ReturnType<JellyportApp['inject']>>;

function fakeAuthentication() {
  const behavior = {
    validationError: undefined as JellyfinAuthError | undefined,
    keyValidationError: undefined as JellyfinAuthError | undefined,
    keyValidationGate: undefined as ((key: string) => Promise<void>) | undefined,
    revoked: new Set<string>(),
    tokens: [] as string[],
    keys: [] as string[],
  };
  const auth = {
    authenticate: vi.fn<JellyfinAuthentication['authenticate']>(
      async (_baseUrl, username, password, expectedServerId) => {
        if (expectedServerId !== undefined && expectedServerId !== SERVER_ID)
          throw new JellyfinAuthError('The linked Jellyfin server does not match.', 502);
        if (password !== JELLYFIN_PASSWORD)
          throw new JellyfinAuthError('Jellyfin rejected the credentials.', 401);
        if (['member', 'disabled-admin'].includes(username))
          throw new JellyfinAuthError('An enabled administrator account is required.', 403);
        const accessToken = `interactive-secret-${behavior.tokens.length + 1}`;
        behavior.tokens.push(accessToken);
        return {
          serverId: SERVER_ID,
          userId: username === 'second-admin' ? 'second-admin-id' : 'administrator-id',
          username,
          accessToken,
        };
      },
    ),
    validateSession: vi.fn<JellyfinAuthentication['validateSession']>(
      async (_baseUrl, accessToken, expectedServerId, expectedUserId) => {
        if (behavior.validationError) throw behavior.validationError;
        if (behavior.revoked.has(accessToken))
          throw new JellyfinAuthError('Jellyfin rejected the session.', 401);
        return {
          serverId: expectedServerId,
          userId: expectedUserId,
          username: expectedUserId === 'second-admin-id' ? 'second-admin' : 'administrator',
          accessToken,
        };
      },
    ),
    signOut: vi.fn<JellyfinAuthentication['signOut']>(async (_url, accessToken) => {
      behavior.revoked.add(accessToken);
    }),
    validateApiKey: vi.fn<JellyfinAuthentication['validateApiKey']>(
      async (_baseUrl, apiKey, expectedServerId) => {
        if (behavior.keyValidationError) throw behavior.keyValidationError;
        if (expectedServerId !== undefined && expectedServerId !== SERVER_ID)
          throw new JellyfinAuthError('The linked Jellyfin server does not match.', 502);
        if (!behavior.keys.includes(apiKey)) behavior.keys.push(apiKey);
        await behavior.keyValidationGate?.(apiKey);
        return {
          serverId: SERVER_ID,
          apiKeyName: `Supplied key ${apiKey === API_KEY ? 'one' : 'two'}`,
        };
      },
    ),
  } satisfies JellyfinAuthentication;
  return { auth, behavior };
}

async function fixture(
  options: {
    directory?: string;
    authentication?: ReturnType<typeof fakeAuthentication>;
    existingServerUrl?: string;
    legacyPendingCode?: string;
    legacyPreviousServerId?: string;
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'jellyport-jellyfin-auth-'));
  directories.add(directory);
  const servers = new DemoServers();
  const mediaCalls: Array<Parameters<ClientFactory>> = [];
  const clientFactory: ClientFactory = (...args) => {
    mediaCalls.push(args);
    return servers.factory(...args);
  };
  const authentication = options.authentication ?? fakeAuthentication();
  if (options.existingServerUrl || options.legacyPendingCode) {
    const previous = new Store(directory);
    try {
      if (options.existingServerUrl)
        previous.saveSettings({ ...previous.settings(), jellyfin_url: options.existingServerUrl });
      if (options.legacyPendingCode)
        previous.db.prepare('INSERT OR REPLACE INTO auth_state VALUES (1,?)').run(
          previous.encrypt({
            kind: 'pending',
            generation: 'existing-generation',
            setupCode: options.legacyPendingCode,
            ...(options.legacyPreviousServerId
              ? { previousServerId: options.legacyPreviousServerId }
              : {}),
          }),
        );
    } finally {
      previous.close();
    }
  }
  const app = await createApp({
    demo: false,
    dataDir: directory,
    authClient: authentication.auth,
    clientFactory,
  });
  apps.add(app);
  return { app, directory, servers, mediaCalls, ...authentication };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const app of apps) await app.close();
  apps.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function browser(response: Response, nested = false): Browser {
  const body = nested ? response.json().session : response.json();
  const cookie = response.cookies.find((value) => value.name === 'jellyport_session');
  expect(cookie).toBeDefined();
  return { cookie: `${cookie!.name}=${cookie!.value}`, csrf: body.csrf_token as string };
}
function headers(value: Browser) {
  return { cookie: value.cookie, 'x-csrf-token': value.csrf };
}

function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    started,
    release,
    wait: async () => {
      entered();
      await waiting;
    },
  };
}
async function anonymous(app: JellyportApp): Promise<Browser> {
  const response = await app.inject('/api/session');
  expect(response.statusCode).toBe(200);
  return browser(response);
}
async function connect(value: Fixture, current?: Browser) {
  const initial = current ?? (await anonymous(value.app));
  const response = await value.app.inject({
    method: 'POST',
    url: '/api/setup/connect',
    headers: headers(initial),
    payload: {
      jellyfin_url: `${SERVER_URL}/`,
      api_key: API_KEY,
    },
  });
  expect(response.statusCode).toBe(200);
  return { initial, response, current: browser(response, true) };
}
async function complete(value: Fixture, current: Browser) {
  return value.app.inject({
    method: 'POST',
    url: '/api/setup/complete',
    headers: headers(current),
    payload: { template_user_id: 'template', jellyfin_public_url: 'https://watch.example.test/' },
  });
}
async function configured(options: Parameters<typeof fixture>[0] = {}) {
  const value = await fixture(options);
  const connected = await connect(value);
  const response = await complete(value, connected.current);
  expect(response.statusCode).toBe(200);
  expect(response.json().authenticated).toBe(false);
  const signedIn = await signIn(value);
  return { ...value, current: signedIn.current, setupBrowser: connected.current };
}
async function signIn(value: Fixture, username = 'administrator') {
  const initial = await anonymous(value.app);
  const response = await value.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: headers(initial),
    payload: { username, password: JELLYFIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return { current: browser(response), response };
}

describe('first-time Jellyfin API-key setup', () => {
  it('offers direct setup while protecting private settings and rejects obsolete credentials', async () => {
    const value = await fixture();
    const initial = await anonymous(value.app);
    const view = (
      await value.app.inject({ url: '/api/session', headers: headers(initial) })
    ).json();
    expect(view).toMatchObject({
      authenticated: false,
      setup_required: true,
      setup_connected: false,
    });
    expect(view).not.toHaveProperty('setup_protection');
    expect(view).not.toHaveProperty('setup_code');
    expect(value.app.jellyport.store.authState()).not.toHaveProperty('setupCode');
    expect((await value.app.inject('/api/settings')).statusCode).toBe(401);
    expect(
      (await value.app.inject({ url: '/api/setup', headers: headers(initial) })).statusCode,
    ).toBe(403);
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: {
        jellyfin_url: SERVER_URL,
        username: 'administrator',
        password: JELLYFIN_PASSWORD,
        api_key: API_KEY,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(value.auth.authenticate).not.toHaveBeenCalled();
    expect(value.auth.validateApiKey).not.toHaveBeenCalled();
    expect(value.mediaCalls).toEqual([]);
  });

  it('protects setup, login, and completion against CSRF, including encoded route aliases', async () => {
    const value = await fixture();
    const initial = await anonymous(value.app);
    for (const url of [
      '/api/setup/connect',
      '/%61pi/setup/connect',
      '/api/setup/complete',
      '/%61pi/setup/complete',
      '/api/login',
      '/%61pi/login',
    ]) {
      const response = await value.app.inject({
        method: 'POST',
        url,
        headers: { cookie: initial.cookie },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    }
    expect(value.auth.authenticate).not.toHaveBeenCalled();
    expect(value.auth.validateApiKey).not.toHaveBeenCalled();
  });

  it('rotates the setup cookie, lists only enabled ordinary templates, and resumes without exposing the key', async () => {
    const value = await fixture();
    value.servers.users.jellyfin.push(
      {
        Id: 'admin-template',
        Name: 'Administrator',
        Policy: { IsAdministrator: true, IsDisabled: false },
      },
      {
        Id: 'disabled-template',
        Name: 'Disabled',
        Policy: { IsAdministrator: false, IsDisabled: true },
      },
      { Id: 'unverified-template', Name: 'Unverified', Policy: {} },
    );
    const result = await connect(value);
    expect(result.current.cookie).not.toBe(result.initial.cookie);
    expect(result.current.csrf).not.toBe(result.initial.csrf);
    expect(result.response.json().session).toMatchObject({
      authenticated: false,
      setup_required: true,
      setup_connected: true,
    });
    expect(result.response.json().templates.map((item: { Id: string }) => item.Id)).toEqual([
      'template',
      'j-river',
    ]);
    expect(value.auth.validateApiKey).toHaveBeenCalledWith(SERVER_URL, API_KEY, undefined);
    expect(value.auth.authenticate).not.toHaveBeenCalled();
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(result.current) }))
        .statusCode,
    ).toBe(401);
    const resumed = await value.app.inject({ url: '/api/setup', headers: headers(result.current) });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().session.setup_connected).toBe(true);
    expect(value.auth.validateApiKey).toHaveBeenLastCalledWith(SERVER_URL, API_KEY, SERVER_ID);
    expect(result.response.body + resumed.body).not.toContain(API_KEY);
    expect((await complete(value, result.initial)).statusCode).toBe(403);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
  });

  it('refuses a supplied key rejected by Jellyfin', async () => {
    const status = 400;
    const value = await fixture();
    value.behavior.keyValidationError = new JellyfinAuthError(
      'Jellyfin rejected the API key.',
      status,
    );
    const initial = await anonymous(value.app);
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: { jellyfin_url: SERVER_URL, api_key: API_KEY },
    });
    expect(response.statusCode).toBe(status);
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
    expect(value.auth.authenticate).not.toHaveBeenCalled();
    expect(value.auth.signOut).not.toHaveBeenCalled();
    expect(value.mediaCalls).toEqual([]);
  });

  it('validates the selected template and public URL before saving the supplied key', async () => {
    const value = await fixture();
    value.servers.users.jellyfin.push({
      Id: 'administrator',
      Name: 'Admin',
      Policy: { IsAdministrator: true, IsDisabled: false },
    });
    const { current } = await connect(value);
    for (const payload of [
      { template_user_id: 'administrator', jellyfin_public_url: '' },
      { template_user_id: 'template', jellyfin_public_url: 'javascript:alert(1)' },
    ]) {
      const response = await value.app.inject({
        method: 'POST',
        url: '/api/setup/complete',
        headers: headers(current),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.auth.signOut).not.toHaveBeenCalled();
  });

  it('commits the encrypted server binding and supplied key, then requires an administrator sign-in', async () => {
    const value = await fixture();
    const pending = await connect(value);
    const response = await complete(value, pending.current);
    expect(response.statusCode).toBe(200);
    const current = browser(response);
    expect(current.cookie).not.toBe(pending.current.cookie);
    expect(current.csrf).not.toBe(pending.current.csrf);
    expect(response.json()).toMatchObject({
      authenticated: false,
      setup_required: false,
      setup_connected: false,
    });
    expect(response.json().user).toBeUndefined();
    expect(value.auth.authenticate).not.toHaveBeenCalled();
    expect(value.app.jellyport.store.authState()).toMatchObject({
      kind: 'configured',
      serverUrl: SERVER_URL,
      serverId: SERVER_ID,
      apiKeyName: 'Supplied key one',
    });
    expect(value.app.jellyport.store.settings()).toMatchObject({
      jellyfin_url: SERVER_URL,
      jellyfin_api_key: API_KEY,
      template_user_id: 'template',
      jellyfin_public_url: 'https://watch.example.test',
    });
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(current) })).statusCode,
    ).toBe(401);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(pending.current) }))
        .statusCode,
    ).toBe(401);
    expect((await complete(value, pending.current)).statusCode).toBe(403);
    const stored = Buffer.concat(
      readdirSync(value.directory)
        .filter((file) => file.startsWith('jellyport.db'))
        .map((file) => readFileSync(join(value.directory, file))),
    );
    for (const secret of [JELLYFIN_PASSWORD, SERVER_URL, API_KEY]) {
      expect(stored.includes(Buffer.from(secret))).toBe(false);
      expect(response.body).not.toContain(secret);
    }
    expect(value.auth.signOut).not.toHaveBeenCalled();
    expect((await signIn(value)).response.json().authenticated).toBe(true);
  });

  it('leaves the wizard resumable if supplied-key validation temporarily fails', async () => {
    const value = await fixture();
    const { current } = await connect(value);
    value.behavior.keyValidationError = new JellyfinAuthError(
      'Jellyfin is temporarily unavailable.',
      502,
    );
    expect((await complete(value, current)).statusCode).toBe(502);
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
    expect(value.auth.signOut).not.toHaveBeenCalled();
    value.behavior.keyValidationError = undefined;
    expect((await complete(value, current)).statusCode).toBe(200);
  });

  it('allows only one concurrent setup completion without revoking user-owned keys', async () => {
    const value = await fixture();
    const first = await connect(value);
    const second = await connect(value);
    const pending = barrier();
    let arrivals = 0;
    value.behavior.keyValidationGate = async () => {
      if (++arrivals === 2) pending.release();
      await pending.wait();
    };
    const responses = await Promise.all([
      complete(value, first.current),
      complete(value, second.current),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 403]);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(API_KEY);
    expect(value.auth.signOut).not.toHaveBeenCalled();
  });

  it.each(['short', 'replace-with-a-long-random-password', 'previous-Jellyport-password!42'])(
    'ignores the obsolete local admin environment password: %s',
    async (legacyPassword) => {
      vi.stubEnv('JELLYPORT_ADMIN_PASSWORD', legacyPassword);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const value = await fixture();
      const initial = await anonymous(value.app);
      expect(
        (await value.app.inject({ url: '/api/session', headers: headers(initial) })).json()
          .setup_required,
      ).toBe(true);
      const connected = await connect(value, initial);
      const response = await complete(value, connected.current);
      expect(response.statusCode).toBe(200);
      const current = browser(response);
      expect(
        (
          await value.app.inject({
            method: 'POST',
            url: '/api/login',
            headers: headers(current),
            payload: { username: 'administrator', password: legacyPassword },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await value.app.inject({
            method: 'POST',
            url: '/api/login',
            headers: headers(current),
            payload: { username: 'administrator', password: JELLYFIN_PASSWORD },
          })
        ).statusCode,
      ).toBe(200);
      expect(log.mock.calls.flat().join(' ')).not.toContain(legacyPassword);
    },
  );

  it('pins an existing installation to its saved URL before transmitting any key', async () => {
    const value = await fixture({ existingServerUrl: `${SERVER_URL}/` });
    const initial = await anonymous(value.app);
    expect(
      (await value.app.inject({ url: '/api/session', headers: headers(initial) })).json()
        .setup_server_url,
    ).toBe(SERVER_URL);
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: { jellyfin_url: 'https://different-server.test', api_key: API_KEY },
    });
    expect([400, 403]).toContain(response.statusCode);
    expect(value.auth.validateApiKey).not.toHaveBeenCalled();
    expect(value.mediaCalls).toEqual([]);
    expect((await complete(value, (await connect(value, initial)).current)).statusCode).toBe(200);
  });

  it.each([undefined, SERVER_ID])(
    'migrates pending bootstrap state without its obsolete code; existing pin: %s',
    async (previousServerId) => {
      const legacyCode = 'obsolete-persisted-setup-code';
      const value = await fixture({
        existingServerUrl: SERVER_URL,
        legacyPendingCode: legacyCode,
        legacyPreviousServerId: previousServerId,
      });
      expect(value.app.jellyport.store.authState()).toMatchObject({
        kind: 'pending',
        generation: 'existing-generation',
        serverUrl: SERVER_URL,
      });
      expect(value.app.jellyport.store.authState()).not.toHaveProperty('setupCode');
      expect(value.app.jellyport.store.authState()).toMatchObject(
        previousServerId ? { previousServerId } : {},
      );
      const result = await connect(value);
      expect(value.auth.validateApiKey).toHaveBeenLastCalledWith(
        SERVER_URL,
        API_KEY,
        previousServerId,
      );
      expect(result.response.body).not.toContain(legacyCode);
      expect((await complete(value, result.current)).statusCode).toBe(200);
    },
  );

  it('rejects completion after logout without saving or revoking the supplied key', async () => {
    const value = await fixture();
    const { current } = await connect(value);
    const pending = barrier();
    value.behavior.keyValidationGate = () => pending.wait();
    const finishing = complete(value, current);
    await pending.started;
    expect(
      (await value.app.inject({ method: 'POST', url: '/api/logout', headers: headers(current) }))
        .statusCode,
    ).toBe(200);
    pending.release();
    expect((await finishing).statusCode).toBe(403);
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
    expect(value.auth.signOut).not.toHaveBeenCalled();
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(current) })).statusCode,
    ).toBe(401);
  });

  it('does not restore a setup connection when key validation finishes after logout', async () => {
    const value = await fixture();
    const initial = await anonymous(value.app);
    const pending = barrier();
    value.behavior.keyValidationGate = () => pending.wait();
    const connecting = value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: { jellyfin_url: SERVER_URL, api_key: API_KEY },
    });
    await pending.started;
    expect(
      (await value.app.inject({ method: 'POST', url: '/api/logout', headers: headers(initial) }))
        .statusCode,
    ).toBe(200);
    pending.release();
    const response = await connecting;
    expect([401, 403]).toContain(response.statusCode);
    expect(response.cookies).toEqual([]);
    expect(value.auth.signOut).not.toHaveBeenCalled();
    expect(
      (await value.app.inject({ url: '/api/setup', headers: headers(initial) })).statusCode,
    ).toBe(403);
  });
});

describe('configured Jellyfin administrator sessions', () => {
  it('pins login to the configured server, rotates its cookie, and allows another verified administrator', async () => {
    const value = await configured();
    const { current, response } = await signIn(value, 'second-admin');
    expect(response.json().user).toEqual({ id: 'second-admin-id', name: 'second-admin' });
    expect(value.auth.authenticate).toHaveBeenLastCalledWith(
      SERVER_URL,
      'second-admin',
      JELLYFIN_PASSWORD,
      SERVER_ID,
    );
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(current) })).statusCode,
    ).toBe(200);
    expect(value.auth.validateSession).toHaveBeenLastCalledWith(
      SERVER_URL,
      value.behavior.tokens[1],
      SERVER_ID,
      'second-admin-id',
    );
    for (const token of value.behavior.tokens) expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(JELLYFIN_PASSWORD);
  });

  it('redacts managed keys and locks the linked server and service credential in settings', async () => {
    const value = await configured();
    const requestHeaders = headers(value.current);
    const initial = await value.app.inject({ url: '/api/settings', headers: requestHeaders });
    expect(initial.json()).toMatchObject({
      jellyfin_api_key_set: true,
      jellyfin_auth_managed: true,
    });
    expect(initial.json().jellyfin_api_key).toBeUndefined();
    expect(initial.body).not.toContain(value.behavior.keys[0]!);
    for (const payload of [
      { jellyfin_url: 'https://other-server.test' },
      { jellyfin_api_key: 'replacement-secret' },
    ]) {
      expect(
        (
          await value.app.inject({
            method: 'PUT',
            url: '/api/settings',
            headers: requestHeaders,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    const updated = await value.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: requestHeaders,
      payload: {
        jellyfin_url: `${SERVER_URL}/`,
        jellyfin_api_key: '',
        emby_api_key: 'emby-sensitive-key',
        emby_url: 'http://emby:8096',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain('emby-sensitive-key');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(value.behavior.keys[0]);
  });

  it.each([401, 403])(
    'invalidates Jellyport immediately on upstream HTTP %i before credentials can be revealed',
    async (status) => {
      const value = await configured();
      const created = await value.app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: headers(value.current),
        payload: { username: 'new-member' },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json().id as string;
      await value.app.jellyport.service.jobTasks.get(jobId);
      expect(
        value.app.jellyport.store.db
          .prepare('SELECT COUNT(*) AS count FROM credentials WHERE job_id=?')
          .get(jobId)?.count,
      ).toBe(1);
      value.behavior.validationError = new JellyfinAuthError(
        'Administrator permission was removed.',
        status,
      );
      const response = await value.app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/credentials`,
        headers: headers(value.current),
      });
      expect(response.statusCode).toBe(401);
      expect(
        value.app.jellyport.store.db
          .prepare('SELECT COUNT(*) AS count FROM credentials WHERE job_id=?')
          .get(jobId)?.count,
      ).toBe(1);
      expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[0]);
      value.behavior.validationError = undefined;
      expect(
        (await value.app.inject({ url: '/api/settings', headers: headers(value.current) }))
          .statusCode,
      ).toBe(401);
      const signedIn = await signIn(value);
      const revealed = await value.app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/credentials`,
        headers: headers(signedIn.current),
      });
      expect(revealed.statusCode).toBe(200);
      expect(revealed.json().credentials).toHaveLength(1);
    },
  );

  it('refuses account mutations after upstream permission loss, including encoded aliases', async () => {
    const value = await configured();
    const previousUsers = value.servers.users.jellyfin.length;
    const previousCalls = value.mediaCalls.length;
    value.behavior.validationError = new JellyfinAuthError('The administrator was disabled.', 403);
    const response = await value.app.inject({
      method: 'POST',
      url: '/%61pi/accounts',
      headers: headers(value.current),
      payload: { username: 'forbidden-member' },
    });
    expect(response.statusCode).toBe(401);
    expect(value.servers.users.jellyfin).toHaveLength(previousUsers);
    expect(value.mediaCalls).toHaveLength(previousCalls);
    expect(value.app.jellyport.store.jobs()).toEqual([]);
  });

  it('preserves the local login during a transient Jellyfin outage while refusing protected requests', async () => {
    const value = await configured();
    value.behavior.validationError = new JellyfinAuthError(
      'Jellyfin is temporarily unavailable.',
      502,
    );
    const unavailable = await value.app.inject({
      url: '/api/settings',
      headers: headers(value.current),
    });
    expect(unavailable.statusCode).toBe(502);
    expect(value.auth.signOut).not.toHaveBeenCalled();
    value.behavior.validationError = undefined;
    const recovered = await value.app.inject({
      url: '/api/session',
      headers: headers(value.current),
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ authenticated: true, csrf_token: value.current.csrf });
    expect(recovered.cookies).toEqual([]);
  });

  it('logs out the interactive token while preserving the service key and another administrator’s session', async () => {
    const value = await configured();
    const second = await signIn(value, 'second-admin');
    const serviceKey = value.app.jellyport.store.settings().jellyfin_api_key;
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: headers(value.current),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().authenticated).toBe(false);
    expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[0]);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(serviceKey);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(value.current) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(second.current) }))
        .statusCode,
    ).toBe(200);
  });

  it('replaces the service key through a verified admin session without exposing it', async () => {
    const value = await configured();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
      payload: { api_key: 'replacement-service-secret' },
    });
    expect(response.statusCode).toBe(200);
    expect(value.auth.validateApiKey).toHaveBeenLastCalledWith(
      SERVER_URL,
      'replacement-service-secret',
      SERVER_ID,
    );
    expect(value.app.jellyport.store.settings().jellyfin_api_key).not.toBe(previousKey);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(value.behavior.keys[1]);
    expect(value.app.jellyport.store.authState()).toMatchObject({
      apiKeyName: 'Supplied key two',
    });
    for (const secret of [...value.behavior.keys, ...value.behavior.tokens])
      expect(response.body).not.toContain(secret);
    expect(value.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([400, 502])(
    'retains the previous service key if replacement validation fails with %i',
    async (status) => {
      const value = await configured();
      const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
      const previousState = value.app.jellyport.store.authState();
      value.behavior.keyValidationError = new JellyfinAuthError('Key validation failed.', status);
      expect(
        (
          await value.app.inject({
            method: 'POST',
            url: '/api/auth/service-key',
            headers: headers(value.current),
            payload: { api_key: 'replacement-service-secret' },
          })
        ).statusCode,
      ).toBe(status);
      expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(previousKey);
      expect(value.app.jellyport.store.authState()).toEqual(previousState);
    },
  );

  it('requires an explicit replacement API key and CSRF protection before validation', async () => {
    const value = await configured();
    const validations = value.auth.validateApiKey.mock.calls.length;
    for (const payload of [
      {},
      { api_key: '' },
      { api_key: 12 },
      { api_key: 'replacement-service-secret', unexpected: true },
    ]) {
      const response = await value.app.inject({
        method: 'POST',
        url: '/api/auth/service-key',
        headers: headers(value.current),
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
    const noCsrf = await value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: { cookie: value.current.cookie },
      payload: { api_key: 'replacement-service-secret' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(value.auth.validateApiKey).toHaveBeenCalledTimes(validations);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(API_KEY);
  });

  it('requires administrator access rather than accepting the API key as a browser login', async () => {
    const value = await configured();
    const initial = await anonymous(value.app);
    const validations = value.auth.validateApiKey.mock.calls.length;
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(initial),
      payload: { api_key: 'replacement-service-secret' },
    });
    expect(response.statusCode).toBe(401);
    expect(value.auth.validateApiKey).toHaveBeenCalledTimes(validations);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(API_KEY);
  });

  it('rejects a replacement that finishes after logout without saving or revoking either key', async () => {
    const value = await configured();
    const pending = barrier();
    value.behavior.keyValidationGate = () => pending.wait();
    const replacing = value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
      payload: { api_key: 'replacement-service-secret' },
    });
    await pending.started;
    expect(
      (
        await value.app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: headers(value.current),
        })
      ).statusCode,
    ).toBe(200);
    pending.release();
    const response = await replacing;
    expect([401, 403]).toContain(response.statusCode);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(API_KEY);
    expect(value.auth.signOut.mock.calls).toEqual([[SERVER_URL, value.behavior.tokens[0]]]);
    expect(response.body).not.toContain('replacement-service-secret');
  });

  it('rechecks administrator permission after validating a replacement key', async () => {
    const value = await configured();
    const pending = barrier();
    value.behavior.keyValidationGate = () => pending.wait();
    const replacing = value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
      payload: { api_key: 'replacement-service-secret' },
    });
    await pending.started;
    value.behavior.validationError = new JellyfinAuthError(
      'Administrator permission was removed.',
      403,
    );
    pending.release();
    expect([401, 403]).toContain((await replacing).statusCode);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(API_KEY);
  });

  it('rejects key replacement after a local authentication reset without changing the saved key', async () => {
    const value = await configured();
    const pending = barrier();
    value.behavior.keyValidationGate = () => pending.wait();
    const replacing = value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
      payload: { api_key: 'replacement-service-secret' },
    });
    await pending.started;
    const reset = value.app.jellyport.store.resetAuth();
    pending.release();
    expect([401, 403]).toContain((await replacing).statusCode);
    expect(value.app.jellyport.store.authState()).toEqual(reset);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(API_KEY);
    expect(value.auth.signOut).not.toHaveBeenCalled();
  });

  it('serializes replacement attempts so an overlapping request cannot overwrite another key', async () => {
    const value = await configured();
    const pending = barrier();
    value.behavior.keyValidationGate = () => pending.wait();
    const replacing = value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
      payload: { api_key: 'replacement-service-secret' },
    });
    await pending.started;
    const overlapping = await value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
      payload: { api_key: 'overlapping-service-secret' },
    });
    expect(overlapping.statusCode).toBe(400);
    pending.release();
    expect((await replacing).statusCode).toBe(200);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(
      'replacement-service-secret',
    );
    expect(value.behavior.keys).not.toContain('overlapping-service-secret');
  });

  it('persists the server binding across restarts and ignores a stale or short legacy password after setup', async () => {
    const value = await configured();
    const previousState = value.app.jellyport.store.authState();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    await value.app.close();
    apps.delete(value.app);
    expect(existsSync(join(value.directory, 'jellyport.db'))).toBe(true);
    vi.stubEnv('JELLYPORT_ADMIN_PASSWORD', 'short');
    const restarted = await fixture({
      directory: value.directory,
      authentication: { auth: value.auth, behavior: value.behavior },
    });
    expect(restarted.app.jellyport.store.authState()).not.toHaveProperty('setupCode');
    expect(restarted.app.jellyport.store.authState()).toEqual(previousState);
    expect(restarted.app.jellyport.store.settings().jellyfin_api_key).toBe(previousKey);
    expect(
      (await restarted.app.inject({ url: '/api/settings', headers: headers(value.current) }))
        .statusCode,
    ).toBe(401);
    const signedIn = await signIn(restarted);
    expect(signedIn.response.json().setup_required).toBe(false);
    expect(value.auth.authenticate).toHaveBeenLastCalledWith(
      SERVER_URL,
      'administrator',
      JELLYFIN_PASSWORD,
      SERVER_ID,
    );
    expect(value.auth.validateApiKey).toHaveBeenCalled();
  });

  it('keeps the original server URL and fingerprint during local authentication recovery', async () => {
    const value = await configured();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    const reset = value.app.jellyport.store.resetAuth();
    expect(reset).toMatchObject({ previousServerId: SERVER_ID, serverUrl: SERVER_URL });
    expect(reset).not.toHaveProperty('setupCode');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(previousKey);
    const initial = await anonymous(value.app);
    const previousCalls = value.auth.validateApiKey.mock.calls.length;
    const wrongServer = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: {
        jellyfin_url: 'https://different-server.test',
        api_key: API_KEY,
      },
    });
    expect([400, 403]).toContain(wrongServer.statusCode);
    expect(value.auth.validateApiKey).toHaveBeenCalledTimes(previousCalls);
    expect(value.app.jellyport.store.authState()).toEqual(reset);
    value.auth.validateApiKey.mockImplementationOnce(async (_url, _apiKey, expectedServerId) => {
      expect(expectedServerId).toBe(SERVER_ID);
      throw new JellyfinAuthError(
        'The connected Jellyfin server does not match this installation.',
        502,
      );
    });
    const changedServer = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: { jellyfin_url: SERVER_URL, api_key: API_KEY },
    });
    expect(changedServer.statusCode).toBe(502);
    const connected = await connect(value, initial);
    expect(value.auth.validateApiKey).toHaveBeenLastCalledWith(SERVER_URL, API_KEY, SERVER_ID);
    expect((await complete(value, connected.current)).statusCode).toBe(200);
    expect(value.app.jellyport.store.authState()).toMatchObject({
      kind: 'configured',
      serverId: SERVER_ID,
    });
  });

  it('allows a local server-address recovery while retaining the original Jellyfin fingerprint', async () => {
    const value = await configured();
    const relocatedUrl = 'http://relocated-jellyfin:8096';
    const reset = value.app.jellyport.store.resetAuth(relocatedUrl);
    expect(reset).toMatchObject({ serverUrl: relocatedUrl, previousServerId: SERVER_ID });
    const initial = await anonymous(value.app);
    expect(
      (await value.app.inject({ url: '/api/session', headers: headers(initial) })).json()
        .setup_server_url,
    ).toBe(relocatedUrl);
    const connection = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: {
        jellyfin_url: relocatedUrl,
        api_key: API_KEY,
      },
    });
    expect(connection.statusCode).toBe(200);
    expect(value.auth.validateApiKey).toHaveBeenLastCalledWith(relocatedUrl, API_KEY, SERVER_ID);
    expect((await complete(value, browser(connection, true))).statusCode).toBe(200);
    expect(value.app.jellyport.store.authState()).toMatchObject({
      kind: 'configured',
      serverUrl: relocatedUrl,
      serverId: SERVER_ID,
    });
    expect(value.app.jellyport.store.settings().jellyfin_url).toBe(relocatedUrl);
  });

  it('does not reveal credentials when remote authorization finishes after local logout', async () => {
    const value = await configured();
    const created = await value.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: headers(value.current),
      payload: { username: 'race-member' },
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().id as string;
    await value.app.jellyport.service.jobTasks.get(jobId);
    const pending = barrier();
    // This result was valid when the upstream request started; do not let the fake independently
    // detect logout, so the test specifically exercises Jellyport's stale-session guard.
    value.auth.validateSession.mockImplementationOnce(
      async (_url, accessToken, serverId, userId) => {
        await pending.wait();
        return { serverId, userId, username: 'administrator', accessToken };
      },
    );
    const revealing = value.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/credentials`,
      headers: headers(value.current),
    });
    await pending.started;
    expect(
      (
        await value.app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: headers(value.current),
        })
      ).statusCode,
    ).toBe(200);
    pending.release();
    const response = await revealing;
    expect(response.statusCode).toBe(401);
    expect(response.json().credentials).toBeUndefined();
    expect(
      value.app.jellyport.store.db
        .prepare('SELECT COUNT(*) AS count FROM credentials WHERE job_id=?')
        .get(jobId)?.count,
    ).toBe(1);
  });

  it('revokes a login result that arrives after its original browser session was logged out', async () => {
    const value = await configured();
    const initial = await anonymous(value.app);
    const pending = barrier();
    const authenticate = value.auth.authenticate.getMockImplementation()!;
    value.auth.authenticate.mockImplementationOnce(async (...args) => {
      const identity = await authenticate(...args);
      await pending.wait();
      return identity;
    });
    const signingIn = value.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: headers(initial),
      payload: { username: 'administrator', password: JELLYFIN_PASSWORD },
    });
    await pending.started;
    expect(
      (await value.app.inject({ method: 'POST', url: '/api/logout', headers: headers(initial) }))
        .statusCode,
    ).toBe(200);
    pending.release();
    const response = await signingIn;
    expect([401, 403]).toContain(response.statusCode);
    expect(response.cookies).toEqual([]);
    expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[1]);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(initial) })).statusCode,
    ).toBe(401);
  });

  it('expires setup sessions after thirty minutes without revoking the supplied API key', async () => {
    const value = await fixture();
    const { current } = await connect(value);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_801_000);
    expect(
      (await value.app.inject({ url: '/api/setup', headers: headers(current) })).statusCode,
    ).toBe(403);
    expect(value.auth.signOut).not.toHaveBeenCalled();
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
  });

  it('expires authenticated sessions after eight hours and revokes only their interactive token', async () => {
    const value = await configured();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 28_801_000);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(value.current) }))
        .statusCode,
    ).toBe(401);
    expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[0]);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(value.behavior.keys[0]);
  });
});
