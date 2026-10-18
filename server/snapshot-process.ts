import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPTURE_DEADLINE } from './snapshot-files.js';
import {
  DestinationCatalogError,
  validDestinationDiagnostic,
  validDestinationErrorCode,
  type DestinationCatalogDiagnostic,
} from './destination-catalog-files.js';

export interface SnapshotProcessOptions {
  onProgress?: (value: unknown) => void;
}

/** Kill and reap the worker on timeout; an abandoned native backup must not keep reading Emby. */
export function snapshotProcess<T>(
  request: unknown,
  signal?: AbortSignal,
  timeout = CAPTURE_DEADLINE,
  options: SnapshotProcessOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const destination = !!(
      request &&
      typeof request === 'object' &&
      'operation' in request &&
      request.operation === 'destination_capture'
    );
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = fileURLToPath(new URL(`./snapshot-worker.${extension}`, import.meta.url));
    const child = fork(worker, [], {
      execArgv: extension === 'ts' ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    let result: T | undefined, error: Error | undefined;
    let diagnostic: DestinationCatalogDiagnostic | undefined;
    const cancel = () => {
      error = destination
        ? new DestinationCatalogError('canceled', diagnostic)
        : new Error('Snapshot operation was canceled.');
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      error = destination
        ? new DestinationCatalogError('timeout', diagnostic)
        : new Error(
            'Snapshot operation exceeded its time limit. Any previously saved capture is preserved.',
          );
      child.kill('SIGKILL');
    }, timeout);
    timer.unref();
    signal?.addEventListener('abort', cancel, { once: true });
    child.on(
      'message',
      (message: {
        type?: string;
        ok?: boolean;
        value?: T;
        error?: string;
        error_code?: unknown;
        diagnostic?: unknown;
      }) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'progress') {
          if (destination && validDestinationDiagnostic(message.value)) {
            diagnostic = message.value;
            try {
              options.onProgress?.(diagnostic);
            } catch {
              /* Observers do not affect workers. */
            }
          }
          return;
        }
        if (
          destination &&
          error instanceof DestinationCatalogError &&
          ['timeout', 'canceled'].includes(error.error_code)
        )
          return;
        if (message.ok) result = message.value;
        else
          error = destination
            ? new DestinationCatalogError(
                validDestinationErrorCode(message.error_code)
                  ? message.error_code
                  : 'worker_failed',
                validDestinationDiagnostic(message.diagnostic) ? message.diagnostic : diagnostic,
              )
            : new Error(message.error || 'Snapshot operation failed.');
      },
    );
    child.on('error', (cause) => {
      error = destination ? new DestinationCatalogError('worker_failed', diagnostic) : cause;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error || code !== 0 || result === undefined)
        reject(
          error ||
            (destination
              ? new DestinationCatalogError('worker_failed', diagnostic)
              : new Error('Snapshot worker failed.')),
        );
      else resolve(result);
    });
    if (signal?.aborted) cancel();
    else child.send(request as object);
  });
}
