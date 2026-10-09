import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Icon } from './components';
import type { Api, Notify, SourceSnapshotConfig, SourceSnapshotStatus } from './types';

const clock = (config: SourceSnapshotConfig) =>
  `${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`;
const timestamp = (value: string) => new Date(value).toLocaleString();
const age = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (!Number.isFinite(minutes)) return 'Age unavailable';
  return minutes < 1
    ? 'Captured just now'
    : minutes < 60
      ? `${minutes}m old`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m old`;
};

export default function SourceSnapshotsPanel({
  api,
  notify,
  demo,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
}) {
  const [status, setStatus] = useState<SourceSnapshotStatus | null>(null);
  const [draft, setDraft] = useState<SourceSnapshotConfig | null>(null);
  const [captureTime, setCaptureTime] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const mounted = useRef(false);
  const active = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const changing = useRef(false);
  const initialized = useRef(false);

  const load = useCallback(async () => {
    if (changing.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++requestVersion.current;
    try {
      const value = await api<SourceSnapshotStatus>('/api/source-snapshots', {
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted || requestVersion.current !== version)
        return;
      setStatus(value);
      if (!initialized.current) {
        initialized.current = true;
        setDraft({ ...value.config });
        setCaptureTime(clock(value.config));
      }
      setError('');
    } catch {
      if (mounted.current && !controller.signal.aborted && requestVersion.current === version)
        setError('Saved snapshot status could not be loaded. Refresh status to try again.');
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
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

  async function change(kind: 'schedule' | 'capture' | 'clear', body?: unknown) {
    if (demo || changing.current || !status) return;
    changing.current = true;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++requestVersion.current;
    setBusy(kind);
    setError('');
    try {
      const path =
        kind === 'schedule'
          ? '/api/source-snapshots/schedule'
          : kind === 'capture'
            ? '/api/source-snapshots/refresh'
            : '/api/source-snapshots';
      const value = await api<SourceSnapshotStatus>(path, {
        method: kind === 'schedule' ? 'PUT' : kind === 'capture' ? 'POST' : 'DELETE',
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted || requestVersion.current !== version)
        return;
      setStatus(value);
      if (kind === 'schedule') {
        setDraft({ ...value.config });
        setCaptureTime(clock(value.config));
      }
      notify(
        kind === 'schedule'
          ? 'Database capture schedule saved.'
          : kind === 'capture'
            ? 'Database capture started. You can follow its status here.'
            : 'Saved database captures cleared.',
      );
    } catch {
      if (mounted.current && !controller.signal.aborted && requestVersion.current === version)
        setError(
          kind === 'schedule'
            ? 'The capture schedule could not be saved. Refresh status and reload the saved schedule before trying again.'
            : kind === 'capture'
              ? 'Database capture could not start. Check the read-only source mount and refresh status.'
              : 'Saved captures could not be cleared. A capture or migration may still be using them. Refresh status and try again.',
        );
    } finally {
      changing.current = false;
      if (mounted.current && requestVersion.current === version) setBusy('');
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !/^\d{2}:\d{2}$/.test(captureTime)) return;
    const [hour, minute] = captureTime.split(':').map(Number);
    void change('schedule', {
      enabled: draft.enabled,
      hour,
      minute,
      time_zone: draft.time_zone.trim(),
      scope: draft.scope,
      expected_revision: draft.revision,
    });
  }
  function resetDraft() {
    if (!status) return;
    setDraft({ ...status.config });
    setCaptureTime(clock(status.config));
    setError('');
  }
  const fileCopy = status?.capture_method === 'file_copy';
  const hasFileCopies =
    fileCopy || status?.records.some((record) => record.source_type === 'file_copy');
  return (
    <section className="panel mt-18" aria-label="Saved Emby database snapshots">
      <div className="panel-header">
        <div>
          <h2>Saved Emby database snapshots</h2>
          <p>Capture the database once, then read saved user history for migrations.</p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <p className="muted text-small">
          A network-isolated helper uses a read-only Emby database mount on the same Docker host.{' '}
          {fileCopy
            ? 'File copies run while Emby stays online; no filesystem snapshot or downtime is needed.'
            : 'Emby can keep running while a consistent SQLite online backup is captured.'}{' '}
          This avoids a full library scan through Emby’s API. Database captures support both
          complete and watched-only migrations.
        </p>
        {hasFileCopies && (
          <Callout icon="info" title="File copies use best-effort history.">
            Live file copies are not transactional. Some history may be missing or inconsistent even
            when validation passes. Failed captures keep the last good copy.
          </Callout>
        )}
        {status?.available === false && (
          <Callout warning title="Emby database source is unavailable.">
            Configure the read-only source mount using the{' '}
            <a
              href="https://github.com/Cruv/Jellyport/blob/main/docs/docker-deployment.md"
              target="_blank"
              rel="noreferrer"
            >
              Docker deployment guide
            </a>
            , then refresh status. Saved captures remain listed below.
          </Callout>
        )}
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {status && (
          <div aria-live="polite">
            <p className="muted text-small">
              Capture method:{' '}
              <strong>{fileCopy ? 'Scheduled file copy' : 'SQLite online backup'}</strong>
            </p>
            <strong>
              {status.running
                ? 'Capturing Emby database…'
                : `${status.snapshots} saved database ${status.snapshots === 1 ? 'capture' : 'captures'}`}
            </strong>
            {status.running && (
              <progress className="progress-track" aria-label="Database capture progress" />
            )}
            {status.users_total > 0 && (
              <p className="muted text-small">
                {status.users_processed} of {status.users_total} accounts checked ·{' '}
                {status.users_succeeded} succeeded · {status.users_failed} failed
              </p>
            )}
            {status.last_attempt_at && (
              <p className="muted text-small">Last attempt {timestamp(status.last_attempt_at)}</p>
            )}
            {status.last_finished_at && (
              <p className="muted text-small">Last finished {timestamp(status.last_finished_at)}</p>
            )}
            {status.last_error && (
              <p className="error-block">
                {status.last_error} Previous valid captures are retained.
              </p>
            )}
          </div>
        )}
        {draft && status && (
          <form onSubmit={save} className="form-stack" aria-label="Database capture schedule">
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                disabled={demo || !!busy}
              />
              Enable daily database capture
            </label>
            <div className="field-row">
              <div className="field">
                <label htmlFor="snapshot-time">Capture time</label>
                <input
                  id="snapshot-time"
                  type="time"
                  required
                  value={captureTime}
                  onChange={(event) => setCaptureTime(event.target.value)}
                  disabled={demo || !!busy}
                />
              </div>
              <div className="field">
                <label htmlFor="snapshot-zone">Time zone</label>
                <input
                  id="snapshot-zone"
                  required
                  value={draft.time_zone}
                  onChange={(event) => setDraft({ ...draft, time_zone: event.target.value })}
                  disabled={demo || !!busy}
                  aria-describedby="snapshot-schedule-help"
                />
              </div>
            </div>
            <small id="snapshot-schedule-help">
              Scheduling starts off. Times use the time zone shown here, supplied by the server.
              Each capture includes data for both migration scopes.
            </small>
            {draft.revision !== status.config.revision && (
              <p className="error-block">
                The saved schedule changed. Reload it before saving your changes.
              </p>
            )}
            <div className="button-row">
              <button
                className="btn btn-primary"
                type="submit"
                disabled={demo || !!busy || draft.revision !== status.config.revision}
              >
                {busy === 'schedule' ? 'Saving schedule…' : 'Save capture schedule'}
              </button>
              <button
                className="btn btn-quiet"
                type="button"
                onClick={resetDraft}
                disabled={!!busy}
              >
                Reload saved schedule
              </button>
            </div>
          </form>
        )}
        <div className="button-row">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => void load()}
            disabled={!!busy}
          >
            <Icon name="refresh" />
            Refresh snapshot status
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void change('capture')}
            disabled={demo || !!busy || !status || status.running || status.available === false}
          >
            {busy === 'capture' ? 'Starting capture…' : 'Capture database now'}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => void change('clear')}
            disabled={demo || !!busy || !status || status.running || !status.snapshots}
          >
            {busy === 'clear' ? 'Clearing captures…' : 'Clear saved captures'}
          </button>
        </div>
        {demo && (
          <p className="muted text-small">Demo mode: database capture changes are disabled.</p>
        )}
        {!!status?.records.length && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Captured</th>
                  <th>Contents</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody>
                {status.records.map((record) => (
                  <tr key={`${record.id}:${record.source_user_id}`}>
                    <td>
                      <strong>{record.source_username || 'All Emby users'}</strong>
                      <small>
                        Emby {record.source_server_version}
                        {record.schema ? ` · ${record.schema}` : ''}
                      </small>
                      <small>Source {record.source_server_id}</small>
                    </td>
                    <td>
                      <strong>{timestamp(record.finished_at)}</strong>
                      <small>{age(record.finished_at)}</small>
                      <small>
                        Read window {timestamp(record.started_at)} – {timestamp(record.finished_at)}
                      </small>
                    </td>
                    <td>
                      <strong>
                        {record.source_type === 'file_copy'
                          ? 'File copy'
                          : record.source_type === 'sqlite_online_backup'
                            ? 'SQLite online backup'
                            : record.scope === 'watched_only'
                              ? 'Watched-only data'
                              : 'Complete data'}
                      </strong>
                      {record.source_type && (
                        <small>
                          {record.scope === 'watched_only'
                            ? 'Watched-only migration data'
                            : 'Complete migration data'}
                        </small>
                      )}
                      <small>{Math.ceil(record.bytes / 1024).toLocaleString()} KiB</small>
                    </td>
                    <td>
                      <span
                        className={`status ${new Date(record.expires_at).getTime() <= Date.now() ? 'warn' : 'good'}`}
                      >
                        {new Date(record.expires_at).getTime() <= Date.now()
                          ? 'Expired'
                          : 'Available'}
                      </span>
                      <small>Expires {timestamp(record.expires_at)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <small>
          Saved copies contain user data and stay on the Jellyport server. Choose “Use saved Emby
          snapshot” when previewing a migration. Missing, expired, or unsupported data stops that
          migration rather than silently switching to live reads. Captures in use by a migration
          cannot be cleared.
        </small>
      </div>
    </section>
  );
}
