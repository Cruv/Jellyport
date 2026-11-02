import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouteTab } from './routing';
import { useWorkspaceDraftState } from './workspace-drafts';
import { Callout, Empty, Heading, Icon, Loading, Modal } from './components';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
import DiscordMemberPicker from './DiscordMemberPicker';
import { MemberIdentityAccountReview } from './IdentityReviewPanel';
import WorkflowRequirements, { useWorkflowAction } from './WorkflowRequirements';
import AccountCloneDialog, {
  AccountRenameDialog,
  type AccountCloneRequest,
  type AccountCloneReview,
  type AccountRenameRecovery,
} from './AccountCloneDialog';
import { safeUrl } from './types';
import type {
  Api,
  DirectoryAccount,
  DirectoryUser,
  DiscordMember,
  DiscordTagPreview,
  DiscordTagRole,
  Job,
  Notify,
  Page,
  Settings,
} from './types';

const accessNames = {
  subscription: 'Subscription',
  complimentary: 'Complimentary',
  standalone: 'Independent',
  unlinked: 'Unlinked',
};
const presence = (user: DirectoryUser) =>
  user.emby.length && user.jellyfin.length
    ? 'both'
    : user.jellyfin.length
      ? 'jellyfin'
      : user.emby.length
        ? 'emby'
        : 'none';
const presenceNames = {
  both: 'Both servers',
  jellyfin: 'Jellyfin only',
  emby: 'Emby only',
  none: 'No media account',
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'This change could not be completed.';
type ProfileAccount = {
  key: string;
  kind: 'emby' | 'jellyfin';
  account: DirectoryAccount;
};
const profileAccounts = (user: DirectoryUser): ProfileAccount[] =>
  (['jellyfin', 'emby'] as const).flatMap((kind) =>
    user[kind]
      .filter((account) => account.protected === false)
      .map((account) => ({ key: JSON.stringify([kind, account.id]), kind, account })),
  );
const familyAccount = (user: DirectoryUser) =>
  !!user.family || [...user.emby, ...user.jellyfin].some((account) => account.profile?.family);
const cloneAccounts = (user: DirectoryUser) =>
  user.jellyfin.filter((account) => account.protected === false && account.disabled === false);
const renameAccounts = (user: DirectoryUser) =>
  user.jellyfin.filter((account) => account.protected === false);
const selectedFirst = (accounts: DirectoryAccount[], selectedId: string) =>
  [...accounts].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));

