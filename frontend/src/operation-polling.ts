import type { Api } from './types';

export const operationStatusDeadlineMs = 8000;

export function operationPollDelay(active: boolean, failures: number): number {
  if (failures) return Math.min(30_000, 3000 * 2 ** Math.min(failures - 1, 4));
  return active ? 3000 : 20_000;
}

/** A deadline bounds response headers and body reading, even if a transport stalls on abort. */
export async function readOperationStatus<T>(
  api: Api,
  path: string,
  lifetime?: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const signal = lifetime ? AbortSignal.any([lifetime, deadline.signal]) : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new Error('Operation status timed out. Jellyport will retry.')),
    operationStatusDeadlineMs,
  );
  let cancel = () => {};
  try {
    signal.throwIfAborted();
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    return await Promise.race([api<T>(path, { signal }), stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
