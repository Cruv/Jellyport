import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Api,
  ApiOptions,
  ImportWorkflowStatus,
  Notify,
  DestinationCatalogDiagnostic,
  DestinationCatalogStage,
  DestinationCatalogErrorCode,
} from './types';

const importStages: Record<DestinationCatalogStage, string> = {
  validating_backup: 'Validating backup',
  reading_items: 'Reading media items',
  reading_providers: 'Reading provider identifiers',
  enriching: 'Enriching matching data',
  indexing: 'Building matching index',
  fingerprinting: 'Checking backup integrity',
  encrypting: 'Encrypting matching catalog',
  validating_catalog: 'Validating matching catalog',
};
const importFailures: Record<DestinationCatalogErrorCode, string> = {
  backup_missing: 'Completed backup not found',
  backup_expired: 'Backup expired',
  backup_future: 'Backup timestamp is in the future',
  version_mismatch: 'Backup server version does not match',
  backup_invalid: 'Backup is invalid or unsupported',
  backup_changed: 'Backup changed during import',
  storage_error: 'Working storage is unavailable',
  timeout: 'Import time limit reached',
  interrupted: 'Import interrupted',
  canceled: 'Import canceled',
  worker_failed: 'Import worker failed',
};
const importCounterLimits = {
  source_rows: 5_000_000,
  provider_rows: 10_000_000,
  items: 2_000_000,
  keys: 20_000_000,
  bytes: 8 * 1024 ** 3,
} as const;
function checkedImportDiagnostic(value?: DestinationCatalogDiagnostic | null) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.stage !== 'string' ||
    typeof value.started_at !== 'string' ||
    typeof value.updated_at !== 'string' ||
    !Object.hasOwn(importStages, value.stage)
  )
    return;
  const started = Date.parse(value.started_at),
    updated = Date.parse(value.updated_at);
  if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started) return;
  for (const [key, limit] of Object.entries(importCounterLimits)) {
    const count = value[key as keyof typeof importCounterLimits];
    if (!Number.isSafeInteger(count) || count < 0 || count > limit) return;
  }
  return value;
}
export function importDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Time unavailable';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

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

