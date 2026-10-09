import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import type { MediaUser } from '../server/media.js';

const resources: Array<{ app: JellyportApp; server: Server; directory: string }> = [];
afterEach(async () => {
  for (const { app, server, directory } of resources.splice(0)) {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

it('runs production HTTP clients through manual-key setup, separate admin login, key replacement, and logout', async () => {
  const serverId = 'http-fixture-server';
  const password = 'fixture-administrator-password!42';
  const administrator: MediaUser = {
    Id: 'administrator-id',
    Name: 'Administrator',
    ServerId: serverId,
    Policy: { IsAdministrator: true, IsDisabled: false },
  };
  const template: MediaUser = {
    Id: 'template-id',
    Name: 'Member template',
    ServerId: serverId,
    Policy: { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true },
    Configuration: {},
  };
  const interactiveTokens = new Map<string, MediaUser>();
  // Created by the operator before Jellyport setup. Labels need not be unique or Jellyport-specific.
  const serviceKeys = new Map<string, string>([
    ['service-http-1', 'My manually created key'],
    ['unrelated-service-key', 'My manually created key'],
  ]);
  const requests: Array<{ method: string; path: string; token: string; authorization: string }> =
    [];
  const handlerErrors: unknown[] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      const address = new URL(request.url!, 'http://127.0.0.1');
      const path = address.pathname.replace(/^\/jellyfin/, '');
      const authorization = request.headers.authorization ?? '';
      const token = /(?:^|[,\s])Token="([a-zA-Z0-9._~+\/-]+)"/.exec(authorization)?.[1] ?? '';
      expect(request.headers['x-emby-token']).toBeUndefined();
      expect(request.headers['x-emby-authorization']).toBeUndefined();
      requests.push({ method: request.method!, path: request.url!, token, authorization });
      if (request.method === 'GET' && path === '/System/Info/Public') {
        expect(authorization).toBe('');
        send(200, { Id: serverId, ServerName: 'HTTP fixture', Version: '10.11.0' });
        return;
      }
      if (request.method === 'POST' && path === '/Users/AuthenticateByName') {
        expect(authorization).toMatch(
          /^MediaBrowser Client="Jellyport", Device="Jellyport", DeviceId="jellyport-[a-f0-9-]{36}", Version="0\.3\.0"$/,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        expect(body).toEqual({ Username: 'Administrator', Pw: password });
        const accessToken = `interactive-http-${++sequence}`;
        interactiveTokens.set(accessToken, administrator);
        send(200, { User: administrator, ServerId: serverId, AccessToken: accessToken });
        return;
      }
      const isInteractive = interactiveTokens.has(token);
      if (!isInteractive && !serviceKeys.has(token)) {
        send(401);
        return;
      }
      expect(authorization).toMatch(/^MediaBrowser /);
      if (request.method === 'GET' && path === '/Users/Me') {
        send(isInteractive ? 200 : 400, isInteractive ? interactiveTokens.get(token) : undefined);
      } else if (request.method === 'GET' && path === '/Users') {
        send(200, [administrator, template]);
      } else if (request.method === 'GET' && path === '/Users/template-id') {
        send(200, template);
      } else if (request.method === 'GET' && path === '/System/Info') {
        send(200, { Id: serverId, ServerName: 'HTTP fixture', Version: '10.11.0' });
      } else if (request.method === 'GET' && path === '/Auth/Keys') {
        send(200, {
          Items: [...serviceKeys].map(([AccessToken, AppName]) => ({
            AccessToken,
            AppName,
            // Jellyfin 10.11 leaves this legacy DTO flag at its default false for live API keys.
            IsActive: false,
            DateRevoked: null,
            UserId: '00000000000000000000000000000000',
            DeviceId: '',
            DeviceName: '',
            AppVersion: '',
          })),
          TotalRecordCount: serviceKeys.size,
        });
      } else if (request.method === 'POST' && path === '/Sessions/Logout') {
        expect(isInteractive).toBe(true);
        interactiveTokens.delete(token);
        send(204);
      } else {
        throw new Error(`Unexpected HTTP fixture endpoint: ${request.method} ${path}`);
      }
    } catch (error) {
      handlerErrors.push(error);
      send(500, { detail: 'HTTP fixture failed.' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jellyfin`;
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-auth-http-'));
  const app = await createApp({
    demo: false,
    dataDir: directory,
  });
  resources.push({ app, server, directory });
  const getBrowser = (response: Awaited<ReturnType<JellyportApp['inject']>>, nested = false) => ({
    cookie: `${response.cookies[0]!.name}=${response.cookies[0]!.value}`,
    'x-csrf-token': (nested ? response.json().session : response.json()).csrf_token as string,
  });
  const anonymous = getBrowser(await app.inject('/api/session'));
  const connected = await app.inject({
    method: 'POST',
    url: '/api/setup/connect',
    headers: anonymous,
    payload: { jellyfin_url: baseUrl, api_key: 'service-http-1' },
  });
  expect(connected.statusCode).toBe(200);
  expect(interactiveTokens.size).toBe(0);
  expect(connected.json().templates).toEqual([{ Id: 'template-id', Name: 'Member template' }]);
  const pending = getBrowser(connected, true);
  const finished = await app.inject({
    method: 'POST',
    url: '/api/setup/complete',
    headers: pending,
    payload: { template_user_id: 'template-id', jellyfin_public_url: 'https://watch.example.test' },
  });
  expect(finished.statusCode).toBe(200);
  expect(finished.json()).toMatchObject({
    authenticated: false,
    setup_required: false,
    setup_connected: false,
  });
  expect(finished.json()).not.toHaveProperty('user');
  expect(interactiveTokens.size).toBe(0);
  expect(app.jellyport.store.settings().jellyfin_api_key).toBe('service-http-1');
  expect(serviceKeys.size).toBe(2);
  expect((await app.inject({ url: '/api/users', headers: getBrowser(finished) })).statusCode).toBe(
    401,
  );
  const firstLogin = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: getBrowser(finished),
    payload: { username: 'Administrator', password },
  });
  expect(firstLogin.statusCode).toBe(200);
  expect(firstLogin.json()).toMatchObject({
    authenticated: true,
    user: { id: administrator.Id, name: administrator.Name },
  });
  const signedIn = getBrowser(firstLogin);
  const users = await app.inject({ url: '/api/users', headers: signedIn });
  expect(users.statusCode).toBe(200);
  expect(users.json().jellyfin.map((item: { Id: string }) => item.Id)).toContain('template-id');
  expect(
    requests.some(
      (request) => request.path === '/jellyfin/Users' && request.token === 'service-http-1',
    ),
  ).toBe(true);
  const rejectedKey = await app.inject({
    method: 'POST',
    url: '/api/auth/service-key',
    headers: signedIn,
    payload: { api_key: 'not-a-valid-server-key' },
  });
  expect(rejectedKey.statusCode).toBe(400);
  expect(rejectedKey.body).not.toContain('not-a-valid-server-key');
  expect(app.jellyport.store.settings().jellyfin_api_key).toBe('service-http-1');
  expect((await app.inject({ url: '/api/settings', headers: signedIn })).statusCode).toBe(200);
  const userToken = await app.inject({
    method: 'POST',
    url: '/api/auth/service-key',
    headers: signedIn,
    payload: { api_key: 'interactive-http-1' },
  });
  expect(userToken.statusCode).toBe(403);
  expect(app.jellyport.store.settings().jellyfin_api_key).toBe('service-http-1');
  serviceKeys.set('service-http-2', 'A replacement I created');
  const replacement = await app.inject({
    method: 'POST',
    url: '/api/auth/service-key',
    headers: signedIn,
    payload: { api_key: 'service-http-2' },
  });
  expect(replacement.statusCode).toBe(200);
  expect(app.jellyport.store.settings().jellyfin_api_key).toBe('service-http-2');
  expect(serviceKeys.has('service-http-1')).toBe(true);
  expect(serviceKeys.size).toBe(3);
  const replacedUsers = await app.inject({ url: '/api/users', headers: signedIn });
  expect(replacedUsers.statusCode).toBe(200);
  expect(
    requests.some(
      (request) => request.path === '/jellyfin/Users' && request.token === 'service-http-2',
    ),
  ).toBe(true);
  const loggedOut = await app.inject({ method: 'POST', url: '/api/logout', headers: signedIn });
  expect(loggedOut.statusCode).toBe(200);
  expect(interactiveTokens.size).toBe(0);
  expect(serviceKeys.size).toBe(3);
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: getBrowser(loggedOut),
    payload: { username: 'Administrator', password },
  });
  expect(login.statusCode).toBe(200);
  expect(login.json().authenticated).toBe(true);
  expect((await app.inject({ url: '/api/settings', headers: getBrowser(login) })).statusCode).toBe(
    200,
  );
  const authRequests = requests.filter(
    (request) => request.path === '/jellyfin/Users/AuthenticateByName',
  );
  expect(authRequests).toHaveLength(2);
  expect(authRequests[0]!.authorization).not.toBe(authRequests[1]!.authorization);
  for (const request of requests) {
    expect(request.path).not.toContain(password);
    for (const token of [...interactiveTokens.keys(), ...serviceKeys.keys()])
      expect(request.path).not.toContain(token);
  }
  for (const secret of [
    password,
    'interactive-http-1',
    'interactive-http-2',
    'service-http-1',
    'service-http-2',
    'unrelated-service-key',
  ])
    expect(
      connected.body +
        finished.body +
        firstLogin.body +
        login.body +
        users.body +
        replacement.body +
        replacedUsers.body +
        rejectedKey.body +
        userToken.body,
    ).not.toContain(secret);
  expect(
    requests
      .filter((request) => request.path.startsWith('/jellyfin/Auth/Keys'))
      .every((request) => request.method === 'GET'),
  ).toBe(true);
  expect(handlerErrors).toEqual([]);
});
