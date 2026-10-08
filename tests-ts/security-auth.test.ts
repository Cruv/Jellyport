import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { hostPolicy, localSetupHost, privateAddress, sameOrigin } from '../server/security.js';
import type { JellyfinAuthentication } from '../server/jellyfin-auth.js';

const resources: Array<{ app: JellyportApp; directory: string }> = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(demo = false, allowedHosts: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-security-'));
  const identity = {
    serverId: 'server',
    userId: 'admin',
    username: 'Administrator',
    accessToken: 'private-interactive-token',
  };
  let authentications = 0;
  const authClient: JellyfinAuthentication = {
    authenticate: async () => {
      authentications++;
      return identity;
    },
    validateSession: async () => identity,
    signOut: async () => {},
    createApiKey: async () => 'private-service-key',
    deleteApiKey: async () => {},
  };
  const app = await createApp({ dataDir: directory, demo, allowedHosts, authClient });
  resources.push({ app, directory });
  return { app, authentications: () => authentications };
}

function browser(response: Awaited<ReturnType<JellyportApp['inject']>>) {
  const cookie = response.cookies.find((item) => item.name === 'jellyport_session')!;
  return {
    cookie: `${cookie.name}=${cookie.value}`,
    'x-csrf-token': response.json().csrf_token as string,
  };
}

