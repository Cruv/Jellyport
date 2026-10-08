import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupFailureDetail } from '../server/startup.js';

async function runStartup(environment: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, JELLYPORT_DEMO: 'false', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (value) => {
    output += String(value);
  });
  child.stderr.on('data', (value) => {
    output += String(value);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, output };
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}

it('reports an invalid admin password without printing its value or data path', async () => {
  const secret = 'short!234';
  const dataDir = join(tmpdir(), 'private-jellyport-startup-path');
  const { code, output } = await runStartup({
    JELLYPORT_ADMIN_PASSWORD: secret,
    JELLYPORT_DATA_DIR: dataDir,
  });
  expect(code).toBe(1);
  expect(output).toContain('JELLYPORT_ADMIN_PASSWORD');
  expect(output).toContain('12–512 characters');
  expect(output).not.toContain(secret);
  expect(output).not.toContain(dataDir);
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'reports an inaccessible data volume separately from a password failure',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-startup-permissions-'));
    chmodSync(directory, 0o000);
    try {
      const { code, output } = await runStartup({
        JELLYPORT_ADMIN_PASSWORD: 'valid-private-password!234',
        JELLYPORT_DATA_DIR: directory,
      });
      expect(code).toBe(1);
      expect(output).toContain('Permission denied.');
      expect(output).toContain('configured container user and group');
      expect(output).not.toContain('12–512 characters');
      expect(output).not.toContain('valid-private-password!234');
      expect(output).not.toContain(directory);
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { force: true, recursive: true });
    }
  },
);

it.each([
  ['EACCES', 'Permission denied.'],
  ['EPERM', 'Permission denied.'],
  ['EROFS', 'read-only'],
  ['ENOSPC', 'no free space'],
  ['EADDRINUSE', 'already in use'],
  ['ERR_SQLITE_ERROR', 'database could not be opened'],
])('reports %s without exposing the original message or path', (code, expected) => {
  const secret = 'private-token-in-error-message';
  const path = '/private/server/path/secret.key';
  const error = Object.assign(new Error(`${secret}: ${path}`), { code, path });
  const detail = startupFailureDetail(error);
  expect(detail).toContain(expected);
  expect(detail).not.toContain(secret);
  expect(detail).not.toContain(path);
});

it.each([
  [
    'The Jellyport database has no encryption key. Restore secret.key from the same backup.',
    'missing its encryption key',
  ],
  [
    'Invalid Jellyport encryption key. Restore the original secret.key from backup.',
    'encryption key is invalid',
  ],
  [
    'Saved Jellyport secrets could not be decrypted. Restore the matching database and secret.key.',
    'Restore the matching database and secret.key',
  ],
])('reports a recognized encryption failure safely', (message, expected) => {
  expect(startupFailureDetail(new Error(message))).toContain(expected);
});

it.each([
  new Error('private-token-in-error-message at /private/server/path'),
  Object.assign(new Error('private-token-in-error-message'), { code: 'UNKNOWN_SECRET_CODE' }),
  'private-token-in-error-message',
  null,
])('keeps unrecognized startup failures redacted', (error) => {
  expect(startupFailureDetail(error)).toBe(
    'Check the admin password, data volume and configuration.',
  );
});

it('closes the application and exits when its HTTP port is already occupied', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Test port unavailable.');
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-startup-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(address.port),
      JELLYPORT_DEMO: 'true',
      JELLYPORT_ADMIN_PASSWORD: 'demo-jellyport',
      JELLYPORT_DATA_DIR: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (value) => {
    output += String(value);
  });
  child.stderr.on('data', (value) => {
    output += String(value);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(code).toBe(1);
    expect(output).toContain('Jellyport could not start.');
    expect(output).toContain('configured HTTP port is already in use');
    expect(output).not.toContain('demo-jellyport');
  } finally {
    clearTimeout(deadline);
    child.kill();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(directory, { force: true, recursive: true });
  }
});
