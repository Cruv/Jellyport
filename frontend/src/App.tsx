import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Callout,
  Empty,
  Icon,
  Issues,
  Loading,
  Modal,
  Status,
  UserCell,
  progressPercent,
} from './components';
import SettingsPage from './SettingsPage';
import AuthScreen from './AuthScreen';
import UserMappingsPage from './UserMappingsPage';
import DiscordMemberPicker from './DiscordMemberPicker';
import {
  AccountsPage,
  ActivityPage,
  MigratePage,
  OverviewPage,
  SubscriptionsPage,
} from './WorkspacePages';
import {
  activeJob,
  date,
  num,
  safeUrl,
  type Api,
  type ApiOptions,
  type Credential,
  type Job,
  type Overview,
  type Page,
  type Preview,
  type Session,
  type Settings,
  type SubscriptionEvent,
  type Users,
  type UserMapping,
  type DiscordMember,
  type PreviewUser,
} from './types';

const pages: Record<Page, { title: string; icon: string }> = {
  overview: { title: 'Overview', icon: 'grid' },
  migrate: { title: 'Migrate users', icon: 'migrate' },
  mappings: { title: 'User mappings', icon: 'link' },
  accounts: { title: 'Create account', icon: 'userPlus' },
  subscriptions: { title: 'Subscriptions', icon: 'inbox' },
  activity: { title: 'Activity', icon: 'activity' },
  settings: { title: 'Settings', icon: 'settings' },
};
type Dialog =
  | { kind: 'preview'; preview: Preview }
  | { kind: 'job'; job: Job }
  | { kind: 'reveal'; jobId: string }
  | { kind: 'credentials'; credentials: Credential[] }
  | { kind: 'event'; event: SubscriptionEvent };
