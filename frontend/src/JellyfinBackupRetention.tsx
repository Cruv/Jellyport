import { useRef, useState, type FormEvent } from 'react';
import { Callout } from './components';
import { importTimestamp } from './ImportWorkflow';
import { useWorkspaceDraftState } from './workspace-drafts';
import type { JellyfinBackupCleanupStatus, JellyfinBackupRetentionConfig } from './types';

export default function JellyfinBackupRetention({
  status,
  busy,
  disabled,
  onSave,
}: {
  status: JellyfinBackupCleanupStatus;
  busy: boolean;
  disabled: boolean;
  onSave: (input: {
    enabled: boolean;
    keep: number;
    expected_revision: string;
  }) => Promise<JellyfinBackupRetentionConfig | undefined>;
}) {
  const [draft, setDraft] = useWorkspaceDraftState('jellyfin-backup-retention:config', () => ({
    ...status.config,
    keep: String(status.config.keep),
  }));
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const generation = useRef(0);
  const saving = useRef(false);
  const stale = draft.revision !== status.config.revision;
  const dirty =
    draft.enabled !== status.config.enabled || Number(draft.keep) !== status.config.keep;
  const blocked = busy || disabled || status.running;

  function reload() {
    generation.current++;
    setDraft({ ...status.config, keep: String(status.config.keep) });
    setValidation('');
    setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || stale || saving.current) return;
    const keep = Number(draft.keep);
    if (!/^[0-9]+$/.test(draft.keep) || !Number.isSafeInteger(keep) || keep < 1 || keep > 100) {
      setValidation('Choose a whole number of backups from 1 to 100.');
      return;
    }
    setValidation('');
    setError('');
    saving.current = true;
    const submitted = generation.current;
    try {
      const value = await onSave({
        enabled: draft.enabled,
        keep,
        expected_revision: draft.revision,
      });
      if (generation.current !== submitted) return;
      if (value) setDraft({ ...value, keep: String(value.keep) });
      else
        setError(
          'Backup cleanup settings could not be saved. Your changes are kept; refresh status to verify the saved setting before retrying.',
        );
    } catch {
      if (generation.current === submitted)
        setError(
          'Backup cleanup settings could not be saved. Your changes are kept; refresh status to verify the saved setting before retrying.',
        );
    } finally {
      saving.current = false;
    }
  }
  return (
    <section className="form-stack" aria-label="Jellyfin backup cleanup">
      <div className="status-summary form-stack">
        <p>
          Saved backup cleanup:{' '}
          <strong>
            {status.config.enabled
              ? `Keep the latest ${status.config.keep} Jellyport-created backups`
              : 'Off'}
          </strong>
        </p>
        <p>
          {status.running
            ? 'Cleaning up eligible Jellyfin backups…'
            : status.last_run_at
              ? `Last backup cleanup: ${importTimestamp(status.last_run_at)}`
              : 'Backup cleanup has not run yet.'}
        </p>
        {status.last_outcome && (
          <p>
            Cleanup outcome:{' '}
            <strong>
              {status.last_outcome === 'succeeded'
                ? 'Completed'
                : status.last_outcome === 'interrupted'
                  ? 'Interrupted'
                  : 'Failed'}
            </strong>{' '}
            · {status.last_deleted.toLocaleString()} backups removed
          </p>
        )}
      </div>
      {status.error && (
        <Callout warning title="Jellyfin backup cleanup could not finish.">
          Check the helper’s cleanup permission, backup-folder mount and available storage. Import
          status is shown separately; a cleanup failure does not discard the saved catalog.
        </Callout>
      )}
      <details className="help-disclosure">
        <summary>Automatic backup cleanup</summary>
        <form
          className="inline-panel form-stack"
          aria-label="Jellyfin backup retention"
          onSubmit={save}
          noValidate
        >
          <div>
            <h4>Retain Jellyport-created backups</h4>
            <p className="section-note">
              Saves independently from the import schedule. Cleanup runs after a successful import.
              Manual backups and existing untracked archives are preserved.
            </p>
          </div>
          <div className="toggle-row">
            <label htmlFor="jellyfin-backup-cleanup-enabled" className="switch-label">
              Enable automatic Jellyfin backup cleanup
            </label>
            <label className="toggle">
              <input
                id="jellyfin-backup-cleanup-enabled"
                type="checkbox"
                checked={draft.enabled}
                disabled={blocked}
                onChange={(event) => {
                  generation.current++;
                  setDraft({ ...draft, enabled: event.target.checked });
                }}
              />
              <span className="toggle-track" aria-hidden="true" />
            </label>
          </div>
          <div className="field">
            <label htmlFor="jellyfin-backups-to-keep">Jellyport-created backups to keep</label>
            <input
              id="jellyfin-backups-to-keep"
              type="number"
              min="1"
              max="100"
              step="1"
              inputMode="numeric"
              value={draft.keep}
              disabled={blocked || !draft.enabled}
              aria-invalid={!!validation}
              aria-describedby={`jellyfin-backup-keep-hint${validation ? ' jellyfin-backup-keep-error' : ''}`}
              onChange={(event) => {
                generation.current++;
                setDraft({ ...draft, keep: event.target.value });
                setValidation('');
              }}
            />
            <small id="jellyfin-backup-keep-hint">
              Keep 1–100 completed backups; 7 is recommended. Protected backups can temporarily
              exceed this count.
            </small>
          </div>
          {!status.supported && (
            <Callout warning title="Backup cleanup permission is not enabled on the helper.">
              Set JELLYPORT_JELLYFIN_BACKUP_CLEANUP=true on the helper and make only its Jellyfin
              backup-folder bind mount writable. Keep Emby backups read-only and raw backups out of
              the web container. Until then, imports can continue but cleanup cannot run.
            </Callout>
          )}
          <p className="section-note">
            Only future backups whose creation and successful import Jellyport can verify are
            eligible. Uncertain operations and files changed since import are protected. Enabling
            cleanup does not remove old untracked backups or run a deletion immediately.
          </p>
          {dirty && <p className="section-note">Unsaved backup cleanup changes.</p>}
          {stale && (
            <p className="error-block" role="alert">
              The saved backup cleanup setting changed. Reload it before saving; your draft is still
              here.
            </p>
          )}
          {validation && (
            <p id="jellyfin-backup-keep-error" className="error-block" role="alert">
              {validation}
            </p>
          )}
          {error && (
            <p className="error-block" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-quiet" type="button" onClick={reload} disabled={busy}>
              Reload saved cleanup
            </button>
            <button className="btn btn-primary" type="submit" disabled={blocked || stale}>
              {busy ? 'Saving cleanup…' : 'Save backup cleanup'}
            </button>
          </div>
        </form>
      </details>
    </section>
  );
}
