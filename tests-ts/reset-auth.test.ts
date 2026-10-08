import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function existingInstallation() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-reset-'));
  directories.push(directory);
  const store = new Store(directory);
  const pending = store.ensureAuthState();
  if (pending.kind !== 'pending') throw new Error('Expected fresh test data.');
  store.completeAuth(
    pending.generation,
    {
      kind: 'configured',
      serverUrl: 'http://jellyfin.test:8096',
      serverId: 'original-server',
      apiKeyName: 'test-key',
    },
    (settings) => ({
      ...settings,
      jellyfin_url: 'http://jellyfin.test:8096',
      jellyfin_api_key: 'test-service-key',
      template_user_id: 'template',
    }),
  );
  store.saveAccount('casey', 'remote-casey', 'completed');
  store.close();
  return directory;
}
function reset(directory: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'server/reset-auth.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JELLYPORT_DATA_DIR: directory,
      JELLYPORT_ADMIN_PASSWORD: 'obsolete-password!42',
    },
    encoding: 'utf8',
    timeout: 5000,
  });
}
it('resets pairing locally without a local password or code while preserving data and server identity', () => {
  const directory = existingInstallation();
  const key = readFileSync(join(directory, 'secret.key'));
  const result = reset(directory);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('complete setup with your Jellyfin administrator account');
  expect(result.stdout + result.stderr).not.toMatch(/setup code|obsolete-password/i);
  const store = new Store(directory);
  try {
    expect(store.authState()).toMatchObject({
      kind: 'pending',
      serverUrl: 'http://jellyfin.test:8096',
      previousServerId: 'original-server',
    });
    expect(store.authState()).not.toHaveProperty('setupCode');
    expect(store.settings().jellyfin_api_key).toBe('test-service-key');
    expect(store.account('casey')?.remote_id).toBe('remote-casey');
    expect(readFileSync(join(directory, 'secret.key'))).toEqual(key);
  } finally {
    store.close();
  }
});
it('lets the local operator update the pinned address while retaining the original Jellyfin identity', () => {
  const directory = existingInstallation();
  expect(reset(directory, ['--server-url', 'https://new-jellyfin.test/base/']).status).toBe(0);
  const store = new Store(directory);
  try {
    expect(store.authState()).toMatchObject({
      kind: 'pending',
      serverUrl: 'https://new-jellyfin.test/base',
      previousServerId: 'original-server',
    });
  } finally {
    store.close();
  }
});
it.each([
  ['--server-url', 'https://admin:private-password@jellyfin.test'],
  ['--server-url', 'javascript:private-password'],
  ['--unknown', 'private-password'],
])(
  'rejects invalid recovery arguments without changing the binding or logging their values',
  (...args) => {
    const directory = existingInstallation();
    const result = reset(directory, args);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('private-password');
    const store = new Store(directory);
    try {
      expect(store.authState()).toMatchObject({
        kind: 'configured',
        serverUrl: 'http://jellyfin.test:8096',
        serverId: 'original-server',
      });
    } finally {
      store.close();
    }
  },
);
