import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { version as appVersion } from '../../package.json';
import { useClientLayout, useVisualViewport } from './client-layout';
import { navigateWorkspace, useWorkspaceRoute, workspaceRouteHash } from './routing';
import { WorkspaceDraftProvider } from './workspace-drafts';
import { WorkspaceNotice, WorkspaceNoticeProvider } from './workspace-notices';
import { jobOutcome, migrationReport, resultOutcome, MigrationCoverage } from './migration-outcome';
import {
  DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
  renderCredentialMessage,
} from '../../server/credential-message';
import {
  Callout,
  Empty,
  Icon,
  Issues,
  JobProgressDetails,
  Loading,
  Modal,
  Status,
  SourceSnapshotNote,
} from './components';
import SettingsPage from './SettingsPage';
import BotMessageHistoryPanel, { DiscordDeliverySummary } from './BotMessageHistoryPanel';
import AuthScreen from './AuthScreen';
import ChangelogDialog from './ChangelogDialog';
import UserMappingsPage from './UserMappingsPage';
import MigrationPreviewDialog from './MigrationPreviewDialog';
import AccountRolesPage from './AccountRolesPage';
import MemberManagementPage from './MemberManagementPage';
import UserDirectoryPage from './UserDirectoryPage';
import {
  AccountsPage,
  ActivityPage,
  MigratePage,
  OverviewPage,
  SubscriptionsPage,
} from './WorkspacePages';
import {
  activeJob,
  finishedJob,
  date,
  num,
  safeUrl,
  ApiResponseError,
  type Api,
  type ActivityFilter,
  type ActivityResults,
  type LiveOperations,
  type ApiOptions,
  type Credential,
  type Job,
  type Overview,
  type Page,
  type Preview,
  type PreviewTask,
  type Session,
  type Settings,
  type SubscriptionEvent,
  type Users,
  type UserMapping,
  type SourceSnapshotStatus,
  type HistoryCleanupResult,
} from './types';
import { WorkflowProvider } from './WorkflowRequirements';
import { operationPollDelay, readOperationStatus } from './operation-polling';

const pages: Record<Page, { title: string; icon: string }> = {
  overview: { title: 'Overview', icon: 'grid' },
  users: { title: 'Users', icon: 'users' },
  migrate: { title: 'Migrate users', icon: 'migrate' },
  mappings: { title: 'User mappings', icon: 'link' },
  roles: { title: 'Account roles', icon: 'shield' },
  accounts: { title: 'Create account', icon: 'userPlus' },
  memberships: { title: 'Memberships', icon: 'discord' },
  subscriptions: { title: 'Subscriptions', icon: 'inbox' },
  activity: { title: 'Activity', icon: 'activity' },
  settings: { title: 'Settings', icon: 'settings' },
};
const navigationGroups: { title: string; pages: Page[] }[] = [
  { title: 'People & access', pages: ['users', 'memberships'] },
  { title: 'Tasks', pages: ['overview', 'migrate', 'accounts', 'activity'] },
  { title: 'Configuration', pages: ['roles', 'mappings', 'settings'] },
];

function accountMessage(credential: Credential): string {
  if (credential.message) return credential.message;
  // Older retained credentials predate configurable messages. Never use a newly edited template.
  try {
    return renderCredentialMessage(DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE, {
      username: credential.username,
      password: credential.password,
      server_url: credential.server_url || 'Not configured',
    });
  } catch {
    // Keep legacy secrets recoverable even if their original values fail newer validation.
    return `Username: ${credential.username}\nPassword: ${credential.password}${credential.server_url ? `\nJellyfin: ${credential.server_url}` : ''}`;
  }
}
type CleanupCandidate = Pick<Job, 'id' | 'status' | 'created_at' | 'updated_at' | 'finished_at'>;
type Dialog =
  | {
      kind: 'preview';
      preview: Preview;
      previewId: string;
      reviewElapsedMs?: number;
      followUpJob?: string;
    }
  | { kind: 'job'; job: Job; submissionReceipt?: string }
  | { kind: 'reveal'; jobId: string }
  | { kind: 'credentials'; jobId: string; credentials: Credential[] }
  | { kind: 'changelog'; buildRevision?: string }
  | {
      kind: 'cleanup';
      candidates: CleanupCandidate[];
      filteredIds: string[];
      openedAt: number;
      single: boolean;
      filtered: boolean;
    }
  | { kind: 'event'; event: SubscriptionEvent };
interface Toast {
  id: number;
  message: string;
  error: boolean;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The operation could not be completed.';
const emptyUsers: Users = { emby: [], jellyfin: [] };
const pendingReceiptsKey = 'jellyport:pending-operation-receipts';
const legacyReceiptKeys = [
  'jellyport:pending-operation-receipt',
  'jellyport:pending-migration-receipt',
];
const opaqueReceipt = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const membershipAcceptPath = '/api/memberships/workflow/accept';
const receiptPaths = new Set([
  '/api/accounts',
  '/api/accounts/clone',
  '/api/accounts/recover',
  '/api/account-roles/apply',
  '/api/memberships/provision',
  membershipAcceptPath,
]);
function newSubmissionReceipt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function readPendingReceipts(): string[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(pendingReceiptsKey) ?? '[]');
    return Array.from(
      new Set(
        [
          ...(Array.isArray(saved) ? saved : []),
          ...legacyReceiptKeys.map((key) => sessionStorage.getItem(key)),
        ].filter(
          (value): value is string => typeof value === 'string' && opaqueReceipt.test(value),
        ),
      ),
    );
  } catch {
    return [];
  }
}
function storePendingReceipts(receipts: string[]) {
  try {
    if (receipts.length) sessionStorage.setItem(pendingReceiptsKey, JSON.stringify(receipts));
    else sessionStorage.removeItem(pendingReceiptsKey);
    for (const key of legacyReceiptKeys) sessionStorage.removeItem(key);
  } catch {
    // Receipt lookup still works until this page reloads when storage is disabled.
  }
}
const nextPreviewPoll = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Preview cancelled.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });

