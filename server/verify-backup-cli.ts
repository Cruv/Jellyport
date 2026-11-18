import { parseArgs } from 'node:util';
import { verifyBackup } from './backup-verification.js';

try {
  const { values } = parseArgs({
    options: { backup: { type: 'string' }, receipt: { type: 'string' } },
  });
  if (!values.backup)
    throw new Error(
      'Pass --backup with the offline directory containing jellyport.db and secret.key.',
    );
  const verified = verifyBackup(
    values.backup,
    process.env.JELLYPORT_DATA_DIR ?? './data',
    values.receipt,
  );
  console.log(JSON.stringify(verified));
} catch (error) {
  const systemError = error as NodeJS.ErrnoException;
  console.error(
    systemError?.code
      ? 'A backup or receipt file could not be opened. Check the directory and file permissions.'
      : systemError.message,
  );
  process.exitCode = 1;
}
