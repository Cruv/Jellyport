import { useCallback, useEffect, useRef, useState } from 'react';
import { Callout, Icon } from './components';
import type { Api, Notify } from './types';

export interface DestinationCatalogMetadata {
  id: string;
  items: number;
  keys: number;
  bytes: number;
  server_version: string;
  backup_engine_version: string;
  backup_created_at: string;
  imported_at: string;
  import_elapsed_ms: number;
  expires_at: string;
}

export interface DestinationCatalogStatus {
  usable?: boolean;
  configured: boolean;
  available: boolean;
  running: boolean;
  record: DestinationCatalogMetadata | null;
  last_error: string | null;
  last_attempt_at: string | null;
}

const timestamp = (value: string) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Time unavailable';
};
const age = (value: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return 'Age unavailable';
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m old`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m old`;
};
const duration = (milliseconds: number) =>
  milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;

export default function DestinationCatalogPanel({
  api,
  notify,
  demo,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
}) {
  const [status, setStatus] = useState<DestinationCatalogStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'import' | 'clear' | ''>('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const changing = useRef(false);
  const active = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (changing.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const value = await api<DestinationCatalogStatus>('/api/destination-catalog', {
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted || requestVersion.current !== version)
        return;
      setStatus(value);
      setNow(Date.now());
      setError('');
    } catch {
      if (mounted.current && !controller.signal.aborted && requestVersion.current === version)
        setError('Jellyfin catalog status could not be loaded. Refresh status to try again.');
    } finally {
      if (mounted.current && requestVersion.current === version) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    changing.current = false;
    setBusy('');
    void load();
    return () => {
      mounted.current = false;
      changing.current = false;
      requestVersion.current++;
      active.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!status?.running || busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status?.running, busy, load]);

  const record = status?.record;
  useEffect(() => {
    if (!record) return;
    const tick = () => setNow(Date.now());
    const interval = setInterval(tick, 60_000);
    const remaining = Date.parse(record.expires_at) - Date.now();
    const expiry =
      Number.isFinite(remaining) && remaining > 0 ? setTimeout(tick, remaining) : undefined;
    return () => {
      clearInterval(interval);
      if (expiry !== undefined) clearTimeout(expiry);
    };
  }, [record?.id, record?.expires_at]);

  async function change(kind: 'import' | 'clear') {
    if (
      demo ||
      changing.current ||
      !status ||
      status.running ||
      (kind === 'import' ? !status.configured || !status.available : !status.record)
    )
      return;
    changing.current = true;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++requestVersion.current;
    setBusy(kind);
    setLoading(false);
    setError('');
    try {
      const value = await api<DestinationCatalogStatus>(
        kind === 'import' ? '/api/destination-catalog/refresh' : '/api/destination-catalog',
        { method: kind === 'import' ? 'POST' : 'DELETE', signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted || requestVersion.current !== version)
        return;
      setStatus(value);
      setNow(Date.now());
      notify(
        kind === 'import'
          ? 'Jellyfin backup import started. You can follow its status here.'
          : 'Saved Jellyfin matching catalog cleared.',
      );
    } catch {
      if (mounted.current && !controller.signal.aborted && requestVersion.current === version)
        setError(
          kind === 'import'
            ? 'Jellyfin backup import could not start. Check the completed backup and refresh status.'
            : 'The matching catalog could not be cleared. An import or migration may still be using it. Refresh status and try again.',
        );
    } finally {
      if (requestVersion.current === version) {
        changing.current = false;
        if (mounted.current) setBusy('');
      }
    }
  }

  const expired =
    !!record &&
    (!Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= now);
  const usable = !!record && !expired && status?.usable !== false;
  return (
    <section className="panel mt-18" aria-label="Saved Jellyfin matching catalog">
      <div className="panel-header">
        <div>
          <h2>Saved Jellyfin matching catalog</h2>
          <p>Import matching metadata from a completed Jellyfin database backup.</p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <p className="muted text-small">
          The saved catalog supplies item identities for matching, avoiding a live library scan.
          Current Jellyfin watch history and account access are still checked through its API;
          history updates and verification also use the live server. No saved Jellyfin user history
          is imported.
        </p>
        <Callout icon="info" title="Original backup time controls expiry.">
          Import a completed database backup from the linked Jellyfin server. Importing it again
          does not make the catalog newer. Changes to library identities after the backup require a
          new backup and import.
        </Callout>
        {status?.configured === false && (
          <Callout warning title="Jellyfin backup import is not configured.">
            Configure the read-only backup bind mount and helper using the{' '}
            <a
              href="https://github.com/Cruv/Jellyport/blob/main/docs/docker-deployment.md"
              target="_blank"
              rel="noreferrer"
            >
              Docker deployment guide
            </a>
            , then refresh status.
          </Callout>
        )}
        {status?.configured && !status.available && (
          <Callout warning title="Jellyfin backup import helper is unavailable.">
            Check that the helper is running with its read-only Jellyfin backup bind mount, then
            refresh status. An existing, unexpired matching catalog can still be used.
          </Callout>
        )}
        {status && !usable && !status.running && (
          <Callout
            warning
            title={
              expired
                ? 'The saved matching catalog has expired.'
                : 'Saved matching catalog unavailable.'
            }
          >
            Import a recent, completed Jellyfin database backup before starting a migration with
            saved matching data. The last imported catalog remains listed for review.
          </Callout>
        )}
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {status?.last_error && (
          <p className="error-block" role="alert">
            {status.last_error}
          </p>
        )}
        <div role="status" aria-live="polite">
          <strong>
            {status?.running
              ? 'Importing Jellyfin backup…'
              : !status
                ? loading
                  ? 'Loading Jellyfin catalog status…'
                  : 'Jellyfin catalog status unavailable'
                : usable
                  ? 'Saved matching catalog available'
                  : record
                    ? expired
                      ? 'Saved matching catalog expired'
                      : 'Saved matching catalog unavailable'
                    : 'No saved Jellyfin matching catalog'}
          </strong>
          {status?.running && <progress aria-label="Jellyfin catalog import progress" />}
          {status?.last_attempt_at && (
            <p className="muted text-small">
              Last import attempt {timestamp(status.last_attempt_at)}
            </p>
          )}
        </div>
        {record && (
          <div className="table-wrap">
            <table aria-label="Imported Jellyfin catalog">
              <thead>
                <tr>
                  <th>Original backup</th>
                  <th>Contents</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{timestamp(record.backup_created_at)}</strong>
                    <small>{age(record.backup_created_at, now)}</small>
                    <small>Imported {timestamp(record.imported_at)}</small>
                    <small>Import duration {duration(record.import_elapsed_ms)}</small>
                  </td>
                  <td>
                    <strong>{record.items.toLocaleString()} matching items</strong>
                    <small>
                      {record.keys.toLocaleString()} matching keys ·{' '}
                      {(record.bytes / 1024 ** 2).toFixed(1)} MiB
                    </small>
                    <small>
                      Jellyfin {record.server_version} · Backup format{' '}
                      {record.backup_engine_version}
                    </small>
                  </td>
                  <td>
                    <strong>{expired ? 'Expired' : usable ? 'Available' : 'Unavailable'}</strong>
                    <small>Expires {timestamp(record.expires_at)}</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <div className="button-row">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => void load()}
            disabled={!!busy || loading}
          >
            <Icon name="refresh" />
            {loading ? 'Refreshing catalog status…' : 'Refresh catalog status'}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void change('import')}
            disabled={demo || !!busy || !status?.configured || !status.available || status.running}
          >
            {busy === 'import' ? 'Starting import…' : 'Import latest Jellyfin backup'}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => void change('clear')}
            disabled={demo || !!busy || !record || !!status?.running}
          >
            {busy === 'clear' ? 'Clearing catalog…' : 'Clear matching catalog'}
          </button>
        </div>
        {demo && (
          <p className="muted text-small">Demo mode: Jellyfin catalog changes are disabled.</p>
        )}
      </div>
    </section>
  );
}
