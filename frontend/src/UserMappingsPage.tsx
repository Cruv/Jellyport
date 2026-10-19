import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouteTab } from './routing';
import { useWorkspaceDraftState } from './workspace-drafts';
import { Empty, Heading, Icon, Modal } from './components';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
import { UserWarnings } from './SettingsPage';
import DiscordMemberPicker from './DiscordMemberPicker';
import type { Api, DiscordMember, Notify, UserMapping, Users } from './types';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The mapping could not be saved.';

export default function UserMappingsPage({
  mappings,
  users,
  api,
  notify,
  refresh,
  templateUserId,
}: {
  mappings: UserMapping[];
  users: Users;
  api: Api;
  notify: Notify;
  refresh: (manual?: boolean) => Promise<void>;
  templateUserId?: string;
}) {
  const [view, setView] = useRouteTab('mappings');
  const [query, setQuery] = useState('');
  const filteredMappings = mappings.filter((mapping) =>
    [mapping.source_username, mapping.target_username, mapping.discord_username || ''].some(
      (name) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ),
  );
  const mappingPage = usePagination(filteredMappings, 25, query);
  const [editing, setEditing] = useWorkspaceDraftState<UserMapping | null>(
    'mappings.editing',
    null,
  );
  const [sourceId, setSourceId] = useWorkspaceDraftState('mappings.sourceId', '');
  const [targetId, setTargetId] = useWorkspaceDraftState('mappings.targetId', '');
  const [targetName, setTargetName] = useWorkspaceDraftState('mappings.targetName', '');
  const [discordName, setDiscordName] = useWorkspaceDraftState('mappings.discordName', '');
  const [discordId, setDiscordId] = useWorkspaceDraftState('mappings.discordId', '');
  const [membershipSlot, setMembershipSlot] = useWorkspaceDraftState('mappings.membershipSlot', 1);
  const [discordMember, setDiscordMember] = useWorkspaceDraftState<DiscordMember | null>(
    'mappings.discordMember',
    null,
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<UserMapping | null>(null);
  useEffect(() => {
    if (!busyRef.current) setRemoving(null);
  }, [view]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const destinations = users.jellyfin.filter(
    (user) =>
      user.Id !== templateUserId &&
      user.Policy?.IsAdministrator === false &&
      user.Policy?.IsDisabled === false,
  );
  function reset() {
    setEditing(null);
    setSourceId('');
    setTargetId('');
    setTargetName('');
    setDiscordName('');
    setDiscordId('');
    setMembershipSlot(1);
    setDiscordMember(null);
    setError('');
  }
  function edit(mapping: UserMapping) {
    setView('editor');
    setEditing(mapping);
    setSourceId(mapping.source_user_id);
    setTargetId(mapping.target_user_id || '');
    setTargetName(mapping.target_username);
    setDiscordName(mapping.discord_username || '');
    setDiscordId(mapping.discord_user_id || '');
    setMembershipSlot(mapping.membership_slot || 1);
    setDiscordMember(
      mapping.discord_user_id
        ? {
            id: mapping.discord_user_id,
            username: mapping.discord_username || 'Saved Discord member',
            display_name: null,
            nickname: null,
            membership_active: null,
          }
        : null,
    );
    setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await api<UserMapping>('/api/user-mappings', {
        method: 'POST',
        body: {
          ...(editing ? { id: editing.id } : {}),
          source_user_id: sourceId,
          target_user_id: targetId || null,
          ...(targetId ? {} : { target_username: targetName.trim() }),
          discord_username: discordName.trim() || null,
          discord_user_id: discordId.trim() || null,
          ...(discordId.trim() && (membershipSlot !== 1 || editing?.membership_slot)
            ? { membership_slot: membershipSlot }
            : {}),
        },
      });
      if (!mounted.current) return;
      reset();
      setView('list');
      notify('User mapping saved. Review a migration preview before starting.');
      await refresh();
    } catch (reason) {
      if (mounted.current) {
        setError(errorMessage(reason));
        notify(errorMessage(reason), true);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function remove() {
    if (!removing || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/api/user-mappings/${encodeURIComponent(removing.id)}`, {
        method: 'DELETE',
      });
      if (!mounted.current) return;
      if (editing?.id === removing.id) {
        reset();
        setView('list');
      }
      setRemoving(null);
      notify('User mapping removed. The server accounts were preserved.');
      await refresh();
    } catch (reason) {
      if (mounted.current) {
        setError(errorMessage(reason));
        notify(errorMessage(reason), true);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const changed = editing
    ? targetId !== (editing.target_user_id || '') ||
      targetName !== editing.target_username ||
      discordName !== (editing.discord_username || '') ||
      discordId !== (editing.discord_user_id || '') ||
      membershipSlot !== (editing.membership_slot || 1)
    : Boolean(sourceId || targetName || discordName || discordId);

  return (
    <div className="page-stack">
      <Heading
        title="User mappings"
        description="Connect Emby, Jellyfin, and Discord identities when usernames differ."
        actions={
          <button className="btn btn-quiet" onClick={() => void refresh(true)} disabled={busy}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <UserWarnings users={users} />
      <Tabs
        id="mapping-views"
        label="User mapping tasks"
        tabs={[
          { id: 'list', label: 'Saved mappings', count: mappings.length },
          {
            id: 'editor',
            label: editing ? 'Edit mapping' : changed ? 'Mapping draft' : 'Add mapping',
          },
        ]}
        value={view}
        onChange={setView}
      />
      <TabPanel id="mapping-views" tabId="list" active={view === 'list'}>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Saved mappings</h2>
              <p>Select a mapping to review or edit its approved destination.</p>
            </div>
            <span className="status">{mappings.length}</span>
          </div>
          <div className="panel-body directory-toolbar">
            <div className="field">
              <label htmlFor="mapping-search">Find mappings</label>
              <input
                id="mapping-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Emby, Jellyfin, or Discord usernames"
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                reset();
                setView('editor');
              }}
              disabled={busy}
            >
              Add mapping
            </button>
          </div>
          {filteredMappings.length ? (
            <div className="panel-body summary-list record-list" aria-label="Saved mappings">
              {mappingPage.items.map((mapping) => (
                <article
                  className={`summary-card${editing?.id === mapping.id ? ' selected' : ''}`}
                  key={mapping.id}
                >
                  <dl>
                    <div>
                      <dt>Emby</dt>
                      <dd>
                        <strong>{mapping.source_username}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>Jellyfin</dt>
                      <dd>
                        <strong>{mapping.target_username}</strong>
                        <small>
                          {mapping.target_user_id ? 'Existing account' : 'Create during migration'}
                        </small>
                      </dd>
                    </div>
                    <div>
                      <dt>Discord</dt>
                      <dd>
                        {mapping.discord_username || 'No username label'}
                        <small>
                          {mapping.discord_user_id
                            ? `Verified user ID: ${mapping.discord_user_id} · Account slot ${mapping.membership_slot || 1}`
                            : 'No verified Discord identity'}
                        </small>
                      </dd>
                    </div>
                  </dl>
                  <div className="toolbar">
                    <button
                      className="btn btn-quiet"
                      onClick={() => edit(mapping)}
                      disabled={busy}
                      aria-label={`Edit mapping for ${mapping.source_username}`}
                      aria-pressed={editing?.id === mapping.id}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-quiet"
                      onClick={() => {
                        setError('');
                        setRemoving(mapping);
                      }}
                      disabled={busy}
                      aria-label={`Remove mapping for ${mapping.source_username}`}
                    >
                      <Icon name="trash" /> Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              icon="link"
              title={mappings.length ? 'No matching mappings' : 'No saved mappings'}
              text="Add a mapping when media accounts or Discord identities use different usernames."
            />
          )}
          <Pagination
            label="Mappings"
            page={mappingPage.page}
            total={mappingPage.total}
            pageSize={mappingPage.pageSize}
            onPageChange={mappingPage.setPage}
            onPageSizeChange={mappingPage.setPageSize}
          />
        </section>
      </TabPanel>
      <TabPanel id="mapping-views" tabId="editor" active={view === 'editor'}>
        <section className="panel task-panel">
          <div className="panel-header">
            <div>
              <h2>{editing ? 'Edit user mapping' : 'Add a user mapping'}</h2>
              <p>Choose the destination explicitly, then migrate the Emby user as usual.</p>
            </div>
            <span className={`status${changed ? ' warn' : ''}`}>
              {changed ? 'Unsaved changes' : editing ? 'Saved mapping' : 'New mapping'}
            </span>
          </div>
          <div className="panel-body">
            <details className="help-details">
              <summary>How user mappings work</summary>
              <p>
                Mappings connect differently named accounts. Saving a mapping does not create
                accounts or send messages. Existing Jellyfin accounts retain their username,
                password, and permissions.
              </p>
            </details>
            <form className="form-stack" onSubmit={(event) => void save(event)}>
              {error && !removing && (
                <div className="error-block" role="alert">
                  {error}
                </div>
              )}
              <div className="field-row">
                <div className="field">
                  <label htmlFor="mapping-source">Emby account</label>
                  <select
                    id="mapping-source"
                    value={sourceId}
                    required
                    disabled={busy || Boolean(editing)}
                    onChange={(event) => {
                      const id = event.target.value;
                      const previousName = users.emby.find((user) => user.Id === sourceId)?.Name;
                      setSourceId(id);
                      setDiscordMember(null);
                      setDiscordId('');
                      setMembershipSlot(1);
                      setDiscordName('');
                      if (!targetName || targetName === previousName)
                        setTargetName(users.emby.find((user) => user.Id === id)?.Name || '');
                    }}
                  >
                    <option value="">Select an Emby user</option>
                    {editing && !users.emby.some((user) => user.Id === sourceId) && (
                      <option value={sourceId}>{editing.source_username} (unavailable)</option>
                    )}
                    {users.emby.map((user) => (
                      <option key={user.Id} value={user.Id}>
                        {user.Name}
                      </option>
                    ))}
                  </select>
                  <small>
                    Emby account names are preserved exactly, including spaces or symbols.
                  </small>
                </div>
                <div className="field">
                  <label htmlFor="mapping-target">Jellyfin destination</label>
                  <select
                    id="mapping-target"
                    value={targetId}
                    disabled={busy}
                    onChange={(event) => setTargetId(event.target.value)}
                  >
                    <option value="">Create a new account during migration</option>
                    {editing && targetId && !destinations.some((user) => user.Id === targetId) && (
                      <option value={targetId}>{editing.target_username} (unavailable)</option>
                    )}
                    {destinations.map((user) => (
                      <option key={user.Id} value={user.Id}>
                        {user.Name}
                      </option>
                    ))}
                  </select>
                  <small>Existing accounts keep their username, password, and permissions.</small>
                </div>
              </div>
              {!targetId && (
                <div className="field">
                  <label htmlFor="mapping-target-name">New Jellyfin username</label>
                  <input
                    id="mapping-target-name"
                    value={targetName}
                    onChange={(event) => setTargetName(event.target.value)}
                    required
                    maxLength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
                    title="Start with a letter or number; use letters, numbers, periods, underscores, or hyphens."
                    disabled={busy}
                    autoComplete="off"
                  />
                  <small>
                    Use 1–64 letters, numbers, periods, underscores, or hyphens; start with a letter
                    or number.
                  </small>
                </div>
              )}
              <DiscordMemberPicker
                key={editing?.id || sourceId || 'new-mapping'}
                api={api}
                value={discordMember}
                onChange={(member) => {
                  setDiscordMember(member);
                  setDiscordId(member?.id || '');
                  setDiscordName(member?.username || '');
                }}
                suggestedQuery={
                  discordName ||
                  users.jellyfin.find((user) => user.Id === targetId)?.Name ||
                  targetName ||
                  users.emby.find((user) => user.Id === sourceId)?.Name ||
                  ''
                }
                allowInactive
                disabled={busy}
                id="mapping-discord-member"
              />
              <div className="field">
                <label htmlFor="mapping-membership-slot">Membership account slot</label>
                <select
                  id="mapping-membership-slot"
                  value={membershipSlot}
                  disabled={busy || !discordId.trim()}
                  onChange={(event) => setMembershipSlot(Number(event.target.value))}
                >
                  <option value={1}>1 · Primary account</option>
                  <option value={2}>2 · Second account</option>
                  <option value={3}>3 · Third account</option>
                </select>
                <small>
                  Link additional Emby accounts to the same Discord owner in separate slots. Assign
                  their tier on Memberships before migrating extra slots. The member’s tier controls
                  how many linked accounts can stay enabled.
                </small>
              </div>
              <details className="discord-picker-advanced">
                <summary>Advanced Discord details</summary>
                <p>
                  Use a username label or a known Discord ID when a server search is unavailable.
                </p>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="mapping-discord-name">
                      Discord username <span className="optional">optional</span>
                    </label>
                    <input
                      id="mapping-discord-name"
                      value={discordName}
                      onChange={(event) => {
                        setDiscordMember(null);
                        setDiscordName(event.target.value);
                      }}
                      maxLength={64}
                      disabled={busy}
                      autoComplete="off"
                      placeholder="Actual username, not a server nickname"
                    />
                    <small>Without a user ID, this is an unverified label.</small>
                  </div>
                  <div className="field">
                    <label htmlFor="mapping-discord-id">
                      Discord user ID <span className="optional">optional</span>
                    </label>
                    <input
                      id="mapping-discord-id"
                      value={discordId}
                      onChange={(event) => {
                        setDiscordMember(null);
                        setDiscordId(event.target.value);
                      }}
                      inputMode="numeric"
                      pattern="[0-9]{5,22}"
                      maxLength={22}
                      disabled={busy}
                      autoComplete="off"
                    />
                    <small>
                      The connected Discord bot verifies the member and their actual username.
                    </small>
                  </div>
                </div>
              </details>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    reset();
                    setView('list');
                  }}
                  disabled={busy}
                >
                  {editing ? 'Cancel edit' : 'Cancel'}
                </button>
                {editing && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setError('');
                      setRemoving(editing);
                    }}
                    disabled={busy}
                    aria-label={`Remove mapping for ${editing.source_username}`}
                  >
                    <Icon name="trash" />
                    Remove
                  </button>
                )}
                <button type="submit" className="btn btn-primary" disabled={busy || !sourceId}>
                  {busy ? <span className="spinner" /> : <Icon name="check" />}
                  {busy ? 'Saving…' : 'Save mapping'}
                </button>
              </div>
            </form>
          </div>
        </section>
      </TabPanel>
      {removing && (
        <Modal
          title="Remove this user mapping?"
          description={`${removing.source_username} → ${removing.target_username}`}
          close={() => {
            if (!busy) {
              setRemoving(null);
              setError('');
            }
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  setRemoving(null);
                  setError('');
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
                {busy ? 'Removing…' : 'Remove mapping'}
              </button>
            </>
          }
        >
          <p>
            Future operations will no longer use this association. The Emby and Jellyfin accounts
            and their data are preserved.
          </p>
          {error && (
            <div className="error-block mt-18" role="alert">
              {error}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
