import 'dotenv/config';
import { Store } from './store.js';
import { startupFailureDetail } from './startup.js';
import { normalizeJellyfinUrl, JellyfinAuthError } from './jellyfin-auth.js';

// Local recovery command. Stop the server before running against its data volume.
let store: Store | undefined;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--server-url'))
    throw new JellyfinAuthError(
      'Usage: node dist/server/reset-auth.js [--server-url http://JELLYFIN_ADDRESS:8096]',
      400,
    );
  const serverUrl = args.length ? normalizeJellyfinUrl(args[1]!) : undefined;
  store = new Store(process.env.JELLYPORT_DATA_DIR ?? './data');
  store.resetAuth(serverUrl);
  console.log('Jellyport authentication reset. Existing settings and account data are preserved.');
  console.log('Restart Jellyport and complete setup with your Jellyfin administrator account.');
} catch (error) {
  console.error(
    `Jellyport authentication could not be reset. ${error instanceof JellyfinAuthError ? error.message : startupFailureDetail(error)}`,
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