export default function UserDirectoryPage({
  settings,
  api,
  notify,
  navigate,
  created,
  onMigrate,
  onMembership,
}: {
  settings: Settings;
  api: Api;
  notify: Notify;
  navigate: (page: Page) => void;
  created?: (job: Job) => void;
  onMigrate?: (sourceIds: string[]) => void;
  onMembership?: (member: { id: string; username: string }) => void;
}) {
  const workspaceFormId = useId();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [directorySources, setDirectorySources] = useState<
    Partial<
      Record<'emby' | 'jellyfin', { configured: boolean; available: boolean; error?: string }>
    >
  >({});
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [server, setServer] = useState('all');
  const [access, setAccess] = useState('all');
  const [family, setFamily] = useState('all');
  const [review, setReview] = useState('all');
  const [section, setSection] = useRouteTab('users');
  const sectionGeneration = useRef({ section, version: 0 });
  if (sectionGeneration.current.section !== section)
    sectionGeneration.current = { section, version: sectionGeneration.current.version + 1 };
  const [advanced, setAdvanced] = useState(false);
  const [workspaceTarget, setWorkspaceTarget] = useState('');
  const profileDrafts = useRef(
    new Map<string, { family: boolean; owner: string; notes: string }>(),
  );
  const accessDrafts = useRef(new Map<string, boolean>());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DirectoryUser | null>(null);
  const [profileTarget, setProfileTarget] = useState('');
  const [profileFamily, setProfileFamily] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [ownerNotes, setOwnerNotes] = useState('');
  const [accessReview, setAccessReview] = useState<DirectoryUser | null>(null);
  const [accessTarget, setAccessTarget] = useState('');
  const [accessDisabled, setAccessDisabled] = useState(false);
  const [toolAccountId, setToolAccountId] = useState('');
  const [cloning, setCloning] = useState<DirectoryUser | null>(null);
  const [cloneReview, setCloneReview] = useState<AccountCloneReview | null>(null);
  const [renaming, setRenaming] = useState<DirectoryUser | null>(null);
  const [renameRecovery, setRenameRecovery] = useState<AccountRenameRecovery | undefined>();
  const [linking, setLinking] = useState<DirectoryUser | null>(null);
  const [member, setMember] = useState<DiscordMember | null>(null);
  const [ownerReviewing, setOwnerReviewing] = useState(false);
  const [organizer, setOrganizer] = useState(false);
  const [roles, setRoles] = useState<DiscordTagRole[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [roleError, setRoleError] = useState('');
  const [embyRole, setEmbyRole] = useWorkspaceDraftState(
    'organization.embyRole',
    settings.discord_emby_role_id || '',
  );
  const [jellyfinRole, setJellyfinRole] = useWorkspaceDraftState(
    'organization.jellyfinRole',
    settings.discord_jellyfin_role_id || '',
  );
  const [autoSync, setAutoSync] = useWorkspaceDraftState(
    'organization.autoSync',
    !!settings.discord_auto_role_sync,
  );
  const [embyOnly, setEmbyOnly] = useWorkspaceDraftState(
    'organization.embyOnly',
    settings.discord_emby_only_role === true,
  );
  const [savedRoles, setSavedRoles] = useWorkspaceDraftState('organization.savedRoles', {
    embyRole: settings.discord_emby_role_id || '',
    jellyfinRole: settings.discord_jellyfin_role_id || '',
    autoSync: !!settings.discord_auto_role_sync,
    embyOnly: settings.discord_emby_only_role === true,
  });
  const [preview, setPreview] = useState<DiscordTagPreview | null>(null);
  const organizationInvite = safeUrl(settings.bot_organization_invite_url);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    if (busyRef.current) return;
    setEditing(null);
    setAccessReview(null);
    setCloning(null);
    setCloneReview(null);
    setRenaming(null);
    setRenameRecovery(undefined);
    setLinking(null);
    setPreview(null);
    profileDrafts.current.clear();
    accessDrafts.current.clear();
  }, [section]);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const loadController = useRef<AbortController | null>(null);
  const roleDirty =
    embyRole !== savedRoles.embyRole ||
    jellyfinRole !== savedRoles.jellyfinRole ||
    autoSync !== savedRoles.autoSync ||
    embyOnly !== savedRoles.embyOnly;

  const reload = useCallback(
    async (manual = false) => {
      const version = ++generation.current;
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      setLoading(true);
      setError('');
      try {
        const value = await api<{
          users: DirectoryUser[];
          sources?: Partial<
            Record<'emby' | 'jellyfin', { configured: boolean; available: boolean; error?: string }>
          >;
        }>('/api/user-directory', {
          signal: controller.signal,
        });
        if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
        setUsers(value.users);
        setDirectorySources(value.sources || {});
        if (manual) notify('Users refreshed.');
      } catch (reason) {
        if (mounted.current && !controller.signal.aborted && version === generation.current) {
          setError(message(reason));
          if (manual) notify(message(reason), true);
        }
      } finally {
        if (mounted.current && !controller.signal.aborted && version === generation.current)
          setLoading(false);
      }
    },
    [api, notify],
  );
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      generation.current++;
      loadController.current?.abort();
      controllers.current.forEach((controller) => controller.abort());
    };
  }, [reload]);

  async function run(operation: (signal: AbortSignal) => Promise<void>, forRoles = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    (forRoles ? setRoleError : setError)('');
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      await operation(controller.signal);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) {
        (forRoles ? setRoleError : setError)(message(reason));
        notify(message(reason), true);
      }
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const workspaceUser = accessReview || editing || linking;
  const workspaceAccounts = workspaceUser ? profileAccounts(workspaceUser) : [];
  const selectedWorkspaceAccount = workspaceAccounts.find((item) => item.key === workspaceTarget);
  const workspaceCloneAccounts = workspaceUser
    ? selectedFirst(
        cloneAccounts(workspaceUser),
        selectedWorkspaceAccount?.kind === 'jellyfin' ? selectedWorkspaceAccount.account.id : '',
      )
    : [];
  const workspaceRenameAccounts = workspaceUser
    ? selectedFirst(
        renameAccounts(workspaceUser),
        selectedWorkspaceAccount?.kind === 'jellyfin' ? selectedWorkspaceAccount.account.id : '',
      )
    : [];
  const accountAction =
    selectedWorkspaceAccount?.kind === 'emby' ? 'account_access_emby' : 'account_access_jellyfin';
  const accountReadiness = useWorkflowAction(accountAction);
  const identityReadiness = useWorkflowAction('identity_review');
  const jellyfinReadiness = useWorkflowAction('account_access_jellyfin');
  const ownerInitialAccounts = useMemo(
    () =>
      selectedWorkspaceAccount
        ? [{ kind: selectedWorkspaceAccount.kind, id: selectedWorkspaceAccount.account.id }]
        : [],
    [selectedWorkspaceAccount?.key],
  );
  function closeWorkspace() {
    if (busy) return;
    clearWorkspace();
  }
  function clearWorkspace() {
    setAccessReview(null);
    setEditing(null);
    setLinking(null);
    setOwnerReviewing(false);
    setMember(null);
    profileDrafts.current.clear();
    accessDrafts.current.clear();
    setError('');
  }
  function selectedAccount(user: DirectoryUser): ProfileAccount | undefined {
    return (
      (workspaceUser?.id === user.id
        ? profileAccounts(user).find((item) => item.key === workspaceTarget)
        : undefined) || profileAccounts(user)[0]
    );
  }
  function openLink(user: DirectoryUser) {
    const account = selectedAccount(user);
    if (!account) return;
    const sameWorkspace = workspaceUser?.id === user.id;
    setAccessReview(null);
    setEditing(null);
    setLinking(user);
    setWorkspaceTarget(account.key);
    if (!sameWorkspace) {
      setOwnerReviewing(false);
      setMember(null);
    }
    setError('');
  }
  function selectProfile(target: ProfileAccount) {
    const draft = profileDrafts.current.get(target.key);
    setWorkspaceTarget(target.key);
    setProfileTarget(target.key);
    setProfileFamily(draft?.family ?? !!target.account.profile?.family);
    setOwnerName(draft?.owner ?? target.account.profile?.owner_name ?? '');
    setOwnerNotes(draft?.notes ?? target.account.profile?.notes ?? '');
  }
  useEffect(() => {
    if (editing && profileTarget)
      profileDrafts.current.set(profileTarget, {
        family: profileFamily,
        owner: ownerName,
        notes: ownerNotes,
      });
  }, [editing, profileTarget, profileFamily, ownerName, ownerNotes]);
  function openProfile(user: DirectoryUser) {
    const account = selectedAccount(user);
    if (!account) return;
    setAccessReview(null);
    setLinking(null);
    setEditing(user);
    selectProfile(account);
    setError('');
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const target = editing && profileAccounts(editing).find((item) => item.key === profileTarget);
    if (!target || !accountReadiness.ready) return;
    void run(async (signal) => {
      await api('/api/account-profiles', {
        method: 'POST',
        body: {
          kind: target.kind,
          user_id: target.account.id,
          family: profileFamily,
          owner_name: ownerName,
          notes: ownerNotes,
          expected_revision: target.account.profile?.revision || '',
        },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      clearWorkspace();
      notify('Family flag and private owner notes saved.');
      await reload();
    });
  }
  function openAccessReview(user: DirectoryUser) {
    const target = selectedAccount(user);
    if (!target) return;
    setEditing(null);
    setLinking(null);
    setAccessReview(user);
    setWorkspaceTarget(target.key);
    setAccessTarget(target.key);
    setAccessDisabled(accessDrafts.current.get(target.key) ?? !target.account.disabled);
    setError('');
  }
  function updateAccess(event: FormEvent) {
    event.preventDefault();
    const target =
      accessReview && profileAccounts(accessReview).find((item) => item.key === accessTarget);
    if (!target || !accountReadiness.ready || accessDisabled === target.account.disabled) return;
    void run(async (signal) => {
      await api('/api/accounts/access', {
        method: 'POST',
        body: {
          kind: target.kind,
          user_id: target.account.id,
          disabled: accessDisabled,
          expected_username: target.account.name,
          expected_profile_revision: target.account.profile?.revision || '',
        },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      clearWorkspace();
      notify(
        `Account ${accessDisabled ? 'disabled' : 'enabled'}. Its password and media data are preserved.`,
      );
      await reload();
    });
  }
  function prepareClone(request: AccountCloneRequest) {
    void run(async (signal) => {
      const result = await api<AccountCloneReview>('/api/accounts/clone/review', {
        method: 'POST',
        body: request,
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setCloneReview(result);
      notify('Clone review ready. Confirm the new accounts before creating them.');
    });
  }
  function startClone(reviewId: string) {
    if (!created) return;
    void run(async (signal) => {
      const job = await api<Job>('/api/accounts/clone', {
        method: 'POST',
        body: { review_id: reviewId },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setCloning(null);
      setCloneReview(null);
      clearWorkspace();
      notify('Account cloning started. Open the report to retrieve the new credentials.');
      created(job);
    });
  }
  function renameAccount(request: {
    user_id: string;
    expected_username: string;
    username: string;
  }) {
    void run(async (signal) => {
      await api('/api/accounts/rename', { method: 'POST', body: request, signal });
      if (!mounted.current || signal.aborted) return;
      setRenaming(null);
      clearWorkspace();
      notify('Jellyfin account renamed. Its password, settings, and media data are preserved.');
      await reload();
    });
  }
  function inspectRename(userId: string) {
    setRenameRecovery(undefined);
    void run(async (signal) => {
      const result = await api<{ pending: AccountRenameRecovery['pending'] }>(
        `/api/accounts/rename/recovery?user_id=${encodeURIComponent(userId)}`,
        { signal },
      );
      if (!mounted.current || signal.aborted) return;
      setRenameRecovery({ user_id: userId, pending: result.pending });
    });
  }
  function loadRoles() {
    const version = sectionGeneration.current.version;
    setOrganizer(true);
    void run(async (signal) => {
      const result = await api<{ roles: DiscordTagRole[]; can_manage_roles: boolean }>(
        '/api/discord/tag-roles',
        { signal },
      );
      if (!mounted.current || signal.aborted) return;
      setRoles(result.roles);
      setCanManage(result.can_manage_roles);
      setRolesLoaded(true);
      if (sectionGeneration.current.version === version) notify('Discord roles loaded.');
    }, true);
  }
  function saveRoles(event: FormEvent) {
    event.preventDefault();
    void run(async (signal) => {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          discord_emby_role_id: embyRole,
          discord_jellyfin_role_id: jellyfinRole,
          discord_auto_role_sync: autoSync,
          discord_emby_only_role: embyOnly,
        },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setSavedRoles({ embyRole, jellyfinRole, autoSync, embyOnly });
      setPreview(null);
      notify('Discord organization settings saved.');
    }, true);
  }
  function previewRoles() {
    const version = sectionGeneration.current.version;
    const currentSection = () =>
      sectionGeneration.current.version === version &&
      sectionGeneration.current.section === 'organization';
    void run(async (signal) => {
      try {
        const result = await api<DiscordTagPreview>('/api/discord/tags/preview', {
          method: 'POST',
          body: {},
          signal,
        });
        if (mounted.current && !signal.aborted && currentSection()) setPreview(result);
      } catch (reason) {
        if (currentSection()) throw reason;
      }
    }, true);
  }
  function applyRoles() {
    if (!preview) return;
    void run(async (signal) => {
      const result = await api<{ updated: number; failed: number }>('/api/discord/tags/apply', {
        method: 'POST',
        body: { token: preview.token },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setPreview(null);
      notify(
        `${result.updated} Discord members updated.${result.failed ? ` ${result.failed} need attention; review Activity and try again.` : ''}`,
        result.failed > 0,
      );
    }, true);
  }
  const roleName = (id: string) => roles.find((role) => role.id === id)?.name || id;
  const reviewCount = users.filter((user) => user.requires_review).length;
  const visible = users.filter((user) => {
    const text = [
      ...user.emby.map((item) => item.name),
      ...user.jellyfin.map((item) => item.name),
      ...[...user.emby, ...user.jellyfin].map((item) => item.profile?.owner_name || ''),
      user.discord_username || '',
    ]
      .join(' ')
      .toLowerCase();
    return (
      text.includes(search.trim().toLowerCase()) &&
      (server === 'all' || presence(user) === server) &&
      (access === 'all' || user.access_mode === access) &&
      (family === 'all' || familyAccount(user) === (family === 'family')) &&
      (review === 'all' || !!user.requires_review)
    );
  });
  const filtered =
    search.trim() !== '' || [server, access, family, review].some((value) => value !== 'all');
  const pagination = usePagination(
    visible,
    25,
    JSON.stringify([search, server, access, family, review]),
  );
  return (
    <div className="page-stack">
      <Heading
        title="Users"
        description="Find a person once, then manage their accounts, access, and ownership in one place."
        actions={
          <>
            <button
              className="btn btn-quiet"
              disabled={busy || loading}
              aria-busy={loading}
              onClick={() => void reload(true)}
            >
              <Icon name="refresh" /> Refresh
            </button>
            <button className="btn btn-primary" onClick={() => navigate('accounts')}>
              <Icon name="userPlus" /> Create Jellyfin account
            </button>
          </>
        }
      />
      <Tabs
        id="users"
        label="User management sections"
        tabs={[
          { id: 'directory', label: 'Directory', count: loading ? undefined : users.length },
          { id: 'organization', label: 'Discord organization' },
        ]}
        value={section}
        onChange={(value) => {
          setSection(value);
        }}
      />
      {error && !linking && !editing && !accessReview && !cloning && !renaming && (
        <div className="error-block" role="alert">
          {error}
        </div>
      )}
      <TabPanel
        id="users"
        tabId="directory"
        active={section === 'directory'}
        className="page-stack"
      >
        {!loading && reviewCount > 0 && (
          <Callout
            warning
            icon="warning"
            title={`${reviewCount} ${reviewCount === 1 ? 'user needs' : 'users need'} review`}
          >
            Confirm an owner or Family flag when appropriate. Account access can be managed now.
            They will not be automatically disabled.{' '}
            <button className="text-button" onClick={() => setReview('review')}>
              Show users needing review
            </button>
          </Callout>
        )}
        {Object.entries(directorySources).some(
          ([, source]) => source.configured && !source.available,
        ) && (
          <Callout warning title="Some server accounts are temporarily unavailable">
            {Object.entries(directorySources)
              .filter(([, source]) => source.configured && !source.available)
              .map(([kind, source]) => (
                <p key={kind}>
                  {kind === 'emby' ? 'Emby' : 'Jellyfin'}:{' '}
                  {source.error || 'The account list could not be verified.'}
                </p>
              ))}
            Available accounts stay visible. Missing server data is not treated as a missing account
            or unpaid access.
          </Callout>
        )}
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>User directory</h2>
              <p>
                Manage account access directly. Discord ownership and membership are separate,
                optional steps.
              </p>
            </div>
            {!loading && <span className="status">{users.length} users</span>}
          </div>
          <div className="panel-body form-stack">
            <div className="directory-filters">
              <div className="field">
                <label htmlFor="directory-search">Search users</label>
                <input
                  id="directory-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Media or Discord username"
                />
              </div>
              <div className="field">
                <label htmlFor="directory-server">Server presence</label>
                <select
                  id="directory-server"
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                >
                  <option value="all">All servers</option>
                  {Object.entries(presenceNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="directory-review">Account review</label>
                <select
                  id="directory-review"
                  value={review}
                  onChange={(event) => setReview(event.target.value)}
                >
                  <option value="all">All users</option>
                  <option value="review">
                    Needs review{reviewCount ? ` (${reviewCount})` : ''}
                  </option>
                </select>
              </div>
              <button
                className="btn"
                aria-expanded={advanced}
                aria-controls="directory-advanced-filters"
                onClick={() => setAdvanced((value) => !value)}
              >
                {advanced ? 'Fewer filters' : 'More filters'}
                {(access !== 'all' || family !== 'all') && <span className="status">Active</span>}
              </button>
            </div>
            <div
              id="directory-advanced-filters"
              className="directory-advanced-filters"
              hidden={!advanced}
            >
              <div className="field">
                <label htmlFor="directory-access">Access policy</label>
                <select
                  id="directory-access"
                  value={access}
                  onChange={(event) => setAccess(event.target.value)}
                >
                  <option value="all">All access policies</option>
                  {Object.entries(accessNames)
                    .filter(([value]) => value !== 'unlinked')
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="directory-family">Family accounts</label>
                <select
                  id="directory-family"
                  value={family}
                  onChange={(event) => setFamily(event.target.value)}
                >
                  <option value="all">All users</option>
                  <option value="family">Family only</option>
                  <option value="other">Other users</option>
                </select>
              </div>
            </div>
            {!loading && (
              <div className="toolbar">
                <p className="section-note" role="status">
                  Showing {visible.length} of {users.length} users
                </p>
                {filtered && (
                  <button
                    className="btn btn-quiet"
                    onClick={() => {
                      setSearch('');
                      setServer('all');
                      setAccess('all');
                      setFamily('all');
                      setReview('all');
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </div>
          {loading ? (
            <Loading />
          ) : visible.length ? (
            <div className="table-wrap">
              <table
                className="directory-table"
                aria-label="Media accounts and confirmed ownership"
              >
                <thead>
                  <tr>
                    <th>Emby accounts</th>
                    <th>Jellyfin accounts</th>
                    <th>Discord owner / access</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagination.items.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Emby accounts">
                        {user.emby.length
                          ? user.emby.map((account) => (
                              <div className="account-cell" key={account.id}>
                                <strong>{account.name}</strong>
                                {account.profile?.family && <span className="status">Family</span>}
                                {account.profile?.owner_name && (
                                  <small>Owner: {account.profile.owner_name}</small>
                                )}
                                {account.disabled && <small>Disabled</small>}
                              </div>
                            ))
                          : '—'}
                      </td>
                      <td data-label="Jellyfin accounts">
                        {user.jellyfin.length
                          ? user.jellyfin.map((account) => (
                              <div className="account-cell" key={account.id}>
                                <strong>{account.name}</strong>
                                {account.profile?.family && <span className="status">Family</span>}
                                {account.profile?.owner_name && (
                                  <small>Owner: {account.profile.owner_name}</small>
                                )}
                                {account.disabled && <small>Disabled</small>}
                              </div>
                            ))
                          : '—'}
                      </td>
                      <td data-label="Discord owner / access">
                        <strong>
                          {user.discord_username
                            ? `@${user.discord_username}`
                            : user.discord_user_id
                              ? 'Linked Discord member'
                              : 'No Discord link'}
                        </strong>
                        <small>
                          {accessNames[user.access_mode]} · {presenceNames[presence(user)]}
                        </small>
                        {familyAccount(user) && <span className="status">Family accounts</span>}
                        {user.requires_review && <span className="status warn">Needs review</span>}
                        {user.account_limit !== null && (
                          <small>{user.account_limit} account allowance</small>
                        )}
                        {user.protected && (
                          <small>Protected administrator or template account</small>
                        )}
                      </td>
                      <td className="right" data-label="Actions">
                        {profileAccounts(user).length > 0 ||
                        (!user.protected && (user.emby.length > 0 || user.jellyfin.length > 0)) ? (
                          <div className="directory-actions person-directory-actions">
                            <button
                              className="btn btn-primary btn-small"
                              disabled={busy}
                              aria-label={`Manage ${profileAccounts(user)[0]?.account.name || user.jellyfin[0]?.name || user.emby[0]?.name}`}
                              onClick={(event) => {
                                event.currentTarget.focus({ preventScroll: true });
                                openAccessReview(user);
                              }}
                            >
                              Manage
                            </button>
                            {profileAccounts(user).length === 1 && (
                              <button
                                className="btn btn-quiet btn-small"
                                disabled={busy}
                                aria-label={`${profileAccounts(user)[0]!.account.disabled ? 'Enable' : 'Disable'} ${profileAccounts(user)[0]!.account.name}`}
                                onClick={(event) => {
                                  event.currentTarget.focus({ preventScroll: true });
                                  openAccessReview(user);
                                }}
                              >
                                {profileAccounts(user)[0]!.account.disabled ? 'Enable' : 'Disable'}
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="section-note">
                            {user.protected ? 'Protected' : 'No media account'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon="users"
              title="No users match."
              text="Refresh the directory or change your filters."
            />
          )}
          {!loading && (
            <Pagination
              label="Users"
              page={pagination.page}
              total={pagination.total}
              pageSize={pagination.pageSize}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
          )}
        </section>
        <details className="directory-guidance">
          <summary>About family accounts and account ownership</summary>
          <div className="form-stack">
            <strong>Discord and subscriptions are optional.</strong>
            <p>
              Mark family accounts and record who owns them using Family and owner notes. Family
              access stays admin-managed, with no Discord or payment requirement. Paying members
              require a Discord owner. You can also save complimentary access in{' '}
              <button className="text-button" onClick={() => navigate('memberships')}>
                Memberships
              </button>{' '}
              for other non-paying members. Create independent accounts from{' '}
              <button className="text-button" onClick={() => navigate('accounts')}>
                Create account
              </button>
              .
            </p>
          </div>
        </details>
      </TabPanel>
      <TabPanel
        id="users"
        tabId="organization"
        active={section === 'organization'}
        className="page-stack"
      >
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Discord organization roles</h2>
              <p>
                Tag confirmed owners by their media accounts without changing their subscription
                access.
              </p>
            </div>
            <div className="toolbar">
              {organizer && roleDirty && <span className="status warn">Unsaved changes</span>}
              <button
                className="btn"
                disabled={busy || !settings.discord_enabled}
                aria-busy={busy}
                onClick={loadRoles}
              >
                {organizer ? 'Refresh roles' : 'Configure roles'}
              </button>
            </div>
          </div>
          {organizer && (
            <div className="panel-body form-stack">
              <p>
                Choose existing roles with no server permissions, placed below the bot’s highest
                role. Use dedicated tags without channel permission overwrites. The bot needs Manage
                Roles. Other Discord roles are preserved. Accounts without a confirmed Discord owner
                are skipped.
              </p>
              {roleError && (
                <div className="error-block" role="alert">
                  {roleError}
                </div>
              )}
              {rolesLoaded && !canManage && (
                <Callout warning icon="warning" title="The bot needs Manage Roles.">
                  Grant this permission and place the organization roles below the bot, then refresh
                  roles.
                  {organizationInvite && (
                    <p>
                      <a className="btn" href={organizationInvite} target="_blank" rel="noreferrer">
                        Update bot permissions
                      </a>
                    </p>
                  )}
                </Callout>
              )}
              {rolesLoaded && (
                <form className="form-stack" onSubmit={saveRoles}>
                  {[
                    {
                      id: 'emby-organization-role',
                      label: embyOnly ? 'Emby-only role' : 'Emby account role',
                      value: embyRole,
                      change: setEmbyRole,
                    },
                    {
                      id: 'jellyfin-organization-role',
                      label: 'Jellyfin account role',
                      value: jellyfinRole,
                      change: setJellyfinRole,
                    },
                  ].map((field) => (
                    <div className="field" key={field.id}>
                      <label htmlFor={field.id}>{field.label}</label>
                      <select
                        id={field.id}
                        value={field.value}
                        disabled={busy}
                        onChange={(event) => {
                          field.change(event.target.value);
                          setPreview(null);
                        }}
                      >
                        <option value="">Do not assign a role</option>
                        {field.value && !roles.some((role) => role.id === field.value) && (
                          <option value={field.value} disabled>
                            Previously selected role is unavailable
                          </option>
                        )}
                        {roles.map((role) => (
                          <option key={role.id} value={role.id} disabled={!role.manageable}>
                            {role.name}
                            {!role.manageable ? ' · unavailable' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={embyOnly}
                      disabled={busy}
                      onChange={(event) => {
                        setEmbyOnly(event.target.checked);
                        setPreview(null);
                      }}
                    />
                    Reserve the Emby role for owners who have only Emby accounts
                  </label>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={autoSync}
                      disabled={busy}
                      onChange={(event) => setAutoSync(event.target.checked)}
                    />
                    Automatically keep organization roles up to date
                  </label>
                  <small>
                    Automatic synchronization is optional. Start with a preview to review role
                    changes.
                  </small>
                  <div className="form-actions">
                    <button className="btn" disabled={busy || !roleDirty}>
                      Save organization settings
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={busy || roleDirty || !canManage || (!embyRole && !jellyfinRole)}
                      onClick={previewRoles}
                    >
                      Preview role changes
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </section>
      </TabPanel>
      {cloning && (
        <AccountCloneDialog
          accounts={selectedFirst(cloneAccounts(cloning), toolAccountId)}
          existingUsernames={users.flatMap((user) => user.jellyfin.map((account) => account.name))}
          busy={busy}
          error={error}
          review={cloneReview}
          prepare={prepareClone}
          edit={() => {
            if (!busy) {
              setCloneReview(null);
              setError('');
            }
          }}
          close={() => {
            if (!busy) {
              setCloning(null);
              setCloneReview(null);
              setError('');
            }
          }}
          submit={startClone}
        />
      )}
      {renaming && (
        <AccountRenameDialog
          accounts={selectedFirst(renameAccounts(renaming), toolAccountId)}
          existingUsernames={users.flatMap((user) => user.jellyfin.map((account) => account.name))}
          busy={busy}
          error={error}
          recovery={renameRecovery}
          inspect={inspectRename}
          close={() => {
            if (!busy) {
              setRenaming(null);
              setError('');
            }
          }}
          submit={renameAccount}
        />
      )}
      {workspaceUser && !cloning && !renaming && (
        <Modal
          title={`Manage ${workspaceUser.discord_username ? '@' + workspaceUser.discord_username : workspaceAccounts[0]?.account.name || 'account'}`}
          description="Account access is available immediately. Confirm relationships here only when you need member-based management."
          close={closeWorkspace}
          closeDisabled={busy}
          footer={
            accessReview || editing ? (
              <>
                <button className="btn" type="button" disabled={busy} onClick={closeWorkspace}>
                  Cancel
                </button>
                {accessReview ? (
                  <button
                    className="btn btn-primary"
                    type="submit"
                    form={`${workspaceFormId}-access`}
                    disabled={
                      busy ||
                      !accountReadiness.ready ||
                      accessDisabled ===
                        profileAccounts(accessReview).find((target) => target.key === accessTarget)
                          ?.account.disabled
                    }
                  >
                    {busy
                      ? 'Updating…'
                      : accessDisabled
                        ? 'Disable selected account'
                        : 'Enable selected account'}
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    type="submit"
                    form={`${workspaceFormId}-profile`}
                    disabled={busy || !accountReadiness.ready}
                  >
                    {busy ? 'Saving…' : 'Save family and owner notes'}
                  </button>
                )}
              </>
            ) : undefined
          }
        >
          <div className="person-workspace-summary">
            <strong>
              {workspaceUser.discord_user_id
                ? workspaceUser.discord_username
                  ? '@' + workspaceUser.discord_username
                  : 'Linked Discord member'
                : 'Independent media account'}
            </strong>
            <p>
              {presenceNames[presence(workspaceUser)]} · {accessNames[workspaceUser.access_mode]}
              {workspaceUser.account_limit
                ? ` · ${workspaceUser.account_limit} account allowance`
                : ''}
            </p>
            {selectedWorkspaceAccount && (
              <p>
                <strong>
                  {selectedWorkspaceAccount.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'}:{' '}
                  {selectedWorkspaceAccount.account.name}
                </strong>{' '}
                · {selectedWorkspaceAccount.account.disabled ? 'Disabled' : 'Enabled'}
              </p>
            )}
            <small>
              {workspaceUser.discord_user_id
                ? 'Confirmed owner links are already available for this person.'
                : 'No Discord link is required to change this account’s access or Family flag.'}
            </small>
          </div>
          <Tabs
            id="person-workspace"
            label="Account workspace sections"
            tabs={[
              { id: 'access', label: 'Account access' },
              { id: 'owner', label: 'Discord owner' },
              { id: 'profile', label: 'Family & notes' },
            ]}
            value={accessReview ? 'access' : linking ? 'owner' : 'profile'}
            onChange={(value) => {
              if (busy) return;
              if (value === 'access') openAccessReview(workspaceUser);
              else if (value === 'owner') openLink(workspaceUser);
              else openProfile(workspaceUser);
            }}
          />
          {accessReview && (
            <form id={`${workspaceFormId}-access`} className="form-stack" onSubmit={updateAccess}>
              <WorkflowRequirements action={accountAction} compact />
              <div className="field">
                <label htmlFor="directory-access-account">Media account</label>
                <select
                  id="directory-access-account"
                  value={accessTarget}
                  disabled={busy}
                  onChange={(event) => {
                    const target = profileAccounts(accessReview).find(
                      (item) => item.key === event.target.value,
                    );
                    if (!target) return;
                    setAccessTarget(target.key);
                    setWorkspaceTarget(target.key);
                    setAccessDisabled(
                      accessDrafts.current.get(target.key) ?? !target.account.disabled,
                    );
                  }}
                >
                  {profileAccounts(accessReview).map((target) => (
                    <option key={target.key} value={target.key}>
                      {target.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'}: {target.account.name}
                    </option>
                  ))}
                </select>
                <small>
                  Currently{' '}
                  {profileAccounts(accessReview).find((target) => target.key === accessTarget)
                    ?.account.disabled
                    ? 'disabled'
                    : 'enabled'}
                  .
                </small>
              </div>
              <div className="field">
                <label htmlFor="directory-access-change">Access change</label>
                <select
                  id="directory-access-change"
                  value={accessDisabled ? 'disable' : 'enable'}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value === 'disable';
                    setAccessDisabled(value);
                    accessDrafts.current.set(accessTarget, value);
                  }}
                >
                  <option value="disable">Disable this account</option>
                  <option value="enable">Enable this account</option>
                </select>
              </div>
              <p>
                {accessDisabled
                  ? 'Disabling prevents this account from signing in. Its password, watch history, favorites, playlists, and preferences are preserved, so you can enable it again later.'
                  : 'Enabling restores access for this account with its existing password and media data.'}
              </p>
              <small>
                Only the selected account changes. Its family flag, notes, and linked owner’s access
                policy remain as saved.
              </small>
              {error && (
                <div className="error-block" role="alert">
                  {error}
                </div>
              )}
            </form>
          )}
          {editing && (
            <form id={`${workspaceFormId}-profile`} className="form-stack" onSubmit={saveProfile}>
              <WorkflowRequirements action={accountAction} compact />
              <div className="field">
                <label htmlFor="directory-profile-account">Media account</label>
                <select
                  id="directory-profile-account"
                  value={profileTarget}
                  disabled={busy}
                  onChange={(event) => {
                    const target = profileAccounts(editing).find(
                      (item) => item.key === event.target.value,
                    );
                    if (target) selectProfile(target);
                  }}
                >
                  {profileAccounts(editing).map((target) => (
                    <option key={target.key} value={target.key}>
                      {target.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'}: {target.account.name}
                    </option>
                  ))}
                </select>
                <small>These notes belong to the selected account on this server.</small>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={profileFamily}
                  disabled={busy}
                  onChange={(event) => setProfileFamily(event.target.checked)}
                />
                Family account
              </label>
              <p>
                This flag applies only to the selected account. Family accounts are exempt from
                automatic billing-based access changes. No Discord membership or payment is
                required.
              </p>
              <small>
                Removing the family flag does not disable the account. Its confirmed owner and saved
                membership remain as configured.
              </small>
              <div className="field">
                <label htmlFor="directory-profile-owner">Owner name</label>
                <input
                  id="directory-profile-owner"
                  value={ownerName}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setOwnerName(event.target.value)}
                  placeholder="Who this account belongs to"
                />
              </div>
              <div className="field">
                <label htmlFor="directory-profile-notes">Private owner notes</label>
                <textarea
                  id="directory-profile-notes"
                  value={ownerNotes}
                  maxLength={2000}
                  rows={4}
                  disabled={busy}
                  onChange={(event) => setOwnerNotes(event.target.value)}
                  placeholder="Details to help you recognize and manage the account"
                />
                <small>Visible only to Jellyport administrators. Never sent to Discord.</small>
              </div>
              {error && (
                <div className="error-block" role="alert">
                  {error}
                </div>
              )}
            </form>
          )}
          {linking && (
            <div className="form-stack">
              <div className="field">
                <label htmlFor="directory-owner-account">Media account</label>
                <select
                  id="directory-owner-account"
                  value={workspaceTarget}
                  disabled={busy || ownerReviewing}
                  onChange={(event) => setWorkspaceTarget(event.target.value)}
                >
                  {workspaceAccounts.map((account) => (
                    <option key={account.key} value={account.key}>
                      {account.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'}: {account.account.name}
                    </option>
                  ))}
                </select>
              </div>
              {linking?.discord_user_id ? (
                <Callout title="Owner already confirmed">
                  <p>
                    @{linking.discord_username || linking.discord_user_id} owns these linked
                    accounts. Existing links are reused for account and membership actions.
                  </p>
                  {onMembership && (
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const owner = {
                          id: linking.discord_user_id!,
                          username: linking.discord_username || linking.discord_user_id!,
                        };
                        closeWorkspace();
                        onMembership(owner);
                      }}
                    >
                      Manage this member’s access policy
                    </button>
                  )}
                </Callout>
              ) : !settings.discord_enabled ? (
                <Callout title="Discord is optional for account management">
                  Enable, disable, rename, clone, or flag this account as Family without linking
                  Discord. Connect the bot when you want member ownership or message delivery.
                  <WorkflowRequirements action="identity_review" compact />
                </Callout>
              ) : ownerReviewing && member && selectedWorkspaceAccount ? (
                <>
                  <WorkflowRequirements action="identity_review" compact />
                  <MemberIdentityAccountReview
                    api={api}
                    notify={notify}
                    active={identityReadiness.ready}
                    member={member}
                    initialAccounts={ownerInitialAccounts}
                    onBusyChange={setBusy}
                    onCancel={() => setOwnerReviewing(false)}
                    onApplied={() => {
                      setLinking(null);
                      setOwnerReviewing(false);
                      setMember(null);
                      void reload();
                    }}
                  />
                </>
              ) : (
                <>
                  <Callout title="Confirm ownership once">
                    Associate existing media accounts with a Discord member. This step does not
                    require a paid subscription, create an account, or opt anyone into Jellyfin.
                  </Callout>
                  <WorkflowRequirements action="identity_review" compact />
                  <DiscordMemberPicker
                    api={api}
                    value={member}
                    onChange={setMember}
                    suggestedQuery={selectedWorkspaceAccount?.account.name}
                    autoSearch
                    allowInactive
                    disabled={busy || !identityReadiness.ready}
                  />
                  <div className="form-actions">
                    <button className="btn" type="button" disabled={busy} onClick={closeWorkspace}>
                      Close
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={
                        busy || !identityReadiness.ready || !member || !selectedWorkspaceAccount
                      }
                      onClick={() => setOwnerReviewing(true)}
                    >
                      Review owner and accounts
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="person-workspace-tools">
            <h3>More for this person</h3>
            {linking &&
              (workspaceCloneAccounts.length > 0 || workspaceRenameAccounts.length > 0) && (
                <WorkflowRequirements action="account_access_jellyfin" compact />
              )}
            <div className="person-workspace-actions">
              {created && workspaceCloneAccounts.length > 0 && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !jellyfinReadiness.ready}
                  aria-label={`Clone Jellyfin account for ${workspaceCloneAccounts[0]!.name}`}
                  onClick={() => {
                    setError('');
                    setCloneReview(null);
                    setToolAccountId(
                      selectedWorkspaceAccount?.kind === 'jellyfin'
                        ? selectedWorkspaceAccount.account.id
                        : '',
                    );
                    setCloning(workspaceUser);
                  }}
                >
                  Clone account
                </button>
              )}
              {workspaceRenameAccounts.length > 0 && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !jellyfinReadiness.ready}
                  aria-label={`Rename Jellyfin account for ${workspaceRenameAccounts[0]!.name}`}
                  onClick={() => {
                    setError('');
                    const account = selectedFirst(
                      renameAccounts(workspaceUser),
                      selectedWorkspaceAccount?.kind === 'jellyfin'
                        ? selectedWorkspaceAccount.account.id
                        : '',
                    )[0]!;
                    setToolAccountId(account.id);
                    setRenaming(workspaceUser);
                    inspectRename(account.id);
                  }}
                >
                  Rename account
                </button>
              )}
              {onMigrate && workspaceUser.emby.length > 0 && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const ids = workspaceUser.emby.map((account) => account.id);
                    closeWorkspace();
                    onMigrate(ids);
                  }}
                >
                  Migrate played status
                </button>
              )}
              {onMembership && workspaceUser.discord_user_id && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const member = {
                      id: workspaceUser.discord_user_id!,
                      username: workspaceUser.discord_username || workspaceUser.discord_user_id!,
                    };
                    closeWorkspace();
                    onMembership(member);
                  }}
                >
                  Manage membership
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal
          title="Review Discord role changes"
          description={`${preview.changes.length} members with changes · ${preview.unchanged} unchanged · ${preview.unlinked} unlinked accounts skipped${preview.unavailable ? ` · ${preview.unavailable} no longer in Discord` : ''}`}
          close={() => {
            if (!busy) {
              setPreview(null);
              setRoleError('');
            }
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || preview.changes.length === 0}
                onClick={applyRoles}
              >
                {busy ? 'Applying…' : 'Apply role changes'}
              </button>
            </>
          }
        >
          {preview.changes.length ? (
            <ul>
              {preview.changes.map((change) => (
                <li key={change.discord_user_id}>
                  <strong>@{change.username}</strong>
                  {change.add.length > 0 && <p>Add: {change.add.map(roleName).join(', ')}</p>}
                  {change.remove.length > 0 && (
                    <p>Remove: {change.remove.map(roleName).join(', ')}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>Confirmed members already have the expected organization roles.</p>
          )}
          <p>
            This updates only the configured organization roles. Media account access and
            subscription roles are preserved.
          </p>
          {roleError && (
            <div className="error-block" role="alert">
              {roleError}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
