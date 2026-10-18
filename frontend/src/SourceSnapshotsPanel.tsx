import { Callout, Icon } from './components';
import { Pagination, usePagination } from './ui-layout';
import DailyImportSchedule from './DailyImportSchedule';
import {
  ImportStatus,
  importAge,
  importTimestamp as timestamp,
  useImportClock,
  useImportWorkflow,
} from './ImportWorkflow';
import type { Api, Notify, SourceSnapshotMetadata, SourceSnapshotStatus } from './types';

const historyDate = (record: SourceSnapshotMetadata) =>
  record.source_type === 'plugin_backup' ? record.backup_created_at : record.finished_at;

export default function SourceSnapshotsPanel({
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
    useImportWorkflow<SourceSnapshotStatus>({
      api,
      notify,
      demo,
      active,
      path: '/api/source-snapshots',
      statusError: 'Saved snapshot status could not be loaded. Refresh status to try again.',
    });
  const now = useImportClock(
    [
      ...(status?.records.map((record) => record.expires_at) || []),
      ...(status?.next_run_at ? [status.next_run_at] : []),
    ],
    active,
  );
  const age = (value?: string) => (value ? importAge(value, now) : 'Age unavailable');
  async function manual(kind: 'import' | 'clear') {
    if (
      !status ||
      (kind === 'import' && status.available === false) ||
      (kind === 'clear' && !status.snapshots)
    )
      return;
    await change(
      kind,
      { method: kind === 'import' ? 'POST' : 'DELETE' },
      kind === 'import'
        ? pluginBackup
          ? 'Backup import started. You can follow its status here.'
          : 'Database capture started. You can follow its status here.'
        : 'Saved database captures cleared.',
      kind === 'import'
        ? pluginBackup
          ? 'Backup import could not start. Check the backup folder and refresh status.'
          : 'Database capture could not start. Check the read-only source mount and refresh status.'
        : 'Saved captures could not be cleared. A capture or migration may still be using them. Refresh status and try again.',
    );
  }
  const fileCopy = status?.capture_method === 'file_copy';
  const pluginBackup = status?.capture_method === 'plugin_backup';
  const hasFileCopies =
    fileCopy || status?.records.some((record) => record.source_type === 'file_copy');
  const hasPluginBackups =
    pluginBackup || status?.records.some((record) => record.source_type === 'plugin_backup');
  const captures = usePagination(status?.records || [], 10);
  const currentCaptures =
    status?.records.filter((record) => Date.parse(record.expires_at) > now).length || 0;
  return (
    <section className="panel" aria-label="Saved Emby database snapshots">
      <div className="panel-header">
        <div className="setting-heading">
          <span className="server-icon emby">
            <Icon name="emby" />
          </span>
          <div>
            <h3>Saved Emby database snapshots</h3>
            <p>
              {pluginBackup
                ? 'Import an Emby backup, then read saved user history for migrations.'
                : 'Capture the database once, then read saved user history for migrations.'}
            </p>
          </div>
        </div>
      </div>
      <div className="panel-body form-stack">
        <details className="help-disclosure">
          <summary>How saved Emby history works</summary>
          <p className="muted text-small">
            {pluginBackup ? (
              'A network-isolated helper reads saved Emby Backup & Restore backups. Jellyport does not start Emby’s backup task or open its live databases.'
            ) : (
              <>
                A network-isolated helper uses a read-only Emby database mount on the same Docker
                host.{' '}
                {fileCopy
                  ? 'File copies run while Emby stays online; no filesystem snapshot or downtime is needed.'
                  : 'Emby can keep running while a consistent SQLite online backup is captured.'}
              </>
            )}{' '}
            This avoids a full library scan through Emby’s API. Migrations use only played flags
            from the captured database.
          </p>
        </details>
        {hasPluginBackups && (
          <Callout icon="info" title="Backup age stays with the original backup.">
            Import after Emby’s backup finishes. Jellyport checks stable backup files before
            importing and keeps the last good import if validation fails. History expires 48 hours
            after the original backup time. Importing an unchanged backup does not make it newer.
          </Callout>
        )}
        {hasFileCopies && (
          <Callout icon="info" title="File copies use best-effort history.">
            Live file copies are not transactional. Some history may be missing or inconsistent even
            when validation passes. Failed captures keep the last good copy.
          </Callout>
        )}
        {status?.available === false && (
          <Callout
            warning
            title={
              pluginBackup
                ? 'Emby backup source is unavailable.'
                : 'Emby database source is unavailable.'
            }
          >
            Configure the {pluginBackup ? 'backup folder' : 'read-only source mount'} using the{' '}
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
        <ImportStatus
          status={status}
          loading={loading}
          starting={busy === 'import'}
          error={error}
          stale={stale}
          uncertain={uncertain}
          initialLabel="Loading Emby history status…"
          runningLabel={pluginBackup ? 'Importing Emby backup…' : 'Capturing Emby database…'}
          progressLabel={pluginBackup ? 'Backup import progress' : 'Database capture progress'}
          capture={!pluginBackup}
          measured={
            status ? { total: status.users_total, processed: status.users_processed } : undefined
          }
          summary={
            status
              ? currentCaptures
                ? 'Saved Emby history available'
                : status.records.length
                  ? 'Saved Emby history expired'
                  : 'No saved Emby history'
              : ''
          }
        />
        {status && (
          <p className="muted text-small">
            History source:{' '}
            <strong>
              {pluginBackup
                ? 'Emby plugin backup'
                : fileCopy
                  ? 'Scheduled file copy'
                  : 'SQLite online backup'}
            </strong>
          </p>
        )}
        <div className="section-heading">
          <h4>{pluginBackup ? 'Import a backup now' : 'Capture database now'}</h4>
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
            disabled={
              demo || !!busy || uncertain || stale || !status || status.running || !status.snapshots
            }
          >
            {busy === 'clear' ? 'Clearing captures…' : 'Clear saved captures'}
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
              !status ||
              status.running ||
              status.available === false
            }
          >
            {busy === 'import'
              ? pluginBackup
                ? 'Starting import…'
                : 'Starting capture…'
              : pluginBackup
                ? 'Import latest backup'
                : 'Capture database now'}
          </button>
        </div>
        {demo && (
          <p className="muted text-small">Demo mode: database capture changes are disabled.</p>
        )}
        {status?.config && (
          <DailyImportSchedule
            id="emby-import"
            config={status.config}
            nextRun={status.next_run_at}
            busy={busy}
            demo={demo}
            capture={!pluginBackup}
            onSave={async (input) => {
              const value = await change(
                'schedule',
                { method: 'PUT', body: { ...input, scope: status.config.scope } },
                pluginBackup ? 'Backup import schedule saved.' : 'Database capture schedule saved.',
                'The schedule could not be saved. Your changes are kept; refresh status to verify the saved schedule before retrying.',
              );
              return value?.config;
            }}
          />
        )}
        {!!status?.records.length && (
          <details className="help-disclosure">
            <summary>Saved captures ({status.records.length.toLocaleString()})</summary>
            <div className="table-wrap">
              <table className="responsive-table" aria-label="Saved Emby captures">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>History date</th>
                    <th>Contents</th>
                    <th>Availability</th>
                  </tr>
                </thead>
                <tbody>
                  {captures.items.map((record) => (
                    <tr key={`${record.id}:${record.source_user_id}`}>
                      <td data-label="Source">
                        <strong>{record.source_username || 'All Emby users'}</strong>
                        <small>
                          Emby {record.source_server_version}
                          {record.schema ? ` · ${record.schema}` : ''}
                        </small>
                        <small>Source {record.source_server_id}</small>
                      </td>
                      <td data-label="History date">
                        <strong>{timestamp(historyDate(record))}</strong>
                        <small>{age(historyDate(record))}</small>
                        <small>
                          {record.source_type === 'plugin_backup'
                            ? `Imported ${timestamp(record.finished_at)}`
                            : `Read window ${timestamp(record.started_at)} – ${timestamp(record.finished_at)}`}
                        </small>
                      </td>
                      <td data-label="Contents">
                        <strong>
                          {record.source_type === 'plugin_backup'
                            ? 'Emby plugin backup'
                            : record.source_type === 'file_copy'
                              ? 'File copy'
                              : record.source_type === 'sqlite_online_backup'
                                ? 'SQLite online backup'
                                : record.scope === 'watched_only'
                                  ? 'Played-status capture'
                                  : 'Complete database capture'}
                        </strong>
                        {record.source_type && (
                          <small>
                            {record.scope === 'watched_only'
                              ? 'Played-status capture'
                              : 'Complete database capture'}
                          </small>
                        )}
                        <small>{Math.ceil(record.bytes / 1024).toLocaleString()} KiB</small>
                      </td>
                      <td data-label="Availability">
                        <span
                          className={`status ${!Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= now ? 'warn' : 'good'}`}
                        >
                          {!Number.isFinite(Date.parse(record.expires_at)) ||
                          Date.parse(record.expires_at) <= now
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
            <Pagination
              label="Saved captures"
              page={captures.page}
              total={captures.total}
              pageSize={captures.pageSize}
              onPageChange={captures.setPage}
              onPageSizeChange={captures.setPageSize}
            />
          </details>
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
