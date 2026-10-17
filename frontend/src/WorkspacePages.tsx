import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, JobsTable, Status, UserCell } from './components';
import { ConnectionRows, UserWarnings } from './SettingsPage';
import DiscordMemberPicker from './DiscordMemberPicker';
import { Pagination, Tabs, TabPanel, usePagination } from './ui-layout';
import {
  activeJob,
  date,
  num,
  type Api,
  type DiscordMember,
  type Job,
  type Notify,
  type Overview,
  type Page,
  type Recovery,
  type Settings,
  type SubscriptionEvent,
  type Users,
} from './types';
interface Common {
  navigate: (page: Page) => void;
  openJob: (id: string) => void;
}
export function OverviewPage({
  overview: data,
  navigate,
  openJob,
  refresh,
}: Common & { overview: Overview; refresh: () => void }) {
  const ready = data.connections.emby.connected && data.connections.jellyfin.connected;
  return (
    <div className="page-stack">
      <Heading
        title="Overview"
        description="Check your servers, manage accounts, and review recent operations."
        actions={
          <>
            <button className="btn btn-quiet" onClick={refresh}>
              <Icon name="refresh" />
              Refresh
            </button>
            <button className="btn btn-primary" onClick={() => navigate('migrate')}>
              <Icon name="migrate" />
              Migrate users
            </button>
          </>
        }
      />
      {!data.connections.jellyfin.configured && (
        <Callout title="Start by connecting your servers.">
          Add your Emby and Jellyfin API keys, then choose the Jellyfin user whose permissions new
          accounts should inherit.{' '}
          <button className="text-button" onClick={() => navigate('settings')}>
            Open settings
          </button>
        </Callout>
      )}
      <div className="metrics">
        {[
          {
            label: 'Emby users',
            count: data.counts.emby_users,
            icon: 'users',
            color: 'mint',
            note: 'Accounts on your source server',
          },
          {
            label: 'Jellyfin users',
            count: data.counts.jellyfin_users,
            icon: 'jellyfin',
            color: '',
            note: 'Accounts on your destination server',
          },
          {
            label: 'Operations',
            count: data.counts.jobs,
            icon: 'activity',
            color: 'blue',
            note: 'Migrations and account changes',
          },
        ].map((metric) => (
          <div className="metric" key={metric.label}>
            <div className="metric-top">
              {metric.label}
              <span className={`metric-icon ${metric.color}`}>
                <Icon name={metric.icon} />
              </span>
            </div>
            <div className="metric-number">{num(metric.count)}</div>
            <div className="metric-note">{metric.note}</div>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Server connections</h2>
              <p>Connection status for your media servers and Discord bot.</p>
            </div>
            <button className="btn btn-small btn-quiet" onClick={() => navigate('settings')}>
              Manage
            </button>
          </div>
          <ConnectionRows connections={data.connections} />
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2>Account management</h2>
          </div>
          <div className="quick-actions">
            {[
              {
                page: 'migrate' as Page,
                icon: 'migrate',
                title: 'Migrate existing users',
                text: 'Bring played status into Jellyfin.',
              },
              {
                page: 'accounts' as Page,
                icon: 'userPlus',
                title: 'Create an account',
                text: 'Apply your saved account defaults.',
              },
              {
                page: 'subscriptions' as Page,
                icon: 'inbox',
                title: 'Review subscriptions',
                text: 'Approve incoming membership events.',
              },
            ].map((action) => (
              <button
                className="quick-action"
                onClick={() => navigate(action.page)}
                key={action.page}
              >
                <Icon name={action.icon} />
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.text}</small>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-header">
          <h2>Recent activity</h2>
          <button className="text-button" onClick={() => navigate('activity')}>
            View all
          </button>
        </div>
        <JobsTable
          jobs={data.recent_jobs.slice(0, 5)}
          compact
          openJob={openJob}
          migrate={() => navigate('migrate')}
        />
      </section>
      <p className="section-note">
        <span className={`status ${ready ? 'good' : ''}`}>
          {ready ? 'Servers are ready' : 'Configure servers to begin'}
        </span>{' '}
        Migration reviews protect existing Jellyfin activity before any played flags are added.
      </p>
    </div>
  );
}
export function MigratePage({
  users,
  overview,
  selected,
  select,
  search,
  setSearch,
  preview,
  useSnapshots,
  setUseSnapshots,
  busy,
  navigate,
}: {
  users: Users;
  overview: Overview;
  selected: Set<string>;
  select: (value: Set<string>) => void;
  search: string;
  setSearch: (value: string) => void;
  preview: () => void;
  useSnapshots: boolean;
  setUseSnapshots: (value: boolean) => void;
  busy: boolean;
  navigate: (page: Page) => void;
}) {
  const filtered = users.emby.filter((user) =>
    user.Name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const pagination = usePagination(filtered, 25, search.trim().toLowerCase());
  const targets = new Set(users.jellyfin.map((user) => user.Name.toLowerCase()));
  const all = useRef<HTMLInputElement>(null);
  const selectedVisible = pagination.items.filter((user) => selected.has(user.Id)).length;
  useEffect(() => {
    if (all.current)
      all.current.indeterminate = selectedVisible > 0 && selectedVisible < pagination.items.length;
  }, [selectedVisible, pagination.items.length]);
  return (
    <div className="page-stack">
      <Heading
        title="Migrate users"
        description="Select Emby accounts, review the migration, and add their played status to Jellyfin."
        actions={
          <button
            id="preview-migration"
            className="btn btn-primary"
            onClick={preview}
            disabled={!selected.size || selected.size > 100 || busy}
          >
            {busy ? <span className="spinner" /> : <Icon name="migrate" />}
            {busy
              ? 'Preparing review…'
              : `Preview migration${selected.size ? ` (${selected.size})` : ''}`}
          </button>
        }
      />
      <div className="steps" aria-label="Migration steps">
        <span className="step active" aria-current="step">
          <span className="step-number">1</span>Select users
        </span>
        <span className="step-separator" />
        <span className="step">
          <span className="step-number">2</span>Review accounts
        </span>
        <span className="step-separator" />
        <span className="step">
          <span className="step-number">3</span>Migrate &amp; deliver
        </span>
      </div>
      <UserWarnings users={users} />
      {!(overview.connections.emby.connected && overview.connections.jellyfin.connected) && (
        <Callout icon="warning" warning title="Both servers need to be connected.">
          <button className="text-button" onClick={() => navigate('settings')}>
            Check your server settings
          </button>{' '}
          before starting a migration.
        </Callout>
      )}
      <div className="migration-options">
        <label className="check-label">
          <input
            type="checkbox"
            className="checkbox"
            checked={useSnapshots}
            onChange={(event) => setUseSnapshots(event.target.checked)}
            disabled={busy}
            aria-describedby="migration-snapshot-help"
          />
          Use saved Emby snapshot
        </label>
        <span id="migration-snapshot-help" className="section-note">
          Saved history must be current and cover every selected user. Missing data stops the
          preview.
        </span>
      </div>
      <div className="page-stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Emby users</h2>
              <p>Select up to 100 users for one migration.</p>
            </div>
            <span className="status">{num(users.emby.length)} users</span>
          </div>
          <div className="toolbar">
            <div className="search-wrap">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search Emby users"
                placeholder="Search by username…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="migration-selection">
              <label className="check-label">
                <input
                  ref={all}
                  className="checkbox"
                  type="checkbox"
                  aria-label="Select all visible Emby users"
                  checked={!!pagination.items.length && selectedVisible === pagination.items.length}
                  disabled={
                    busy ||
                    (selectedVisible < pagination.items.length &&
                      selected.size + pagination.items.length - selectedVisible > 100)
                  }
                  onChange={(event) => {
                    const next = new Set(selected);
                    pagination.items.forEach((user) =>
                      event.target.checked ? next.add(user.Id) : next.delete(user.Id),
                    );
                    select(next);
                  }}
                />
                Select this page
              </label>
              <span className="selection-info">{num(selected.size)} selected</span>
            </div>
          </div>
          {filtered.length ? (
            <div className="table-wrap">
              <table className="responsive-table migration-table">
                <thead>
                  <tr>
                    <th className="check-col" aria-label="Selection" />
                    <th>Username</th>
                    <th>Jellyfin account</th>
                    <th className="right">Emby access</th>
                  </tr>
                </thead>
                <tbody>
                  {pagination.items.map((user) => (
                    <tr key={user.Id}>
                      <td className="check-col">
                        <input
                          className="checkbox"
                          type="checkbox"
                          aria-label={`Select ${user.Name}`}
                          checked={selected.has(user.Id)}
                          disabled={busy || (!selected.has(user.Id) && selected.size >= 100)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(user.Id);
                            else next.delete(user.Id);
                            select(next);
                          }}
                        />
                      </td>
                      <td data-label="Username">
                        <UserCell name={user.Name} />
                      </td>
                      <td data-label="Jellyfin">
                        <span
                          className={`status ${targets.has(user.Name.toLowerCase()) ? '' : 'good'}`}
                        >
                          {targets.has(user.Name.toLowerCase())
                            ? 'Already exists'
                            : 'Will be created'}
                        </span>
                      </td>
                      <td className="right" data-label="Emby access">
                        <span className="subtle">
                          {user.Policy?.IsDisabled
                            ? 'Disabled'
                            : user.Policy?.IsAdministrator
                              ? 'Administrator'
                              : 'User'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon="users"
              title={search ? 'No matching users' : 'No Emby users yet'}
              text={
                search
                  ? 'Try another username.'
                  : 'Connect your Emby server in Settings to load its users.'
              }
            >
              {!search && (
                <button className="btn btn-quiet" onClick={() => navigate('settings')}>
                  Connect Emby
                </button>
              )}
            </Empty>
          )}
          <div className="table-footer">
            <span>
              {num(filtered.length)} of {num(users.emby.length)} users
            </span>
            <button
              className="text-button"
              disabled={!selected.size}
              onClick={() => select(new Set())}
            >
              Clear selection
            </button>
          </div>
          <Pagination
            label="Emby users"
            page={pagination.page}
            total={pagination.total}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setPage}
            onPageSizeChange={pagination.setPageSize}
          />
        </section>
        <details className="help-details">
          <summary>What is migrated</summary>
          <div className="help-body form-stack">
            <p>
              Only played or unplayed status is migrated. Existing Jellyfin resume positions and
              other personal state stay unchanged.
            </p>
            <p>
              New accounts use saved defaults and receive a generated password. Existing accounts
              keep their passwords and permissions. Unmatched or ambiguous items are reported for
              review.
            </p>
            <p>
              Previews check accounts and backup freshness without scanning libraries; matching and
              played flags are read only after approval. Migrations pause between source requests to
              protect playback. File copies provide best-effort saved history.
            </p>
            <p>
              Set username exceptions in{' '}
              <button type="button" className="text-button" onClick={() => navigate('mappings')}>
                User mappings
              </button>
              .
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
export function AccountsPage({
  settings,
  overview,
  api,
  notify,
  created,
  navigate,
}: {
  settings: Settings;
  overview: Overview;
  api: Api;
  notify: Notify;
  created: (job: Job) => void;
  navigate: (page: Page) => void;
}) {
  const [busy, setBusy] = useState('');
  const [task, setTask] = useState('create');
  const [accountUsername, setAccountUsername] = useState('');
  const [accountMember, setAccountMember] = useState<DiscordMember | null>(null);
  const [recoveryUsername, setRecoveryUsername] = useState('');
  const [recoveryMember, setRecoveryMember] = useState<DiscordMember | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [approved, setApproved] = useState(false);
  const [recoveryRecipient, setRecoveryRecipient] = useState('');
  const recoveryVersion = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryVersion.current++;
      controllers.current.forEach((controller) => controller.abort());
    };
  }, []);
  const ready =
    overview.connections.jellyfin.connected &&
    (settings.default_role_id || settings.template_user_id);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const username = String(values.get('username') || '').trim();
    if (!username) {
      (form.elements.namedItem('username') as HTMLInputElement).focus();
      return;
    }
    busyRef.current = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy('create');
    try {
      const job = await api<Job>('/api/accounts', {
        method: 'POST',
        body: {
          username,
          discord_user_id:
            String(values.get('discord_user_id') || values.get('discord_manual_id') || '').trim() ||
            undefined,
        },
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      form.reset();
      setAccountUsername('');
      setAccountMember(null);
      created(job);
      notify('Account creation started.');
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        notify(error instanceof Error ? error.message : 'Account could not be created.', true);
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const values = new FormData(event.currentTarget);
    const controller = new AbortController();
    controllers.current.add(controller);
    busyRef.current = true;
    const version = ++recoveryVersion.current;
    setRecovery(null);
    setApproved(false);
    setBusy('inspect');
    try {
      const result = await api<Recovery>(
        `/api/accounts/recovery?username=${encodeURIComponent(String(values.get('username') || '').trim())}`,
        { signal: controller.signal },
      );
      if (mounted.current && !controller.signal.aborted && version === recoveryVersion.current) {
        setRecovery(result);
        setRecoveryRecipient(
          String(values.get('discord_user_id') || values.get('discord_manual_id') || '').trim(),
        );
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        notify(error instanceof Error ? error.message : 'Account inspection failed.', true);
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function recover() {
    if (busyRef.current || !approved || !recovery?.eligible || !recovery.target_user_id) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    busyRef.current = true;
    setBusy('recover');
    try {
      const job = await api<Job>('/api/accounts/recover', {
        method: 'POST',
        body: {
          username: recovery.username,
          target_user_id: recovery.target_user_id,
          discord_user_id: recoveryRecipient || undefined,
        },
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      setRecovery(null);
      setApproved(false);
      created(job);
      notify('Account recovery started.');
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        notify(error instanceof Error ? error.message : 'Account recovery failed.', true);
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy('');
    }
  }
  return (
    <div className="page-stack">
      <Heading
        title="Create account"
        description="Create a Jellyfin account with your saved defaults and a secure generated password."
      />
      {!ready && (
        <Callout icon="warning" warning title="Finish your Jellyfin setup first.">
          Connect Jellyfin and choose a default account role or fallback template in{' '}
          <button className="text-button" onClick={() => navigate('settings')}>
            Settings
          </button>
          .
        </Callout>
      )}
      <Tabs
        id="account-task"
        label="Account task"
        tabs={[
          { id: 'create', label: 'New account' },
          { id: 'recover', label: 'Recover interrupted creation' },
        ]}
        value={task}
        onChange={setTask}
      />
      <TabPanel id="account-task" tabId="create" active={task === 'create'}>
        <div className="task-panel">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Account details</h2>
                <p>For new members, family, and children without an Emby account.</p>
              </div>
              <span className="server-icon jellyfin">
                <Icon name="userPlus" />
              </span>
            </div>
            <div className="panel-body">
              <form className="form-stack" onSubmit={create}>
                <div className="field">
                  <label htmlFor="account-username">Username</label>
                  <input
                    id="account-username"
                    name="username"
                    value={accountUsername}
                    onChange={(event) => setAccountUsername(event.target.value)}
                    placeholder="Enter a username"
                    required
                    maxLength={64}
                    autoComplete="off"
                  />
                  <small>
                    Selecting a Discord member fills in their actual username automatically.
                  </small>
                </div>
                <DiscordMemberPicker
                  api={api}
                  value={accountMember}
                  onChange={(member) => {
                    setAccountMember(member);
                    if (member) setAccountUsername(member.username);
                  }}
                  suggestedQuery={accountUsername}
                  disabled={!!busy}
                  label="Discord member (optional)"
                  allowInactive
                  id="account-discord"
                  inputName="discord_user_id"
                />
                <div className="form-stack">
                  <p className="section-note">
                    {overview.connections.discord.connected
                      ? 'Jellyport will privately message this member with their credentials.'
                      : 'Connect your Discord bot in Settings to enable private account delivery.'}
                  </p>
                  <p className="section-note">
                    Leave Discord blank for an independent, admin-managed account with no
                    subscription requirement. For non-paying Discord members, save complimentary
                    access in Memberships first.
                  </p>
                </div>
                <ManualDiscordId id="account-manual-discord" disabled={!!busy || !!accountMember} />
                <Callout
                  icon="key"
                  title="A password will be generated automatically."
                  className="mb-0"
                >
                  You can reveal it once after the account is created. If delivery fails, the
                  operation will show the reason.
                </Callout>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={!ready || !!busy}>
                    {busy === 'create' ? <span className="spinner" /> : <Icon name="userPlus" />}
                    {busy === 'create' ? 'Creating account…' : 'Create account'}
                  </button>
                </div>
              </form>
            </div>
          </section>
          <details className="help-details">
            <summary>Account defaults and delivery</summary>
            <div className="help-body form-stack">
              <p>
                New accounts receive your default role’s saved settings, or your fallback Jellyfin
                template. Credentials can be revealed once or delivered privately through Discord.
              </p>
              <p>
                Discord IDs keep membership links stable when names change. Leave Discord blank for
                an independent, admin-managed account. Set complimentary access in Memberships for
                non-paying Discord members.
              </p>
              <p>
                Already using Emby?{' '}
                <button type="button" className="text-button" onClick={() => navigate('migrate')}>
                  Migrate users
                </button>{' '}
                to preserve their username and played history.
              </p>
            </div>
          </details>
        </div>
      </TabPanel>
      <TabPanel id="account-task" tabId="recover" active={task === 'recover'}>
        <section className="panel task-panel">
          <div className="panel-header">
            <h2>Recover an interrupted account creation</h2>
          </div>
          <div className="panel-body">
            <p className="section-note">
              If a creation request timed out after reaching Jellyfin, inspect the resulting account
              before retrying. Recovery is available only for an incomplete creation tracked by
              Jellyport.
            </p>
            <form
              onSubmit={inspect}
              onInput={() => {
                recoveryVersion.current++;
                setRecovery(null);
                setApproved(false);
              }}
            >
              <div className="field-row">
                <div className="field">
                  <label htmlFor="recovery-username">Account to inspect</label>
                  <input
                    id="recovery-username"
                    name="username"
                    value={recoveryUsername}
                    onChange={(event) => setRecoveryUsername(event.target.value)}
                    required
                    maxLength={64}
                    placeholder="Exact Jellyfin username"
                    autoComplete="off"
                  />
                </div>
                <DiscordMemberPicker
                  api={api}
                  value={recoveryMember}
                  onChange={(member) => {
                    recoveryVersion.current++;
                    setRecovery(null);
                    setApproved(false);
                    setRecoveryMember(member);
                  }}
                  suggestedQuery={recoveryUsername}
                  disabled={!!busy}
                  label="Recovery Discord member (optional)"
                  id="recovery-discord"
                  inputName="discord_user_id"
                />
              </div>
              <ManualDiscordId id="recovery-manual-discord" disabled={!!busy || !!recoveryMember} />
              <div className="form-actions">
                <button className="btn btn-quiet" type="submit" disabled={!!busy}>
                  {busy === 'inspect' ? <span className="spinner" /> : <Icon name="search" />}
                  {busy === 'inspect' ? 'Inspecting…' : 'Inspect account'}
                </button>
              </div>
            </form>
            <div className="recovery-result" aria-live="polite">
              {recovery && (
                <>
                  <Callout
                    icon={recovery.eligible ? 'warning' : 'info'}
                    warning={recovery.eligible}
                    title={`${recovery.username} · ${recovery.eligible ? 'Eligible for recovery' : 'Recovery unavailable'}`}
                  >
                    {recovery.reason}
                    {recovery.target_user_id && (
                      <span className="recovery-target mono">
                        Jellyfin account ID: {recovery.target_user_id}
                      </span>
                    )}
                  </Callout>
                  {recovery.eligible && (
                    <>
                      <label className="approval-check">
                        <input
                          type="checkbox"
                          className="checkbox"
                          checked={approved}
                          onChange={(event) => setApproved(event.target.checked)}
                        />
                        <span>
                          I inspected this Jellyfin account and approve a new password and account
                          defaults.
                        </span>
                      </label>
                      <div className="form-actions">
                        <button
                          className="btn btn-danger"
                          type="button"
                          onClick={recover}
                          disabled={!approved || !!busy}
                        >
                          {busy === 'recover' && <span className="spinner" />}
                          {busy === 'recover' ? 'Recovering…' : 'Recover account'}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </TabPanel>
    </div>
  );
}
function ManualDiscordId({ id, disabled }: { id: string; disabled: boolean }) {
  return (
    <details>
      <summary>Advanced Discord details</summary>
      <div className="field">
        <label htmlFor={id}>Discord user ID (advanced)</label>
        <input
          id={id}
          name="discord_manual_id"
          disabled={disabled}
          inputMode="numeric"
          pattern="[0-9]{15,22}"
          maxLength={22}
          autoComplete="off"
        />
        <small>Use this fallback only when you already know the member’s ID.</small>
      </div>
    </details>
  );
}

export function ActivityPage({
  jobs,
  refresh,
  openJob,
  navigate,
  clearHistory,
}: Common & {
  jobs: Job[];
  refresh: () => void;
  clearHistory?: (filteredIds: string[], filtered: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filtered = jobs.filter(
    (job) =>
      (status === 'all' || (status === 'active' ? activeJob(job) : job.status === status)) &&
      `${job.kind} ${job.id} ${job.results?.map((item) => item.username).join(' ') ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const pagination = usePagination(filtered, 25, `${status}:${query}`);
  const count = jobs.filter(activeJob).length;
  return (
    <div className="page-stack">
      <Heading
        title="Activity"
        description="Review migrations, new accounts, and any items that need your attention."
        actions={
          <>
            <button className="btn btn-quiet" onClick={refresh}>
              <Icon name="refresh" />
              Refresh
            </button>
            {clearHistory && (
              <button
                className="btn btn-quiet"
                onClick={() =>
                  clearHistory(
                    filtered.map((job) => job.id),
                    status !== 'all' || query.trim() !== '',
                  )
                }
                disabled={!jobs.length}
              >
                Clear history…
              </button>
            )}
          </>
        }
      />
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Operation history</h2>
            <p>
              {count
                ? `${num(count)} ${count === 1 ? 'operation is' : 'operations are'} running. Progress updates automatically.`
                : 'Open an operation to see its results and account delivery.'}
            </p>
          </div>
          <span className="status">
            {num(jobs.length)} {jobs.length === 1 ? 'operation' : 'operations'}
          </span>
        </div>
        <div className="view-toolbar">
          <label className="field toolbar-search">
            Search operations
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Username, operation, or job ID"
            />
          </label>
          <label className="field">
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All operations</option>
              <option value="active">Running or queued</option>
              <option value="completed">Completed</option>
              <option value="partial">Needs review</option>
              <option value="failed">Failed</option>
              <option value="canceled">Canceled</option>
            </select>
          </label>
        </div>
        <JobsTable
          jobs={pagination.items}
          filtered={query.trim() !== '' || status !== 'all'}
          openJob={openJob}
          migrate={() => navigate('migrate')}
        />
        <Pagination
          label="Operations"
          page={pagination.page}
          total={pagination.total}
          pageSize={pagination.pageSize}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
        />
        <div className="table-footer">
          <span>Newest first</span>
          <span>Credentials are available through an explicit, one-time reveal.</span>
        </div>
      </section>
    </div>
  );
}
export function SubscriptionsPage({
  events,
  refresh,
  openJob,
  navigate,
  review,
  ignore,
  busy,
}: Common & {
  events: SubscriptionEvent[];
  refresh: () => void;
  review: (event: SubscriptionEvent) => void;
  ignore: (event: SubscriptionEvent) => void;
  busy: boolean;
}) {
  const [scope, setScope] = useState('review');
  const [query, setQuery] = useState('');
  const needsReview = (event: SubscriptionEvent) => ['pending', 'failed'].includes(event.status);
  const filtered = events.filter(
    (event) =>
      (scope === 'all' || (scope === 'review' ? needsReview(event) : !needsReview(event))) &&
      `${event.username ?? ''} ${event.discord_user_id ?? ''} ${event.detail ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const pagination = usePagination(filtered, 25, `${scope}:${query}`);
  const pending = events.filter((event) => event.status === 'pending').length;
  const names: Record<string, string> = {
    subscribe: 'Subscribed',
    cancel: 'Cancellation',
    expire: 'Access expired',
  };
  return (
    <div className="page-stack">
      <Heading
        title="Subscriptions"
        description="Review trusted Discord membership events before making account changes."
        actions={
          <>
            <button className="btn btn-quiet" onClick={refresh}>
              <Icon name="refresh" />
              Refresh
            </button>
            <button className="btn" onClick={() => navigate('settings')}>
              Automation settings
            </button>
          </>
        }
      />
      <Tabs
        id="subscription-queue"
        label="Subscription view"
        tabs={[
          { id: 'review', label: 'Needs review', count: events.filter(needsReview).length },
          { id: 'history', label: 'Processed' },
          { id: 'all', label: 'All events' },
        ]}
        value={scope}
        onChange={setScope}
      />
      <div className="view-toolbar">
        <label className="field toolbar-search">
          Search subscription events
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Member or plan"
          />
        </label>
      </div>
      {['review', 'history', 'all'].map((tab) => (
        <TabPanel key={tab} id="subscription-queue" tabId={tab} active={scope === tab}>
          {scope === tab && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Subscription events</h2>
                  <p>
                    {pending
                      ? `${num(pending)} ${pending === 1 ? 'event is' : 'events are'} waiting for review.`
                      : 'Events appear when your configured Discord integration receives a membership change.'}
                  </p>
                </div>
                <span className={`status ${pending ? 'warn' : ''}`}>{num(pending)} pending</span>
              </div>
              {filtered.length ? (
                <div className="table-wrap">
                  <table className="responsive-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Event</th>
                        <th>Status</th>
                        <th>Received</th>
                        <th className="right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagination.items.map((event) => (
                        <tr key={event.id}>
                          <td data-label="Member">
                            <strong>{event.username || 'Discord member'}</strong>
                            <small>{event.discord_user_id}</small>
                            {event.error && <small className="red">{event.error}</small>}
                          </td>
                          <td data-label="Event">
                            <span>{names[event.action] || event.action}</span>
                            <small>
                              {event.source === 'mee6_message'
                                ? 'MEE6 announcement'
                                : event.source || 'Discord'}
                            </small>
                            {event.action === 'subscribe' &&
                              event.source === 'mee6_message' &&
                              event.detail && <small>Plan: {event.detail}</small>}
                            {event.account_limit !== undefined && (
                              <small>
                                {event.account_limit} entitled{' '}
                                {event.account_limit === 1 ? 'account' : 'accounts'}
                              </small>
                            )}
                          </td>
                          <td data-label="Status">
                            <Status value={event.status} />
                          </td>
                          <td className="nowrap" data-label="Received">
                            {date(event.created_at)}
                          </td>
                          <td className="right nowrap" data-label="Actions">
                            {['pending', 'failed'].includes(event.status) ? (
                              <div className="row-actions">
                                <button
                                  className="btn btn-small btn-quiet"
                                  disabled={busy}
                                  onClick={() => ignore(event)}
                                >
                                  Ignore
                                </button>
                                <button
                                  className="btn btn-small btn-primary"
                                  disabled={busy}
                                  onClick={() => review(event)}
                                >
                                  Review
                                </button>
                              </div>
                            ) : event.job_id ? (
                              <button
                                className="btn btn-small btn-quiet"
                                onClick={() => openJob(event.job_id!)}
                              >
                                View operation
                              </button>
                            ) : event.report_cleared ? (
                              <span className="subtle">Report cleared</span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon="inbox"
                  title={
                    query
                      ? 'No events match'
                      : scope === 'review'
                        ? 'Your review queue is clear'
                        : 'No subscription events'
                  }
                  text={
                    query.trim()
                      ? 'Try a different member or plan.'
                      : events.length
                        ? 'Use another view to see previously processed events.'
                        : 'Connect the Discord bot and configure trusted membership events in Settings to start collecting subscription activity.'
                  }
                >
                  {!events.length && (
                    <button className="btn btn-quiet" onClick={() => navigate('settings')}>
                      Configure Discord
                    </button>
                  )}
                </Empty>
              )}
              <Pagination
                label="Subscription events"
                page={pagination.page}
                total={pagination.total}
                pageSize={pagination.pageSize}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
              />
            </section>
          )}
        </TabPanel>
      ))}
      <details className="help-details">
        <summary>Membership automation</summary>
        <div className="help-body">
          Automatic creation and disabling are off by default. A subscription cancellation and an
          access expiration can be handled separately in Settings.
        </div>
      </details>
    </div>
  );
}
