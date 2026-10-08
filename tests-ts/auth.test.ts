import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';
import type { ClientFactory } from '../server/media.js';

const SERVER_URL = 'http://jellyfin:8096';
const SERVER_ID = 'jellyfin-server-id';
const JELLYFIN_PASSWORD = 'actual-Jellyfin-administrator-password!42';
const apps = new Set<JellyportApp>();
const directories = new Set<string>();
type Browser = { cookie: string; csrf: string };
type Response = Awaited<ReturnType<JellyportApp['inject']>>;

function fakeAuthentication() {
  const behavior = {
    validationError: undefined as JellyfinAuthError | undefined,
    createKeyError: undefined as JellyfinAuthError | undefined,
    createKeyGate: undefined as ((key: string) => Promise<void>) | undefined,
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
    createApiKey: vi.fn<JellyfinAuthentication['createApiKey']>(async () => {
      if (behavior.createKeyError) throw behavior.createKeyError;
      const key = `service-secret-${behavior.keys.length + 1}`;
      behavior.keys.push(key);
      await behavior.createKeyGate?.(key);
      return key;
    }),
    deleteApiKey: vi.fn<JellyfinAuthentication['deleteApiKey']>(async () => {}),
  } satisfies JellyfinAuthentication;
  return { auth, behavior };
}

