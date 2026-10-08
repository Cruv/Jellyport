import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, JobsTable, Status, UserCell } from './components';
import { ConnectionRows, UserWarnings } from './SettingsPage';
import DiscordMemberPicker from './DiscordMemberPicker';
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
    <>
      <Heading
        title="Everyone’s next chapter."
        description="Bring your users, their progress, and your community over to Jellyfin."
        eyebrow="YOUR MIGRATION WORKSPACE"
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
            note: 'Ready for their next chapter',
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
      <div className="dashboard-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Server connections</h2>
                <p>Your migration route, at a glance.</p>
              </div>
              <button className="btn btn-small btn-quiet" onClick={() => navigate('settings')}>
                Manage
              </button>
            </div>
            <ConnectionRows connections={data.connections} />
          </section>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Recent activity</h2>
                <p>A record of every move.</p>
              </div>
              <button className="text-button" onClick={() => navigate('activity')}>
                View all
              </button>
            </div>
            <JobsTable
              jobs={data.recent_jobs}
              compact
              openJob={openJob}
              migrate={() => navigate('migrate')}
            />
          </section>
        </div>
        <div className="stack">
          <section className="panel">
            <div className="panel-header">
              <h2>Make the next move</h2>
            </div>
            <div className="quick-actions">
              {[
                {
                  page: 'migrate' as Page,
                  icon: 'migrate',
                  title: 'Migrate existing users',
                  text: 'Bring progress, favorites and playlists.',
                },
                {
                  page: 'accounts' as Page,
                  icon: 'userPlus',
                  title: 'Create a fresh account',
                  text: 'A warm welcome for a new member.',
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
          <section className="panel">
            <div className="panel-body">
              <h3>Your users. Their progress.</h3>
              <p className="muted text-small mt-9">
                Preview the match before you migrate. Existing Jellyfin activity is preserved as
                Emby progress, favorites and playlists are added.
              </p>
              <div className="flow">
                <div className="flow-node">
                  <span className="server-icon emby">
                    <Icon name="emby" />
                  </span>
                  Emby
                </div>
                <span className="flow-line" />
                <div className="flow-node">
                  <span className="server-icon jellyfin">
                    <Icon name="jellyfin" />
                  </span>
                  Jellyfin
                </div>
                <span className="flow-line" />
                <div className="flow-node">
                  <span className="server-icon discord">
                    <Icon name="discord" />
                  </span>
                  Discord
                </div>
              </div>
              <span className={`status ${ready ? 'good' : ''}`}>
                {ready ? 'Servers are ready' : 'Configure servers to begin'}
              </span>
            </div>
          </section>
        </div>
      </div>
      <div className="footer-note">
        <Icon name="shield" />
        Self-hosted. Your servers, your community.
      </div>
    </>
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
  busy: boolean;
  navigate: (page: Page) => void;
}) {
  const filtered = users.emby.filter((user) =>
    user.Name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const targets = new Set(users.jellyfin.map((user) => user.Name.toLowerCase()));
  const all = useRef<HTMLInputElement>(null);
  const selectedVisible = filtered.filter((user) => selected.has(user.Id)).length;
  useEffect(() => {
    if (all.current)
      all.current.indeterminate = selectedVisible > 0 && selectedVisible < filtered.length;
  }, [selectedVisible, filtered.length]);
  return (
    <>
      <Heading
        title="Migrate users"
        description="Bring Emby progress, favorites and playlists into Jellyfin. Set name exceptions in User mappings."
        actions={
          <button
            id="preview-migration"
            className="btn btn-primary"
            onClick={preview}
            disabled={!selected.size || busy}
          >
            {busy ? <span className="spinner" /> : <Icon name="migrate" />}
            {busy
              ? 'Matching history…'
              : `Preview migration${selected.size ? ` (${selected.size})` : ''}`}
          </button>
        }
      />
      <div className="steps">
        <span className="step active">
          <span className="step-number">1</span>Select users
        </span>
        <span className="step-separator" />
        <span className="step">
          <span className="step-number">2</span>Preview matches
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
      <div className="migration-layout">
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
            <span className="selection-info">{num(selected.size)} selected</span>
          </div>
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="check-col">
                      <input
                        ref={all}
                        className="checkbox"
                        type="checkbox"
                        aria-label="Select all visible Emby users"
                        checked={!!filtered.length && selectedVisible === filtered.length}
                        onChange={(event) => {
                          const next = new Set(selected);
                          filtered.forEach((user) =>
                            event.target.checked ? next.add(user.Id) : next.delete(user.Id),
                          );
                          select(next);
                        }}
                      />
                    </th>
                    <th>Username</th>
                    <th>Jellyfin account</th>
                    <th className="right">Emby access</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((user) => (
                    <tr key={user.Id}>
                      <td className="check-col">
                        <input
                          className="checkbox"
                          type="checkbox"
                          aria-label={`Select ${user.Name}`}
                          checked={selected.has(user.Id)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(user.Id);
                            else next.delete(user.Id);
                            select(next);
                          }}
                        />
                      </td>
                      <td>
                        <UserCell name={user.Name} />
                      </td>
                      <td>
                        <span
                          className={`status ${targets.has(user.Name.toLowerCase()) ? '' : 'good'}`}
                        >
                          {targets.has(user.Name.toLowerCase())
                            ? 'Already exists'
                            : 'Will be created'}
                        </span>
                      </td>
                      <td className="right">
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
        </section>
        <aside className="panel aside-panel">
          <div className="panel-body">
            <span className="server-icon jellyfin mb-17">
              <Icon name="shield" />
            </span>
            <h3>What comes along</h3>
            <ul>
              <li>The same username</li>
              <li>Played status for matched movies and episodes</li>
              <li>Saved account defaults for new accounts</li>
              <li>A generated password for each new account</li>
            </ul>
          </div>
          <div className="aside-footer">
            Existing accounts keep their passwords. Unmatched items are reported for review.
          </div>
        </aside>
      </div>
    </>
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
    <>
      <Heading
        title="Welcome someone new."
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
      <div className="section-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Create a fresh account</h2>
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
              <p className="subtle text-small">
                {overview.connections.discord.connected
                  ? 'Jellyport will privately message this member with their credentials.'
                  : 'Connect your Discord bot in Settings to enable private account delivery.'}
              </p>
              <p className="subtle text-small">
                Leave Discord blank for an independent, admin-managed account with no subscription
                requirement. For non-paying Discord members, save complimentary access in
                Memberships first.
              </p>
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
        <aside className="stack">
          <section className="panel">
            <div className="panel-header">
              <h2>Ready from day one</h2>
            </div>
            <div className="panel-body">
              {[
                {
                  icon: 'shield',
                  title: 'Your account defaults',
                  text: 'New accounts receive your default role’s saved settings, or your fallback Jellyfin template when no default role is selected.',
                },
                {
                  icon: 'discord',
                  title: 'A stable Discord link',
                  text: 'Discord user IDs keep each membership linked to its Jellyfin account. The initial username is preserved even if their Discord name changes.',
                },
                {
                  icon: 'lock',
                  title: 'Private credential delivery',
                  text: 'Credentials are sent by direct message. Members should change their password after signing in.',
                },
              ].map((row) => (
                <div className="command-row" key={row.icon}>
                  <Icon name={row.icon} />
                  <strong className="command-title">{row.title}</strong>
                  <p>{row.text}</p>
                </div>
              ))}
            </div>
          </section>
          <Callout icon="migrate" title="Already using Emby?">
            Use{' '}
            <button className="text-button" onClick={() => navigate('migrate')}>
              Migrate users
            </button>{' '}
            to keep their username and played history.
          </Callout>
        </aside>
      </div>
      <details className="panel recovery-panel">
        <summary>
          <Icon name="refresh" />
          Recover an interrupted account creation
        </summary>
        <p className="muted text-small">
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
      </details>
    </>
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
}: Common & { jobs: Job[]; refresh: () => void }) {
  const count = jobs.filter(activeJob).length;
  return (
    <>
      <Heading
        title="Every move, recorded."
        description="Review migrations, new accounts, and any items that need your attention."
        actions={
          <button className="btn btn-quiet" onClick={refresh}>
            <Icon name="refresh" />
            Refresh
          </button>
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
          <span className="status">{num(jobs.length)} operations</span>
        </div>
        <JobsTable jobs={jobs} openJob={openJob} migrate={() => navigate('migrate')} />
        <div className="table-footer">
          <span>Newest first</span>
          <span>Credentials are available through an explicit, one-time reveal.</span>
        </div>
      </section>
    </>
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
  const pending = events.filter((event) => event.status === 'pending').length;
  const names: Record<string, string> = {
    subscribe: 'Subscribed',
    cancel: 'Cancellation',
    expire: 'Access expired',
  };
  return (
    <>
      <Heading
        title="Membership, connected."
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
      <Callout icon="shield" title="You stay in control.">
        Automatic creation and disabling are off by default. A subscription cancellation and an
        access expiration can be handled separately in Settings.
      </Callout>
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
        {events.length ? (
          <div className="table-wrap">
            <table>
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
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <strong>{event.username || 'Discord member'}</strong>
                      <small>{event.discord_user_id}</small>
                      {event.error && <small className="red">{event.error}</small>}
                    </td>
                    <td>
                      <span>{names[event.action] || event.action}</span>
                      <small>{event.source || 'Discord'}</small>
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
                    <td>
                      <Status value={event.status} />
                    </td>
                    <td className="nowrap">{date(event.created_at)}</td>
                    <td className="right nowrap">
                      {['pending', 'failed'].includes(event.status) ? (
                        <>
                          <button
                            className="btn btn-small btn-quiet"
                            disabled={busy}
                            onClick={() => ignore(event)}
                          >
                            Ignore
                          </button>{' '}
                          <button
                            className="btn btn-small btn-primary"
                            disabled={busy}
                            onClick={() => review(event)}
                          >
                            Review
                          </button>
                        </>
                      ) : event.job_id ? (
                        <button
                          className="btn btn-small btn-quiet"
                          onClick={() => openJob(event.job_id!)}
                        >
                          View operation
                        </button>
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
            title="Your review queue is clear"
            text="Connect the Discord bot and configure trusted membership events in Settings to start collecting subscription activity."
          >
            <button className="btn btn-quiet" onClick={() => navigate('settings')}>
              Configure Discord
            </button>
          </Empty>
        )}
      </section>
    </>
  );
}
