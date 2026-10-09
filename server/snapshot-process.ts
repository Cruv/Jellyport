import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPTURE_DEADLINE } from './snapshot-files.js';

/** Kill and reap the worker on timeout; an abandoned native backup must not keep reading Emby. */
export function snapshotProcess<T>(
  request: unknown,
  signal?: AbortSignal,
  timeout = CAPTURE_DEADLINE,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = fileURLToPath(new URL(`./snapshot-worker.${extension}`, import.meta.url));
    const child = fork(worker, [], {
      execArgv: extension === 'ts' ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    let result: T | undefined, error: Error | undefined;
    const cancel = () => {
      error = new Error('Snapshot operation was canceled.');
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      error = new Error(
        'Snapshot operation exceeded its time limit. The last good capture is preserved.',
      );
      child.kill('SIGKILL');
    }, timeout);
    timer.unref();
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('message', (message: { ok: boolean; value?: T; error?: string }) => {
      if (message.ok) result = message.value;
      else error = new Error(message.error || 'Snapshot operation failed.');
    });
    child.on('error', (cause) => {
      error = cause;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error || code !== 0 || result === undefined)
        reject(error || new Error('Snapshot worker failed.'));
      else resolve(result);
    });
    if (signal?.aborted) cancel();
    else child.send(request as object);
  });
}
