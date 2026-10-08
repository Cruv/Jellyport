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
const users = await request('/api/users');
assert.equal(users.emby.length, 3);
assert.deepEqual(await request('/api/user-mappings'), { mappings: [] });
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
  (await fetch(new URL('/api/jobs', base), { headers: { Cookie: cookie } })).status,
  401,
);
console.log(
  'Container smoke passed: React assets, authentication/CSRF, bulk migration, preserved existing accounts, and one-time credentials.',
);
