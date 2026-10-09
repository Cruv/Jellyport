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
async function request(path, method = 'GET', payload, expectedStatus) {
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
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus);
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
const adminAlerts = await request('/api/discord/admin-alerts');
assert.equal(adminAlerts.enabled, false);
assert.equal(adminAlerts.recipient_id, null);
assert.equal(adminAlerts.pending_count, 0);
const directory = await request('/api/user-directory');
assert(directory.users.some((user) => user.access_mode === 'standalone'));
assert(directory.users.every((user) => user.discord_user_id === null));
assert(directory.users.some((user) => user.requires_review));
assert(directory.users.every((user) => user.family === false));
assert(!JSON.stringify(directory).includes('Configuration'));
for (const [path, body] of [
  ['/api/memberships/access', { discord_user_id: '123456789', access_mode: 'complimentary' }],
  ['/api/accounts/link', { discord_user_id: '123456789', jellyfin_user_id: 'j-river' }],
  ['/api/discord/tags/preview', {}],
  ['/api/discord/admin-alerts/disable', { expected_revision: 'synthetic-review' }],
  [
    '/api/account-profiles',
    {
      kind: 'jellyfin',
      user_id: 'j-river',
      family: true,
      owner_name: 'Synthetic child',
      notes: 'Synthetic note',
      expected_revision: '',
    },
  ],
  [
    '/api/accounts/access',
    {
      kind: 'jellyfin',
      user_id: 'j-river',
      disabled: true,
      expected_username: 'river',
      expected_profile_revision: '',
    },
  ],
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
let previewTask = await request(
  '/api/migrations/preview',
  'POST',
  { source_user_ids: users.emby.map((user) => user.Id) },
  202,
);
assert.equal(typeof previewTask.id, 'string');
assert(['running', 'ready'].includes(previewTask.status));
for (let attempt = 0; attempt < 100 && previewTask.status === 'running'; attempt++) {
  await delay(100);
  previewTask = await request(`/api/migrations/preview/${previewTask.id}`);
}
assert.equal(previewTask.status, 'ready', 'Background history matching must finish.');
assert.deepEqual(previewTask.progress, { processed: 3, total: 3 });
const preview = previewTask.preview;
assert.equal(preview.mode, 'merge');
assert.equal(preview.migration_scope, 'complete');
assert.equal(preview.users.length, 3);
assert(preview.users.every((user) => Number.isInteger(user.stats.source_items)));
assert(preview.users.every((user) => user.mapping_revision === null));
assert.equal(
  (
    await fetch(new URL(`/api/migrations/preview/${previewTask.id}`, base), {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
  ).status,
  403,
  'Cancelling a history review must require CSRF protection.',
);
assert.deepEqual(await request(`/api/migrations/preview/${previewTask.id}`, 'DELETE'), {
  canceled: true,
});
assert.equal(
  (
    await fetch(new URL(`/api/migrations/preview/${previewTask.id}`, base), {
      headers: { Cookie: cookie },
    })
  ).status,
  404,
  'A cancelled history review must no longer be available.',
);
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
assert.equal(finished.migration_scope, 'complete');
assert(Number.isFinite(Date.parse(finished.started_at)));
assert(Number.isFinite(Date.parse(finished.finished_at)));
let quickPreview = await request('/api/migrations/preview', 'POST', {
  source_user_ids: ['e-river'],
  migration_scope: 'watched_only',
});
for (let attempt = 0; attempt < 100 && quickPreview.status === 'running'; attempt++) {
  await delay(100);
  quickPreview = await request(`/api/migrations/preview/${quickPreview.id}`);
}
assert.equal(quickPreview.status, 'ready');
assert.equal(quickPreview.preview.migration_scope, 'watched_only');
assert.equal(quickPreview.preview.users[0].stats.source_playlists, 0);
const quick = await request('/api/migrations', 'POST', {
  source_user_ids: ['e-river'],
  migration_scope: 'watched_only',
});
let quickFinished;
for (let attempt = 0; attempt < 100; attempt++) {
  quickFinished = await request(`/api/jobs/${quick.id}`);
  if (!['queued', 'running'].includes(quickFinished.status)) break;
  await delay(100);
}
assert.equal(quickFinished.status, 'completed');
assert.equal(quickFinished.migration_scope, 'watched_only');
assert.equal(quickFinished.results[0].applied, 0, 'Watched-only reruns must skip merged flags.');
assert.equal(quickFinished.results[0].data.items_updated, 0);
assert.equal(quickFinished.results[0].data.resume_positions, 0);
assert.equal(quickFinished.results[0].data.playlists_created, 0);
assert.equal((await request(`/api/jobs/${quick.id}/credentials`, 'POST')).credentials.length, 0);
await request('/api/logout', 'POST');
assert.equal(
  (
    await fetch(new URL(`/api/migrations/preview/${previewTask.id}`, base), {
      headers: { Cookie: cookie },
    })
  ).status,
  401,
  'History previews must remain private after logout.',
);
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
  'Container smoke passed: React assets, authentication/CSRF, private history review, complete bulk migration, watched-only scope and no-op reruns, preserved accounts, timestamps, and one-time credentials.',
);
