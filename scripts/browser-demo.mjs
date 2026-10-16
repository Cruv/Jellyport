import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never inherit an operator's data directory, helper paths, keys or external URLs.
// This entrypoint deliberately skips dotenv and has no production-target option.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('JELLYPORT_')) delete process.env[name];
}
process.env.TZ = 'Etc/UTC';
const { createApp } = await import('../dist/server/main.js');
const directory = await mkdtemp(join(tmpdir(), 'jellyport-browser-demo-'));
let app;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app?.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
}
try {
  app = await createApp({
    demo: true,
    demoPassword: 'demo-jellyport',
    dataDir: directory,
    secureCookie: false,
    allowedHosts: ['127.0.0.1'],
  });
  await app.listen({ host: '127.0.0.1', port: 4179 });
} catch (error) {
  await stop();
  throw error;
}
