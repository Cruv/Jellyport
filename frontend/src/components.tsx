import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  type Job,
  activeJob,
  date,
  num,
  type ItemIdentitySummary,
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
    <div className="loading" role="status">
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
        <div className="callout-copy">{children}</div>
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
                    ? 'Played-status migration'
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
function issueText(value: unknown, limit = 512): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function issueNumber(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
function issuePath(value: unknown): string {
  const path = issueText(value, 2048);
  if (
    /[\u0000-\u001f\u007f]/.test(path) ||
    (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) ||
    /^[/\\]{2}[^/\\]*@/.test(path)
  )
    return 'Remote URL omitted';
  return path || 'Not recorded';
}
function issueIdentity(item: ItemIssue): ItemIdentitySummary {
  return {
    ...item,
    id: issueText(item.id) || issueText(item.Id),
    name:
      issueText(item.name) ||
      issueText(item.Name) ||
      issueText(item.title) ||
      issueText(item.source?.Name),
    type: issueText(item.type) || issueText(item.Type),
  };
}
function issueType(item: ItemIdentitySummary): string {
  const type = issueText(item.type);
  switch (type.toLowerCase()) {
    case 'episode':
      return 'TV episode';
    case 'season':
      return 'TV season';
    case 'series':
      return 'TV show';
    case 'movie':
      return 'Movie';
    default:
      return type || 'Media item';
  }
}
function issueTitle(item: ItemIdentitySummary): string {
  const name = issueText(item.name);
  const type = issueText(item.type).toLowerCase();
  if (type === 'episode' || type === 'season') {
    const season = issueNumber(item.season_number);
    const episode = issueNumber(item.episode_number);
    const end = issueNumber(item.episode_number_end);
    const position =
      type === 'season'
        ? season === undefined
          ? 'Season number unavailable'
          : `Season ${season}`
        : season !== undefined && episode !== undefined
          ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}${end !== undefined && end > episode ? `–E${String(end).padStart(2, '0')}` : ''}`
          : episode !== undefined
            ? `Episode ${episode} · season unavailable`
            : 'Episode number unavailable';
    return [issueText(item.series_name) || 'Show name unavailable', position, name]
      .filter(Boolean)
      .join(' · ');
  }
  const year = issueNumber(item.production_year);
  return `${name || 'Unnamed item'}${year !== undefined && year > 0 && year <= 9999 ? ` (${year})` : ''}`;
}
const ambiguityReasons: Record<string, string> = {
  media_type_conflict: 'The media types disagree, so Jellyport cannot safely select a match.',
  provider_conflict: 'The provider IDs disagree, so Jellyport cannot safely select a match.',
  numbering_conflict: 'The show, season or episode identity disagrees between these items.',
  duplicate_provider_id: 'Several Jellyfin items share a matching provider ID.',
  duplicate_series_episode: 'Several Jellyfin items match the same show, season and episode.',
  duplicate_series_season: 'Several Jellyfin items match the same show and season.',
  duplicate_path: 'Several Jellyfin items share the matching file path.',
  competing_provider_matches: 'Different matching provider IDs select different Jellyfin items.',
};
const matchingMethods: Record<string, string> = {
  provider_id: 'Provider ID',
  series_episode: 'Show ID + season and episode',
  series_season: 'Show ID + season',
  path: 'Exact mapped file path',
  'provider_id+path': 'Provider ID + exact mapped file path',
  'series_episode+path': 'Show ID + season and episode + exact mapped file path',
  'series_season+path': 'Show ID + season + exact mapped file path',
};
function issueReason(item: ItemIssue): string {
  const reason = issueText(item.reason, 2048);
  if (reason) return reason;
  const codes = Array.isArray(item.reason_codes) ? [...new Set(item.reason_codes)].slice(0, 6) : [];
  const explanations = codes
    .filter((code) => typeof code === 'string' && Object.hasOwn(ambiguityReasons, code))
    .map((code) => ambiguityReasons[code]);
  return explanations.length
    ? explanations.join(' ')
    : 'This saved operation does not include the reason or enough information to explain the ambiguity. Run a new migration to record these details.';
}
function IssueProviders({ values }: { values?: Record<string, string> }) {
  const entries =
    values && typeof values === 'object' && !Array.isArray(values)
      ? Object.entries(values)
          .filter(([key, value]) => issueText(key) && issueText(value))
          .slice(0, 20)
      : [];
  return entries.length ? (
    <span className="issue-providers mono">
      {entries.map(([key, value]) => (
        <span key={key}>
          {issueText(key)}: {issueText(value)}
        </span>
      ))}
    </span>
  ) : (
    <span className="subtle">Not recorded</span>
  );
}
function IssueIdentityCard({ label, item }: { label: string; item: ItemIdentitySummary }) {
  return (
    <section className="issue-identity-card" aria-label={label}>
      <h4>{label}</h4>
      <p className="issue-identity-title">
        <span className="issue-type">{issueType(item)}</span> {issueTitle(item)}
      </p>
      <dl>
        <dt>File path</dt>
        <dd className="mono">{issuePath(item.path)}</dd>
        <dt>
          {issueText(item.type).toLowerCase() === 'episode'
            ? 'Episode provider IDs'
            : 'Provider IDs'}
        </dt>
        <dd>
          <IssueProviders values={item.provider_ids} />
        </dd>
        {['episode', 'season'].includes(issueText(item.type).toLowerCase()) && (
          <>
            <dt>Show provider IDs</dt>
            <dd>
              <IssueProviders values={item.series_provider_ids} />
            </dd>
          </>
        )}
        <dt>Item ID</dt>
        <dd className="mono">{issueText(item.id) || 'Not recorded'}</dd>
      </dl>
    </section>
  );
}
function IssueCandidates({ item }: { item: ItemIssue }) {
  const [expanded, setExpanded] = useState(false);
  const candidates = Array.isArray(item.candidates)
    ? item.candidates.filter((candidate) => candidate && typeof candidate === 'object').slice(0, 20)
    : [];
  const ids = Array.isArray(item.candidate_ids)
    ? item.candidate_ids
        .map((id) => issueText(id))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const count = Math.max(issueNumber(item.candidate_count) || 0, candidates.length, ids.length);
  return (
    <details
      className="issue-candidates"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {candidates.length
          ? `Compare ${num(count)} Jellyfin ${count === 1 ? 'candidate' : 'candidates'}`
          : 'View saved item details'}
      </summary>
      {expanded && (
        <>
          <div className="issue-identity-grid">
            <IssueIdentityCard label="Emby source" item={issueIdentity(item)} />
            {candidates.map((candidate, index) => (
              <IssueIdentityCard
                key={`${issueText(candidate.id)}-${index}`}
                label={`Jellyfin candidate ${index + 1}`}
                item={candidate}
              />
            ))}
          </div>
          {!candidates.length && (
            <p className="issue-note">
              Candidate names and metadata were not saved with this operation.
              {ids.length ? ` Jellyfin candidate IDs: ${ids.join(', ')}.` : ''}
            </p>
          )}
          {count > Math.max(candidates.length, ids.length) && (
            <p className="issue-note">
              Showing {num(Math.max(candidates.length, ids.length))} of {num(count)} candidates.
              Details are limited to 20 candidates per item; matching checks every candidate.
            </p>
          )}
        </>
      )}
    </details>
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
  const displayed = items.slice(0, 200);
  const total = Math.max(issueNumber(count) || 0, items.length);
  return (
    <details className="disclosure">
      <summary>
        {label} ({num(total)})
      </summary>
      {displayed.length ? (
        <ul className="issue-list">
          {displayed.map((item, i) => (
            <li className="issue-item" key={`${issueText(item.Id) || issueText(item.id)}-${i}`}>
              <div className="issue-heading">
                <span className="issue-type">{issueType(issueIdentity(item))}</span>
                <strong>{issueTitle(issueIdentity(item))}</strong>
              </div>
              {ambiguous && (
                <>
                  <p className="issue-reason">{issueReason(item)}</p>
                  {item.method && Object.hasOwn(matchingMethods, item.method) && (
                    <p className="issue-note">Matching basis: {matchingMethods[item.method]}.</p>
                  )}
                  <IssueCandidates item={item} />
                </>
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
      {displayed.length > 0 && total > displayed.length && (
        <p className="issue-note">
          Showing {num(displayed.length)} of {num(total)} items. Details are limited to 200 items;
          migration checks every item.
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
    reading_source:
      job.migration_scope === 'watched_only' ? 'Reading Emby played flags' : 'Reading Emby library',
    preparing_account: 'Preparing Jellyfin account',
    indexing_target: 'Preparing shared Jellyfin matching index',
    reading_target:
      job.migration_scope === 'watched_only'
        ? 'Reading Jellyfin played status'
        : 'Reading Jellyfin account history',
    matching: 'Matching media identities',
    verifying_history:
      job.migration_scope === 'watched_only'
        ? 'Verifying Jellyfin played status'
        : 'Verifying Jellyfin watch history',
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
      {progress?.phase === 'indexing_target' && (
        <p className="muted text-small">
          {progress.catalog_cache_hit
            ? `Using cached matching index · ${num(progress.catalog_items ?? 0)} items`
            : `${num(progress.catalog_pages ?? 0)} catalog pages · ${num(progress.catalog_items ?? 0)} items indexed`}
          {!progress.catalog_cache_hit && (progress.catalog_pages ?? 0) === 0
            ? ' · Waiting for the first catalog page…'
            : !progress.catalog_cache_hit && progress.catalog_last_page_ms !== undefined
              ? ` · Last page ${num(progress.catalog_last_page_ms)} ms`
              : ''}
        </p>
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
  const recovered = snapshot.diagnostics?.recovered_orphan_state_items ?? 0;
  const recoveryNote = recovered
    ? ` ${num(recovered)} orphan history ${recovered === 1 ? 'record was' : 'records were'} reattached to verified Emby media. Duplicate played flags were merged before Jellyfin matching.`
    : '';
  if (snapshot.source_type === 'plugin_backup')
    return (
      <p className="subtle text-small">
        Saved Emby plugin backup · Emby {snapshot.source_server_version} ·{' '}
        {snapshot.scope === 'watched_only' ? 'played-status capture' : 'complete database capture'}{' '}
        · backed up{' '}
        {snapshot.backup_created_at
          ? new Date(snapshot.backup_created_at).toLocaleString()
          : 'at an unavailable time'}
        . Imported {new Date(snapshot.finished_at).toLocaleString()}. Activity after the backup time
        is not included; importing it again does not refresh its history.
        {recoveryNote}
      </p>
    );
  return (
    <p className="subtle text-small">
      Saved Emby snapshot{fileCopy ? ' · File copy' : ''} · Emby {snapshot.source_server_version} ·{' '}
      {snapshot.scope === 'watched_only' ? 'played-status capture' : 'complete database capture'} ·
      captured {new Date(snapshot.finished_at).toLocaleString()}. {fileCopy ? 'Copy' : 'Read'}{' '}
      window: {new Date(snapshot.started_at).toLocaleString()} –{' '}
      {new Date(snapshot.finished_at).toLocaleString()}. Activity after this window is not included.
      {fileCopy &&
        ' Live file copies are not transactional; some history may be missing or inconsistent even when validation passes.'}
      {recoveryNote}
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