async function fixture(
  options: {
    adminPassword?: string;
    directory?: string;
    authentication?: ReturnType<typeof fakeAuthentication>;
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
  let setupCode = '';
  const app = await createApp({
    demo: false,
    dataDir: directory,
    adminPassword: options.adminPassword ?? '',
    authClient: authentication.auth,
    clientFactory,
    onSetupCode: (code) => {
      setupCode = code;
    },
  });
  apps.add(app);
  return { app, directory, servers, mediaCalls, setupCode, ...authentication };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(async () => {
  vi.restoreAllMocks();
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
async function connect(value: Fixture, current?: Browser, setupCode = value.setupCode) {
  const initial = current ?? (await anonymous(value.app));
  const response = await value.app.inject({
    method: 'POST',
    url: '/api/setup/connect',
    headers: headers(initial),
    payload: {
      setup_code: setupCode,
      jellyfin_url: `${SERVER_URL}/`,
      username: 'administrator',
      password: JELLYFIN_PASSWORD,
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
  const connected = await connect(value, undefined, options?.adminPassword ?? value.setupCode);
  const response = await complete(value, connected.current);
  expect(response.statusCode).toBe(200);
  return { ...value, current: browser(response), setupBrowser: connected.current };
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

describe('first-time Jellyfin administrator setup', () => {
  it('requires the local setup code before contacting a server or exposing settings', async () => {
    const value = await fixture();
    const initial = await anonymous(value.app);
    expect(value.setupCode.length).toBeGreaterThanOrEqual(24);
    const view = (
      await value.app.inject({ url: '/api/session', headers: headers(initial) })
    ).json();
    expect(view).toMatchObject({
      authenticated: false,
      setup_required: true,
      setup_connected: false,
      setup_protection: 'setup_code',
    });
    expect(JSON.stringify(view)).not.toContain(value.setupCode);
    expect((await value.app.inject('/api/settings')).statusCode).toBe(401);
    expect(
      (await value.app.inject({ url: '/api/setup', headers: headers(initial) })).statusCode,
    ).toBe(403);
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: {
        setup_code: 'wrong-local-code',
        jellyfin_url: 'https://untrusted.test',
        username: 'administrator',
        password: JELLYFIN_PASSWORD,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(value.auth.authenticate).not.toHaveBeenCalled();
    expect(value.mediaCalls).toEqual([]);
    expect(value.auth.createApiKey).not.toHaveBeenCalled();
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
  });

  it('rotates the setup cookie, lists only enabled ordinary templates, and resumes the connected wizard', async () => {
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
    expect(value.auth.authenticate).toHaveBeenCalledWith(
      SERVER_URL,
      'administrator',
      JELLYFIN_PASSWORD,
      undefined,
    );
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(result.current) }))
        .statusCode,
    ).toBe(401);
    const resumed = await value.app.inject({ url: '/api/setup', headers: headers(result.current) });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().session.setup_connected).toBe(true);
    expect(value.auth.validateSession).toHaveBeenCalledWith(
      SERVER_URL,
      value.behavior.tokens[0],
      SERVER_ID,
      'administrator-id',
    );
    for (const secret of [JELLYFIN_PASSWORD, value.setupCode, value.behavior.tokens[0]!])
      expect(result.response.body + resumed.body).not.toContain(secret);
    expect((await complete(value, result.initial)).statusCode).toBe(403);
  });

  it.each(['member', 'disabled-admin'])(
    'refuses a Jellyfin account without enabled administrator access: %s',
    async (username) => {
      const value = await fixture();
      const initial = await anonymous(value.app);
      const response = await value.app.inject({
        method: 'POST',
        url: '/api/setup/connect',
        headers: headers(initial),
        payload: {
          setup_code: value.setupCode,
          jellyfin_url: SERVER_URL,
          username,
          password: JELLYFIN_PASSWORD,
        },
      });
      expect(response.statusCode).toBe(403);
      expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
      expect(value.auth.createApiKey).not.toHaveBeenCalled();
      expect(value.mediaCalls).toEqual([]);
    },
  );

  it('validates the chosen template and public URL before creating an API key', async () => {
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
    expect(value.auth.createApiKey).not.toHaveBeenCalled();
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
  });

  it('commits the encrypted server binding and service key, then rotates into an authenticated session', async () => {
    const value = await fixture();
    const pending = await connect(value);
    const response = await complete(value, pending.current);
    expect(response.statusCode).toBe(200);
    const current = browser(response);
    expect(current.cookie).not.toBe(pending.current.cookie);
    expect(current.csrf).not.toBe(pending.current.csrf);
    expect(response.json()).toMatchObject({
      authenticated: true,
      setup_required: false,
      setup_connected: false,
      user: { id: 'administrator-id', name: 'administrator' },
    });
    expect(value.auth.createApiKey).toHaveBeenCalledWith(
      SERVER_URL,
      value.behavior.tokens[0],
      expect.stringMatching(/^Jellyport [a-f0-9-]{36}$/),
    );
    expect(value.app.jellyport.store.authState()).toMatchObject({
      kind: 'configured',
      serverUrl: SERVER_URL,
      serverId: SERVER_ID,
    });
    expect(value.app.jellyport.store.settings()).toMatchObject({
      jellyfin_url: SERVER_URL,
      jellyfin_api_key: value.behavior.keys[0],
      template_user_id: 'template',
      jellyfin_public_url: 'https://watch.example.test',
    });
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(current) })).statusCode,
    ).toBe(200);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(pending.current) }))
        .statusCode,
    ).toBe(401);
    expect((await complete(value, pending.current)).statusCode).toBe(403);
    expect(value.auth.deleteApiKey).not.toHaveBeenCalled();

    const plaintextSettings = JSON.stringify(value.app.jellyport.store.settings());
    const plaintextBinding = JSON.stringify(value.app.jellyport.store.authState());
    expect(plaintextSettings + plaintextBinding).not.toContain(JELLYFIN_PASSWORD);
    expect(plaintextSettings + plaintextBinding).not.toContain(value.behavior.tokens[0]!);
    const stored = Buffer.concat(
      readdirSync(value.directory)
        .filter((file) => file.startsWith('jellyport.db'))
        .map((file) => readFileSync(join(value.directory, file))),
    );
    for (const secret of [
      JELLYFIN_PASSWORD,
      value.setupCode,
      SERVER_URL,
      value.behavior.tokens[0]!,
      value.behavior.keys[0]!,
    ]) {
      expect(stored.includes(Buffer.from(secret))).toBe(false);
      expect(response.body).not.toContain(secret);
    }
  });

  it('leaves the wizard resumable if dedicated API-key creation fails', async () => {
    const value = await fixture();
    const { current } = await connect(value);
    value.behavior.createKeyError = new JellyfinAuthError(
      'Jellyfin is temporarily unavailable.',
      502,
    );
    const response = await complete(value, current);
    expect(response.statusCode).toBe(502);
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
    expect(value.auth.deleteApiKey).not.toHaveBeenCalled();
    value.behavior.createKeyError = undefined;
    expect((await complete(value, current)).statusCode).toBe(200);
  });

  it('allows one concurrent setup completion and revokes the losing attempt’s newly created key', async () => {
    const value = await fixture();
    const first = await connect(value);
    const second = await connect(value);
    let release!: () => void;
    let bothEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    let arrivals = 0;
    value.behavior.createKeyGate = async () => {
      if (++arrivals === 2) bothEntered();
      await gate;
    };
    const completions = [complete(value, first.current), complete(value, second.current)];
    await entered;
    release();
    const responses = await Promise.all(completions);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 403]);
    expect(value.behavior.keys).toHaveLength(2);
    expect(value.auth.deleteApiKey).toHaveBeenCalledOnce();
    const deleted = value.auth.deleteApiKey.mock.calls[0]![2];
    expect(value.behavior.keys).toContain(deleted);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).not.toBe(deleted);
  });

  it('uses the existing flat password only to protect the one-time upgrade wizard', async () => {
    const legacyPassword = 'previous-Jellyport-password!42';
    const value = await fixture({ adminPassword: legacyPassword });
    expect(value.setupCode).toBe('');
    const initial = await anonymous(value.app);
    expect(
      (await value.app.inject({ url: '/api/session', headers: headers(initial) })).json()
        .setup_protection,
    ).toBe('legacy_password');
    const connected = await connect(value, initial, legacyPassword);
    const response = await complete(value, connected.current);
    expect(response.statusCode).toBe(200);
    const signedIn = browser(response);
    const loggedOut = await value.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: headers(signedIn),
    });
    const current = browser(loggedOut);
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
  });

  it('rejects a setup completion that returns after the connected session was logged out and revokes its new key', async () => {
    const value = await fixture();
    const { current } = await connect(value);
    const pending = barrier();
    value.behavior.createKeyGate = () => pending.wait();
    const finishing = complete(value, current);
    await pending.started;
    expect(
      (await value.app.inject({ method: 'POST', url: '/api/logout', headers: headers(current) }))
        .statusCode,
    ).toBe(200);
    pending.release();
    const response = await finishing;
    expect(response.statusCode).toBe(403);
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe('');
    expect(value.auth.deleteApiKey).toHaveBeenCalledWith(
      SERVER_URL,
      value.behavior.tokens[0],
      value.behavior.keys[0],
    );
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(current) })).statusCode,
    ).toBe(401);
  });

  it('does not restore a wizard session when connection authentication finishes after logout', async () => {
    const value = await fixture();
    const initial = await anonymous(value.app);
    const pending = barrier();
    const authenticate = value.auth.authenticate.getMockImplementation()!;
    value.auth.authenticate.mockImplementationOnce(async (...args) => {
      const identity = await authenticate(...args);
      await pending.wait();
      return identity;
    });
    const connecting = value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: {
        setup_code: value.setupCode,
        jellyfin_url: SERVER_URL,
        username: 'administrator',
        password: JELLYFIN_PASSWORD,
      },
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
    expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[0]);
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
    expect(value.auth.deleteApiKey).not.toHaveBeenCalled();
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

  it('refreshes the dedicated service key through a verified admin session without exposing it', async () => {
    const value = await configured();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/auth/service-key',
      headers: headers(value.current),
    });
    expect(response.statusCode).toBe(200);
    expect(value.auth.createApiKey).toHaveBeenCalledTimes(2);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).not.toBe(previousKey);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(value.behavior.keys[1]);
    expect(value.app.jellyport.store.authState()).toMatchObject({
      apiKeyName: value.auth.createApiKey.mock.calls[1]![2],
    });
    for (const secret of [...value.behavior.keys, ...value.behavior.tokens])
      expect(response.body).not.toContain(secret);
    expect(value.auth.signOut).not.toHaveBeenCalled();
  });

  it('retains the previous service key if refresh fails', async () => {
    const value = await configured();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    const previousState = value.app.jellyport.store.authState();
    value.behavior.createKeyError = new JellyfinAuthError('Key creation failed.', 502);
    expect(
      (
        await value.app.inject({
          method: 'POST',
          url: '/api/auth/service-key',
          headers: headers(value.current),
        })
      ).statusCode,
    ).toBe(502);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(previousKey);
    expect(value.app.jellyport.store.authState()).toEqual(previousState);
  });

  it('persists the server binding across restarts and ignores a stale or short legacy password after setup', async () => {
    const value = await configured();
    const previousState = value.app.jellyport.store.authState();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    await value.app.close();
    apps.delete(value.app);
    expect(existsSync(join(value.directory, 'jellyport.db'))).toBe(true);
    const restarted = await fixture({
      directory: value.directory,
      authentication: { auth: value.auth, behavior: value.behavior },
      adminPassword: 'short',
    });
    expect(restarted.setupCode).toBe('');
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
    expect(value.auth.createApiKey).toHaveBeenCalledOnce();
  });

  it('keeps the original server fingerprint during local authentication recovery', async () => {
    const value = await configured();
    const previousKey = value.app.jellyport.store.settings().jellyfin_api_key;
    const reset = value.app.jellyport.store.resetAuth();
    expect(reset.previousServerId).toBe(SERVER_ID);
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(previousKey);
    const initial = await anonymous(value.app);
    value.auth.authenticate.mockImplementationOnce(
      async (_url, _username, _password, expectedServerId) => {
        expect(expectedServerId).toBe(SERVER_ID);
        throw new JellyfinAuthError(
          'The connected Jellyfin server does not match this installation.',
          502,
        );
      },
    );
    const wrongServer = await value.app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: headers(initial),
      payload: {
        setup_code: reset.setupCode,
        jellyfin_url: 'https://different-server.test',
        username: 'administrator',
        password: JELLYFIN_PASSWORD,
      },
    });
    expect(wrongServer.statusCode).toBe(502);
    expect(value.app.jellyport.store.authState()).toEqual(reset);
    const connected = await connect(value, initial, reset.setupCode);
    expect(value.auth.authenticate).toHaveBeenLastCalledWith(
      SERVER_URL,
      'administrator',
      JELLYFIN_PASSWORD,
      SERVER_ID,
    );
    expect((await complete(value, connected.current)).statusCode).toBe(200);
    expect(value.app.jellyport.store.authState()).toMatchObject({
      kind: 'configured',
      serverId: SERVER_ID,
    });
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

  it('expires setup sessions after thirty minutes and revokes their interactive token', async () => {
    const value = await fixture();
    const { current } = await connect(value);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_801_000);
    expect(
      (await value.app.inject({ url: '/api/setup', headers: headers(current) })).statusCode,
    ).toBe(403);
    expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[0]);
    expect(value.app.jellyport.store.authState()?.kind).toBe('pending');
    expect(value.auth.createApiKey).not.toHaveBeenCalled();
  });

  it('expires authenticated sessions after eight hours and revokes only their interactive token', async () => {
    const value = await configured();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 28_801_000);
    expect(
      (await value.app.inject({ url: '/api/settings', headers: headers(value.current) }))
        .statusCode,
    ).toBe(401);
    expect(value.auth.signOut).toHaveBeenCalledWith(SERVER_URL, value.behavior.tokens[0]);
    expect(value.auth.deleteApiKey).not.toHaveBeenCalled();
    expect(value.app.jellyport.store.settings().jellyfin_api_key).toBe(value.behavior.keys[0]);
  });
});
