import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8000');
const secureCookie = process.argv.includes('--secure-cookie');
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
assert.equal(session.secure_cookie, secureCookie);
const setCookies = response.headers.getSetCookie();
const expectedCookie = secureCookie ? 'jellyport_setup_session' : 'jellyport_session';
const sessionCookie = setCookies.find((value) => value.startsWith(`${expectedCookie}=`));
assert(sessionCookie, 'Fresh setup must issue the cookie accepted by its wizard.');
assert.match(sessionCookie, /;\s*HttpOnly(?:;|$)/i);
assert.match(sessionCookie, /;\s*SameSite=Strict(?:;|$)/i);
assert(!/;\s*Secure(?:;|$)/i.test(sessionCookie), 'Local setup must work over LAN HTTP.');
assert.match(sessionCookie, secureCookie ? /;\s*Path=\/api(?:;|$)/i : /;\s*Path=\/(?:;|$)/i);
assert(!/;\s*Domain=/i.test(sessionCookie), 'Setup cookies must remain host-only.');
if (secureCookie) {
  assert(
    !setCookies.some((value) => value.startsWith('jellyport_session=')),
    'Local setup must not downgrade the normal administrator cookie.',
  );
}
const cookie = sessionCookie.split(';')[0];
const resumed = await fetch(new URL('/api/session', base), { headers: { Cookie: cookie } });
assert.equal(resumed.status, 200);
assert.equal(
  (await resumed.json()).csrf_token,
  session.csrf_token,
  'A browser must be able to retain its local wizard session.',
);
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
    Cookie: cookie,
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
  `Fresh-container smoke passed: manual Jellyfin API-key setup, ${secureCookie ? 'separate local setup cookie with secure administrator cookies enabled' : 'ordinary HTTP cookie'}, no local password or code, CSRF protection, and no demo sign-in.`,
);
