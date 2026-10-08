import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, Loading, Modal } from './components';
import DiscordMemberPicker from './DiscordMemberPicker';
import { safeUrl } from './types';
import type {
  Api,
  DirectoryAccount,
  DirectoryUser,
  DiscordMember,
  DiscordTagPreview,
  DiscordTagRole,
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

export default function UserDirectoryPage({
  settings,
  api,
  notify,
  navigate,
}: {
  settings: Settings;
  api: Api;
  notify: Notify;
  navigate: (page: Page) => void;
}) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [server, setServer] = useState('all');
  const [access, setAccess] = useState('all');
  const [family, setFamily] = useState('all');
  const [review, setReview] = useState('all');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DirectoryUser | null>(null);
  const [profileTarget, setProfileTarget] = useState('');
  const [profileFamily, setProfileFamily] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [ownerNotes, setOwnerNotes] = useState('');
  const [accessReview, setAccessReview] = useState<DirectoryUser | null>(null);
  const [accessTarget, setAccessTarget] = useState('');
  const [accessDisabled, setAccessDisabled] = useState(false);
  const [linking, setLinking] = useState<DirectoryUser | null>(null);
  const [member, setMember] = useState<DiscordMember | null>(null);
  const [target, setTarget] = useState('');
  const [slot, setSlot] = useState(1);
  const [organizer, setOrganizer] = useState(false);
  const [roles, setRoles] = useState<DiscordTagRole[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [roleError, setRoleError] = useState('');
  const [embyRole, setEmbyRole] = useState(settings.discord_emby_role_id || '');
  const [jellyfinRole, setJellyfinRole] = useState(settings.discord_jellyfin_role_id || '');
  const [autoSync, setAutoSync] = useState(!!settings.discord_auto_role_sync);
  const [embyOnly, setEmbyOnly] = useState(settings.discord_emby_only_role === true);
  const [savedRoles, setSavedRoles] = useState({
    embyRole: settings.discord_emby_role_id || '',
    jellyfinRole: settings.discord_jellyfin_role_id || '',
    autoSync: !!settings.discord_auto_role_sync,
    embyOnly: settings.discord_emby_only_role === true,
  });
  const [preview, setPreview] = useState<DiscordTagPreview | null>(null);
  const organizationInvite = safeUrl(settings.bot_organization_invite_url);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const loadController = useRef<AbortController | null>(null);
  const roleDirty =
    embyRole !== savedRoles.embyRole ||
    jellyfinRole !== savedRoles.jellyfinRole ||
    autoSync !== savedRoles.autoSync ||
    embyOnly !== savedRoles.embyOnly;

  const reload = useCallback(async () => {
    const version = ++generation.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError('');
    try {
      const value = await api<{ users: DirectoryUser[] }>('/api/user-directory', {
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      setUsers(value.users);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && version === generation.current)
        setError(message(reason));
    } finally {
      if (mounted.current && !controller.signal.aborted && version === generation.current)
        setLoading(false);
    }
  }, [api]);
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
      if (mounted.current && !controller.signal.aborted)
        (forRoles ? setRoleError : setError)(message(reason));
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function openLink(user: DirectoryUser) {
    setLinking(user);
    setTarget(user.jellyfin[0]?.id || '');
    setSlot(1);
    setMember(
      user.discord_user_id
        ? {
            id: user.discord_user_id,
            username: user.discord_username || user.jellyfin[0]?.name || '',
            display_name: null,
            nickname: null,
            membership_active: null,
          }
        : null,
    );
    setError('');
  }
  function selectProfile(target: ProfileAccount) {
    setProfileTarget(target.key);
    setProfileFamily(!!target.account.profile?.family);
    setOwnerName(target.account.profile?.owner_name || '');
    setOwnerNotes(target.account.profile?.notes || '');
  }
  function openProfile(user: DirectoryUser) {
    const account = profileAccounts(user)[0];
    if (!account) return;
    setEditing(user);
    selectProfile(account);
    setError('');
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const target = editing && profileAccounts(editing).find((item) => item.key === profileTarget);
    if (!target) return;
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
      setEditing(null);
      notify('Family flag and private owner notes saved.');
      await reload();
    });
  }
  function openAccessReview(user: DirectoryUser) {
    const target = profileAccounts(user)[0];
    if (!target) return;
    setAccessReview(user);
    setAccessTarget(target.key);
    setAccessDisabled(!target.account.disabled);
    setError('');
  }
  function updateAccess(event: FormEvent) {
    event.preventDefault();
    const target =
      accessReview && profileAccounts(accessReview).find((item) => item.key === accessTarget);
    if (!target || accessDisabled === target.account.disabled) return;
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
      setAccessReview(null);
      notify(
        `Account ${accessDisabled ? 'disabled' : 'enabled'}. Its password and media data are preserved.`,
      );
      await reload();
    });
  }
  function link(event: FormEvent) {
    event.preventDefault();
    if (!member || !target) return;
    void run(async (signal) => {
      await api('/api/accounts/link', {
        method: 'POST',
        body: { discord_user_id: member.id, jellyfin_user_id: target, membership_slot: slot },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setLinking(null);
      notify('Existing account linked. Its password, settings, and media data are preserved.');
      await reload();
    });
  }
  function loadRoles() {
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
    void run(async (signal) => {
      const result = await api<DiscordTagPreview>('/api/discord/tags/preview', {
        method: 'POST',
        body: {},
        signal,
      });
      if (mounted.current && !signal.aborted) setPreview(result);
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
  return (
    <>
      <Heading
        title="Everyone, across both servers."
        description="Organize paid members, family, and independent media accounts in one place."
        actions={
          <button className="btn" disabled={busy || loading} onClick={() => void reload()}>
            <Icon name="refresh" /> Refresh
          </button>
        }
      />
      <Callout icon="users" title="Discord and subscriptions are optional.">
        Mark family accounts and record who owns them using Family and owner notes. Family access
        stays admin-managed, with no Discord or payment requirement. Paying members require a
        Discord owner. You can also save complimentary access in{' '}
        <button className="text-button" onClick={() => navigate('memberships')}>
          Memberships
        </button>{' '}
        for other non-paying members. Create independent accounts from{' '}
        <button className="text-button" onClick={() => navigate('accounts')}>
          Create account
        </button>
        .
      </Callout>
      {!loading && reviewCount > 0 && (
        <Callout
          warning
          icon="warning"
          title={`${reviewCount} ${reviewCount === 1 ? 'user needs' : 'users need'} review`}
        >
          These users have accounts without a confirmed Discord owner or a family flag. Review who
          owns them and how their access should be managed. They will not be automatically disabled.
          <p>
            <button className="text-button" onClick={() => setReview('review')}>
              Show users needing review
            </button>
          </p>
        </Callout>
      )}
      {error && !linking && !editing && !accessReview && (
        <div className="error-block" role="alert">
          {error}
        </div>
      )}
      <div className="stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>User directory</h2>
              <p>
                Confirmed links determine account ownership. Unlinked accounts require your review.
              </p>
            </div>
          </div>
          <div className="panel-body form-stack">
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
            <div className="section-grid">
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
              <div className="field">
                <label htmlFor="directory-review">Account review</label>
                <select
                  id="directory-review"
                  value={review}
                  onChange={(event) => setReview(event.target.value)}
                >
                  <option value="all">All users</option>
                  <option value="review">Needs review</option>
                </select>
              </div>
            </div>
          </div>
          {loading ? (
            <Loading />
          ) : visible.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Emby accounts</th>
                    <th>Jellyfin accounts</th>
                    <th>Discord owner / access</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((user) => (
                    <tr key={user.id}>
                      <td>
                        {user.emby.length
                          ? user.emby.map((account) => (
                              <div key={account.id}>
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
                      <td>
                        {user.jellyfin.length
                          ? user.jellyfin.map((account) => (
                              <div key={account.id}>
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
                      <td>
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
                      <td className="right">
                        {profileAccounts(user).length > 0 && (
                          <button
                            className="btn btn-quiet"
                            disabled={busy}
                            onClick={() => openProfile(user)}
                            aria-label={`Family and owner notes for ${profileAccounts(user)[0]!.account.name}`}
                          >
                            Family and owner notes
                          </button>
                        )}
                        {profileAccounts(user).length > 0 && (
                          <button
                            className="btn btn-quiet"
                            disabled={busy}
                            onClick={() => openAccessReview(user)}
                            aria-label={`Manage account access for ${profileAccounts(user)[0]!.account.name}`}
                          >
                            Manage account access
                          </button>
                        )}
                        {user.jellyfin.length > 0 && !user.protected && (
                          <button
                            className="btn btn-quiet"
                            disabled={busy}
                            onClick={() => openLink(user)}
                            aria-label={`Link Discord owner for ${user.jellyfin[0].name}`}
                          >
                            Link Discord owner
                          </button>
                        )}
                        {user.emby.length > 0 && !user.protected && (
                          <button className="btn btn-quiet" onClick={() => navigate('mappings')}>
                            User mappings
                          </button>
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
        </section>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Discord organization roles</h2>
              <p>
                Tag confirmed owners by their media accounts without changing their subscription
                access.
              </p>
            </div>
            <button
              className="btn"
              disabled={busy || !settings.discord_enabled}
              onClick={loadRoles}
            >
              {organizer ? 'Refresh roles' : 'Configure roles'}
            </button>
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
      </div>
      {accessReview && (
        <Modal
          title="Review account access"
          description="Change access for one selected media account."
          close={() => {
            if (!busy) {
              setAccessReview(null);
              setError('');
            }
          }}
        >
          <form className="form-stack" onSubmit={updateAccess}>
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
                  setAccessDisabled(!target.account.disabled);
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
                onChange={(event) => setAccessDisabled(event.target.value === 'disable')}
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
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setAccessReview(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={
                  busy ||
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
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal
          title="Family and owner notes"
          description="Keep account ownership details private in Jellyport."
          close={() => {
            if (!busy) {
              setEditing(null);
              setError('');
            }
          }}
        >
          <form className="form-stack" onSubmit={saveProfile}>
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
              automatic billing-based access changes. No Discord membership or payment is required.
            </p>
            <small>
              Removing the family flag does not disable the account. Manage the linked owner’s
              subscription or complimentary access separately in Memberships.
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
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save family and owner notes'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {linking && (
        <Modal
          title="Link an existing Jellyfin account"
          description="Choose the confirmed owner. The account keeps its password and data."
          close={() => {
            if (!busy) {
              setLinking(null);
              setError('');
            }
          }}
        >
          <form className="form-stack" onSubmit={link}>
            <div className="field">
              <label htmlFor="directory-link-account">Existing Jellyfin account</label>
              <select
                id="directory-link-account"
                value={target}
                disabled={busy}
                onChange={(event) => setTarget(event.target.value)}
              >
                {linking.jellyfin.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <DiscordMemberPicker
              api={api}
              value={member}
              onChange={setMember}
              suggestedQuery={linking.jellyfin[0]?.name}
              autoSearch
              allowInactive
              disabled={busy}
            />
            <div className="field">
              <label htmlFor="directory-link-slot">Owner’s account slot</label>
              <select
                id="directory-link-slot"
                value={slot}
                disabled={busy}
                onChange={(event) => setSlot(Number(event.target.value))}
              >
                {[1, 2, 3].map((value) => (
                  <option key={value} value={value}>
                    Slot {value}
                  </option>
                ))}
              </select>
              <small>
                For a non-paying owner, save complimentary access in Memberships first. Slots 2 and
                3 must fit their saved account allowance.
              </small>
            </div>
            {error && (
              <div className="error-block" role="alert">
                {error}
              </div>
            )}
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setLinking(null)}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy || !member || !target}>
                {busy ? 'Linking…' : 'Confirm account owner'}
              </button>
            </div>
          </form>
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
    </>
  );
}
