import { Callout, Icon } from './components';
import DailyImportSchedule from './DailyImportSchedule';
import {
  ImportStatus,
  importAge as age,
  importTimestamp as timestamp,
  useImportClock,
  useImportWorkflow,
} from './ImportWorkflow';
import type { Api, Notify, DestinationCatalogStatus } from './types';
export type { DestinationCatalogStatus } from './types';

const duration = (milliseconds: number) =>
  milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;

export default function DestinationCatalogPanel({
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
  const { status, busy, loading, error, uncertain, stale, load, change } =
    useImportWorkflow<DestinationCatalogStatus>({
      api,
      notify,
      demo,
      active,
      path: '/api/destination-catalog',
      statusError: 'Jellyfin catalog status could not be loaded. Refresh status to try again.',
    });
  const record = status?.record;
  const now = useImportClock(
    [...(record ? [record.expires_at] : []), ...(status?.next_run_at ? [status.next_run_at] : [])],
    active,
  );
  async function manual(kind: 'import' | 'clear') {
    if (
      !status ||
      (kind === 'import' && (!status.configured || !status.available)) ||
      (kind === 'clear' && !record)
    )
      return;
    await change(
      kind,
      { method: kind === 'import' ? 'POST' : 'DELETE' },
      kind === 'import'
        ? 'Jellyfin backup import started. You can follow its status here.'
        : 'Saved Jellyfin matching catalog cleared.',
      kind === 'import'
        ? 'Jellyfin backup import could not start. Check the completed backup and refresh status.'
        : 'The matching catalog could not be cleared. An import or migration may still be using it. Refresh status and try again.',
    );
  }

  const expired =
    !!record &&
    (!Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= now);
  const usable = !!record && !expired && status?.usable !== false;
  return (
    <section className="panel" aria-label="Saved Jellyfin matching catalog">
      <div className="panel-header">
        <div className="setting-heading">
          <span className="server-icon jellyfin">
            <Icon name="jellyfin" />
          </span>
          <div>
            <h3>Saved Jellyfin matching catalog</h3>
            <p>Import matching metadata from a completed Jellyfin database backup.</p>
          </div>
        </div>
      </div>
      <div className="panel-body form-stack">
        <details className="help-disclosure">
          <summary>How saved Jellyfin matching works</summary>
          <p className="muted text-small">
            The saved catalog supplies item identities for matching, avoiding a live library scan.
            Current Jellyfin watch history and account access are still checked through its API;
            history updates and verification also use the live server. No saved Jellyfin user
            history is imported.
          </p>
        </details>
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
            saved matching data.{' '}
            {record
              ? 'The last imported catalog remains listed for review.'
              : 'No matching catalog has been imported yet.'}
          </Callout>
        )}
        <ImportStatus
          status={status}
          loading={loading}
          starting={busy === 'import'}
          error={error}
          stale={stale}
          uncertain={uncertain}
          initialLabel="Loading Jellyfin catalog status…"
          runningLabel="Importing Jellyfin backup…"
          progressLabel="Jellyfin catalog import progress"
          summary={
            usable
              ? 'Saved matching catalog available'
              : record
                ? expired
                  ? 'Saved matching catalog expired'
                  : 'Saved matching catalog unavailable'
                : 'No saved Jellyfin matching catalog'
          }
        />
        <div className="section-heading">
          <h4>Import a backup now</h4>
          <p>Manual actions do not change the daily schedule.</p>
        </div>
        <div className="form-actions">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => void load()}
            disabled={!!busy || loading}
          >
            <Icon name="refresh" />
            {loading ? 'Refreshing status…' : 'Refresh status'}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => void manual('clear')}
            disabled={demo || !!busy || uncertain || stale || !record || !!status?.running}
          >
            {busy === 'clear' ? 'Clearing catalog…' : 'Clear matching catalog'}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void manual('import')}
            disabled={
              demo ||
              !!busy ||
              uncertain ||
              stale ||
              !status?.configured ||
              !status.available ||
              status.running
            }
          >
            {busy === 'import' ? 'Starting import…' : 'Import latest Jellyfin backup'}
          </button>
        </div>
        {status?.config && (
          <DailyImportSchedule
            id="jellyfin-import"
            config={status.config}
            nextRun={status.next_run_at}
            busy={busy}
            demo={demo}
            onSave={async (input) => {
              const value = await change(
                'schedule',
                { method: 'PUT', body: input },
                'Jellyfin backup import schedule saved.',
                'The schedule could not be saved. Your changes are kept; refresh status to verify the saved schedule before retrying.',
              );
              return value?.config;
            }}
          />
        )}
        {record && (
          <div className="table-wrap">
            <table className="responsive-table" aria-label="Imported Jellyfin catalog">
              <thead>
                <tr>
                  <th>Original backup</th>
                  <th>Contents</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label="Original backup">
                    <strong>{timestamp(record.backup_created_at)}</strong>
                    <small>{age(record.backup_created_at, now)}</small>
                    <small>Imported {timestamp(record.imported_at)}</small>
                    <small>Import duration {duration(record.import_elapsed_ms)}</small>
                  </td>
                  <td data-label="Contents">
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
                  <td data-label="Availability">
                    <strong>{expired ? 'Expired' : usable ? 'Available' : 'Unavailable'}</strong>
                    <small>Expires {timestamp(record.expires_at)}</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {demo && (
          <p className="muted text-small">Demo mode: Jellyfin catalog changes are disabled.</p>
        )}
      </div>
    </section>
  );
}
