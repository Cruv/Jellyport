import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Icon } from './components';
import { date, num, type ActivityRetentionStatus, type Api, type Notify } from './types';

export default function ActivityRetentionPanel({
  api,
  notify,
  demo,
  active = true,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
  active?: boolean;
}) {
  const [status, setStatus] = useState<ActivityRetentionStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const initialized = useRef(false);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const saving = useRef(false);
  const readStatus = useCallback(
    async (manual = false) => {
      if (saving.current) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const version = ++requestVersion.current;
      setBusy('load');
      setError('');
      try {
        const value = await api<ActivityRetentionStatus>('/api/jobs/retention', {
          signal: controller.signal,
        });
        if (!mounted.current || controller.signal.aborted || version !== requestVersion.current)
          return;
        if (
          !Number.isInteger(value.retention_days) ||
          value.retention_days < 0 ||
          value.retention_days > 3650
        )
          throw new Error('Unsupported retention setting.');
        setStatus(value);
        if (manual) notify('Activity retention status refreshed.');
        if (!initialized.current) {
          initialized.current = true;
          setEnabled(value.retention_days > 0);
          setDays(String(value.retention_days || 30));
        }
      } catch {
        if (mounted.current && !controller.signal.aborted && version === requestVersion.current) {
          const detail =
            'Activity retention status could not be loaded. Refresh status to try again.';
          setError(detail);
          if (manual) notify(detail, true);
        }
      } finally {
        if (mounted.current && !controller.signal.aborted && version === requestVersion.current)
          setBusy('');
      }
    },
    [api, notify],
  );
  useEffect(() => {
    if (!active) return;
    mounted.current = true;
    void readStatus();
    return () => {
      mounted.current = false;
      requestVersion.current++;
      request.current?.abort();
      saving.current = false;
    };
  }, [active, readStatus]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demo || saving.current || busy || !status || !active) return;
    const retentionDays = enabled ? Number(days) : 0;
    if (
      enabled &&
      (!/^[0-9]+$/.test(days) ||
        !Number.isSafeInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 3650)
    ) {
      setValidation('Enter a whole number of days from 1 to 3,650.');
      return;
    }
    saving.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++requestVersion.current;
    setBusy('save');
    setError('');
    setValidation('');
    try {
      const value = await api<ActivityRetentionStatus>('/api/jobs/retention', {
        method: 'PUT',
        body: { retention_days: retentionDays },
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted || version !== requestVersion.current)
        return;
      setStatus(value);
      notify(
        retentionDays
          ? 'Automatic activity cleanup saved.'
          : 'Automatic activity cleanup turned off.',
      );
    } catch {
      if (mounted.current && !controller.signal.aborted && version === requestVersion.current) {
        const detail =
          'Activity retention could not be saved. Your changes are kept; retry saving or refresh status to verify the current setting.';
        setError(detail);
        notify(detail, true);
      }
    } finally {
      if (version === requestVersion.current) {
        saving.current = false;
        if (mounted.current && !controller.signal.aborted) setBusy('');
      }
    }
  }
  const dirty = !!status && (enabled ? Number(days) : 0) !== status.retention_days;
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Activity retention</h2>
          <p>Optionally clear old Jellyport reports automatically.</p>
        </div>
        <button
          className="btn btn-small btn-quiet"
          type="button"
          onClick={() => void readStatus(true)}
          aria-busy={busy === 'load'}
          disabled={!!busy}
        >
          <Icon name="refresh" />
          Refresh status
        </button>
      </div>
      <div className="panel-body form-stack">
        <p className="section-note">
          Saves independently from connection and account settings. Automatic cleanup is off until
          you enable and save it.
        </p>
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {!status && !error && <p role="status">Loading activity retention…</p>}
        {status && (
          <>
            <p className="text-small">
              Saved setting:{' '}
              <strong>
                {status.retention_days
                  ? `Clear reports older than ${num(status.retention_days)} ${status.retention_days === 1 ? 'day' : 'days'}`
                  : 'Automatic cleanup off'}
              </strong>
            </p>
            <form className="form-stack" aria-label="Activity retention" onSubmit={save} noValidate>
              <div className="toggle-row">
                <div>
                  <label htmlFor="activity-retention-enabled" className="switch-label">
                    Enable automatic activity cleanup
                  </label>
                </div>
                <label className="toggle">
                  <input
                    id="activity-retention-enabled"
                    type="checkbox"
                    checked={enabled}
                    disabled={demo || !!busy}
                    onChange={(event) => {
                      setEnabled(event.target.checked);
                      setValidation('');
                    }}
                  />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
              </div>
              <div className="field">
                <label htmlFor="activity-retention-days">Keep reports for this many days</label>
                <input
                  id="activity-retention-days"
                  type="number"
                  min="1"
                  max="3650"
                  step="1"
                  inputMode="numeric"
                  value={days}
                  disabled={demo || !!busy || !enabled}
                  aria-invalid={!!validation}
                  aria-describedby={
                    validation ? 'retention-days-hint retention-days-error' : 'retention-days-hint'
                  }
                  onChange={(event) => {
                    setDays(event.target.value);
                    setValidation('');
                  }}
                />
                <small id="retention-days-hint">
                  30 days is a suggested starting point. Choose 1–3,650 days.
                </small>
              </div>
              {validation && (
                <p className="error-block" role="alert" id="retention-days-error">
                  {validation}
                </p>
              )}
              <div className="button-row">
                <button className="btn btn-primary" type="submit" disabled={demo || !!busy}>
                  {busy === 'save' && <span className="spinner" />}
                  {busy === 'save' ? 'Saving…' : 'Save activity retention'}
                </button>
                {dirty && <span className="subtle text-small">Unsaved retention changes</span>}
              </div>
            </form>
            <div className="job-meta">
              <span>
                Last automatic pass: {status.last_run_at ? date(status.last_run_at) : 'Not run yet'}
              </span>
              <span>Reports cleared: {num(status.last_removed)}</span>
              <span>Protected reports kept: {num(status.last_kept)}</span>
            </div>
            {status.error && (
              <p className="error-block" role="alert">
                Automatic cleanup could not finish. Reports are kept; the next pass will retry.
              </p>
            )}
          </>
        )}
        <Callout icon="info" title="Only stored reports are cleared.">
          Completed, Failed, and Needs review reports are eligible once old enough. Media accounts
          and watch history stay unchanged. Active work, pending credentials, recovery records, and
          unfinished subscription processing remain protected. When enabled, Jellyport checks every
          minute and clears at most 100 reports per pass.
        </Callout>
      </div>
    </section>
  );
}