type ChangeKind = 'import' | 'clear' | 'schedule' | 'backup-acknowledge' | 'backup-retention';
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
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
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

  const load = useCallback(
    async (manual = false) => {
      if (!mounted.current || !visible.current || changing.current || read.current) return;
      const controller = new AbortController();
      read.current = controller;
      const requestVersion = ++version.current;
      setLoading(true);
      if (manual) notifyRef.current('Refreshing status…');
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (!mounted.current || controller.signal.aborted || requestVersion !== version.current)
          return;
        setStatus(value);
        setError('');
        setStale(false);
        setUncertain(false);
        if (manual) notifyRef.current('Status refreshed.');
      } catch {
        if (mounted.current && !controller.signal.aborted && requestVersion === version.current) {
          setError(statusError);
          setStale(true);
          if (manual) notifyRef.current(statusError, true);
        }
      } finally {
        if (mounted.current && requestVersion === version.current) setLoading(false);
        if (read.current === controller) read.current = null;
      }
    },
    [api, path, statusError],
  );

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
    const next = Date.parse(status.next_run_at ?? '');
    const untilNext = next - Date.now();
    // This polls Jellyport's local status, never the media server. Discover an
    // imminent/due scheduled start promptly instead of showing idle for 30s.
    const imminent = Number.isFinite(next) && untilNext < 30_000 && untilNext > -60 * 60_000;
    const delay = status.running || imminent ? 2000 : 30_000;
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
  }, [active, status?.running, status?.next_run_at, busy, load]);

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
    let refreshAfterFailure = false;
    try {
      const value = await api<T>(
        kind === 'clear'
          ? path
          : `${path}/${kind === 'import' ? 'refresh' : kind === 'backup-acknowledge' ? 'backup/acknowledge' : kind === 'backup-retention' ? 'backup-retention' : 'schedule'}`,
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
        if (failure) notify(failure, true);
        if (kind === 'import') setUncertain(true);
        // Reconciliation may find a completed backup and start importing it (409).
        // Never repeat the acknowledgement; read the authoritative state instead.
        if (kind === 'backup-acknowledge') refreshAfterFailure = true;
      }
    } finally {
      // An old session's reply must never release a newer session's mutation guard.
      if (requestVersion === version.current) {
        changing.current = false;
        if (mounted.current && !controller.signal.aborted) setBusy('');
      }
      if (mutation.current === controller) mutation.current = null;
      if (refreshAfterFailure && mounted.current && !controller.signal.aborted) void load();
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
  hasRetainedData,
  importDiagnostic,
  importErrorCode,
  showAttemptDuration = false,
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
  /** Existence only. Freshness and usability are reported separately by the caller. */
  hasRetainedData?: boolean;
  importDiagnostic?: DestinationCatalogDiagnostic | null;
  importErrorCode?: DestinationCatalogErrorCode | null;
  showAttemptDuration?: boolean;
  summary: string;
  error: string;
  stale: boolean;
  uncertain: boolean;
}) {
  const outcome = starting ? null : status?.running ? 'running' : status?.last_outcome;
  const now = Date.now();
  const attemptStart = Date.parse(status?.last_attempt_at || '');
  const attemptFinish = status?.running ? now : Date.parse(status?.last_finished_at || '');
  const attemptDuration =
    !starting &&
    showAttemptDuration &&
    Number.isFinite(attemptStart) &&
    Number.isFinite(attemptFinish) &&
    attemptFinish >= attemptStart
      ? attemptFinish - attemptStart
      : undefined;
  let diagnostic = !starting && status ? checkedImportDiagnostic(importDiagnostic) : undefined;
  if (
    diagnostic &&
    Number.isFinite(attemptStart) &&
    Date.parse(diagnostic.updated_at) < attemptStart
  )
    diagnostic = undefined;
  const oldProgress = !!(
    status?.running &&
    diagnostic &&
    now - Date.parse(diagnostic.updated_at) > 15_000
  );
  const failure =
    importErrorCode && Object.hasOwn(importFailures, importErrorCode)
      ? importFailures[importErrorCode]
      : undefined;
  const counters = diagnostic
    ? [
        diagnostic.source_rows > 0
          ? `${diagnostic.source_rows.toLocaleString()} media rows read`
          : '',
        diagnostic.provider_rows > 0
          ? `${diagnostic.provider_rows.toLocaleString()} provider rows read`
          : '',
        diagnostic.items > 0 ? `${diagnostic.items.toLocaleString()} matching items` : '',
        diagnostic.keys > 0 ? `${diagnostic.keys.toLocaleString()} matching keys` : '',
        diagnostic.bytes > 0
          ? `Processed bytes: ${(diagnostic.bytes / 1024 ** 2).toFixed(1)} MiB`
          : '',
      ].filter(Boolean)
    : [];
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
      {attemptDuration !== undefined && (
        <p aria-live="off">
          {status?.running ? 'Current attempt elapsed' : 'Latest attempt duration'}:{' '}
          {importDuration(attemptDuration)}
        </p>
      )}
      {diagnostic && (
        <>
          <p>
            {status?.running ? 'Current stage' : 'Last observed stage'}:{' '}
            <strong>{importStages[diagnostic.stage]}</strong>
          </p>
          {counters.length > 0 && (
            <p className="text-small" aria-live="off">
              {counters.join(' · ')}
            </p>
          )}
          <p className="text-small" aria-live="off">
            Progress last updated {importTimestamp(diagnostic.updated_at)}
          </p>
          {oldProgress && (
            <p>
              No recent progress update. The import may still be running; refresh status to check.
            </p>
          )}
        </>
      )}
      {failure && (status?.last_error || outcome === 'failed' || outcome === 'interrupted') && (
        <>
          <p>
            Failure reason: <strong>{failure}</strong>
          </p>
          {importErrorCode === 'backup_expired' && (
            <p>Create a fresh database backup in Jellyfin, then import it.</p>
          )}
        </>
      )}
      {status?.last_error && (
        <>
          <p className="error-block" role="alert">
            {status.last_error}
          </p>
          <p>
            {hasRetainedData === true
              ? 'Previous saved data is retained.'
              : hasRetainedData === false
                ? 'No previous saved data is available.'
                : 'Refresh status to check available saved data before retrying.'}
          </p>
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
