import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
let response;
for (let attempt = 0; attempt < 150; attempt++) {
  try {
    response = await fetch(new URL('/api/session', base), { signal: AbortSignal.timeout(1000) });
    if (response.ok) break;
  } catch {
    /* Wait for the owned, fresh container. */
  }
  await delay(200);
}
assert(response?.ok, 'Fresh server did not start without an admin password environment variable.');
const session = await response.json();
assert.equal(session.demo, false);
assert.equal(session.authenticated, false);
assert.equal(session.setup_required, true);
assert.equal(session.setup_connected, false);
assert(!Object.hasOwn(session, 'setup_protection'), 'Setup must use Jellyfin directly.');
assert(
  !Object.hasOwn(session, 'setup_code'),
  'Direct Jellyfin setup must not require a local bootstrap code.',
);
assert.equal((await fetch(new URL('/api/settings', base))).status, 401);
assert.equal((await fetch(new URL('/api/account-roles', base))).status, 401);
assert.equal((await fetch(new URL('/api/discord/members?query=alex', base))).status, 401);
const setupWithoutCsrf = await fetch(new URL('/api/setup/connect', base), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jellyfin_url: 'http://jellyfin:8096',
    api_key: 'fixture-pre-created-api-key',
  }),
});
assert.equal(setupWithoutCsrf.status, 403, 'Direct Jellyfin setup must retain CSRF protection.');
const login = await fetch(new URL('/api/login', base), {
  method: 'POST',
  headers: {
    Cookie: response.headers.get('set-cookie').split(';')[0],
    'X-CSRF-Token': session.csrf_token,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ username: 'admin', password: 'demo-jellyport' }),
});
assert.equal(
  login.status,
  403,
  'Fresh production instances must require setup, without demo login.',
);
console.log(
  'Fresh-container smoke passed: manual Jellyfin API-key setup, no local password or code, CSRF protection, and no demo sign-in.',
);