describe('request boundaries', () => {
  it('accepts local hosts and explicit proxy hostnames only', () => {
    const allowed = hostPolicy(['portal.example.com']);
    for (const host of [
      'localhost:8000',
      'nas',
      'nas.local:8057',
      'nas.home.arpa',
      '192.168.1.2:8057',
      '[::1]:8000',
      'portal.example.com:443',
    ])
      expect(allowed(host), host).toBe(true);
    for (const host of [
      'unconfigured.example.com',
      'localhost.example.com',
      'portal.example.com.other.example',
      'localhost@other.example',
      'localhost/path',
      'localhost,other.example',
      '',
    ])
      expect(allowed(host), host).toBe(false);
    expect(() => hostPolicy(['*.example.com'])).toThrow();
    expect(() => hostPolicy(['https://portal.example.com'])).toThrow();
  });

  it('classifies private sources and local setup hostnames independently of proxy configuration', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.2.3',
      '192.168.1.2',
      '::1',
      'fd01::2',
      '::ffff:192.168.1.2',
    ])
      expect(privateAddress(address), address).toBe(true);
    for (const address of [
      '203.0.113.7',
      '172.32.1.1',
      '169.254.169.254',
      '2001:db8::1',
      'not-an-address',
    ])
      expect(privateAddress(address), address).toBe(false);
    expect(localSetupHost('portal.example.com')).toBe(false);
    expect(localSetupHost('203.0.113.7')).toBe(false);
    expect(localSetupHost('[::1]:8000')).toBe(true);
  });

  it('compares browser origins including their port without trusting forwarded host headers', () => {
    expect(sameOrigin('localhost:8000', 'http://localhost:8000')).toBe(true);
    expect(sameOrigin('portal.example.com', 'https://portal.example.com')).toBe(true);
    for (const origin of [
      'null',
      'http://localhost:8001',
      'https://other.example',
      'http://localhost:8000/path',
      'http://localhost:8000@other.example',
    ])
      expect(sameOrigin('localhost:8000', origin), origin).toBe(false);
  });

  it('rejects an unconfigured Host before allocating cookies or accessing setup', async () => {
    const { app, authentications } = await fixture();
    for (const url of ['/health', '/api/session', '/api/setup']) {
      const response = await app.inject({ url, headers: { host: 'unconfigured.example.com' } });
      expect(response.statusCode).toBe(403);
      expect(response.cookies).toHaveLength(0);
    }
    expect(authentications()).toBe(0);
  });

  it('requires a private connection and local Host for first pairing, including behind a proxy', async () => {
    const { app, authentications } = await fixture(false, ['portal.example.com']);
    const initial = await app.inject('/api/session');
    const headers = browser(initial);
    for (const connection of [
      { remoteAddress: '203.0.113.7', headers },
      { remoteAddress: '203.0.113.7', headers: { ...headers, 'x-forwarded-for': '127.0.0.1' } },
      { remoteAddress: '192.168.1.2', headers: { ...headers, host: 'portal.example.com' } },
    ]) {
      const session = await app.inject({ url: '/api/session', ...connection });
      expect(session.statusCode).toBe(403);
      expect(session.cookies).toHaveLength(0);
      const connect = await app.inject({
        method: 'POST',
        url: '/api/setup/connect',
        ...connection,
        payload: {
          jellyfin_url: 'http://192.168.1.3:8096',
          username: 'Administrator',
          password: 'private-password',
        },
      });
      expect(connect.statusCode).toBe(403);
      expect(connect.body).not.toContain('private-password');
    }
    expect(authentications()).toBe(0);
    expect(app.jellyport.store.authState()?.kind).toBe('pending');
    expect(
      (
        await app.inject({
          url: '/api/session',
          remoteAddress: '192.168.1.2',
          headers: { host: '192.168.1.3:8057' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('rejects different origins and cross-site requests even with a valid cookie and CSRF token', async () => {
    const { app } = await fixture(true);
    const initial = browser(await app.inject('/api/session'));
    for (const extra of [
      { origin: 'https://other.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { ...initial, ...extra },
        payload: { username: 'admin', password: 'demo-jellyport' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.cookies).toHaveLength(0);
      expect(
        (await app.inject({ url: '/api/session', headers: { ...initial, ...extra } })).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { ...initial, origin: 'http://localhost:80' },
          payload: { username: 'admin', password: 'demo-jellyport' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { ...initial, origin: 'http://localhost' },
          payload: { username: 'admin', password: 'demo-jellyport' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('allows a configured installation to sign in through an explicitly allowed HTTPS proxy', async () => {
    const { app } = await fixture(false, ['portal.example.com']);
    const state = app.jellyport.store.authState();
    if (state?.kind !== 'pending') throw new Error('Expected fresh state');
    app.jellyport.store.completeAuth(
      state.generation,
      {
        kind: 'configured',
        serverId: 'server',
        serverUrl: 'https://jellyfin.example.com',
        apiKeyName: 'Jellyport',
      },
      (settings) => ({
        ...settings,
        jellyfin_url: 'https://jellyfin.example.com',
        jellyfin_api_key: 'private-service-key',
      }),
    );
    const host = { host: 'portal.example.com', origin: 'https://portal.example.com' };
    const initial = await app.inject({
      url: '/api/session',
      headers: host,
      remoteAddress: '203.0.113.7',
    });
    expect(initial.statusCode).toBe(200);
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { ...host, ...browser(initial) },
      payload: { username: 'Administrator', password: 'private-password' },
    });
    expect(signedIn.statusCode).toBe(200);
    const dto = signedIn.json();
    expect(dto.user).toEqual({ id: 'admin', name: 'Administrator' });
    for (const secret of [
      'private-interactive-token',
      'private-service-key',
      'private-password',
      signedIn.cookies[0]!.value,
    ])
      expect(signedIn.body).not.toContain(secret);
    expect(signedIn.headers['cache-control']).toBe('no-store');
    expect(signedIn.headers['set-cookie']).toContain('HttpOnly');
    expect(signedIn.headers['set-cookie']).toContain('SameSite=Strict');
  });
});

describe('session capacity and private data', () => {
  it('limits new anonymous sessions per address without excluding other clients or invalidating existing cookies', async () => {
    const { app } = await fixture(true);
    let first: ReturnType<typeof browser> | undefined;
    for (let index = 0; index < 30; index++) {
      const response = await app.inject({ url: '/api/session', remoteAddress: '192.168.1.20' });
      expect(response.statusCode).toBe(200);
      first ??= browser(response);
    }
    const limited = await app.inject({ url: '/api/session', remoteAddress: '192.168.1.20' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1800');
    expect(
      (await app.inject({ url: '/api/session', remoteAddress: '192.168.1.21' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/session', remoteAddress: '192.168.1.20', headers: first }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          remoteAddress: '192.168.1.20',
          headers: first,
          payload: { username: 'admin', password: 'demo-jellyport' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('does not disclose private routes to anonymous, invalid, or logged-out sessions', async () => {
    const { app } = await fixture(true);
    const initial = browser(await app.inject('/api/session'));
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: initial,
      payload: { username: 'admin', password: 'demo-jellyport' },
    });
    const expired = browser(signedIn);
    await app.inject({ method: 'POST', url: '/api/logout', headers: expired });
    for (const headers of [{}, initial, expired, { cookie: 'jellyport_session=unknown-session' }]) {
      for (const url of [
        '/api/settings',
        '/api/users',
        '/api/overview',
        '/api/jobs',
        '/api/jobs/private-job',
        '/api/subscriptions',
        '/api/accounts/recovery?username=private-user',
        '/%61pi/settings',
      ]) {
        const response = await app.inject({ url, headers });
        expect(response.statusCode, url).toBe(401);
        expect(response.json(), url).toEqual({ detail: 'Sign in to Jellyport.' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
      const credentials = await app.inject({
        method: 'POST',
        url: '/api/jobs/private-job/credentials',
        headers,
      });
      expect(credentials.statusCode).toBe(401);
    }
  });

  it('does not serve the database, encryption key, server code, or debug maps', async () => {
    const { app } = await fixture(true);
    for (const url of [
      '/jellyport.db',
      '/secret.key',
      '/data/jellyport.db',
      '/server/main.js',
      '/server/main.js.map',
    ])
      expect((await app.inject(url)).statusCode, url).toBe(404);
  });

  it('sets finite HTTP header, request, connection and keep-alive limits', async () => {
    const { app } = await fixture(true);
    expect(app.server.requestTimeout).toBe(30_000);
    expect(app.initialConfig.connectionTimeout).toBe(30_000);
    expect(app.initialConfig.keepAliveTimeout).toBe(5_000);
    expect(app.server.headersTimeout).toBe(15_000);
    expect(app.server.maxRequestsPerSocket).toBe(100);
  });
});
