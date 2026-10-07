import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type JellyportApp } from '../server/main.js';

const resources: Array<{ app: JellyportApp; directory: string }> = [];
async function setup(demo = true) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-'));
  const app = await createApp({ adminPassword: 'testing-password-long', dataDir: directory, demo });
  resources.push({ app, directory });
  return app;
}
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
    payload: { password: 'testing-password-long' },
    headers: { cookie: anonymous.cookie, 'x-csrf-token': anonymous.csrf },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    'x-csrf-token': response.json().csrf_token as string,
  };
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
        payload: { password: 'testing-password-long' },
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
    payload: { password: secret },
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
          payload: { password: 'incorrect' },
        })
      ).statusCode,
    ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        headers,
        payload: { password: 'testing-password-long' },
      })
    ).statusCode,
  ).toBe(429);
});
it('sets security headers and secure session attributes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-api-'));
  const app = await createApp({
    adminPassword: 'testing-password-long',
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
  let response = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: { jellyfin_url: 'https://jellyfin.example/', jellyfin_api_key: 'secret-key' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain('secret-key');
  response = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: { jellyfin_api_key: '' },
  });
  expect(response.statusCode).toBe(200);
  expect(app.jellyport.store.settings().jellyfin_api_key).toBe('secret-key');
  expect(app.jellyport.store.settings().jellyfin_url).toBe('https://jellyfin.example');
  for (const payload of [
    { auto_disable: 'false' },
    { jellyfin_api_key: false },
    { invalid_setting: true },
    { jellyfin_url: 'https://user:password@example.com' },
    { path_mappings: [{ source: '', target: '/media' }] },
  ]) {
    expect(
      (await app.inject({ method: 'PUT', url: '/api/settings', headers, payload })).statusCode,
    ).toBe(400);
  }
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
it('rejects unsafe startup passwords', async () => {
  await expect(createApp({ adminPassword: 'short' })).rejects.toThrow('strong password');
  await expect(createApp({ adminPassword: 'replace-with-a-long-random-password' })).rejects.toThrow(
    'strong password',
  );
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
        payload: { password: 'testing-password-long' },
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
