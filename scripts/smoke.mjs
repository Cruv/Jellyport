import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8000');
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
  'Smoke tests must target a local demo.',
);
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(1000) });
    if (response.ok) break;
  } catch {
    /* Wait for the owned demo container to start. */
  }
  assert(attempt < 150, 'Demo server did not become healthy.');
  await delay(200);
}
let cookie = '',
  csrf = '';
async function request(path, method = 'GET', payload) {
  const response = await fetch(new URL(path, base), {
    method,
    signal: AbortSignal.timeout(5000),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  assert(response.ok, `${method} ${path} failed with HTTP ${response.status}`);
  return response.json();
}
const index = await fetch(base);
assert(index.ok);
assert(index.headers.get('content-security-policy').includes("script-src 'self'"));
const html = await index.text();
const asset = html.match(/src="([^"]+\.js)"/)[1];
assert((await fetch(new URL(asset, base))).ok, 'React production asset must be served.');
assert.equal(
  (await fetch(new URL('/%61pi/settings', base))).status,
  401,
  'Encoded API routes must require authentication.',
);
assert.equal((await fetch(new URL('/api/user-mappings', base))).status, 401);
assert.equal((await fetch(new URL('/api/account-roles', base))).status, 401);
assert.equal((await fetch(new URL('/api/memberships', base))).status, 401);
assert.equal((await fetch(new URL('/api/user-directory', base))).status, 401);
assert.equal((await fetch(new URL('/api/discord/tag-roles', base))).status, 401);
assert.equal(
  (
    await fetch(new URL('/api/memberships/provision', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord_user_id: '123456789', tier_id: 'galleon' }),
    })
  ).status,
  401,
);
assert.equal(
  (
    await fetch(new URL('/api/account-roles/apply', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_id: 'unauthorized',
        role_revision: 'unauthorized',
        user_ids: ['unauthorized'],
        sections: ['policy'],
      }),
    })
  ).status,
  401,
);
assert.equal((await fetch(new URL('/api/discord/members?query=alex', base))).status, 401);
assert.equal(
  (
    await fetch(new URL('/%61pi/accounts', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'unauthorized' }),
    })
  ).status,
  401,
);
let session = await request('/api/session');
assert(session.demo, 'Smoke tests require JELLYPORT_DEMO=true.');
csrf = session.csrf_token;
session = await request('/api/login', 'POST', { username: 'admin', password: 'demo-jellyport' });
assert(session.authenticated);
csrf = session.csrf_token;
const settings = await request('/api/settings');
assert(!Object.hasOwn(settings, 'jellyfin_api_key'));
assert(settings.jellyfin_api_key_set);
assert.equal(settings.discord_auto_role_sync, false);
assert.equal(settings.discord_emby_only_role, false);
const directory = await request('/api/user-directory');
assert(directory.users.some((user) => user.access_mode === 'standalone'));
assert(directory.users.every((user) => user.discord_user_id === null));
assert(!JSON.stringify(directory).includes('Configuration'));
for (const [path, body] of [
  ['/api/memberships/access', { discord_user_id: '123456789', access_mode: 'complimentary' }],
  ['/api/accounts/link', { discord_user_id: '123456789', jellyfin_user_id: 'j-river' }],
  ['/api/discord/tags/preview', {}],
]) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 400, 'Demo organization mutations must remain read-only.');
}
const users = await request('/api/users');
assert.equal(users.emby.length, 3);
assert.deepEqual(await request('/api/user-mappings'), { mappings: [] });
assert.deepEqual(await request('/api/account-roles'), { roles: [], assignments: [] });
const preview = await request('/api/migrations/preview', 'POST', {
  source_user_ids: users.emby.map((user) => user.Id),
});
assert.equal(preview.users.length, 3);
assert(preview.users.every((user) => Number.isInteger(user.stats.source_items)));
assert(preview.users.every((user) => user.mapping_revision === null));
const job = await request('/api/migrations', 'POST', {
  source_user_ids: users.emby.map((user) => user.Id),
});
let finished;
for (let attempt = 0; attempt < 100; attempt++) {
  finished = await request(`/api/jobs/${job.id}`);
  if (!['queued', 'running'].includes(finished.status)) break;
  await delay(100);
}
assert.equal(finished.status, 'partial');
assert.equal(finished.progress.processed, 3);
assert(!JSON.stringify(finished).includes('password'));
assert(finished.results.every((result) => result.data && Array.isArray(result.data.warnings)));
assert(finished.results.some((result) => result.data.last_played_dates > 0));
const credentials = await request(`/api/jobs/${job.id}/credentials`, 'POST');
assert.equal(credentials.credentials.length, 2);
assert((await request(`/api/jobs/${job.id}/credentials`, 'POST')).credentials.length === 0);
await request('/api/logout', 'POST');
assert.equal(
  (await fetch(new URL('/api/discord/members?query=alex', base), { headers: { Cookie: cookie } }))
    .status,
  401,
);
assert.equal(
  (await fetch(new URL('/api/jobs', base), { headers: { Cookie: cookie } })).status,
  401,
);
console.log(
  'Container smoke passed: React assets, authentication/CSRF, safe user directory, read-only demo organization, bulk migration, preserved existing accounts, and one-time credentials.',
);