interface Toast {
  id: number;
  message: string;
  error: boolean;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The operation could not be completed.';
const emptyUsers: Users = { emby: [], jellyfin: [] };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const authGeneration = useRef(0);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  const pageRef = useRef(page);
  pageRef.current = page;
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [loginError, setLoginError] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<Users>(emptyUsers);
  const [mappings, setMappings] = useState<UserMapping[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const [events, setEvents] = useState<SubscriptionEvent[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const dialogVersion = useRef(0);
  const [busy, setBusy] = useState(new Set<string>());
  const busyRef = useRef(new Set<string>());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const loadVersion = useRef(0);
  const [pollPaused, setPollPaused] = useState(false);
  const notify = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, message: text, error }]);
    const timer = setTimeout(
      () => {
        setToasts((current) => current.filter((item) => item.id !== id));
        timers.current.delete(timer);
      },
      error ? 9000 : 5000,
    );
    timers.current.add(timer);
  }, []);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const closeDialog = useCallback(() => {
    dialogVersion.current++;
    setDialog(null);
  }, []);
  const showDialog = useCallback((next: Dialog) => {
    dialogVersion.current++;
    setDialog(next);
  }, []);
  const clearSession = useCallback(() => {
    authGeneration.current++;
    loadVersion.current++;
    sessionRef.current = null;
    setSession(null);
    setOverview(null);
    setUsers(emptyUsers);
    setMappings([]);
    setSettings(null);
    setJobs([]);
    setEvents([]);
    setSelected(new Set());
    setSearch('');
    setToasts([]);
    setMobileOpen(false);
    closeDialog();
  }, [closeDialog]);
  const acceptSession = useCallback((value: Session) => {
    sessionRef.current = value;
    setSession(value);
  }, []);
  const api: Api = useCallback(
    async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
      const generation = authGeneration.current;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.method && options.method !== 'GET' && sessionRef.current?.csrf_token)
        headers['X-CSRF-Token'] = sessionRef.current.csrf_token;
      let response: Response;
      try {
        response = await fetch(path, {
          ...options,
          headers,
          credentials: 'same-origin',
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error(
          'Could not reach Jellyport. Check that the application is running and try again.',
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (generation !== authGeneration.current)
        throw new Error(
          'This request belongs to a previous session. Sign in and refresh to see its status.',
        );
      if (!response.ok) {
        if (response.status === 401 && path !== '/api/login' && path !== '/api/setup/connect')
          clearSession();
        const body = data as { detail?: unknown; error?: unknown; message?: unknown };
        let detail = body.detail || body.error || body.message;
        if (Array.isArray(detail))
          detail = detail
            .map((item) =>
              typeof item === 'object' && item && 'msg' in item
                ? String(item.msg)
                : 'Invalid input',
            )
            .join('; ');
        if (detail && typeof detail === 'object')
          detail = 'message' in detail ? String(detail.message) : JSON.stringify(detail);
        throw new Error(
          typeof detail === 'string' ? detail : `Request failed (${response.status}).`,
        );
      }
      return data as T;
    },
    [clearSession],
  );
  const work = useCallback(
    async (key: string, operation: () => Promise<void>) => {
      if (busyRef.current.has(key)) return;
      busyRef.current.add(key);
      setBusy(new Set(busyRef.current));
      const generation = authGeneration.current;
      try {
        await operation();
      } catch (error) {
        if (generation === authGeneration.current) notify(message(error), true);
      } finally {
        busyRef.current.delete(key);
        setBusy(new Set(busyRef.current));
      }
    },
    [notify],
  );
  const load = useCallback(
    async (target: Page) => {
      const version = ++loadVersion.current;
      setLoading(true);
      setPageError('');
      setPollPaused(false);
      try {
        if (target === 'overview') {
          const value = await api<Overview>('/api/overview');
          if (version === loadVersion.current) setOverview(value);
        } else if (target === 'migrate') {
          const [value, summary] = await Promise.all([
            api<Users>('/api/users'),
            api<Overview>('/api/overview'),
          ]);
          if (version === loadVersion.current) {
            setUsers(value);
            setOverview(summary);
            setSelected(
              (current) =>
                new Set([...current].filter((id) => value.emby.some((user) => user.Id === id))),
            );
          }
        } else if (target === 'mappings') {
          const [value, listed, configuration] = await Promise.all([
            api<{ mappings: UserMapping[] }>('/api/user-mappings'),
            api<Users>('/api/users'),
            api<Settings>('/api/settings'),
          ]);
          if (version === loadVersion.current) {
            setMappings(value.mappings || []);
            setUsers(listed);
            setSettings(configuration);
          }
        } else if (target === 'accounts') {
          const [value, summary] = await Promise.all([
            api<Settings>('/api/settings'),
            api<Overview>('/api/overview'),
          ]);
          if (version === loadVersion.current) {
            setSettings(value);
            setOverview(summary);
          }
        } else if (target === 'activity') {
          const value = await api<{ jobs: Job[] }>('/api/jobs');
          if (version === loadVersion.current) setJobs(value.jobs || []);
        } else if (target === 'subscriptions') {
          const value = await api<{ events: SubscriptionEvent[] }>('/api/subscriptions');
          if (version === loadVersion.current) setEvents(value.events || []);
        } else if (target === 'settings') {
          const value = await api<Settings>('/api/settings');
          let listed: Users;
          try {
            listed = await api<Users>('/api/users');
          } catch (error) {
            listed = emptyUsers;
            if (sessionRef.current?.authenticated && version === loadVersion.current)
              notify(`Template users could not be loaded: ${message(error)}`, true);
          }
          if (version === loadVersion.current) {
            setSettings(value);
            setSettingsVersion((current) => current + 1);
            setUsers(listed);
          }
        }
      } catch (error) {
        if (version === loadVersion.current && sessionRef.current?.authenticated)
          setPageError(message(error));
      } finally {
        if (version === loadVersion.current) setLoading(false);
      }
    },
    [api, notify],
  );
  useEffect(() => {
    const controller = new AbortController();
    void api<Session>('/api/session', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          sessionRef.current = value;
          setSession(value);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoginError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    if (session?.authenticated) void load(page);
  }, [session?.authenticated, page, load]);
  function navigate(target: Page) {
    closeDialog();
    setMobileOpen(false);
    if (target === page) void load(target);
    else setPage(target);
  }
  const hasActive =
    jobs.some(activeJob) ||
    overview?.recent_jobs.some(activeJob) ||
    (dialog?.kind === 'job' && activeJob(dialog.job));
  useEffect(() => {
    if (!session?.authenticated || !hasActive || pollPaused) return;
    let polling = false;
    let stopped = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        const previous = new Set(
          [...jobsRef.current, ...(overviewRef.current?.recent_jobs || [])]
            .filter(activeJob)
            .map((job) => job.id),
        );
        const result = await api<{ jobs: Job[] }>('/api/jobs');
        if (stopped || !sessionRef.current?.authenticated) return;
        const next = result.jobs || [];
        setJobs(next);
        setOverview((current) =>
          current ? { ...current, recent_jobs: next.slice(0, 6) } : current,
        );
        const finished = next.some((job) => previous.has(job.id) && !activeJob(job));
        if (finished && pageRef.current === 'migrate') {
          const listed = await api<Users>('/api/users');
          if (!stopped && pageRef.current === 'migrate') setUsers(listed);
        }
        const current = dialogRef.current;
        if (current?.kind === 'job') {
          const job =
            next.find((item) => item.id === current.job.id) ||
            (await api<Job>(`/api/jobs/${encodeURIComponent(current.job.id)}`));
          if (!stopped)
            setDialog((value) =>
              value?.kind === 'job' && value.job.id === current.job.id
                ? { kind: 'job', job }
                : value,
            );
        }
        if (pageRef.current === 'overview') {
          const value = await api<Overview>('/api/overview');
          if (!stopped && pageRef.current === 'overview') setOverview(value);
        }
      } catch (error) {
        if (!stopped && sessionRef.current?.authenticated) {
          setPollPaused(true);
          notify(`Progress updates paused: ${message(error)} Refresh Activity to retry.`, true);
        }
      } finally {
        polling = false;
      }
    };
    const interval = setInterval(() => void poll(), 3000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [api, hasActive, notify, pollPaused, session?.authenticated]);
  const created = (job: Job) => {
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    showDialog({ kind: 'job', job });
    setPollPaused(false);
  };
  const openJob = (id: string) =>
    void work('job', async () => {
      const value = await api<Job>(`/api/jobs/${encodeURIComponent(id)}`);
      showDialog({ kind: 'job', job: value });
      setPollPaused(false);
    });
  const preview = () =>
    void work('preview', async () => {
      if (selected.size > 100) throw new Error('Select up to 100 users for one migration.');
      const value = await api<Preview>('/api/migrations/preview', {
        method: 'POST',
        body: { source_user_ids: [...selected] },
      });
      if (!value.users?.length)
        throw new Error(
          'No users were returned for this preview. Reload the Emby user list and try again.',
        );
      showDialog({ kind: 'preview', preview: value });
    });
  function startMigration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dialog?.kind !== 'preview') return;
    const values = new FormData(event.currentTarget);
    const recipients: Record<string, string> = {};
    const mappingRevisions: Record<string, string | null> = {};
    dialog.preview.users.forEach((user) => {
      const value = String(
        values.get(user.source_user_id) || values.get(`manual-${user.source_user_id}`) || '',
      ).trim();
      if (value) recipients[user.source_user_id] = value;
      if (user.mapping_revision !== undefined)
        mappingRevisions[user.source_user_id] = user.mapping_revision;
    });
    const ids = dialog.preview.users.map((user) => user.source_user_id);
    void work('migration', async () => {
      const job = await api<Job>('/api/migrations', {
        method: 'POST',
        body: {
          source_user_ids: ids,
          discord_recipients: recipients,
          ...(Object.keys(mappingRevisions).length ? { mapping_revisions: mappingRevisions } : {}),
        },
      });
      setSelected(new Set());
      created(job);
      notify('Migration started. You can follow its progress here.');
    });
  }
  function reveal(id: string) {
    const version = dialogVersion.current;
    void work('reveal', async () => {
      const result = await api<{ credentials: Credential[] }>(
        `/api/jobs/${encodeURIComponent(id)}/credentials`,
        { method: 'POST', body: {} },
      );
      if (version === dialogVersion.current)
        showDialog({ kind: 'credentials', credentials: result.credentials || [] });
    });
  }
  function logout() {
    void work('logout', async () => {
      let anonymous: Session = {
        authenticated: false,
        csrf_token: '',
        demo: !!sessionRef.current?.demo,
        setup_required: false,
        setup_connected: false,
      };
      let error = '';
      try {
        const value = await api<Session>('/api/logout', {
          method: 'POST',
          body: {},
          signal: AbortSignal.timeout(10_000),
        });
        anonymous = { ...value, authenticated: false, user: undefined };
      } catch (reason) {
        error =
          'Private data was cleared from this page, but server sign-out could not be confirmed. ' +
          message(reason);
      } finally {
        clearSession();
        setLoginError(error);
        // Avoid an automatic session refresh restoring private UI after a failed logout.
        acceptSession(anonymous);
      }
    });
  }
  function apply(event: SubscriptionEvent) {
    void work('event', async () => {
      const result = await api<SubscriptionEvent>(
        `/api/subscriptions/${encodeURIComponent(event.id)}/apply`,
        { method: 'POST', body: {} },
      );
      closeDialog();
      notify(
        result.status === 'failed'
          ? result.error || 'The subscription event could not be applied.'
          : 'Subscription event processed.',
        result.status === 'failed',
      );
      await load('subscriptions');
    });
  }
  function ignore(event: SubscriptionEvent) {
    void work('event', async () => {
      await api(`/api/subscriptions/${encodeURIComponent(event.id)}/ignore`, {
        method: 'POST',
        body: {},
      });
      notify('Subscription event ignored.');
      await load('subscriptions');
    });
  }
  let content;
  if (loading) content = <Loading />;
  else if (pageError)
    content = (
      <>
        <div className="page-heading">
          <div>
            <h1>{pages[page].title}</h1>
            <p>Your workspace could not be loaded.</p>
          </div>
        </div>
        <div className="error-block" role="alert">
          {pageError}
        </div>
        <div className="mt-18">
          <button className="btn" onClick={() => void load(page)}>
            <Icon name="refresh" />
            Try again
          </button>
        </div>
      </>
    );
  else if (page === 'overview' && overview)
    content = (
      <OverviewPage
        overview={overview}
        navigate={navigate}
        openJob={openJob}
        refresh={() => void load(page)}
      />
    );
  else if (page === 'migrate' && overview)
    content = (
      <MigratePage
        users={users}
        overview={overview}
        selected={selected}
        select={setSelected}
        search={search}
        setSearch={setSearch}
        preview={preview}
        busy={busy.has('preview')}
        navigate={navigate}
      />
    );
  else if (page === 'mappings')
    content = (
      <UserMappingsPage
        mappings={mappings}
        users={users}
        templateUserId={settings?.template_user_id}
        api={api}
        notify={notify}
        refresh={() => load('mappings')}
      />
    );
  else if (page === 'accounts' && overview && settings)
    content = (
      <AccountsPage
        settings={settings}
        overview={overview}
        api={api}
        notify={notify}
        created={created}
        navigate={navigate}
      />
    );
  else if (page === 'settings' && settings)
    content = (
      <SettingsPage
        key={settingsVersion}
        settings={settings}
        users={users}
        demo={!!session?.demo}
        api={api}
        notify={notify}
        refresh={() => load('settings')}
      />
    );
  else if (page === 'activity')
    content = (
      <ActivityPage
        jobs={jobs}
        navigate={navigate}
        openJob={openJob}
        refresh={() => void load(page)}
      />
    );
  else if (page === 'subscriptions')
    content = (
      <SubscriptionsPage
        events={events}
        navigate={navigate}
        openJob={openJob}
        refresh={() => void load(page)}
        review={(event) => showDialog({ kind: 'event', event })}
        ignore={ignore}
        busy={busy.has('event')}
      />
    );
  else content = <Loading />;
  return (
    <>
      {booting ? (
        <div className="boot-screen">
          <span className="spinner" />
          <span>Opening Jellyport…</span>
        </div>
      ) : !session?.authenticated ? (
        <AuthScreen
          session={session}
          initialError={loginError}
          api={api}
          onSession={acceptSession}
        />
      ) : (
        <div className="shell">
          <aside
            className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}
            aria-label="Main navigation"
          >
            <div className="brand">
              <span className="brand-icon">
                <Icon name="logo" />
              </span>
              <div>
                Jellyport<small>EMBY → JELLYFIN</small>
              </div>
            </div>
            <div className="nav-label">Workspace</div>
            <nav className="nav">
              {(Object.entries(pages) as [Page, (typeof pages)[Page]][]).map(([key, value]) => (
                <button
                  className={`nav-button${page === key ? ' active' : ''}`}
                  aria-current={page === key ? 'page' : undefined}
                  onClick={() => navigate(key)}
                  key={key}
                >
                  <Icon name={value.icon} />
                  {value.title}
                  {page === key && <span className="nav-dot" />}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="operator-card">
                <div className="avatar">
                  {(session.user?.name || 'Admin').slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <strong>{session.user?.name || 'Administrator'}</strong>
                  <span>Jellyfin administrator</span>
                </div>
                <button
                  className="icon-button"
                  onClick={logout}
                  disabled={busy.has('logout')}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <Icon name="logout" />
                </button>
              </div>
              <div className="sidebar-note">A smoother way to move forward.</div>
            </div>
          </aside>
          <main className="main">
            <header className="topbar">
              <button
                className="icon-button mobile-menu"
                onClick={() => setMobileOpen((value) => !value)}
                aria-label="Toggle navigation"
                aria-expanded={mobileOpen}
              >
                <Icon name="menu" />
              </button>
              <div className="breadcrumb">
                <span>Workspace</span>
                <span>/</span>
                <span>{pages[page].title}</span>
              </div>
              <div className="topbar-right">
                <span className="version-label">Emby → Jellyfin</span>
                <span className="operator-label">ADMIN CONSOLE</span>
              </div>
            </header>
            <div className="content">
              {session.demo && (
                <div className="demo-banner">
                  <Icon name="info" />
                  Demo mode is active. Accounts, watch history, and Discord messages use sample
                  data. Settings are read-only.
                </div>
              )}
              {content}
            </div>
          </main>
        </div>
      )}
      {session?.authenticated && dialog && (
        <DialogContent
          api={api}
          dialog={dialog}
          close={closeDialog}
          startMigration={startMigration}
          reveal={reveal}
          showReveal={(jobId) => showDialog({ kind: 'reveal', jobId })}
          apply={apply}
          busy={busy}
          notify={notify}
        />
      )}
      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast${toast.error ? ' error' : ''}`} key={toast.id}>
            <Icon name={toast.error ? 'warning' : 'check'} />
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}
function MigrationRecipient({ user, api }: { user: PreviewUser; api: Api }) {
  const [member, setMember] = useState<DiscordMember | null>(
    user.discord_user_id
      ? {
          id: user.discord_user_id,
          username: user.discord_username || user.username,
          display_name: null,
          nickname: null,
          membership_active: null,
        }
      : null,
  );
  const mapped = !!user.mapping_id && !!user.discord_user_id;
  return (
    <>
      <DiscordMemberPicker
        api={api}
        value={member}
        onChange={setMember}
        suggestedQuery={user.discord_username || user.source_username || user.username}
        disabled={mapped}
        label="Discord recipient (optional)"
        id={`recipient-${user.source_user_id}`}
        inputName={user.source_user_id}
      />
      <p className="subtle text-tiny">
        {mapped
          ? 'This member is linked by your saved user mapping. Edit that mapping to change the recipient.'
          : user.target_exists
            ? 'Select a member to link membership management. Existing credentials are preserved.'
            : 'Select a member for private credential delivery. For different usernames, save a user mapping first.'}
      </p>
      {!mapped && (
        <details>
          <summary>Advanced Discord details</summary>
          <div className="field">
            <label htmlFor={`manual-recipient-${user.source_user_id}`}>
              Discord recipient ID (advanced)
            </label>
            <input
              id={`manual-recipient-${user.source_user_id}`}
              name={`manual-${user.source_user_id}`}
              disabled={!!member}
              inputMode="numeric"
              pattern="[0-9]{15,22}"
              maxLength={22}
              autoComplete="off"
            />
          </div>
        </details>
      )}
    </>
  );
}

function DialogContent({
  api,
  dialog,
  close,
  startMigration,
  reveal,
  showReveal,
  apply,
  busy,
  notify,
}: {
  api: Api;
  dialog: Dialog;
  close: () => void;
  startMigration: (event: FormEvent<HTMLFormElement>) => void;
  reveal: (id: string) => void;
  showReveal: (id: string) => void;
  apply: (event: SubscriptionEvent) => void;
  busy: Set<string>;
  notify: (text: string, error?: boolean) => void;
}) {
  if (dialog.kind === 'preview') {
    const users = dialog.preview.users;
    return (
      <Modal
        title="Review your migration"
        description={`${users.length} ${users.length === 1 ? 'user' : 'users'} selected · merge progress, favorites and playlists`}
        wide
        close={close}
        footer={
          <>
            <button className="btn btn-quiet" onClick={close}>
              Back to users
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="migration-preview-form"
              disabled={busy.has('migration')}
            >
              {busy.has('migration') ? <span className="spinner" /> : <Icon name="migrate" />}
              {busy.has('migration') ? 'Starting migration…' : 'Start migration'}
            </button>
          </>
        }
      >
        <Callout icon="shield" title="Preview before you move.">
          Watched flags and favorites are combined. Newer Jellyfin progress stays intact, and
          playlists become private copies. Unmatched and ambiguous items are skipped.
        </Callout>
        <form id="migration-preview-form" onSubmit={startMigration}>
          {users.map((user) => (
            <section className="preview-user" key={user.source_user_id}>
              <div className="preview-user-header">
                <UserCell name={user.username} />
                <span className={`status ${user.target_exists ? '' : 'good'}`}>
                  {user.target_exists ? 'Merge into existing account' : 'Create new account'}
                </span>
              </div>
              {user.mapping_id && (
                <p className="subtle text-small">
                  Mapped Emby account: {user.source_username} → Jellyfin: {user.username}
                </p>
              )}
              <div className="preview-stats">
                {[
                  { value: user.stats.source_played, label: 'Played in Emby', color: '' },
                  { value: user.stats.matched, label: 'Matched to Jellyfin', color: 'mint' },
                  { value: user.stats.source_favorites, label: 'Favorites in Emby', color: '' },
                  { value: user.stats.source_resume, label: 'Resume positions', color: '' },
                  { value: user.stats.source_playlists, label: 'Playlists', color: '' },
                  {
                    value: user.stats.unmatched,
                    label: 'Unmatched',
                    color: user.stats.unmatched ? '' : 'muted',
                  },
                  {
                    value: user.stats.ambiguous,
                    label: 'Ambiguous',
                    color: user.stats.ambiguous ? '' : 'muted',
                  },
                ].map((stat) => (
                  <div className="preview-stat" key={stat.label}>
                    <strong className={stat.color}>{num(stat.value)}</strong>
                    <span>{stat.label}</span>
                  </div>
                ))}
              </div>
              <div className="preview-user-body">
                {user.warnings?.map((warning, index) => (
                  <p className="subtle text-small" key={index}>
                    {warning}
                  </p>
                ))}
                {!!user.stats.already_played && (
                  <p className="subtle text-tiny mb-14">
                    {num(user.stats.already_played)} matched items are already played on Jellyfin.
                  </p>
                )}
                <Issues
                  label="Unmatched items"
                  items={user.unmatched}
                  count={user.stats.unmatched}
                />
                <Issues
                  label="Ambiguous items"
                  items={user.ambiguous}
                  count={user.stats.ambiguous}
                />
                {user.target_exists && (
                  <p className="subtle text-tiny mb-14">
                    The existing Jellyfin password and account permissions will be preserved.
                  </p>
                )}
                <MigrationRecipient
                  key={`${user.source_user_id}:${user.mapping_revision || ''}`}
                  user={user}
                  api={api}
                />
              </div>
            </section>
          ))}
        </form>
      </Modal>
    );
  }
  if (dialog.kind === 'job') {
    const job = dialog.job;
    const mayHaveCredentials =
      !activeJob(job) &&
      job.results?.some((result) => result.created && result.discord_delivery !== 'sent');
    return (
      <Modal
        title={
          ['migrate', 'migration'].includes(job.kind) ? 'Migration details' : 'Operation details'
        }
        description="Follow account changes and review delivery results."
        close={close}
        footer={
          <>
            <button className="btn btn-quiet" onClick={close}>
              Close
            </button>
            {mayHaveCredentials && (
              <button className="btn btn-primary" onClick={() => showReveal(job.id)}>
                <Icon name="key" />
                Reveal new credentials
              </button>
            )}
          </>
        }
      >
        <div className="job-summary">
          <div>
            <div className="job-id mono">{job.id}</div>
            <p className="subtle text-tiny mt-5">Started {date(job.created_at)}</p>
          </div>
          <Status value={job.status} />
        </div>
        {activeJob(job) && (
          <>
            <progress
              className="progress-track"
              aria-label="Operation progress"
              value={progressPercent(job)}
              max={100}
            />
            <p className="muted text-small">
              {job.status === 'queued'
                ? 'Waiting for the operation to begin…'
                : 'The operation is running. Progress updates automatically.'}
            </p>
          </>
        )}
        {job.error && <div className="error-block mt-15">{job.error}</div>}
        {job.results?.map((result, index) => (
          <section className="job-result" key={index}>
            <div className="job-result-header">
              <h3>{result.username || 'User'}</h3>
              <Status value={result.status} />
            </div>
            {result.source_username && result.source_username !== result.username && (
              <p className="subtle text-small">
                Emby: {result.source_username} → Jellyfin: {result.username}
              </p>
            )}
            <div className="job-meta">
              {result.created && (
                <span>
                  <Icon name="userPlus" /> New account
                </span>
              )}
              {result.matched !== undefined && <span>{num(result.matched)} matched</span>}
              {result.applied !== undefined && (
                <span className="mint">{num(result.applied)} played updates</span>
              )}
              {!!result.already_played && <span>{num(result.already_played)} already played</span>}
              {!!result.unmatched && <span>{num(result.unmatched)} unmatched</span>}
              {!!result.ambiguous && <span>{num(result.ambiguous)} ambiguous</span>}
              {result.data && (
                <>
                  <span>{num(result.data.items_updated)} items updated</span>
                  {!!result.data.favorites && <span>{num(result.data.favorites)} favorites</span>}
                  {!!result.data.resume_positions && (
                    <span>{num(result.data.resume_positions)} resume positions</span>
                  )}
                  {!!result.data.play_counts && (
                    <span>{num(result.data.play_counts)} play counts</span>
                  )}
                  {!!result.data.last_played_dates && (
                    <span>{num(result.data.last_played_dates)} playback dates</span>
                  )}
                  {!!result.data.ratings && <span>{num(result.data.ratings)} ratings / likes</span>}
                  <span>{num(result.data.playlists_created)} playlists created</span>
                  {!!result.data.playlists_existing && (
                    <span>{num(result.data.playlists_existing)} playlists already imported</span>
                  )}
                  {!!result.data.playlist_items_added && (
                    <span>{num(result.data.playlist_items_added)} playlist entries</span>
                  )}
                  {!!result.data.preferences.length && (
                    <span>{result.data.preferences.length} playback preferences</span>
                  )}
                  {result.data.avatar && <span>Profile image copied</span>}
                </>
              )}
            </div>
            {result.data?.warnings.map((warning, index) => (
              <div className="error-block" key={index}>
                {warning}
              </div>
            ))}
            {result.discord_delivery && (
              <p>
                <Icon name="discord" /> Discord delivery:{' '}
                {typeof result.discord_delivery === 'string'
                  ? result.discord_delivery
                  : result.discord_delivery.status || JSON.stringify(result.discord_delivery)}
              </p>
            )}
            {result.delivery_error && <div className="error-block">{result.delivery_error}</div>}
            {result.error && <div className="error-block">{result.error}</div>}
            <Issues
              label="Unmatched items"
              items={result.unmatched_items}
              count={result.unmatched}
            />
            <Issues
              label="Ambiguous items"
              items={result.ambiguous_items}
              count={result.ambiguous}
              ambiguous
            />
          </section>
        ))}
        {!job.results?.length && !activeJob(job) && !job.error && (
          <p className="muted text-small mt-18">This operation has no per-user results.</p>
        )}
        {!activeJob(job) && (
          <div className="support-note">
            New account passwords can be revealed once. Existing account passwords are preserved. If
            Discord delivery failed, reveal and copy the new credentials for manual delivery.
          </div>
        )}
      </Modal>
    );
  }
  if (dialog.kind === 'reveal')
    return (
      <Modal
        title="Reveal new account credentials?"
        description="This is a one-time view. Copy credentials before closing the dialog."
        close={close}
        footer={
          <>
            <button className="btn btn-quiet" onClick={close}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => reveal(dialog.jobId)}
              disabled={busy.has('reveal')}
            >
              {busy.has('reveal') ? <span className="spinner" /> : <Icon name="key" />}
              {busy.has('reveal') ? 'Revealing…' : 'Reveal credentials'}
            </button>
          </>
        }
      >
        <Callout icon="key" warning title="Keep this information private." className="mb-0">
          The password is shown only when you request it and is not saved in browser storage. A
          revealed credential cannot be viewed again.
        </Callout>
      </Modal>
    );
  if (dialog.kind === 'credentials')
    return (
      <Modal
        title="New account credentials"
        description="Copy these now. They cannot be revealed again after this view."
        close={close}
        footer={
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        }
      >
        {dialog.credentials.length ? (
          <>
            <Callout icon="lock" warning title="For the account holder only.">
              Ask members to change their generated password after their first sign-in.
            </Callout>
            {dialog.credentials.map((credential, index) => (
              <section className="credential" key={index}>
                <dl>
                  <dt>Username</dt>
                  <dd className="mono">{credential.username}</dd>
                  <dt>Password</dt>
                  <dd className="credential-password">{credential.password}</dd>
                  <dt>Sign-in URL</dt>
                  <dd>
                    {safeUrl(credential.server_url) ? (
                      <a
                        href={safeUrl(credential.server_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {credential.server_url}
                      </a>
                    ) : (
                      'Not configured'
                    )}
                  </dd>
                </dl>
                <button
                  className="btn btn-small btn-quiet"
                  onClick={() => {
                    const text = `Username: ${credential.username}\nPassword: ${credential.password}${credential.server_url ? `\nJellyfin: ${credential.server_url}` : ''}`;
                    if (!navigator.clipboard?.writeText) {
                      notify(
                        'Clipboard access is unavailable. Select and copy the credential text manually.',
                        true,
                      );
                      return;
                    }
                    void navigator.clipboard
                      .writeText(text)
                      .then(() =>
                        notify('Credentials copied. Share them privately with the account holder.'),
                      )
                      .catch(() =>
                        notify(
                          'Clipboard access is unavailable. Select and copy the credential text manually.',
                          true,
                        ),
                      );
                  }}
                >
                  <Icon name="copy" />
                  Copy credentials
                </button>
              </section>
            ))}
          </>
        ) : (
          <Empty
            icon="key"
            title="No credentials available"
            text="These credentials may already have been revealed, expired, or no new accounts were created."
          />
        )}
      </Modal>
    );
  const event = dialog.event;
  const subscribe = event.action === 'subscribe';
  const titles: Record<string, string> = {
    subscribe: 'Process subscription',
    cancel: 'Process cancellation',
    expire: 'Process expiration',
  };
  return (
    <Modal
      title={titles[event.action] || 'Process event'}
      description={`${event.username || 'Discord member'} · ${event.discord_user_id || 'No Discord ID'}`}
      close={close}
      footer={
        <>
          <button className="btn btn-quiet" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => apply(event)}
            disabled={busy.has('event')}
          >
            {busy.has('event') ? <span className="spinner" /> : <Icon name="check" />}
            {busy.has('event')
              ? 'Applying…'
              : subscribe
                ? 'Apply subscription'
                : 'Disable account now'}
          </button>
        </>
      }
    >
      <Callout
        icon={subscribe ? 'userPlus' : 'warning'}
        warning={!subscribe}
        title={
          subscribe
            ? 'Create or link this member’s Jellyfin account.'
            : 'Disable the linked Jellyfin account now.'
        }
      >
        {subscribe
          ? 'Jellyport uses the Discord username for a new account, then preserves its linked username for future membership events.'
          : 'Approving this event manually disables access immediately, even when automatic disabling is off. The account, password, and watch history are preserved.'}
      </Callout>
      <p className="muted text-small">
        This event was received {date(event.created_at)} from {event.source || 'Discord'}. Review
        your membership settings before applying it.
      </p>
    </Modal>
  );
}
