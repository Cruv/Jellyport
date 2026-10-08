import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, Modal } from './components';
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
  refresh: () => Promise<void>;
  templateUserId?: string;
}) {
  const [editing, setEditing] = useState<UserMapping | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [targetName, setTargetName] = useState('');
  const [discordName, setDiscordName] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [discordMember, setDiscordMember] = useState<DiscordMember | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<UserMapping | null>(null);
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
    setDiscordMember(null);
    setError('');
  }
  function edit(mapping: UserMapping) {
    setEditing(mapping);
    setSourceId(mapping.source_user_id);
    setTargetId(mapping.target_user_id || '');
    setTargetName(mapping.target_username);
    setDiscordName(mapping.discord_username || '');
    setDiscordId(mapping.discord_user_id || '');
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
        },
      });
      if (!mounted.current) return;
      reset();
      notify('User mapping saved. Review a migration preview before starting.');
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
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
      if (editing?.id === removing.id) reset();
      setRemoving(null);
      notify('User mapping removed. The server accounts were preserved.');
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <Heading
        title="Connect the right accounts."
        description="Link an Emby user to an existing Jellyfin account or a simpler new username."
        actions={
          <button className="btn" onClick={() => void refresh()} disabled={busy}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <UserWarnings users={users} />
      <Callout icon="shield" title="Mappings are approved by you.">
        Usernames can differ across Emby, Jellyfin, and Discord. Search for a Discord member to link
        their stable identity automatically. Saving a mapping does not create an account or send a
        message.
      </Callout>
      <div className="stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>{editing ? 'Edit user mapping' : 'Add a user mapping'}</h2>
              <p>Choose the destination explicitly, then migrate the Emby user as usual.</p>
            </div>
            <span className="server-icon jellyfin">
              <Icon name="link" />
            </span>
          </div>
          <div className="panel-body">
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
                {editing && (
                  <button type="button" className="btn" onClick={reset} disabled={busy}>
                    Cancel edit
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
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Saved mappings</h2>
              <p>Each Emby account has one approved Jellyfin destination.</p>
            </div>
          </div>
          {mappings.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Emby</th>
                    <th>Jellyfin</th>
                    <th>Discord</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((mapping) => (
                    <tr key={mapping.id}>
                      <td>
                        <strong>{mapping.source_username}</strong>
                      </td>
                      <td>
                        <strong>{mapping.target_username}</strong>
                        <small>
                          {mapping.target_user_id ? 'Existing account' : 'Create during migration'}
                        </small>
                      </td>
                      <td>
                        {mapping.discord_username || 'No username label'}
                        <small>
                          {mapping.discord_user_id
                            ? `Verified user ID: ${mapping.discord_user_id}`
                            : 'No verified Discord identity'}
                        </small>
                      </td>
                      <td className="right">
                        <button
                          className="btn btn-quiet"
                          onClick={() => edit(mapping)}
                          disabled={busy}
                          aria-label={`Edit mapping for ${mapping.source_username}`}
                        >
                          Edit
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => {
                            setError('');
                            setRemoving(mapping);
                          }}
                          disabled={busy}
                          aria-label={`Remove mapping for ${mapping.source_username}`}
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon="link"
              title="Use the names that work for your users."
              text="Add a mapping when an Emby account and its Jellyfin or Discord identity use different usernames."
            />
          )}
        </section>
      </div>
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
    </>
  );
}
