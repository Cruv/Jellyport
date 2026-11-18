import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JellyfinAuthClient } from '../server/jellyfin-auth.js';
import { createApp } from '../server/main.js';

if (process.argv.length > 2) throw new Error('This synthetic benchmark accepts no arguments.');
const pollingCode = new URL('../frontend/src/operation-polling.ts', import.meta.url);
const delay = existsSync(pollingCode)
  ? (await import(pollingCode.href)).operationPollDelay
  : () => 3000;
const durationMs = 60_000;
const serverId = 'synthetic-server';
const user = {
  Id: 'synthetic-administrator',
  Name: 'Benchmark administrator',
  ServerId: serverId,
  Policy: { IsAdministrator: true, IsDisabled: false },
};
const calls: Record<string, number> = {};
const authClient = new JellyfinAuthClient({
  transport: async (address) => {
    const url = new URL(address);
    assert.equal(url.hostname, 'jellyfin.example');
    const path = url.pathname;
    calls[path] = (calls[path] ?? 0) + 1;
    if (path === '/System/Info/Public') return Response.json({ Id: serverId });
    if (path === '/Users/Me') return Response.json(user);
    if (path === '/Users/AuthenticateByName')
      return Response.json({
        ServerId: serverId,
        User: user,
        AccessToken: 'synthetic-interactive-token',
      });
    if (path === '/Sessions/Logout') return new Response(null, { status: 204 });
    throw new Error('Unexpected fixture path');
  },
});
const directory = mkdtempSync(join(tmpdir(), 'jellyport-status-benchmark-'));
try {
  const app = await createApp({ dataDir: directory, authClient, demo: false });
  try {
    const { store } = app.jellyport;
    const pending = store.authState();
    assert.equal(pending?.kind, 'pending');
    if (pending?.kind !== 'pending') throw new Error('Fixture setup was not isolated.');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverId,
        serverUrl: 'https://jellyfin.example',
        apiKeyName: 'synthetic-fixture',
      },
      (settings) => ({
        ...settings,
        jellyfin_url: 'https://jellyfin.example',
        jellyfin_api_key: 'synthetic-service-key',
      }),
    );
    const anonymous = await app.inject('/api/session');
    const anonymousCookie = anonymous.cookies[0]!;
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `${anonymousCookie.name}=${anonymousCookie.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: user.Name, password: 'fixture-password' },
    });
    assert.equal(login.statusCode, 200);
    const signed = login.cookies[0]!;
    const headers = { cookie: `${signed.name}=${signed.value}` };
    const measurement = async (active: boolean) => {
      for (const key of Object.keys(calls)) delete calls[key];
      let polls = 0;
      let payload_bytes = 0;
      const started = performance.now();
      for (let offset = 0; offset < durationMs; offset += delay(active, 0)) {
        const response = await app.inject({ url: '/api/jobs/live', headers });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().active_count, Number(active));
        polls++;
        payload_bytes += Buffer.byteLength(response.body);
      }
      assert.equal(calls['/System/Info/Public'], polls);
      assert.equal(calls['/Users/Me'], polls);
      return {
        polls,
        payload_bytes,
        upstream_auth_calls: { ...calls },
        local_ms: +(performance.now() - started).toFixed(3),
      };
    };
    const idle = await measurement(false);
    const at = new Date().toISOString();
    store.saveJob({
      id: 'synthetic-active-job',
      kind: 'create',
      status: 'running',
      created_at: at,
      updated_at: at,
      progress: { processed: 0, total: 1 },
      results: [],
    });
    const active = await measurement(true);
    console.log(
      JSON.stringify(
        {
          revision: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          runtime: process.version,
          platform: `${process.platform}/${process.arch}`,
          simulated_duration_ms: durationMs,
          idle,
          active,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
