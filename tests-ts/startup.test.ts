import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(output).not.toContain('demo-jellyport');
  } finally {
    clearTimeout(deadline);
    child.kill();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(directory, { force: true, recursive: true });
  }
});
