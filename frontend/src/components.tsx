import { useEffect, useRef, type ReactNode } from 'react';
import {
  type Job,
  activeJob,
  date,
  num,
  type ItemIssue,
  type SourceSnapshotMetadata,
} from './types';

const icons: Record<string, ReactNode> = {
  logo: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  migrate: <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />,
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  userPlus: (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a7 7 0 0 1 14 0v2M20 8v6m-3-3h6" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  settings: (
    <>
      <path d="m9 3-.7 2.4-2.2 1.3-2.4-.5-1.5 2.6 1.7 1.8v2.6L2.2 15l1.5 2.6 2.4-.5 2.2 1.3L9 21h3l.7-2.6 2.2-1.3 2.4.5 1.5-2.6-1.7-1.8v-2.6l1.7-1.8-1.5-2.6-2.4.5-2.2-1.3L12 3Z" />
      <circle cx="10.5" cy="12" r="3" />
    </>
  ),
  emby: (
    <>
      <path d="m12 3 9 9-9 9-9-9 9-9Z" />
      <path d="m10 8 6 4-6 4V8Z" />
    </>
  ),
  jellyfin: (
    <>
      <path d="M12 3 3.5 19h17L12 3Z" />
      <path d="m12 10-4 7h8l-4-7Z" />
    </>
  ),
  discord: (
    <>
      <path d="m6 5 3-1 .7 1.5h4.6L15 4l3 1c2.2 3.1 3.2 6.5 3 10-1.3 1.3-3 2.2-5 2.8L14.8 16M9.2 16 8 17.8c-2-.6-3.7-1.5-5-2.8-.2-3.5.8-6.9 3-10Z" />
      <path d="M7 15c3.2 1.7 6.8 1.7 10 0" />
      <ellipse cx="8.5" cy="11.5" rx="1" ry="1.4" />
      <ellipse cx="15.5" cy="11.5" rx="1" ry="1.4" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 7a7 7 0 0 1 11.6-1.5L20 8M4 16l2.3 2.5A7 7 0 0 0 18 17" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  logout: <path d="M10 4H5v16h5M14 8l4 4-4 4m-5-4h9" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  warning: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m11.5 11.5 9 9M16 16l3-3M19 19l3-3" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  inbox: (
    <>
      <path d="M4 4h16l2 12v4H2v-4L4 4Z" />
      <path d="M2 16h6l2 2h4l2-2h6" />
    </>
  ),
  link: (
    <path
      d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
      transform="translate(1 0) scale(.9)"
    />
  ),
};
export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {icons[name] || icons.info}
    </svg>
  );
}
export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {children}
    </div>
  );
}
export function Heading({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function Empty({
  icon,
  title,
  text,
  children,
}: {
  icon: string;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
export function Callout({
  icon = 'info',
  warning = false,
  title,
  children,
  className = '',
}: {
  icon?: string;
  warning?: boolean;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`callout${warning ? ' warning' : ''} ${className}`}>
      <Icon name={icon} />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}
export function Status({ value, label }: { value?: string; label?: string }) {
  const labels: Record<string, string> = {
    completed: 'Completed',
    partial: 'Needs review',
    failed: 'Failed',
    processing: 'Processing',
    running: 'In progress',
    queued: 'Queued',
    interrupted: 'Interrupted',
    canceled: 'Canceled',
    pending: 'Awaiting review',
    applied: 'Applied',
    ignored: 'Ignored',
    success: 'Completed',
    migrated: 'Migrated',
    created: 'Created',
  };
  const kind = ['completed', 'applied', 'success', 'migrated', 'created'].includes(value || '')
    ? 'good'
    : ['failed', 'interrupted'].includes(value || '')
      ? 'bad'
      : ['running', 'queued', 'processing'].includes(value || '')
        ? 'running'
        : 'warn';
  return (
    <span className={`status ${kind}`}>{label || labels[value || ''] || value || 'Unknown'}</span>
  );
}
export function UserCell({ name }: { name: string }) {
  return (
    <div className="user-cell">
      <span className="avatar" aria-hidden="true">
        {(name || '?').slice(0, 2).toUpperCase()}
      </span>
      <strong>{name}</strong>
    </div>
  );
}
export function JobsTable({
  jobs,
  compact = false,
  openJob,
  migrate,
}: {
  jobs: Job[];
  compact?: boolean;
  openJob: (id: string) => void;
  migrate: () => void;
}) {
  const names: Record<string, string> = {
    migrate: 'User migration',
    migration: 'User migration',
    create: 'Account creation',
    role_update: 'Account role update',
    account: 'Account creation',
    recover: 'Account recovery',
    disable: 'Disable account',
    enable: 'Enable account',
  };
  if (!jobs.length)
    return (
      <Empty
        icon="activity"
        title="A fresh start"
        text="Your migration and account creation activity will appear here."
      >
        <button className="btn btn-quiet" onClick={migrate}>
          Migrate your first user
        </button>
      </Empty>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Status</th>
            {!compact && <th>Users</th>}
            <th>Started</th>
            <th className="right">Details</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <strong>
                  {job.migration_scope === 'watched_only' &&
                  ['migrate', 'migration'].includes(job.kind)
                    ? 'Watched-only migration'
                    : names[job.kind] || job.kind || 'Account operation'}
                </strong>
                <small>
                  {job.results
                    ?.map((result) => result.username)
                    .filter(Boolean)
                    .slice(0, 2)
                    .join(', ') || 'Preparing operation'}
                  {(job.results?.length || 0) > 2 && ` +${job.results!.length - 2}`}
                </small>
              </td>
              <td>
                <Status value={job.status} />
              </td>
              {!compact && (
                <td>
                  {typeof job.progress === 'object' &&
                  job.progress.processed !== undefined &&
                  job.progress.total !== undefined
                    ? `${num(job.progress.processed)} / ${num(job.progress.total)}`
                    : num(job.results?.length)}
                </td>
              )}
              <td className="nowrap">{date(job.created_at)}</td>
              <td className="right">
                <button
                  className="icon-button"
                  onClick={() => openJob(job.id)}
                  aria-label="View operation details"
                  title="View details"
                >
                  <Icon name="arrow" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Issues({
  label,
  items = [],
  count,
  ambiguous = false,
}: {
  label: string;
  items?: ItemIssue[];
  count?: number;
  ambiguous?: boolean;
}) {
  if (!count && !items.length) return null;
  return (
    <details className="disclosure">
      <summary>
        {label} ({num(count || items.length)})
      </summary>
      {items.length ? (
        <ul>
          {items.map((item, i) => (
            <li key={`${item.Id || item.name || item.Name || ''}-${i}`}>
              {item.Name || item.name || item.title || item.source?.Name || 'Unnamed item'}
              {item.Type && <span className="subtle"> · {item.Type}</span>}
              {ambiguous && (
                <span className="recovery-target mono">
                  Candidate IDs: {item.candidate_ids?.join(', ') || 'Unavailable'}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-8">
          {ambiguous
            ? 'These items were skipped because a unique Jellyfin match could not be established.'
            : 'See the operation details after migration for more information.'}
        </p>
      )}
    </details>
  );
}
export function progressPercent(job: Job) {
  if (typeof job.progress === 'number') return Math.min(100, Math.max(0, job.progress));
  if (job.progress) {
    const completed = Number(
      job.progress.processed || job.progress.completed || job.progress.current || 0,
    );
    const total = Number(job.progress.total || 0);
    return total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  }
  return ['completed', 'partial', 'failed'].includes(job.status) ? 100 : 0;
}
function jobElapsed(job: Job): string | null {
  const end = job.finished_at || job.updated_at;
  if (!job.started_at || (!activeJob(job) && !end)) return null;
  const milliseconds =
    (activeJob(job) ? Date.now() : new Date(end!).getTime()) - new Date(job.started_at).getTime();
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours}h ${minutes % 60}m ${seconds % 60}s`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}
export function JobProgressDetails({ job }: { job: Job }) {
  const progress = typeof job.progress === 'object' ? job.progress : undefined;
  const running = activeJob(job);
  const elapsed = jobElapsed(job);
  const phases = {
    reading_source: 'Reading Emby library',
    preparing_account: 'Preparing Jellyfin account',
    reading_target: 'Reading Jellyfin library',
    transferring_history:
      job.migration_scope === 'watched_only'
        ? 'Migrating watched status'
        : 'Migrating watch history and favorites',
    transferring_playlists: 'Migrating playlists',
    delivering_credentials: 'Delivering account credentials',
  };
  const phase = progress?.phase ? phases[progress.phase] : undefined;
  return (
    <div aria-live={running ? 'polite' : undefined}>
      {running && (
        <progress
          className="progress-track"
          aria-label="Operation progress"
          value={progressPercent(job)}
          max={100}
        />
      )}
      {((progress?.processed !== undefined && progress.total !== undefined) || elapsed) && (
        <div className="job-meta">
          {progress?.processed !== undefined && progress.total !== undefined && (
            <span>
              {num(progress.processed)} of {num(progress.total)}{' '}
              {progress.total === 1 ? 'account' : 'accounts'} processed
            </span>
          )}
          {elapsed && <span>Elapsed {elapsed}</span>}
        </div>
      )}
      {running && (
        <>
          <p className="muted text-small">
            {job.status === 'queued' ? (
              'Waiting for the operation to begin…'
            ) : (
              <>
                {progress?.current_user && <strong>{progress.current_user} · </strong>}
                {phase || 'The operation is running. Progress updates automatically.'}
              </>
            )}
          </p>
          {progress?.items_processed !== undefined && (
            <p className="muted text-small">
              {num(progress.items_processed)}
              {progress.items_total !== undefined && ` of ${num(progress.items_total)}`} matched
              items checked
              {progress.items_updated !== undefined && ` · ${num(progress.items_updated)} updated`}
            </p>
          )}
          {progress?.phase === 'transferring_history' && !!progress.items_total && (
            <progress
              className="progress-track"
              aria-label="History item progress"
              value={progress.items_processed || 0}
              max={progress.items_total}
            />
          )}
        </>
      )}
    </div>
  );
}
export function SourceSnapshotNote({ snapshot }: { snapshot: SourceSnapshotMetadata }) {
  const fileCopy = snapshot.source_type === 'file_copy';
  return (
    <p className="subtle text-small">
      Saved Emby snapshot{fileCopy ? ' · File copy' : ''} · Emby {snapshot.source_server_version} ·{' '}
      {snapshot.scope === 'watched_only' ? 'watched-only' : 'complete'} · captured{' '}
      {new Date(snapshot.finished_at).toLocaleString()}. {fileCopy ? 'Copy' : 'Read'} window:{' '}
      {new Date(snapshot.started_at).toLocaleString()} –{' '}
      {new Date(snapshot.finished_at).toLocaleString()}. Activity after this window is not included.
      {fileCopy &&
        ' Live file copies are not transactional; some history may be missing or inconsistent even when validation passes.'}
    </p>
  );
}
export function Modal({
  title,
  description,
  children,
  footer,
  wide = false,
  close,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.body.classList.add('modal-open');
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || []),
      ].filter((element) => element.getClientRects().length);
      if (!elements.length) {
        event.preventDefault();
        return;
      }
      const first = elements[0],
        last = elements[elements.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('button, input, select, [tabindex]')?.focus();
  }, [title]);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={close} aria-label="Close dialog">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </section>
    </div>
  );
}
