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

it('runs production HTTP clients through a Jellyfin 10.11 wizard, managed service access, logout, and administrator login', async () => {
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
  const serviceKeys = new Map<string, string>();
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
      } else if (request.method === 'POST' && path === '/Auth/Keys') {
        expect(isInteractive).toBe(true);
        const appName = address.searchParams.get('app');
        expect(appName).toMatch(/^Jellyport [a-f0-9-]{36}$/);
        serviceKeys.set(`service-http-${serviceKeys.size + 1}`, appName!);
        send(204);
      } else if (request.method === 'GET' && path === '/Auth/Keys') {
        expect(isInteractive).toBe(true);
        send(200, {
          Items: [...serviceKeys].map(([AccessToken, AppName]) => ({
            AccessToken,
            AppName,
            IsActive: true,
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
  let setupCode = '';
  const app = await createApp({
    demo: false,
    adminPassword: '',
    dataDir: directory,
    onSetupCode: (code) => {
      setupCode = code;
    },
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
    payload: { setup_code: setupCode, jellyfin_url: baseUrl, username: 'Administrator', password },
  });
  expect(connected.statusCode).toBe(200);
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
    authenticated: true,
    user: { id: administrator.Id, name: administrator.Name },
  });
  const signedIn = getBrowser(finished);
  expect(app.jellyport.store.settings().jellyfin_api_key).toBe('service-http-1');
  expect(serviceKeys.size).toBe(1);
  const users = await app.inject({ url: '/api/users', headers: signedIn });
  expect(users.statusCode).toBe(200);
  expect(users.json().jellyfin.map((item: { Id: string }) => item.Id)).toContain('template-id');
  expect(
    requests.some(
      (request) => request.path === '/jellyfin/Users' && request.token === 'service-http-1',
    ),
  ).toBe(true);
  const loggedOut = await app.inject({ method: 'POST', url: '/api/logout', headers: signedIn });
  expect(loggedOut.statusCode).toBe(200);
  expect(interactiveTokens.size).toBe(0);
  expect(serviceKeys.size).toBe(1);
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
  for (const secret of [password, 'interactive-http-1', 'interactive-http-2', 'service-http-1'])
    expect(connected.body + finished.body + login.body + users.body).not.toContain(secret);
  expect(handlerErrors).toEqual([]);
});
