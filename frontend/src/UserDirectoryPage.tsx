import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, Loading, Modal } from './components';
import DiscordMemberPicker from './DiscordMemberPicker';
import { safeUrl } from './types';
import type {
  Api,
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
  const [busy, setBusy] = useState(false);
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
  const [embyOnly, setEmbyOnly] = useState(settings.discord_emby_only_role !== false);
  const [savedRoles, setSavedRoles] = useState({
    embyRole: settings.discord_emby_role_id || '',
    jellyfinRole: settings.discord_jellyfin_role_id || '',
    autoSync: !!settings.discord_auto_role_sync,
    embyOnly: settings.discord_emby_only_role !== false,
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
  const visible = users.filter((user) => {
    const text = [
      ...user.emby.map((item) => item.name),
      ...user.jellyfin.map((item) => item.name),
      user.discord_username || '',
    ]
      .join(' ')
      .toLowerCase();
    return (
      text.includes(search.trim().toLowerCase()) &&
      (server === 'all' || presence(user) === server) &&
      (access === 'all' || user.access_mode === access)
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
        Complimentary members keep access under your control. Independent accounts can belong to
        children or anyone without Discord. Save a complimentary policy in{' '}
        <button className="text-button" onClick={() => navigate('memberships')}>
          Memberships
        </button>{' '}
        before linking a non-paying Discord member. Create independent accounts from{' '}
        <button className="text-button" onClick={() => navigate('accounts')}>
          Create account
        </button>
        .
      </Callout>
      {error && !linking && (
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
                        {user.account_limit !== null && (
                          <small>{user.account_limit} account allowance</small>
                        )}
                        {user.protected && (
                          <small>Protected administrator or template account</small>
                        )}
                      </td>
                      <td className="right">
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
                        {user.emby.length > 0 && (
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
