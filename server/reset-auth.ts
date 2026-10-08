import 'dotenv/config';
import { Store } from './store.js';
import { startupFailureDetail } from './startup.js';

// Local recovery command. Stop the server before running against its data volume.
let store: Store | undefined;
try {
  store = new Store(process.env.JELLYPORT_DATA_DIR ?? './data');
  const state = store.resetAuth();
  console.log('Jellyport authentication reset. Existing settings and account data are preserved.');
  console.log(`Jellyport setup code: ${state.setupCode}`);
  if (process.env.JELLYPORT_ADMIN_PASSWORD)
    console.log('Remove JELLYPORT_ADMIN_PASSWORD before restarting to use this setup code.');
} catch (error) {
  console.error(`Jellyport authentication could not be reset. ${startupFailureDetail(error)}`);
  process.exitCode = 1;
} finally {
  store?.close();
}
