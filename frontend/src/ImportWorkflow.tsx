import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, ApiOptions, ImportWorkflowStatus, Notify } from './types';

export const importTimestamp = (value?: string | null) => {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Time unavailable';
};
export const importAge = (value: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return 'Age unavailable';
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m old`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m old`;
};
export function useImportClock(deadlines: string[], active: boolean) {
  const [now, setNow] = useState(Date.now);
  const key = deadlines.join('|');
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    if (!key) return;
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const next = key
        .split('|')
        .map(Date.parse)
        .filter((value) => Number.isFinite(value) && value > Date.now())
        .sort((a, b) => a - b)[0];
      if (next !== undefined)
        timer = setTimeout(
          () => {
            setNow(Date.now());
            schedule();
          },
          Math.min(next - Date.now(), 2_147_483_647),
        );
    };
    schedule();
    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [active, key]);
  return now;
}

type ChangeKind = 'import' | 'clear' | 'schedule';
/** Own one read or mutation at a time; hiding a panel pauses reads, not accepted server work. */
export function useImportWorkflow<T extends ImportWorkflowStatus>({
  api,
  path,
  active,
  demo,
  notify,
  statusError,
}: {
  api: Api;
  path: string;
  active: boolean;
  demo: boolean;
  notify: Notify;
  statusError: string;
}) {
  const [status, setStatus] = useState<T | null>(null);
  const [busy, setBusy] = useState<ChangeKind | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [stale, setStale] = useState(false);
  const mounted = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const changing = useRef(false);
  const version = useRef(0);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    changing.current = false;
    setStatus(null);
    setBusy('');
    setLoading(false);
    setError('');
    setStale(false);
    setUncertain(false);
    return () => {
      mounted.current = false;
      version.current++;
      read.current?.abort();
      mutation.current?.abort();
    };
  }, [api, path]);

  const load = useCallback(async () => {
    if (!mounted.current || !visible.current || changing.current || read.current) return;
    const controller = new AbortController();
    read.current = controller;
    const requestVersion = ++version.current;
    setLoading(true);
    try {
      const value = await api<T>(path, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || requestVersion !== version.current)
        return;
      setStatus(value);
      setError('');
      setStale(false);
      setUncertain(false);
    } catch {
      if (mounted.current && !controller.signal.aborted && requestVersion === version.current) {
        setError(statusError);
        setStale(true);
      }
    } finally {
      if (mounted.current && requestVersion === version.current) setLoading(false);
      if (read.current === controller) read.current = null;
    }
  }, [api, path, statusError]);

  useEffect(() => {
    if (active) void load();
    else if (read.current) {
      read.current.abort();
      read.current = null;
      version.current++;
      setLoading(false);
    }
    return () => {
      // This cleanup must not abort an import whose acknowledgement is pending.
      if (read.current) {
        read.current.abort();
        read.current = null;
        version.current++;
      }
    };
  }, [active, load]);

  useEffect(() => {
    if (!active || !status || busy) return;
    const delay = status.running ? 2000 : 30_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, status?.running, busy, load]);

  async function change(
    kind: ChangeKind,
    options: Pick<ApiOptions, 'method' | 'body'>,
    success: string,
    failure: string,
  ): Promise<T | undefined> {
    if (
      demo ||
      !visible.current ||
      changing.current ||
      !status ||
      (kind !== 'schedule' && (status.running || uncertain || stale))
    )
      return;
    changing.current = true;
    read.current?.abort();
    read.current = null;
    const controller = new AbortController();
    mutation.current = controller;
    const requestVersion = ++version.current;
    setBusy(kind);
    setLoading(false);
    setError('');
    try {
      const value = await api<T>(
        kind === 'clear' ? path : `${path}/${kind === 'import' ? 'refresh' : 'schedule'}`,
        {
          ...options,
          signal: controller.signal,
        },
      );
      if (!mounted.current || controller.signal.aborted || requestVersion !== version.current)
        return;
      setStatus(value);
      setStale(false);
      setUncertain(false);
      notify(success);
      return value;
    } catch {
      if (mounted.current && !controller.signal.aborted && requestVersion === version.current) {
        setError(failure);
        if (kind === 'import') setUncertain(true);
      }
    } finally {
      // An old session's reply must never release a newer session's mutation guard.
      if (requestVersion === version.current) {
        changing.current = false;
        if (mounted.current && !controller.signal.aborted) setBusy('');
      }
      if (mutation.current === controller) mutation.current = null;
    }
  }
  return { status, busy, loading, error, uncertain, stale, load, change };
}

export function ImportStatus({
  status,
  loading,
  starting,
  initialLabel,
  runningLabel,
  progressLabel,
  capture = false,
  measured,
  summary,
  error,
  stale,
  uncertain,
}: {
  status: ImportWorkflowStatus | null;
  loading: boolean;
  starting: boolean;
  initialLabel: string;
  runningLabel: string;
  progressLabel: string;
  capture?: boolean;
  measured?: { total: number; processed: number };
  summary: string;
  error: string;
  stale: boolean;
  uncertain: boolean;
}) {
  const outcome = starting ? null : status?.running ? 'running' : status?.last_outcome;
  const actual =
    measured &&
    Number.isSafeInteger(measured.total) &&
    measured.total > 0 &&
    Number.isSafeInteger(measured.processed) &&
    measured.processed >= 0 &&
    measured.processed <= measured.total
      ? measured
      : undefined;
  return (
    <div className="status-summary form-stack" role="status" aria-live="polite">
      <strong>
        {starting
          ? capture
            ? 'Starting capture…'
            : 'Starting import…'
          : status?.running
            ? runningLabel
            : !status
              ? loading
                ? initialLabel
                : 'Import status unavailable'
              : summary}
      </strong>
      {((!status && loading) || starting || status?.running) && (
        <progress
          aria-label={progressLabel}
          {...(status?.running && actual ? { value: actual.processed, max: actual.total } : {})}
        />
      )}
      {status?.running && actual && (
        <p>
          {actual.processed.toLocaleString()} of {actual.total.toLocaleString()} accounts checked
        </p>
      )}
      {loading && status && <p>Refreshing status…</p>}
      {status?.last_attempt_at && (
        <p>
          Last {capture ? 'capture' : 'import'} attempt {importTimestamp(status.last_attempt_at)}
        </p>
      )}
      {status?.last_finished_at && (
        <p>
          Last finished {capture ? 'capture' : 'import'} {importTimestamp(status.last_finished_at)}
        </p>
      )}
      {outcome && (
        <p>
          Last outcome:{' '}
          <strong>
            {
              {
                running: 'Running',
                succeeded: 'Completed',
                failed: 'Failed',
                interrupted: 'Interrupted',
              }[outcome]
            }
          </strong>
        </p>
      )}
      {status?.last_error && (
        <>
          <p className="error-block" role="alert">
            {status.last_error}
          </p>
          <p>Previous valid saved data is retained.</p>
        </>
      )}
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {stale && status && (
        <p>Showing the last known status. Refresh status before starting another import.</p>
      )}
      {uncertain && (
        <p>
          The start request may have been accepted. Refresh status to check before trying again.
        </p>
      )}
    </div>
  );
}