export default function App() {
  const { navigationDrawer, compactRecords } = useClientLayout();
  useVisualViewport();
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const authGeneration = useRef(0);
  const [booting, setBooting] = useState(true);
  const route = useWorkspaceRoute();
  const page = route.page;
  const pageRef = useRef(page);
  pageRef.current = page;
  const [loading, setLoading] = useState(false);
  const [loadedPage, setLoadedPage] = useState<Page | null>(null);
  const [pageError, setPageError] = useState('');
  const [loginError, setLoginError] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<Users>(emptyUsers);
  const lastMigrationRoster = useRef<Pick<Users, 'emby' | 'jellyfin'>>(emptyUsers);
  const migrationRosterVersion = useRef(0);
  const [migrationRosterPending, setMigrationRosterPending] = useState(false);
  const [migrationRosterError, setMigrationRosterError] = useState('');
  const [mappings, setMappings] = useState<UserMapping[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activityFilter, setActivityFilter] = useState<
    Omit<ActivityFilter, 'pageSize'> & { pageSize?: number }
  >({
    query: '',
    status: 'all',
    page: 1,
  });
  const activityPageSize = activityFilter.pageSize ?? (compactRecords ? 5 : 25);
  const activityScope = new URLSearchParams({
    limit: String(activityPageSize),
    offset: String((activityFilter.page - 1) * activityPageSize),
    status: activityFilter.status,
    query: activityFilter.query,
  }).toString();
  const activityScopeRef = useRef(activityScope);
  activityScopeRef.current = activityScope;
  const [activity, setActivity] = useState<{ scope: string; result: ActivityResults } | null>(null);
  const [activityPending, setActivityPending] = useState(false);
  const [activityError, setActivityError] = useState<{ scope: string; message: string } | null>(
    null,
  );
  const [activityRefresh, setActivityRefresh] = useState(0);
  const [live, setLive] = useState<LiveOperations | null>(null);
  const wakeOperations = useRef<() => void>(() => {});
  const [pendingReceipts, setPendingReceipts] = useState(readPendingReceipts);
  const pendingReceiptsRef = useRef(pendingReceipts);
  const pendingJobRequests = useRef(new Map<string, string>());
  const updatePendingReceipts = useCallback((receipts: string[]) => {
    storePendingReceipts(receipts);
    pendingReceiptsRef.current = receipts;
    setPendingReceipts(receipts);
  }, []);
  const rememberReceipt = useCallback(
    (value: string) => {
      if (!opaqueReceipt.test(value)) return;
      updatePendingReceipts([value, ...pendingReceiptsRef.current.filter((id) => id !== value)]);
    },
    [updatePendingReceipts],
  );
  const resolveReceipt = useCallback(
    (value: string) => {
      for (const [request, id] of pendingJobRequests.current)
        if (id === value) pendingJobRequests.current.delete(request);
      const remaining = pendingReceiptsRef.current.filter((id) => id !== value);
      updatePendingReceipts(remaining);
    },
    [updatePendingReceipts],
  );
  const [followUp, setFollowUp] = useState<{
    job_id: string;
    source_user_ids: string[];
    use_snapshots: boolean;
    migration_scope: 'played_favorites' | 'watched_only';
  } | null>(null);
  const historyRevision = useRef(0);
  const [events, setEvents] = useState<SubscriptionEvent[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [useSnapshots, setUseSnapshots] = useState(false);
  const [sourceDefaults, setSourceDefaults] = useState<'loading' | 'ready' | 'error'>('loading');
  const sourceChosen = useRef(false);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const openedReceipt = dialog?.kind === 'job' ? dialog.submissionReceipt : undefined;
  useEffect(() => {
    if (session?.authenticated && openedReceipt) resolveReceipt(openedReceipt);
  }, [openedReceipt, resolveReceipt, session?.authenticated]);
  const dialogVersion = useRef(0);
  const [busy, setBusy] = useState(new Set<string>());
  const busyRef = useRef(new Set<string>());
  const [previewProgress, setPreviewProgress] = useState<PreviewTask['progress'] | null>(null);
  const previewRun = useRef<{ controller: AbortController; cancel: () => void } | null>(null);
  const readyPreview = useRef<{ id: string; cancel: () => void } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!navigationDrawer) setMobileOpen(false);
  }, [navigationDrawer]);
  useEffect(() => {
    if (!mobileOpen || !navigationDrawer || !session?.authenticated) return;
    document.body.classList.add('navigation-open');
    const buttons = () =>
      Array.from(
        navigation.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      );
    (
      navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]') ?? buttons()[0]
    )?.focus();
    const closeNavigation = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key === 'Tab') {
        const controls = buttons();
        const first = controls[0];
        const last = controls.at(-1);
        const outside = !navigation.current?.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || outside)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || outside)) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', closeNavigation);
    return () => {
      document.body.classList.remove('navigation-open');
      window.removeEventListener('keydown', closeNavigation);
      mobileToggle.current?.focus();
    };
  }, [mobileOpen, navigationDrawer, session?.authenticated]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const loadVersion = useRef(0);
  const [pollPaused, setPollPaused] = useState(false);
  const settingsSaveOwner = useRef<symbol | null>(null);
  const [settingsSavePending, setSettingsSavePending] = useState(false);
  const [memberHandoff, setMemberHandoff] = useState<{
    id: string;
    username: string;
    tier_id?: string;
    stripe_price_review_event_id?: string;
    key: number;
  }>();
  const notify = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts([{ id, message: text, error }]);
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
  const releaseReadyPreview = useCallback(() => {
    const ready = readyPreview.current;
    readyPreview.current = null;
    ready?.cancel();
  }, []);
  const closeDialog = useCallback(
    (force = false) => {
      if (!force && busyRef.current.has('reveal')) return;
      releaseReadyPreview();
      dialogVersion.current++;
      dialogRef.current = null;
      setDialog(null);
    },
    [releaseReadyPreview],
  );
  const showDialog = useCallback(
    (next: Dialog) => {
      if (busyRef.current.has('reveal') && next.kind !== 'credentials') return;
      releaseReadyPreview();
      dialogVersion.current++;
      // An async result can arrive after navigation opens. Only one overlay may
      // own focus and scrolling; release the drawer before mounting its dialog.
      setMobileOpen(false);
      dialogRef.current = next;
      setDialog(next);
    },
    [releaseReadyPreview],
  );
  useEffect(() => {
    const discardView = (event: PageTransitionEvent) => {
      if (event.persisted && ['credentials', 'reveal'].includes(dialogRef.current?.kind ?? ''))
        closeDialog(true);
    };
    window.addEventListener('pageshow', discardView);
    return () => window.removeEventListener('pageshow', discardView);
  }, [closeDialog]);
  const cancelPreview = useCallback(() => {
    const run = previewRun.current;
    if (!run) return;
    previewRun.current = null;
    run.controller.abort();
    run.cancel();
    setPreviewProgress(null);
    busyRef.current.delete('preview');
    setBusy(new Set(busyRef.current));
  }, []);
  useEffect(
    () => () => {
      cancelPreview();
      releaseReadyPreview();
    },
    [cancelPreview, releaseReadyPreview],
  );
  const clearSession = useCallback(() => {
    authGeneration.current++;
    loadVersion.current++;
    sessionRef.current = null;
    cancelPreview();
    setSession(null);
    setLoadedPage(null);
    setOverview(null);
    setUsers(emptyUsers);
    lastMigrationRoster.current = emptyUsers;
    migrationRosterVersion.current++;
    setMigrationRosterPending(false);
    setMigrationRosterError('');
    setMappings([]);
    setMemberHandoff(undefined);
    setSettings(null);
    settingsSaveOwner.current = null;
    setSettingsSavePending(false);
    setActivity(null);
    setActivityError(null);
    setActivityPending(false);
    setActivityFilter({ query: '', status: 'all', page: 1 });
    setLive(null);
    updatePendingReceipts([]);
    pendingJobRequests.current.clear();
    setFollowUp(null);
    setEvents([]);
    setSelected(new Set());
    setUseSnapshots(false);
    sourceChosen.current = false;
    setSourceDefaults('loading');
    setSearch('');
    setToasts([]);
    setMobileOpen(false);
    closeDialog(true);
  }, [cancelPreview, closeDialog, updatePendingReceipts]);
  const acceptSession = useCallback((value: Session) => {
    sessionRef.current = value;
    setSession(value);
  }, []);
  const api: Api = useCallback(
    async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
      const savingSettings = path === '/api/settings' && options.method === 'PUT';
      if (savingSettings && settingsSaveOwner.current)
        throw new Error(
          'A settings save is still in progress. Wait for it to finish before saving another draft.',
        );
      const owner = savingSettings ? Symbol('settings-save') : null;
      if (owner) {
        settingsSaveOwner.current = owner;
        setSettingsSavePending(true);
      }
      try {
        const generation = authGeneration.current;
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (options.method && options.method !== 'GET' && sessionRef.current?.csrf_token)
          headers['X-CSRF-Token'] = sessionRef.current.csrf_token;
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        let submission: string | undefined;
        if (options.method === 'POST' && body && receiptPaths.has(path)) {
          const request = `${path}\n${body}`;
          submission = pendingJobRequests.current.get(request) ?? newSubmissionReceipt();
          pendingJobRequests.current.set(request, submission);
          headers['X-Jellyport-Submission'] = submission;
          rememberReceipt(submission);
        }
        const recoverableSubmission =
          submission !== undefined || (options.method === 'POST' && path === '/api/migrations');
        let response: Response;
        try {
          response = await fetch(path, {
            ...options,
            headers,
            credentials: 'same-origin',
            body,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          throw new Error(
            recoverableSubmission
              ? 'Could not reach Jellyport. Find the operation in Activity.'
              : 'Could not reach Jellyport. Check that the application is running and try again.',
          );
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          if (response.ok) {
            // A reload can cancel body reading after successful response headers.
            // Never turn an unreadable success into a fabricated typed object.
            if (error instanceof Error && error.name === 'AbortError') throw error;
            throw new Error(
              recoverableSubmission
                ? 'Jellyport’s response could not be read. Find the operation in Activity.'
                : 'Jellyport’s response could not be read. Refresh to check its status before retrying.',
            );
          }
          // Failed responses can have empty/non-JSON bodies; keep their status and
          // authentication handling without exposing a raw parser/body diagnostic.
          data = {};
        }
        if (generation !== authGeneration.current)
          throw new Error(
            'This request belongs to a previous session. Sign in and refresh to see its status.',
          );
        if (!response.ok) {
          if (response.status === 401 && path !== '/api/login' && path !== '/api/setup/connect')
            clearSession();
          if (submission && [400, 403, 422, 429].includes(response.status))
            resolveReceipt(submission);
          const body =
            data && typeof data === 'object'
              ? (data as { detail?: unknown; error?: unknown; message?: unknown })
              : {};
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
          throw new ApiResponseError(
            typeof detail === 'string' ? detail : `Request failed (${response.status}).`,
            response.status,
            data,
          );
        }
        if (
          submission &&
          data &&
          typeof data === 'object' &&
          (('id' in data && typeof data.id === 'string') ||
            (path === membershipAcceptPath && 'job' in data))
        ) {
          resolveReceipt(submission);
        }
        return data as T;
      } finally {
        if (owner && settingsSaveOwner.current === owner) {
          settingsSaveOwner.current = null;
          setSettingsSavePending(false);
        }
      }
    },
    [clearSession, rememberReceipt, resolveReceipt],
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
  useEffect(() => {
    if (page !== 'migrate' || !session?.authenticated) return;
    const controller = new AbortController();
    if (!sourceChosen.current) setSourceDefaults('loading');
    void api<SourceSnapshotStatus>('/api/source-snapshots', { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted || sourceChosen.current) return;
        if (
          !value ||
          value.history_source_known === false ||
          !Number.isSafeInteger(value.snapshots) ||
          value.snapshots < 0 ||
          !Array.isArray(value.records) ||
          ![undefined, 'sqlite_online_backup', 'file_copy', 'plugin_backup'].includes(
            value.capture_method,
          )
        )
          throw new Error('Unsupported history source settings.');
        setUseSnapshots(value.capture_method === 'plugin_backup');
        setSourceDefaults('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted && !sourceChosen.current) setSourceDefaults('error');
      });
    return () => controller.abort();
  }, [api, page, session?.authenticated]);
  function chooseHistorySource(saved: boolean) {
    sourceChosen.current = true;
    setUseSnapshots(saved);
    setSourceDefaults('ready');
  }
  const refreshMigrationRoster = useCallback(
    async (signal?: AbortSignal) => {
      if (pageRef.current !== 'migrate' || !sessionRef.current?.authenticated) return;
      const version = ++migrationRosterVersion.current;
      setMigrationRosterPending(true);
      const current = () =>
        !signal?.aborted &&
        version === migrationRosterVersion.current &&
        pageRef.current === 'migrate' &&
        !!sessionRef.current?.authenticated;
      try {
        const listed = await api<Users>('/api/users', { signal });
        if (!current()) return false;
        if (!listed.errors?.emby) {
          const available = new Set(listed.emby.map(({ Id }) => Id));
          setSelected((selection) => new Set([...selection].filter((id) => available.has(id))));
        }
        lastMigrationRoster.current = {
          emby: listed.errors?.emby ? lastMigrationRoster.current.emby : listed.emby,
          jellyfin: listed.errors?.jellyfin
            ? lastMigrationRoster.current.jellyfin
            : listed.jellyfin,
        };
        setUsers({ ...listed, ...lastMigrationRoster.current });
        setMigrationRosterError('');
        return !listed.errors?.emby && !listed.errors?.jellyfin;
      } catch (error) {
        if (current()) {
          setUsers((previous) => ({ ...previous, ...lastMigrationRoster.current }));
          setMigrationRosterError(message(error));
        }
        return false;
      } finally {
        if (current()) setMigrationRosterPending(false);
      }
    },
    [api],
  );
  const load = useCallback(
    async (target: Page, manual = false) => {
      if (target !== pageRef.current) return;
      const version = ++loadVersion.current;
      const historyVersion = historyRevision.current;
      if (target !== 'activity') setLoading(true);
      setPageError('');
      setPollPaused(false);
      if (manual) notify('Refreshing workspace…');
      let complete = true;
      try {
        if (target === 'overview') {
          const value = await api<Overview>(manual ? '/api/overview?fresh=1' : '/api/overview');
          if (version === loadVersion.current && historyVersion === historyRevision.current)
            setOverview(value);
        } else if (target === 'migrate') {
          const [, summary] = await Promise.all([
            refreshMigrationRoster(),
            api<Overview>('/api/overview'),
          ]);
          if (version === loadVersion.current) setOverview(summary);
        } else if (target === 'roles') {
          const [listed, configuration] = await Promise.all([
            api<Users>('/api/users'),
            api<Settings>('/api/settings'),
          ]);
          if (version === loadVersion.current) {
            setUsers(listed);
            setSettings(configuration);
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
        } else if (target === 'memberships' || target === 'users') {
          const value = await api<Settings>('/api/settings');
          if (version === loadVersion.current) setSettings(value);
          if (target === 'memberships') {
            const listed = await api<{ events: SubscriptionEvent[] }>('/api/subscriptions');
            if (version === loadVersion.current) setEvents(listed.events || []);
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
          setActivityRefresh((current) => current + 1);
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
            complete = false;
            if (sessionRef.current?.authenticated && version === loadVersion.current)
              notify(`Template users could not be loaded: ${message(error)}`, true);
          }
          if (version === loadVersion.current) {
            setSettings(value);
            setUsers(listed);
          }
        }
        if (
          manual &&
          complete &&
          version === loadVersion.current &&
          sessionRef.current?.authenticated
        )
          notify('Workspace refreshed.');
      } catch (error) {
        if (version === loadVersion.current && sessionRef.current?.authenticated) {
          setPageError(message(error));
          if (manual) notify(message(error), true);
        }
      } finally {
        if (version === loadVersion.current) {
          setLoadedPage(target);
          setLoading(false);
        }
      }
    },
    [api, notify, refreshMigrationRoster],
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
    if (target !== 'migrate') cancelPreview();
    closeDialog();
    setMobileOpen(false);
    if (target === 'subscriptions') {
      navigateWorkspace({ page: 'memberships', tab: 'events' });
      if (page === 'memberships') void load('memberships');
    } else if (target === page) void load(target);
    else {
      setLoading(true);
      navigateWorkspace({ page: target });
    }
  }
  const previousRoute = useRef(workspaceRouteHash(route));
  const routeHash = workspaceRouteHash(route);
  useEffect(() => {
    if (previousRoute.current === routeHash) return;
    previousRoute.current = routeHash;
    if (page !== 'migrate') cancelPreview();
    closeDialog();
    setMobileOpen(false);
  }, [routeHash, page, cancelPreview, closeDialog]);
  const hasActive = !!live?.active_count || (dialog?.kind === 'job' && activeJob(dialog.job));
  useEffect(() => {
    if (!session?.authenticated || page !== 'activity') return;
    const controller = new AbortController();
    const { page: index } = activityFilter;
    setActivityPending(true);
    setActivityError(null);
    void readOperationStatus<ActivityResults>(api, `/api/jobs?${activityScope}`, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || activityScopeRef.current !== activityScope) return;
        const lastPage = Math.max(1, Math.ceil(result.total / activityPageSize));
        if (index > lastPage) setActivityFilter((current) => ({ ...current, page: lastPage }));
        else setActivity({ scope: activityScope, result });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setActivityError({ scope: activityScope, message: message(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setActivityPending(false);
      });
    return () => controller.abort();
  }, [
    activityScope,
    activityFilter.page,
    activityPageSize,
    activityRefresh,
    api,
    page,
    session?.authenticated,
  ]);
  useEffect(() => {
    if (
      !session?.authenticated ||
      page !== 'overview' ||
      loadedPage !== 'overview' ||
      loading ||
      pageError
    )
      return;
    const controller = new AbortController();
    const interval = 30_000;
    let nextAt = Date.now() + interval;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (polling || document.hidden || controller.signal.aborted) return;
      polling = true;
      nextAt = Date.now() + interval;
      const load = loadVersion.current;
      const history = historyRevision.current;
      try {
        const result = await readOperationStatus<Pick<Overview, 'inbox' | 'backup_verification'>>(
          api,
          '/api/overview/inbox',
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          pageRef.current !== 'overview' ||
          load !== loadVersion.current ||
          history !== historyRevision.current ||
          !Array.isArray(result?.inbox)
        )
          return;
        setOverview((current) => (current ? { ...current, ...result } : current));
      } catch {
        // Keep the last successful inbox and retry on the next bounded check.
      } finally {
        polling = false;
        schedule();
      }
    }
    function schedule() {
      clearTimeout(timer);
      if (!polling && !document.hidden && !controller.signal.aborted)
        timer = setTimeout(() => void poll(), Math.max(0, nextAt - Date.now()));
    }
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [api, loadedPage, loading, page, pageError, session?.authenticated]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const controller = new AbortController();
    let polling = false;
    let wakePending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let previous: LiveOperations | undefined;
    let reportRevision = '';
    const displayedJob = () => {
      const current = dialogRef.current;
      return current?.kind === 'job' && activeJob(current.job) ? current.job : undefined;
    };
    const poll = async () => {
      if (polling || document.hidden || controller.signal.aborted) return;
      polling = true;
      const revision = historyRevision.current;
      try {
        const next = await readOperationStatus<LiveOperations>(
          api,
          '/api/jobs/live',
          controller.signal,
        );
        if (controller.signal.aborted || revision !== historyRevision.current) return;
        if (
          !Array.isArray(next?.active) ||
          !Array.isArray(next.recent) ||
          typeof next.revision !== 'string' ||
          !Number.isSafeInteger(next.active_count)
        )
          throw new Error('Operation status is unavailable.');
        if (previous && previous.revision !== next.revision && pageRef.current === 'activity')
          setActivityRefresh((current) => current + 1);
        const finished = previous?.active.some((job) =>
          next.recent.some((item) => item.id === job.id && !activeJob(item)),
        );
        previous = next;
        setLive(next);
        setOverview((current) =>
          current
            ? {
                ...current,
                counts: { ...current.counts, jobs: next.total },
                recent_jobs: next.recent,
              }
            : current,
        );
        if (finished && pageRef.current === 'migrate')
          void refreshMigrationRoster(controller.signal);

        const current = displayedJob();
        const version = dialogVersion.current;
        const reportKey = `${version}:${next.revision}`;
        if (current && reportRevision !== reportKey) {
          const id = encodeURIComponent(current.id);
          const summary =
            next.active.find((job) => job.id === current.id) ??
            next.recent.find((job) => job.id === current.id) ??
            (await readOperationStatus<Job>(api, `/api/jobs/${id}/summary`, controller.signal));
          const sameRows =
            JSON.stringify(
              current.results?.map(({ username, status }) => ({ username, status })) ?? [],
            ) === JSON.stringify(summary.results ?? []);
          const job =
            activeJob(summary) && sameRows
              ? {
                  ...current,
                  status: summary.status,
                  progress: summary.progress,
                  updated_at: summary.updated_at,
                  cancel_requested: summary.cancel_requested,
                }
              : await readOperationStatus<Job>(api, `/api/jobs/${id}`, controller.signal);
          if (!controller.signal.aborted && version === dialogVersion.current) {
            setDialog((current) =>
              current?.kind === 'job' && current.job.id === job.id ? { ...current, job } : current,
            );
            reportRevision = reportKey;
          }
        }
        failures = 0;
        setPollPaused(false);
      } catch {
        if (!controller.signal.aborted && sessionRef.current?.authenticated) {
          failures++;
          setPollPaused(true);
        }
      } finally {
        polling = false;
        if (!controller.signal.aborted && !document.hidden) {
          const wait = wakePending
            ? 0
            : operationPollDelay(!!previous?.active_count || !!displayedJob(), failures);
          wakePending = false;
          timer = setTimeout(() => void poll(), wait);
        }
      }
    };
    const wake = () => {
      clearTimeout(timer);
      if (polling) wakePending = true;
      else void poll();
    };
    wakeOperations.current = wake;
    wake();
    document.addEventListener('visibilitychange', wake);
    return () => {
      controller.abort();
      clearTimeout(timer);
      wakeOperations.current = () => {};
      document.removeEventListener('visibilitychange', wake);
    };
  }, [api, refreshMigrationRoster, session?.authenticated]);
  const created = (job: Job) => {
    setLive((current) =>
      current && activeJob(job)
        ? {
            ...current,
            active: [job, ...current.active.filter((item) => item.id !== job.id)].slice(0, 12),
            active_count:
              current.active_count + Number(!current.active.some((item) => item.id === job.id)),
          }
        : current,
    );
    setActivityRefresh((current) => current + 1);
    showDialog({ kind: 'job', job });
    if (activeJob(job)) wakeOperations.current();
  };
  const openJob = (
    id: string,
    {
      activityRowScope,
      submissionReceipt,
    }: { activityRowScope?: string; submissionReceipt?: string } = {},
  ) => {
    const version = dialogVersion.current;
    const generation = authGeneration.current;
    return work('job', async () => {
      const value = await readOperationStatus<Job>(api, `/api/jobs/${encodeURIComponent(id)}`);
      if (
        version !== dialogVersion.current ||
        generation !== authGeneration.current ||
        !sessionRef.current?.authenticated ||
        (activityRowScope !== undefined &&
          (pageRef.current !== 'activity' || activityRowScope !== activityScopeRef.current))
      )
        return;
      if (value?.id !== id) throw new Error('Jellyport returned a different operation report.');
      showDialog({ kind: 'job', job: value, submissionReceipt });
      if (activeJob(value)) wakeOperations.current();
      setPollPaused(false);
    });
  };
  function preview(
    sourceUserIds = [...selected],
    savedSource = useSnapshots,
    scope: 'played_favorites' | 'watched_only' = 'played_favorites',
    followUpJob?: string,
  ) {
    if (busyRef.current.has('preview')) return;
    if (!sourceChosen.current && sourceDefaults !== 'ready') {
      notify('Choose a history source before preparing a migration preview.', true);
      return;
    }
    if (sourceUserIds.length > 100) {
      notify('Select up to 100 users for one migration.', true);
      return;
    }
    const generation = authGeneration.current;
    releaseReadyPreview();
    const controller = new AbortController();
    let taskId = '';
    let retainedForApproval = false;
    let cancellationSent = false;
    const run = {
      controller,
      cancel: () => {
        const current = sessionRef.current;
        if (
          !taskId ||
          cancellationSent ||
          !current?.authenticated ||
          generation !== authGeneration.current
        )
          return;
        cancellationSent = true;
        // Cancellation must not restore UI or clear a newer session if this component has gone away.
        void fetch(`/api/migrations/preview/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json', 'X-CSRF-Token': current.csrf_token },
          credentials: 'same-origin',
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      },
    };
    const active = () =>
      previewRun.current === run &&
      !controller.signal.aborted &&
      generation === authGeneration.current &&
      !!sessionRef.current?.authenticated &&
      pageRef.current === 'migrate';
    previewRun.current = run;
    busyRef.current.add('preview');
    setBusy(new Set(busyRef.current));
    setPreviewProgress({ processed: 0, total: sourceUserIds.length });
    void (async () => {
      try {
        let task = await api<PreviewTask>('/api/migrations/preview', {
          method: 'POST',
          body: {
            source_user_ids: sourceUserIds,
            migration_scope: scope,
            ...(followUpJob ? { follow_up_job_id: followUpJob } : {}),
            ...(savedSource ? { use_snapshots: true } : {}),
          },
          // Receive the task ID even if the user leaves while this short request is in flight.
          // Polling is independently abortable, and an abandoned task is cancelled below.
        });
        taskId = task.id;
        if (!active()) {
          run.cancel();
          return;
        }
        while (task.status === 'running') {
          setPreviewProgress(task.progress);
          await nextPreviewPoll(controller.signal);
          if (!active()) return;
          task = await readOperationStatus<PreviewTask>(
            api,
            `/api/migrations/preview/${encodeURIComponent(taskId)}`,
            controller.signal,
          );
          if (!active()) return;
        }
        if (task.status === 'failed')
          throw new Error(task.error || 'The migration preview could not be completed. Try again.');
        if (task.status !== 'ready' || !task.preview?.users?.length)
          throw new Error(
            'No users were returned for this preview. Reload the Emby user list and try again.',
          );
        if (
          savedSource &&
          (!task.preview.source_snapshot_ids ||
            Object.keys(task.preview.source_snapshot_ids).length !== task.preview.users.length ||
            task.preview.users.some((user) => {
              const pins = task.preview!.source_snapshot_ids!;
              return (
                !Object.hasOwn(pins, user.source_user_id) ||
                typeof pins[user.source_user_id] !== 'string' ||
                !pins[user.source_user_id]
              );
            }))
        )
          throw new Error(
            'The saved snapshot preview is incomplete. Refresh saved snapshots in Settings or choose live Emby reads.',
          );
        showDialog({
          kind: 'preview',
          previewId: task.id,
          reviewElapsedMs: task.elapsed_ms,
          followUpJob,
          preview: {
            ...task.preview,
            // Preserve an older review's played-only approval; favorites require a current review.
            migration_scope:
              task.preview.migration_scope === 'played_favorites'
                ? 'played_favorites'
                : 'watched_only',
            ...(task.preview.source_snapshot_ids
              ? { source_snapshot_ids: { ...task.preview.source_snapshot_ids } }
              : {}),
          },
        });
        readyPreview.current = { id: task.id, cancel: run.cancel };
        retainedForApproval = true;
      } catch (error) {
        if (active()) notify(message(error), true);
      } finally {
        // Ready reviews remain available for server-validated acceptance; abandoned work is released.
        if (!retainedForApproval) run.cancel();
        if (previewRun.current === run) {
          previewRun.current = null;
          setPreviewProgress(null);
          busyRef.current.delete('preview');
          setBusy(new Set(busyRef.current));
        }
      }
    })();
  }
  useEffect(() => {
    if (!followUp || page !== 'migrate' || loadedPage !== 'migrate' || loading) return;
    setFollowUp(null);
    setSelected(new Set(followUp.source_user_ids));
    chooseHistorySource(followUp.use_snapshots);
    preview(
      followUp.source_user_ids,
      followUp.use_snapshots,
      followUp.migration_scope,
      followUp.job_id,
    );
  }, [followUp, page, loadedPage, loading]);
  function reviewFollowUp(id: string) {
    const version = dialogVersion.current;
    void work('follow-up', async () => {
      const result = await api<Omit<NonNullable<typeof followUp>, 'job_id'>>(
        `/api/jobs/${encodeURIComponent(id)}/follow-up`,
      );
      if (version !== dialogVersion.current || !sessionRef.current?.authenticated) return;
      navigate('migrate');
      setFollowUp({ ...result, job_id: id });
    });
  }
  function findSubmission(receipt: string) {
    const version = dialogVersion.current;
    void work('receipt', async () => {
      const result = await readOperationStatus<{ job_id: string }>(
        api,
        `/api/jobs/receipts/${encodeURIComponent(receipt)}`,
      );
      if (
        version !== dialogVersion.current ||
        pageRef.current !== 'activity' ||
        !sessionRef.current?.authenticated
      )
        return;
      if (typeof result?.job_id !== 'string' || !result.job_id)
        throw new Error('The operation receipt could not be resolved.');
      await openJob(result.job_id, { submissionReceipt: receipt });
    });
  }
  function refreshPreview() {
    if (dialog?.kind !== 'preview' || busyRef.current.has('migration')) return;
    const ids = dialog.preview.users.map((user) => user.source_user_id);
    const saved = !!dialog.preview.source_snapshot_ids;
    const scope =
      dialog.preview.migration_scope === 'played_favorites' ? 'played_favorites' : 'watched_only';
    const originalJob = dialog.followUpJob;
    closeDialog();
    setSelected(new Set(ids));
    chooseHistorySource(saved);
    preview(ids, saved, scope, originalJob);
  }
  function startMigration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dialog?.kind !== 'preview') return;
    const values = new FormData(event.currentTarget);
    const recipients: Record<string, string> = {};
    const membershipSlots: Record<string, number> = {};
    const membershipReviewTokens: Record<string, string> = {};
    const accountReviewTokens: Record<string, string> = {};
    const mappingRevisions: Record<string, string | null> = {};
    dialog.preview.users.forEach((user) => {
      const accountToken = String(values.get(`account-review-${user.source_user_id}`) || '').trim();
      if (accountToken && !user.history_only)
        accountReviewTokens[user.source_user_id] = accountToken;
      const value = user.history_only
        ? ''
        : String(
            values.get(user.source_user_id) || values.get(`manual-${user.source_user_id}`) || '',
          ).trim();
      if (value) {
        recipients[user.source_user_id] = value;
        const token = String(values.get(`membership-review-${value}`) || '').trim();
        if (token) membershipReviewTokens[value] = token;
        const locked = !!user.discord_user_id && (!!user.mapping_id || !!user.owner_basis);
        const slot = Number(values.get(`slot-${user.source_user_id}`));
        if (!locked && [1, 2, 3].includes(slot)) membershipSlots[user.source_user_id] = slot;
      }
      if (user.mapping_revision !== undefined)
        mappingRevisions[user.source_user_id] = user.mapping_revision;
    });
    const ids = dialog.preview.users.map((user) => user.source_user_id);
    void work('migration', async () => {
      rememberReceipt(dialog.previewId);
      const job = await api<Job>('/api/migrations', {
        method: 'POST',
        body: {
          source_user_ids: ids,
          preview_id: dialog.previewId,
          submission_receipt: dialog.previewId,
          migration_scope:
            dialog.preview.migration_scope === 'played_favorites'
              ? 'played_favorites'
              : 'watched_only',
          ...(dialog.preview.source_snapshot_ids
            ? { source_snapshot_ids: dialog.preview.source_snapshot_ids }
            : {}),
          discord_recipients: recipients,
          ...(Object.keys(membershipSlots).length ? { membership_slots: membershipSlots } : {}),
          ...(Object.keys(membershipReviewTokens).length
            ? { membership_review_tokens: membershipReviewTokens }
            : {}),
          ...(Object.keys(accountReviewTokens).length
            ? { account_review_tokens: accountReviewTokens }
            : {}),
          ...(Object.keys(mappingRevisions).length ? { mapping_revisions: mappingRevisions } : {}),
        },
      });
      resolveReceipt(dialog.previewId);
      // The accepted job now owns its trusted review metadata and any selected snapshot pins.
      if (readyPreview.current?.id === dialog.previewId) readyPreview.current = null;
      setSelected(new Set());
      created(job);
      notify('Migration started. You can follow its progress here.');
    });
  }
  function cancelJob(id: string) {
    void work(`cancel-job-${id}`, async () => {
      const job = await api<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: {},
      });
      setActivityRefresh((current) => current + 1);
      setOverview((current) =>
        current
          ? {
              ...current,
              recent_jobs: current.recent_jobs.map((item) => (item.id === id ? job : item)),
            }
          : current,
      );
      setDialog((current) =>
        current?.kind === 'job' && current.job.id === id ? { ...current, job } : current,
      );
      setPollPaused(false);
      notify(
        job.status === 'canceled'
          ? 'Job canceled. Completed changes are kept; review results before rerunning.'
          : 'Cancellation requested. Completed changes are kept; review results before rerunning.',
      );
    });
  }
  function reveal(id: string) {
    const version = dialogVersion.current;
    void work('reveal', async () => {
      const result = await api<{ credentials: Credential[] }>(
        `/api/jobs/${encodeURIComponent(id)}/credentials`,
        { method: 'POST', body: { recoverable: true }, signal: AbortSignal.timeout(30_000) },
      );
      if (version === dialogVersion.current)
        showDialog({ kind: 'credentials', jobId: id, credentials: result.credentials || [] });
    });
  }
  function dismissDialog() {
    const current = dialogRef.current;
    if (busyRef.current.has('reveal')) return;
    closeDialog();
    if (current?.kind === 'credentials' && current.credentials.length)
      void api(`/api/jobs/${encodeURIComponent(current.jobId)}/credentials/receipt`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {
        // A receipt whose acknowledgment was lost still expires on the server.
      });
  }
  function reviewHistory(
    _filteredIds: string[],
    filtered = false,
    single?: Job,
    rowScope?: string,
  ) {
    if (
      rowScope !== undefined &&
      (pageRef.current !== 'activity' || rowScope !== activityScopeRef.current)
    )
      return;
    if (single) {
      showDialog({
        kind: 'cleanup',
        candidates: [single],
        filteredIds: [single.id],
        openedAt: Date.now(),
        single: true,
        filtered: true,
      });
      return;
    }
    const version = dialogVersion.current;
    void work('cleanup-review', async () => {
      const params = new URLSearchParams({
        query: activityFilter.query,
        status: activityFilter.status,
      });
      const review = await api<{ all: CleanupCandidate[]; filtered: CleanupCandidate[] }>(
        `/api/jobs/cleanup-review?${params}`,
      );
      if (
        version !== dialogVersion.current ||
        !sessionRef.current?.authenticated ||
        (rowScope !== undefined &&
          (pageRef.current !== 'activity' || rowScope !== activityScopeRef.current))
      )
        return;
      const candidates = new Map([...review.all, ...review.filtered].map((job) => [job.id, job]));
      showDialog({
        kind: 'cleanup',
        candidates: [...candidates.values()],
        filteredIds: review.filtered.map((job) => job.id),
        openedAt: Date.now(),
        single: false,
        filtered,
      });
    });
  }
  async function cleanupHistory(ids: string[]): Promise<HistoryCleanupResult | undefined> {
    const version = dialogVersion.current;
    const generation = authGeneration.current;
    const result = await api<HistoryCleanupResult>('/api/jobs/cleanup', {
      method: 'POST',
      body: { job_ids: ids },
    });
    if (version !== dialogVersion.current || generation !== authGeneration.current) return;
    const requested = new Set(ids);
    const removed = new Set(result.removed_ids.filter((id) => requested.has(id)));
    historyRevision.current++;
    setActivity((current) =>
      current
        ? {
            ...current,
            result: {
              ...current.result,
              jobs: current.result.jobs.filter((job) => !removed.has(job.id)),
            },
          }
        : current,
    );
    setActivityRefresh((current) => current + 1);
    setOverview((current) =>
      current
        ? {
            ...current,
            counts: {
              ...current.counts,
              jobs: Math.max(0, (current.counts.jobs ?? 0) - removed.size),
            },
            recent_jobs: current.recent_jobs.filter((job) => !removed.has(job.id)),
          }
        : current,
    );
    setEvents((current) =>
      current.map((event) => {
        if (!event.job_id || !removed.has(event.job_id)) return event;
        const { job_id: _jobId, ...retained } = event;
        return { ...retained, report_cleared: true };
      }),
    );
    return {
      removed_ids: [...removed],
      skipped: result.skipped.filter((item) => requested.has(item.id)),
    };
  }
  function logout() {
    cancelPreview();
    releaseReadyPreview();
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
      try {
        const result = await api<SubscriptionEvent>(
          `/api/subscriptions/${encodeURIComponent(event.id)}/apply`,
          { method: 'POST', body: {} },
        );
        closeDialog();
        notify(
          result.status === 'failed'
            ? result.error || 'The subscription event could not be applied.'
            : result.status === 'canceled'
              ? 'Subscription work was canceled. Review the linked operation for completed changes.'
              : result.status === 'processing'
                ? 'Subscription processing is in progress. Follow its operation before retrying.'
                : result.status === 'applied'
                  ? 'Subscription event applied.'
                  : 'Subscription event status refreshed.',
          result.status === 'failed',
        );
      } finally {
        // A failed request can still have created a durable operation to inspect.
        await load('memberships');
      }
    });
  }
  function reviewSubscription(event: SubscriptionEvent) {
    if (event.stripe_price_review_required && event.discord_user_id) {
      setMemberHandoff({
        id: event.discord_user_id,
        username: event.username || event.discord_user_id,
        tier_id: event.tier_id,
        stripe_price_review_event_id: event.id,
        key: Date.now(),
      });
      navigate('memberships');
    } else showDialog({ kind: 'event', event });
  }
  function ignore(event: SubscriptionEvent) {
    void work('event', async () => {
      await api(`/api/subscriptions/${encodeURIComponent(event.id)}/ignore`, {
        method: 'POST',
        body: {},
      });
      notify('Subscription event ignored.');
      await load('memberships');
    });
  }
  let content;
  if (loading || loadedPage !== page) content = <Loading />;
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
          <button className="btn" onClick={() => void load(page, true)}>
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
        refresh={() => void load(page, true)}
      />
    );
  else if (page === 'migrate' && overview)
    content = (
      <>
        {sourceDefaults !== 'ready' && !sourceChosen.current && (
          <div className="mb-17" role={sourceDefaults === 'error' ? 'alert' : 'status'}>
            <Callout
              warning={sourceDefaults === 'error'}
              title={
                sourceDefaults === 'error'
                  ? 'History source settings could not be loaded.'
                  : 'Checking history source settings…'
              }
            >
              Choose a source explicitly to continue. Saved history avoids a live Emby catalog read;
              missing or expired saved data stops the preview.
              <div className="button-row mt-12">
                <button className="btn btn-quiet" onClick={() => chooseHistorySource(true)}>
                  Use saved history
                </button>
                <button className="btn btn-quiet" onClick={() => chooseHistorySource(false)}>
                  Use live Emby reads
                </button>
              </div>
            </Callout>
          </div>
        )}
        <MigratePage
          users={users}
          overview={overview}
          selected={selected}
          select={setSelected}
          search={search}
          setSearch={setSearch}
          preview={() => preview()}
          useSnapshots={useSnapshots}
          setUseSnapshots={chooseHistorySource}
          busy={busy.has('preview')}
          navigate={navigate}
          refreshRoster={refreshMigrationRoster}
          rosterPending={migrationRosterPending}
          rosterError={migrationRosterError}
        />
      </>
    );
  else if (page === 'mappings')
    content = (
      <UserMappingsPage
        mappings={mappings}
        users={users}
        templateUserId={settings?.template_user_id}
        accountNaming={settings ?? {}}
        api={api}
        notify={notify}
        refresh={(manual) => load('mappings', manual)}
      />
    );
  else if (page === 'roles')
    content = (
      <AccountRolesPage
        users={users}
        api={api}
        notify={notify}
        created={created}
        templateUserId={settings?.template_user_id}
        defaultRoleId={settings?.default_role_id}
      />
    );
  else if (page === 'users' && settings)
    content = (
      <UserDirectoryPage
        settings={settings}
        api={api}
        notify={notify}
        navigate={navigate}
        created={created}
        onMigrate={(ids) => {
          setSelected(new Set(ids));
          navigate('migrate');
        }}
        onMembership={(member) => {
          setMemberHandoff({ ...member, key: Date.now() });
          navigate('memberships');
        }}
      />
    );
  else if (page === 'memberships' && settings)
    content = (
      <MemberManagementPage
        settings={settings}
        api={api}
        notify={notify}
        created={created}
        demo={!!session?.demo}
        events={events}
        refresh={() => void load('memberships', true)}
        navigate={navigate}
        openJob={openJob}
        review={reviewSubscription}
        ignore={ignore}
        busy={busy.has('event')}
        focusMember={memberHandoff}
        onFocusConsumed={(key) =>
          setMemberHandoff((current) => (current?.key === key ? undefined : current))
        }
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
        settings={settings}
        users={users}
        demo={!!session?.demo}
        api={api}
        notify={notify}
        refresh={() => load('settings')}
        pendingSave={settingsSavePending}
      />
    );
  else if (page === 'activity')
    content = (
      <ActivityPage
        jobs={[]}
        navigate={navigate}
        pendingSubmissions={{
          receipts: pendingReceipts,
          find: findSubmission,
          busy: busy.has('receipt'),
        }}
        openJob={(id) => openJob(id, { activityRowScope: activityScope })}
        refresh={() => void load(page, true)}
        clearHistory={(ids, filtered, single) =>
          reviewHistory(ids, filtered, single, activityScope)
        }
        remote={{
          filter: { ...activityFilter, pageSize: activityPageSize },
          result: activity?.scope === activityScope ? activity.result : null,
          pending:
            activityPending ||
            (activity?.scope !== activityScope && activityError?.scope !== activityScope),
          error: activityError?.scope === activityScope ? activityError.message : '',
          change: (filter) => {
            setActivityFilter(filter);
          },
        }}
      />
    );
  else if (page === 'subscriptions')
    content = (
      <SubscriptionsPage
        events={events}
        navigate={navigate}
        openJob={openJob}
        refresh={() => void load(page, true)}
        review={reviewSubscription}
        ignore={ignore}
        busy={busy.has('event')}
      />
    );
  else content = <Loading />;
  return (
    <WorkflowProvider
      key={authGeneration.current}
      api={api}
      notify={notify}
      enabled={!!session?.authenticated}
      demo={!!session?.demo}
      pendingSave={settingsSavePending}
      onSettingsSaved={setSettings}
    >
      <WorkspaceNoticeProvider notice={toasts.at(-1)} dismiss={() => setToasts([])}>
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
          <WorkspaceDraftProvider key={authGeneration.current}>
            <div className="shell">
              <a
                className="skip-link"
                href="#workspace-content"
                onClick={(event) => {
                  event.preventDefault();
                  const content = document.getElementById('workspace-content');
                  content?.focus();
                  content?.scrollIntoView?.({ block: 'start' });
                }}
              >
                Skip to content
              </a>
              {mobileOpen && (
                <button
                  className="nav-scrim"
                  aria-label="Close navigation"
                  onClick={() => setMobileOpen(false)}
                />
              )}
              <aside
                ref={navigation}
                id="workspace-navigation"
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
                <nav className="nav">
                  {navigationGroups.map((group) => (
                    <div className="nav-group" key={group.title}>
                      <div className="nav-label">{group.title}</div>
                      {group.pages.map((key) => {
                        const value = pages[key];
                        return (
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
                        );
                      })}
                    </div>
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
                  <button
                    className="sidebar-version"
                    type="button"
                    aria-label={`Changelog for Jellyport v${appVersion}`}
                    aria-haspopup="dialog"
                    onClick={() =>
                      showDialog({ kind: 'changelog', buildRevision: session.build_revision })
                    }
                  >
                    v{appVersion} <Icon name="chevron" />
                  </button>
                </div>
              </aside>
              <main className="main" inert={mobileOpen && navigationDrawer}>
                <header className="topbar">
                  <button
                    ref={mobileToggle}
                    className="icon-button mobile-menu"
                    onClick={() => setMobileOpen((value) => !value)}
                    aria-label="Toggle navigation"
                    aria-expanded={mobileOpen}
                    aria-controls="workspace-navigation"
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
                    <span className="operator-label">Admin workspace</span>
                  </div>
                </header>
                <div className="content" id="workspace-content" tabIndex={-1}>
                  {session.demo && (
                    <div className="demo-banner">
                      <Icon name="info" />
                      Demo mode is active. Accounts, watch history, and Discord messages use sample
                      data. Settings are read-only.
                    </div>
                  )}
                  <WorkspaceNotice />
                  {page === 'migrate' && previewProgress && (
                    <div className="setup-server preview-progress mb-17" role="status">
                      <span>
                        Preparing migration review… {previewProgress.processed} of{' '}
                        {previewProgress.total} {previewProgress.total === 1 ? 'user' : 'users'}{' '}
                        complete.
                      </span>
                      <button
                        className="text-button preview-cancel"
                        type="button"
                        onClick={cancelPreview}
                      >
                        Cancel preview
                      </button>
                    </div>
                  )}
                  {pollPaused && hasActive && (
                    <Callout warning title="Activity updates paused.">
                      The last known operation status is shown. Jellyport will keep trying to
                      reconnect.{' '}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          if (page === 'activity') void load('activity', true);
                          else navigate('activity');
                        }}
                      >
                        Refresh Activity
                      </button>
                    </Callout>
                  )}
                  {content}
                </div>
              </main>
            </div>
          </WorkspaceDraftProvider>
        )}
        {session?.authenticated && dialog && (
          <DialogContent
            api={api}
            reviewFollowUp={reviewFollowUp}
            dialog={dialog}
            close={dismissDialog}
            startMigration={startMigration}
            refreshPreview={refreshPreview}
            reveal={reveal}
            cancelJob={cancelJob}
            showReveal={(jobId) => showDialog({ kind: 'reveal', jobId })}
            clearReport={(job) => reviewHistory([job.id], false, job)}
            cleanupHistory={cleanupHistory}
            apply={apply}
            busy={busy}
            notify={notify}
            templateUserId={settings?.template_user_id}
          />
        )}
      </WorkspaceNoticeProvider>
    </WorkflowProvider>
  );
}

function HistoryCleanupDialog({
  review,
  close,
  submit,
}: {
  review: Extract<Dialog, { kind: 'cleanup' }>;
  close: () => void;
  submit: (ids: string[]) => Promise<HistoryCleanupResult | undefined>;
}) {
  const [scope, setScope] = useState(review.filtered ? 'filtered' : 'all');
  const [age, setAge] = useState('all');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HistoryCleanupResult | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const filteredIds = new Set(review.filteredIds);
  const inScope = review.candidates.filter((job) => scope === 'all' || filteredIds.has(job.id));
  const cutoff = review.openedAt - Number(age) * 86_400_000;
  const eligible = inScope.filter(
    (job) =>
      finishedJob(job) &&
      (age === 'all' || Date.parse(job.finished_at || job.updated_at || job.created_at) < cutoff),
  );
  const ids = [...new Set(eligible.map((job) => job.id))];
  const protectedCount = inScope.filter((job) => !finishedJob(job)).length;
  const overLimit = ids.length > 1000;
  const reasons: Record<string, string> = {
    not_found: 'Already cleared or unavailable',
    not_finished: 'Not finished or still queued',
    active: 'Still finalizing',
    pending_credentials: 'New credentials still await delivery or one-time reveal',
    recovery_required: 'Account creation requires recovery review',
    subscription_processing: 'Subscription processing still needs this report',
  };
  const skipped = new Map<string, number>();
  result?.skipped.forEach((item) => {
    const label = reasons[item.reason] || 'Protected by the server';
    skipped.set(label, (skipped.get(label) || 0) + 1);
  });
  async function clear() {
    if (!ids.length || overLimit || pendingRef.current || result) return;
    // These exact reviewed IDs are sent once. Polling never adds newly finished jobs.
    const reviewedIds = [...ids];
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      const value = await submit(reviewedIds);
      if (alive.current && value) setResult(value);
    } catch (reason) {
      if (alive.current) setError(message(reason));
    } finally {
      pendingRef.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <Modal
      title={review.single ? 'Delete this report?' : 'Delete activity history?'}
      description="Remove stored Jellyport activity and migration reports."
      close={() => {
        if (!pendingRef.current) close();
      }}
      closeDisabled={pending}
      footer={
        result ? (
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-quiet" onClick={close} disabled={pending}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => void clear()}
              disabled={pending || !ids.length || overLimit}
            >
              {pending && <span className="spinner" />}
              {pending
                ? 'Deleting…'
                : `Delete ${num(ids.length)} ${ids.length === 1 ? 'report' : 'reports'}`}
            </button>
          </>
        )
      }
    >
      <Callout icon="info" title="Completed server changes are kept.">
        This only removes Jellyport’s stored reports. It does not undo migrations, change media
        accounts, or change watch history. Reports needed for active work, credential delivery, or
        account recovery are kept. Finished reports include Failed and Needs review activity.
      </Callout>
      {review.single && (
        <p className="subtle text-small">
          Operation ID: <code>{review.candidates[0]?.id}</code>
        </p>
      )}
      {result ? (
        <>
          <p role="status">
            {num(result.removed_ids.length)}{' '}
            {result.removed_ids.length === 1 ? 'report deleted' : 'reports deleted'}.{' '}
            {num(result.skipped.length)} kept.
          </p>
          {!!skipped.size && (
            <ul>
              {[...skipped].map(([label, count]) => (
                <li key={label}>
                  {label}: {num(count)}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {!review.single && (
            <div className="field-row">
              <label className="field">
                Reports to review
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value)}
                  disabled={pending}
                >
                  <option value="all">All finished operations</option>
                  <option value="filtered">Current Activity filters</option>
                </select>
              </label>
              <label className="field">
                Recorded before
                <select
                  value={age}
                  onChange={(event) => setAge(event.target.value)}
                  disabled={pending}
                >
                  <option value="30">30 days ago</option>
                  <option value="7">7 days ago</option>
                  <option value="90">90 days ago</option>
                  <option value="all">Any time</option>
                </select>
              </label>
            </div>
          )}
          <p role="status">
            {num(ids.length)} finished {ids.length === 1 ? 'report' : 'reports'} selected.{' '}
            {protectedCount > 0 &&
              `${num(protectedCount)} active or unrecognized operations excluded.`}
          </p>
          {!review.single && (
            <p className="subtle text-small">
              Uses the finish date when recorded, otherwise the last update or creation date. This
              review stays fixed while open; new activity is not added.
            </p>
          )}
          {overLimit && (
            <p className="error-block" role="alert">
              Delete at most 1,000 reports at a time. Use Activity filters or an older date to
              narrow this review.
            </p>
          )}
          {error && (
            <p className="error-block" role="alert">
              {error} You can retry this same review.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

function DialogContent({
  api,
  dialog,
  close,
  startMigration,
  refreshPreview,
  reviewFollowUp,
  reveal,
  cancelJob,
  showReveal,
  clearReport,
  cleanupHistory,
  apply,
  busy,
  notify,
  templateUserId,
}: {
  api: Api;
  dialog: Dialog;
  close: () => void;
  startMigration: (event: FormEvent<HTMLFormElement>) => void;
  refreshPreview: () => void;
  reviewFollowUp: (id: string) => void;
  reveal: (id: string) => void;
  cancelJob: (id: string) => void;
  showReveal: (id: string) => void;
  clearReport: (job: Job) => void;
  cleanupHistory: (ids: string[]) => Promise<HistoryCleanupResult | undefined>;
  apply: (event: SubscriptionEvent) => void;
  busy: Set<string>;
  notify: (text: string, error?: boolean) => void;
  templateUserId?: string;
}) {
  if (dialog.kind === 'changelog')
    return <ChangelogDialog version={appVersion} revision={dialog.buildRevision} close={close} />;
  if (dialog.kind === 'cleanup')
    return <HistoryCleanupDialog review={dialog} close={close} submit={cleanupHistory} />;
  if (dialog.kind === 'preview')
    return (
      <MigrationPreviewDialog
        key={dialog.previewId}
        review={dialog}
        api={api}
        close={close}
        startMigration={startMigration}
        refreshPreview={refreshPreview}
        busy={busy}
        templateUserId={templateUserId}
      />
    );
  if (dialog.kind === 'job') {
    const job = dialog.job;
    const migrationJob = ['migrate', 'migration'].includes(job.kind);
    const cloneJob = job.kind === 'clone';
    const historicalMigration =
      migrationJob &&
      (!['watched_only', 'played_favorites'].includes(job.migration_scope ?? '') ||
        job.results?.some(
          ({ data }) =>
            data &&
            ((job.migration_scope !== 'played_favorites' && data.favorites) ||
              data.resume_positions ||
              data.play_counts ||
              data.last_played_dates ||
              data.ratings ||
              data.playlists_created ||
              data.playlists_existing ||
              data.playlist_items_added ||
              data.preferences?.length ||
              data.avatar),
        ));
    const results = (job.results ?? []).map((result) => ({
      result,
      report: migrationReport(result),
    }));
    const onlyHistoryBlocked =
      migrationJob &&
      results.some(({ report }) => report.blocked) &&
      results.every(
        ({ result, report }) =>
          report.blocked || !resultOutcome(result, job.migration_scope).needsReview,
      );
    const mayHaveCredentials =
      !activeJob(job) &&
      (job.credential_availability
        ? job.credential_availability.available > 0
        : job.results?.some((result) => result.created && result.discord_delivery !== 'sent'));
    return (
      <Modal
        title={
          migrationJob
            ? 'Migration details'
            : cloneJob
              ? 'Account cloning details'
              : 'Operation details'
        }
        description={
          cloneJob
            ? 'Copied settings and played status'
            : job.migration_scope === 'played_favorites'
              ? 'Played status and favorites'
              : job.migration_scope === 'watched_only'
                ? 'Played status'
                : undefined
        }
        close={close}
        footer={
          <>
            <button className="btn btn-quiet" onClick={close}>
              Close
            </button>
            {finishedJob(job) && (
              <button className="btn btn-quiet" onClick={() => clearReport(job)}>
                Delete report…
              </button>
            )}
            {migrationJob && finishedJob(job) && job.status !== 'completed' && (
              <button
                className="btn btn-quiet"
                disabled={busy.has('follow-up')}
                onClick={() => reviewFollowUp(job.id)}
              >
                Review remaining accounts
              </button>
            )}
            {activeJob(job) && (
              <button
                className="btn btn-quiet"
                onClick={() => cancelJob(job.id)}
                disabled={!!job.cancel_requested || busy.has(`cancel-job-${job.id}`)}
              >
                {job.cancel_requested || busy.has(`cancel-job-${job.id}`)
                  ? 'Canceling…'
                  : 'Cancel job'}
              </button>
            )}
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
            <p className="subtle text-tiny mt-5">
              Started {date(job.started_at || job.created_at)}
            </p>
          </div>
          <Status {...jobOutcome(job)} />
        </div>
        {historicalMigration && (
          <Callout icon="info" title="Historical migration">
            This report shows results from an earlier migration scope.
          </Callout>
        )}
        <JobProgressDetails job={job} />
        {jobOutcome(job).needsReview && !onlyHistoryBlocked && (
          <Callout warning title="Review this operation before retrying.">
            <div className="button-row mt-12">
              {job.kind === 'create' && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    close();
                    navigateWorkspace({ page: 'accounts', tab: 'recover' });
                  }}
                >
                  Inspect interrupted creation
                </button>
              )}
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  close();
                  navigateWorkspace({ page: 'settings', tab: 'media', subtab: 'jellyfin' });
                }}
              >
                Check Jellyfin connection
              </button>
              {migrationJob && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    close();
                    navigateWorkspace({ page: 'mappings' });
                  }}
                >
                  Review user mappings
                </button>
              )}
            </div>
          </Callout>
        )}
        {activeJob(job) && (
          <p className="subtle text-small mt-15">
            Cancel stops remaining work. Completed changes stay in place.
          </p>
        )}
        {job.error && <div className="error-block mt-15">{job.error}</div>}
        {!!job.credential_availability?.claimed_elsewhere && (
          <Callout warning title="Credentials claimed in another session">
            Open the reveal in that session.
          </Callout>
        )}
        {results.map(({ result, report }, index) => (
          <section className="job-result" key={index}>
            <div className="job-result-header">
              <h3>{result.username || 'User'}</h3>
              <Status
                {...(migrationJob
                  ? resultOutcome(result, job.migration_scope)
                  : { value: result.status })}
              />
            </div>
            {result.history_only && (
              <p className="subtle text-small">Watch history only · existing protected account</p>
            )}
            {result.cloned_from_username && (
              <p className="muted">Cloned from Jellyfin: {result.cloned_from_username}</p>
            )}
            {!cloneJob && result.source_username && result.source_username !== result.username && (
              <p className="subtle text-small">
                Emby: {result.source_username} → Jellyfin: {result.username}
              </p>
            )}
            {result.role_name && (
              <p className="subtle text-small">
                Account role: {result.role_name} · Applied groups:{' '}
                {result.role_sections
                  ?.map(
                    (section) =>
                      ({
                        policy: 'permissions',
                        configuration: 'account preferences',
                        display: 'Home preferences',
                      })[section],
                  )
                  .join(', ') || 'none'}
              </p>
            )}
            <div className="job-meta">
              {result.created && (
                <span>
                  <Icon name="userPlus" /> New account
                </span>
              )}
              {result.matched !== undefined && (!migrationJob || activeJob(job)) && (
                <span>{num(result.matched)} matched</span>
              )}
              {result.applied !== undefined && (
                <span className="mint">
                  {num(result.applied)}{' '}
                  {job.migration_scope === 'played_favorites' ? 'item updates' : 'played updates'}
                </span>
              )}
              {!!result.already_played && <span>{num(result.already_played)} already played</span>}
              {job.migration_scope === 'played_favorites' &&
                result.source_favorites !== undefined && (
                  <span>{num(result.source_favorites)} source favorites</span>
                )}
              {!migrationJob && !!result.unmatched && (
                <span>{num(result.unmatched)} unmatched</span>
              )}
              {!migrationJob && !!result.ambiguous && (
                <span>{num(result.ambiguous)} ambiguous</span>
              )}
              {result.data && (
                <>
                  {result.applied === undefined && (
                    <span>{num(result.data.items_updated)} items updated</span>
                  )}
                  {!!report.failed && <span>{num(report.failed)} failed updates</span>}
                  {!!result.data.favorites && (
                    <span>
                      {num(result.data.favorites)}{' '}
                      {job.migration_scope === 'played_favorites' ? 'favorites added' : 'favorites'}
                    </span>
                  )}
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
                  {!!result.data.playlists_created && (
                    <span>{num(result.data.playlists_created)} playlists created</span>
                  )}
                  {!!result.data.playlists_existing && (
                    <span>{num(result.data.playlists_existing)} playlists already imported</span>
                  )}
                  {!!result.data.playlist_items_added && (
                    <span>{num(result.data.playlist_items_added)} playlist entries</span>
                  )}
                  {!!result.data.preferences?.length && (
                    <span>{result.data.preferences.length} playback preferences</span>
                  )}
                  {result.data.avatar && <span>Profile image copied</span>}
                </>
              )}
            </div>
            {!!report.verification?.unsupported_fields && (
              <p className="subtle text-small">
                {num(report.verification.unsupported_fields)}{' '}
                {report.verification.unsupported_fields === 1 ? 'change' : 'changes'} skipped
              </p>
            )}
            {!!report.failed && (
              <details className="disclosure">
                <summary>
                  {job.migration_scope === 'watched_only'
                    ? 'Failed played updates'
                    : 'Failed item updates'}{' '}
                  ({num(report.failed)})
                </summary>
                {result.data?.failed_updates?.length ? (
                  <>
                    <ul>
                      {result.data?.failed_updates.slice(0, 200).map((failure, failureIndex) => (
                        <li key={`${failure.target_id}-${failureIndex}`}>
                          <code>{failure.target_id}</code> · {failure.item_type || 'Unknown type'} ·{' '}
                          {failure.error}
                        </li>
                      ))}
                    </ul>
                    {report.failed > Math.min(result.data?.failed_updates.length, 200) && (
                      <p className="mt-8">
                        Showing {num(Math.min(result.data?.failed_updates.length, 200))} of{' '}
                        {num(report.failed)} failed updates. At most 200 item details are retained
                        per account.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-8">Individual failure details were not recorded for this job.</p>
                )}
              </details>
            )}
            {report.verification &&
              !!(
                report.verification.verified ||
                report.verification.preserved_newer ||
                report.verification.missing ||
                report.verification.mismatched
              ) && (
                <p className="subtle text-small">
                  Independent{' '}
                  {job.migration_scope === 'played_favorites'
                    ? 'played-status and favorites'
                    : job.migration_scope === 'watched_only'
                      ? 'played-status'
                      : 'history'}{' '}
                  verification: {num(report.verification.verified)} verified
                  {!!report.verification.preserved_newer && (
                    <>
                      {' '}
                      · {num(report.verification.preserved_newer)} newer Jellyfin entries preserved
                    </>
                  )}
                  {!!report.verification.missing && (
                    <> · {num(report.verification.missing)} missing</>
                  )}
                  {!!report.verification.mismatched && (
                    <> · {num(report.verification.mismatched)} mismatched</>
                  )}
                </p>
              )}
            {report.warnings.map((warning, index) => (
              <div
                className={
                  result.status === 'partial' &&
                  resultOutcome(result, job.migration_scope).value === 'completed'
                    ? 'info-block'
                    : 'error-block'
                }
                key={index}
              >
                {warning}
              </div>
            ))}
            {result.warnings?.map((warning, index) => (
              <div className="error-block" key={`role-${index}`}>
                {warning}
              </div>
            ))}
            {migrationJob && !activeJob(job) && <MigrationCoverage result={result} />}
            <DiscordDeliverySummary result={result} />
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
            {(result.source_snapshot ||
              result.destination_catalog ||
              result.timing ||
              result.source_catalog ||
              result.data?.write_metrics) && (
              <details className="disclosure">
                <summary>Technical details</summary>
                <div className="form-stack mt-8">
                  {result.source_snapshot && (
                    <SourceSnapshotNote snapshot={result.source_snapshot} />
                  )}
                  {result.destination_catalog && (
                    <p className="subtle text-small">
                      Jellyfin matching backup: {date(result.destination_catalog.backup_created_at)}{' '}
                      · {num(result.destination_catalog.items)} catalog items. Shared import:{' '}
                      {(result.destination_catalog.import_elapsed_ms / 1000).toFixed(1)} seconds.
                    </p>
                  )}
                  {result.timing && (
                    <p className="subtle text-small">
                      Account work: {(result.timing.elapsed_ms / 1000).toFixed(1)} seconds.{' '}
                      {Object.entries(result.timing.phase_ms)
                        .map(
                          ([phase, ms]) =>
                            `${phase.replaceAll('_', ' ')}: ${(ms / 1000).toFixed(1)}s`,
                        )
                        .join(' · ')}
                    </p>
                  )}
                  {result.timing?.checkpoints && (
                    <p className="subtle text-small">
                      Progress checkpoints: {num(result.timing.checkpoints.count)} persisted ·{' '}
                      {(result.timing.checkpoints.total_duration_ms / 1000).toFixed(1)} seconds
                      total · {(result.timing.checkpoints.max_duration_ms / 1000).toFixed(1)}{' '}
                      seconds slowest.
                    </p>
                  )}
                  {result.source_catalog && (
                    <p className="subtle text-small">
                      Matching catalog collected {date(result.source_catalog.captured_at)} ·{' '}
                      {num(result.source_catalog.items)} items
                    </p>
                  )}
                  {result.data?.write_metrics && (
                    <p className="subtle text-small">
                      {job.migration_scope === 'played_favorites'
                        ? 'Played-status and favorites'
                        : 'Played-status'}{' '}
                      write requests: {num(result.data.write_metrics.attempts)} attempted ·{' '}
                      {num(result.data.write_metrics.succeeded)} succeeded ·{' '}
                      {num(result.data.write_metrics.failed)} failed · peak{' '}
                      {num(result.data.write_metrics.peak_in_flight)} in flight. Cumulative request
                      time: {(result.data.write_metrics.cumulative_ms / 1000).toFixed(1)} seconds;
                      slowest request: {(result.data.write_metrics.max_ms / 1000).toFixed(1)}{' '}
                      seconds.
                    </p>
                  )}
                </div>
              </details>
            )}
          </section>
        ))}
        {!job.results?.length && !activeJob(job) && !job.error && (
          <p className="muted text-small mt-18">This operation has no per-user results.</p>
        )}
        {job.elapsed_ms !== undefined && (
          <details className="disclosure">
            <summary>Operation timing</summary>
            <p className="subtle text-small">
              {migrationJob && job.workflow_elapsed_ms !== undefined && job.preview_timing ? (
                <>
                  Combined migration elapsed: {(job.workflow_elapsed_ms / 1000).toFixed(1)} seconds
                  · review build: {(job.preview_timing.elapsed_ms / 1000).toFixed(1)} seconds ·
                  accepted migration: {(job.elapsed_ms / 1000).toFixed(1)} seconds
                </>
              ) : (
                <>
                  {migrationJob ? 'Accepted migration elapsed' : 'Operation elapsed'}:{' '}
                  {(job.elapsed_ms / 1000).toFixed(1)} seconds
                </>
              )}
              {job.queue_ms !== undefined && (
                <> · preparation/queue: {(job.queue_ms / 1000).toFixed(1)} seconds</>
              )}
            </p>
          </details>
        )}
        <BotMessageHistoryPanel key={job.id} jobId={job.id} api={api} />
      </Modal>
    );
  }
  if (dialog.kind === 'reveal')
    return (
      <Modal
        title="Reveal new account credentials?"
        description="This is a one-time view. Copy credentials before closing the dialog."
        close={close}
        closeDisabled={busy.has('reveal')}
        footer={
          <>
            <button className="btn btn-quiet" onClick={close} disabled={busy.has('reveal')}>
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
          Copy credentials before closing this view. If the response is lost, reopen this operation
          within 90 seconds in the same signed-in session.
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
                <p className="credential-message-label">Message for the account holder</p>
                <pre className="credential-message">{accountMessage(credential)}</pre>
                <button
                  className="btn btn-small btn-quiet"
                  onClick={() => {
                    const text = accountMessage(credential);
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
                : 'Disable linked accounts now'}
          </button>
        </>
      }
    >
      <Callout
        icon={subscribe ? 'userPlus' : 'warning'}
        warning={!subscribe}
        title={
          subscribe
            ? 'Apply this member’s subscription allowance.'
            : 'Update this member’s access now.'
        }
      >
        {subscribe ? (
          <>
            <p>
              Jellyport records the member’s subscription tier and account allowance. Emby-only and
              Discord-only members do not need a Jellyfin account.
            </p>
            <p>
              Jellyfin accounts are created or migrated only when the member has enabled Jellyfin
              provisioning. Existing linked accounts follow the allowance; eligible extra accounts
              are disabled after a downgrade with their data preserved.
            </p>
            <p>Manually flagged Family accounts and complimentary memberships remain protected.</p>
          </>
        ) : (
          <>
            <p>
              Approving this event manually disables eligible linked Jellyfin account slots
              immediately, even when automatic disabling is off.
            </p>
            <p>
              Manually flagged Family accounts and complimentary memberships are spared. Accounts,
              passwords, and watch history are preserved.
            </p>
            <p>
              When no Jellyfin accounts are linked, Jellyport updates the membership status without
              creating or requiring an account.
            </p>
          </>
        )}
      </Callout>
      {subscribe && event.source === 'mee6_message' && event.detail && (
        <p className="muted text-small">
          Reported subscription plan: <strong>{event.detail}</strong>. The configured plan’s account
          allowance will be applied.
        </p>
      )}
      {subscribe && event.account_limit !== undefined && (
        <p className="muted text-small">
          Account allowance: {event.account_limit}{' '}
          {event.account_limit === 1 ? 'account' : 'accounts'}.
        </p>
      )}
      <p className="muted text-small">
        This event was received {date(event.created_at)} from {event.source || 'Discord'}. Review
        your membership settings before applying it.
      </p>
    </Modal>
  );
}
