import 'dotenv/config';
import { createApp, type JellyportApp } from './main.js';
import { startupFailureDetail } from './startup.js';

let app: JellyportApp | undefined;
try {
  app = await createApp();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void app!
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
  const port = Number(process.env.PORT ?? 8000);
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
  console.log(`Jellyport listening on port ${port}.`);
} catch (error) {
  if (app) await app.close().catch(() => {});
  console.error(`Jellyport could not start. ${startupFailureDetail(error)}`);
  process.exitCode = 1;
}
