import { useRef, useState, type FormEvent } from 'react';
import type { DestinationCatalogConfig, ImportScheduleConfig, SourceSnapshotConfig } from './types';
import { useWorkspaceDraftState } from './workspace-drafts';

const clock = (config: ImportScheduleConfig) =>
  `${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`;
type Schedule = ImportScheduleConfig | SourceSnapshotConfig | DestinationCatalogConfig;
const createsBackup = (config: Schedule) =>
  'create_backup' in config && config.create_backup === true;
const scheduleDraft = (config: Schedule, createBackup: boolean): Schedule => ({
  enabled: config.enabled,
  hour: config.hour,
  minute: config.minute,
  time_zone: config.time_zone,
  revision: config.revision,
  ...('scope' in config ? { scope: config.scope } : {}),
  ...(createBackup ? { create_backup: createsBackup(config) } : {}),
});

export default function DailyImportSchedule({
  id,
  config,
  nextRun,
  busy,
  demo,
  capture = false,
  createBackup = false,
  onSave,
}: {
  id: string;
  config: Schedule;
  nextRun?: string | null;
  busy: string;
  demo: boolean;
  capture?: boolean;
  createBackup?: boolean;
  onSave: (
    input: Omit<Schedule, 'revision'> & { expected_revision: string },
  ) => Promise<Schedule | undefined>;
}) {
  const [draft, setDraft] = useWorkspaceDraftState(`${id}:config`, () =>
    scheduleDraft(config, createBackup),
  );
  const [time, setTime] = useWorkspaceDraftState(`${id}:time`, () => clock(config));
  const [validation, setValidation] = useState('');
  const generation = useRef(0);
  const verb = capture ? 'capture' : 'import';
  const stale = draft.revision !== config.revision;
  const dirty =
    time !== clock(config) ||
    draft.enabled !== config.enabled ||
    draft.time_zone !== config.time_zone ||
    (createBackup && createsBackup(draft) !== createsBackup(config));
  let scheduledTime = 'Time unavailable';
  if (nextRun && Number.isFinite(Date.parse(nextRun))) {
    try {
      scheduledTime = new Intl.DateTimeFormat(undefined, {
        timeZone: config.time_zone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(nextRun));
    } catch {
      // Keep malformed remote timestamps/zones from breaking schedule recovery.
    }
  }
  function reload() {
    generation.current++;
    setDraft(scheduleDraft(config, createBackup));
    setTime(clock(config));
    setValidation('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demo || busy || stale) return;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setValidation('Choose a daily time from 00:00 to 23:59.');
      return;
    }
    const zone = draft.time_zone.trim();
    try {
      if (!zone) throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    } catch {
      setValidation('Enter a valid IANA time zone, such as America/New_York or UTC.');
      return;
    }
    setValidation('');
    const submitted = generation.current;
    const [hour, minute] = time.split(':').map(Number);
    const value = await onSave({
      enabled: draft.enabled,
      hour,
      minute,
      time_zone: zone,
      ...('scope' in draft ? { scope: draft.scope } : {}),
      ...(createBackup ? { create_backup: createsBackup(draft) } : {}),
      expected_revision: draft.revision,
    });
    if (value && generation.current === submitted) {
      setDraft(scheduleDraft(value, createBackup));
      setTime(clock(value));
    }
  }
  return (
    <section className="form-stack" aria-label={`Daily ${verb} schedule`}>
      <div className="status-summary form-stack">
        <p>
          Saved schedule:{' '}
          <strong>
            {config.enabled ? `Daily at ${clock(config)} (${config.time_zone})` : 'Off'}
          </strong>
        </p>
        {createBackup && (
          <p>
            Scheduled workflow:{' '}
            {createsBackup(config)
              ? 'Create a fresh Jellyfin backup, then import it after it finishes.'
              : 'Import an existing completed Jellyfin backup.'}
          </p>
        )}
        <p>
          Next scheduled {verb}:{' '}
          {config.enabled
            ? nextRun
              ? `${Date.parse(nextRun) <= Date.now() ? 'Due — waiting to start; scheduled for ' : ''}${scheduledTime} (${config.time_zone})`
              : 'Unavailable — refresh status to check'
            : 'None — schedule is off'}
        </p>
      </div>
      <details className="help-disclosure">
        <summary>Daily schedule</summary>
        <form
          className="inline-panel form-stack"
          aria-label={capture ? 'Database capture schedule' : 'Backup import schedule'}
          onSubmit={save}
          noValidate
        >
          <div>
            <h4>{capture ? 'Daily database capture' : 'Daily backup import'}</h4>
            <p className="section-note">
              This schedule saves independently from connection and account settings.
            </p>
          </div>
          {createBackup && (
            <div className="toggle-row">
              <label htmlFor={`${id}-create-backup`} className="switch-label">
                Create a fresh Jellyfin backup before each scheduled import
              </label>
              <label className="toggle">
                <input
                  id={`${id}-create-backup`}
                  type="checkbox"
                  checked={createsBackup(draft)}
                  disabled={demo || !!busy}
                  onChange={(event) => {
                    generation.current++;
                    setDraft({ ...draft, create_backup: event.target.checked });
                  }}
                />
                <span className="toggle-track" aria-hidden="true" />
              </label>
            </div>
          )}
          <div className="toggle-row">
            <label htmlFor={`${id}-enabled`} className="switch-label">
              {capture ? 'Enable daily database capture' : 'Enable daily backup import'}
            </label>
            <label className="toggle">
              <input
                id={`${id}-enabled`}
                type="checkbox"
                checked={draft.enabled}
                disabled={demo || !!busy}
                onChange={(event) => {
                  generation.current++;
                  setDraft({ ...draft, enabled: event.target.checked });
                }}
              />
              <span className="toggle-track" aria-hidden="true" />
            </label>
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor={`${id}-time`}>{capture ? 'Capture time' : 'Import time'}</label>
              <input
                id={`${id}-time`}
                type="time"
                value={time}
                required
                disabled={demo || !!busy}
                aria-invalid={!!validation}
                aria-describedby={validation ? `${id}-error` : undefined}
                onChange={(event) => {
                  generation.current++;
                  setTime(event.target.value);
                  setValidation('');
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-zone`}>Time zone</label>
              <input
                id={`${id}-zone`}
                value={draft.time_zone}
                required
                disabled={demo || !!busy}
                aria-invalid={!!validation}
                aria-describedby={`${id}-zone-hint${validation ? ` ${id}-error` : ''}`}
                onChange={(event) => {
                  generation.current++;
                  setDraft({ ...draft, time_zone: event.target.value });
                  setValidation('');
                }}
              />
              <small id={`${id}-zone-hint`}>
                Use an IANA time zone; the server starts with its configured zone.
              </small>
            </div>
          </div>
          <p className="section-note">
            {capture
              ? 'Captured history supplies only played flags; playback positions are not transferred.'
              : createBackup && createsBackup(draft)
                ? 'At the scheduled time, Jellyport asks Jellyfin to create a backup without optional metadata, subtitles or trickplay, then imports the completed backup. Creating it uses the live Jellyfin database and can affect server performance. Manual imports still use existing backups.'
                : createBackup
                  ? 'Choose a time after Jellyfin finishes its backup. This schedule imports an existing completed backup; fresh-backup creation is off.'
                  : 'Choose a time after your media server finishes its backup. Jellyport imports an existing completed backup; it does not create a server backup.'}
          </p>
          {dirty && <p className="section-note">Unsaved schedule changes.</p>}
          {stale && (
            <p className="error-block" role="alert">
              The saved schedule changed. Reload it before saving another change; your draft is
              still here.
            </p>
          )}
          {validation && (
            <p id={`${id}-error`} className="error-block" role="alert">
              {validation}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-quiet" type="button" disabled={!!busy} onClick={reload}>
              Reload saved schedule
            </button>
            <button className="btn btn-primary" type="submit" disabled={demo || !!busy || stale}>
              {busy === 'schedule' ? 'Saving schedule…' : `Save ${verb} schedule`}
            </button>
          </div>
        </form>
      </details>
    </section>
  );
}
