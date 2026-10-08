import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, Loading, Modal } from './components';
import { UserWarnings } from './SettingsPage';
import type {
  AccountRole,
  Api,
  Job,
  Notify,
  RoleAssignment,
  RoleParameters,
  RoleSection,
  Users,
} from './types';

const sections: { id: RoleSection; name: string; description: string }[] = [
  {
    id: 'policy',
    name: 'Permissions',
    description: 'Library access, remote access, downloads, and playback permissions.',
  },
  {
    id: 'configuration',
    name: 'Account preferences',
    description: 'Supported language, subtitle, autoplay, and library preferences.',
  },
  {
    id: 'display',
    name: 'Home and display preferences',
    description: 'Supported server-backed home layout and display options.',
  },
];

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'The account role could not be updated.';
const fieldName = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const fieldValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.length ? value.map(fieldValue).join(', ') : 'None';
  if (typeof value === 'object')
    return Object.entries(value)
      .map(([key, nested]) => `${fieldName(key)}: ${fieldValue(nested)}`)
      .join('; ');
  return String(value);
};

function ParameterPreview({ parameters }: { parameters: RoleParameters }) {
  return (
    <div className="roles-parameters">
      {sections.map((section) => {
        const values = Object.entries(parameters[section.id] || {});
        return (
          <details key={section.id} className="roles-parameter-group">
            <summary>
              {section.name} <span>{values.length} saved fields</span>
            </summary>
            <p>{section.description}</p>
            {values.length ? (
              <dl>
                {values.map(([key, value]) => (
                  <div key={key}>
                    <dt>{fieldName(key)}</dt>
                    <dd>{fieldValue(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p>No supported settings were captured for this group.</p>
            )}
          </details>
        );
      })}
    </div>
  );
}

interface ApplyReview {
  role: AccountRole;
  userIds: string[];
  usernames: string[];
  sections: RoleSection[];
}

export default function AccountRolesPage({
  users,
  api,
  notify,
  created,
  templateUserId,
  defaultRoleId,
}: {
  users: Users;
  api: Api;
  notify: Notify;
  created: (job: Job) => void;
  templateUserId?: string;
  defaultRoleId?: string;
}) {
  const [roles, setRoles] = useState<AccountRole[]>([]);
  const [assignments, setAssignments] = useState<RoleAssignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [roleId, setRoleId] = useState('');
  const [revision, setRevision] = useState('');
  const [name, setName] = useState('');
  const [parameters, setParameters] = useState<RoleParameters | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [chosenSections, setChosenSections] = useState<RoleSection[]>([]);
  const [review, setReview] = useState<ApplyReview | null>(null);
  const [removing, setRemoving] = useState<AccountRole | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const loadGeneration = useRef(0);
  const importGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const controllers = useRef(new Set<AbortController>());

  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (mounted.current) setLoading(true);
    try {
      const data = await api<{ roles: AccountRole[]; assignments: RoleAssignment[] }>(
        '/api/account-roles',
        { signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted || generation !== loadGeneration.current)
        return false;
      setRoles(data.roles);
      setAssignments(data.assignments);
      setLoaded(true);
      return true;
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && generation === loadGeneration.current)
        setError(message(reason));
      return false;
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      ++loadGeneration.current;
      ++importGeneration.current;
      loadController.current?.abort();
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [reload]);

  const sourceUsers = users.jellyfin.filter(
    (user) => user.Policy?.IsAdministrator === false && user.Policy?.IsDisabled === false,
  );
  const targets = sourceUsers.filter((user) => user.Id !== templateUserId);
  const visibleTargets = targets.filter((user) =>
    user.Name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selectedTargets = targets.filter((user) => selected.includes(user.Id));
  const role = roles.find((item) => item.id === roleId);
  const stale = Boolean(role && revision !== role.revision);
  const readyRole = role && !dirty && !stale && !loading ? role : null;
  const canApply = Boolean(
    readyRole &&
    selectedTargets.length &&
    chosenSections.length &&
    selectedTargets.every((user) =>
      assignments.some(
        (assignment) => assignment.user_id === user.Id && assignment.role_id === roleId,
      ),
    ),
  );
  const visibleSelected = visibleTargets.filter((user) => selected.includes(user.Id)).length;
  const allVisibleSelected = Boolean(
    visibleSelected && (visibleSelected === visibleTargets.length || selectedTargets.length >= 100),
  );

  function selectRole(id: string) {
    ++importGeneration.current;
    const item = roles.find((saved) => saved.id === id);
    setRoleId(item?.id || '');
    setRevision(item?.revision || '');
    setName(item?.name || '');
    setParameters(item?.parameters || null);
    setSourceId('');
    setWarnings([]);
    setDirty(false);
    setChosenSections([]);
    setReview(null);
    setError('');
  }

  async function mutate(action: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(message(reason));
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function importSettings() {
    if (!sourceId) return;
    const generation = ++importGeneration.current;
    void mutate(async (signal) => {
      const result = await api<{ parameters: RoleParameters; warnings: string[] }>(
        '/api/account-roles/import',
        { method: 'POST', body: { user_id: sourceId }, signal },
      );
      if (!mounted.current || signal.aborted || generation !== importGeneration.current) return;
      setParameters(result.parameters);
      setWarnings(result.warnings);
      setDirty(true);
      setReview(null);
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parameters || !name.trim()) return;
    void mutate(async (signal) => {
      const result = await api<AccountRole>('/api/account-roles', {
        method: 'POST',
        body: {
          ...(roleId ? { id: roleId, revision } : {}),
          name: name.trim(),
          parameters,
        },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setRoleId(result.id);
      setRevision(result.revision);
      setName(result.name);
      setParameters(result.parameters);
      setDirty(false);
      setReview(null);
      await reload();
      if (mounted.current && !signal.aborted)
        notify('Account role saved. Existing accounts were not changed.');
    });
  }

  function assign() {
    if (!readyRole || !selectedTargets.length) return;
    void mutate(async (signal) => {
      await api('/api/account-roles/assign', {
        method: 'POST',
        body: {
          role_id: readyRole.id,
          role_revision: readyRole.revision,
          user_ids: selectedTargets.map((user) => user.Id),
        },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      await reload();
      if (mounted.current && !signal.aborted)
        notify('Role assigned. Use Review changes to update Jellyfin settings.');
    });
  }

  function unassign() {
    if (!selectedTargets.length) return;
    void mutate(async (signal) => {
      await api('/api/account-roles/unassign', {
        method: 'POST',
        body: { user_ids: selectedTargets.map((user) => user.Id) },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      await reload();
      if (mounted.current && !signal.aborted)
        notify('Roles unassigned. Jellyfin settings were preserved.');
    });
  }

  function apply() {
    if (!review) return;
    const snapshot = review;
    void mutate(async (signal) => {
      const job = await api<Job>('/api/account-roles/apply', {
        method: 'POST',
        body: {
          role_id: snapshot.role.id,
          role_revision: snapshot.role.revision,
          user_ids: snapshot.userIds,
          sections: snapshot.sections,
        },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      setReview(null);
      created(job);
      notify('Role update queued. Track each account in Activity.');
      await reload();
    });
  }

  function remove() {
    if (!removing) return;
    const snapshot = removing;
    void mutate(async (signal) => {
      await api(`/api/account-roles/${encodeURIComponent(snapshot.id)}`, {
        method: 'DELETE',
        body: { revision: snapshot.revision },
        signal,
      });
      if (!mounted.current || signal.aborted) return;
      selectRole('');
      setRemoving(null);
      await reload();
      if (mounted.current && !signal.aborted) notify('Account role removed.');
    });
  }

  return (
    <>
      <Heading
        title="Set the experience once."
        description="Save permissions and preferences as Jellyport roles, then apply selected groups when you choose."
        actions={
          <button
            className="btn"
            disabled={busy || loading}
            onClick={() => {
              setError('');
              void reload();
            }}
          >
            <Icon name="refresh" /> Refresh roles
          </button>
        }
      />
      <UserWarnings users={users} />
      <Callout icon="shield" title="A saved role is a reusable snapshot.">
        Copy supported settings from a Jellyfin account. Saving or assigning a role leaves existing
        accounts unchanged. Choose the default role in Settings for future accounts; update existing
        accounts separately below.
      </Callout>
      {error && !review && !removing && (
        <div className="error-block" role="alert">
          {error}
        </div>
      )}
      {loading && !loaded ? (
        <Loading>Loading account roles…</Loading>
      ) : !loaded ? (
        <Empty
          icon="settings"
          title="Account roles could not be loaded."
          text="Refresh to try again."
        />
      ) : (
        <div className="stack roles-page">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>{role ? 'Edit saved role' : 'Create an account role'}</h2>
                <p>Copy from another account whenever you want to revise the defaults.</p>
              </div>
              <span className="server-icon jellyfin">
                <Icon name="settings" />
              </span>
            </div>
            <div className="panel-body">
              <form className="form-stack" onSubmit={save}>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="roles-saved">Saved role</label>
                    <select
                      id="roles-saved"
                      value={roleId}
                      disabled={busy}
                      onChange={(event) => selectRole(event.target.value)}
                    >
                      <option value="">Create a new role</option>
                      {roles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.id === defaultRoleId ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="roles-name">Role name</label>
                    <input
                      id="roles-name"
                      value={name}
                      maxLength={64}
                      required
                      disabled={busy}
                      autoComplete="off"
                      onChange={(event) => {
                        setName(event.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                </div>
                <div className="roles-import-row">
                  <div className="field">
                    <label htmlFor="roles-source">Copy settings from</label>
                    <select
                      id="roles-source"
                      value={sourceId}
                      disabled={busy}
                      onChange={(event) => {
                        ++importGeneration.current;
                        setSourceId(event.target.value);
                        setParameters(null);
                        setWarnings([]);
                        setDirty(true);
                        setReview(null);
                      }}
                    >
                      <option value="">Choose a Jellyfin account</option>
                      {sourceUsers.map((user) => (
                        <option key={user.Id} value={user.Id}>
                          {user.Name}
                          {user.Id === templateUserId ? ' (template)' : ''}
                        </option>
                      ))}
                    </select>
                    <small>
                      Administrator and disabled accounts cannot be copied. The source account is
                      unchanged.
                    </small>
                  </div>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !sourceId}
                    onClick={importSettings}
                  >
                    <Icon name="copy" /> Copy settings
                  </button>
                </div>
                {parameters && <ParameterPreview parameters={parameters} />}
                {warnings.length > 0 && (
                  <div className="roles-warnings" role="status">
                    <strong>Import notes</strong>
                    <ul>
                      {warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="roles-help">
                  Home layouts and playback options vary by client. Only supported server-backed
                  preferences are copied; device-local options stay with each client.
                </p>
                {stale && (
                  <div className="error-block" role="alert">
                    This role changed after you opened it. Reload the saved role before editing or
                    applying it.
                  </div>
                )}
                <div className="form-actions roles-editor-actions">
                  {role && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => selectRole(role.id)}
                    >
                      Reload saved role
                    </button>
                  )}
                  {role && (
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        busy ||
                        role.id === defaultRoleId ||
                        assignments.some((assignment) => assignment.role_id === role.id)
                      }
                      onClick={() => {
                        setError('');
                        setRemoving(role);
                      }}
                    >
                      <Icon name="trash" /> Remove role
                    </button>
                  )}
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={busy || !parameters || !name.trim() || stale}
                  >
                    {role ? 'Replace saved role' : 'Save new role'}
                  </button>
                </div>
                {role &&
                  (role.id === defaultRoleId ||
                    assignments.some((assignment) => assignment.role_id === role.id)) && (
                    <p className="roles-help">
                      Unassign this role and change the default in Settings before removing it.
                    </p>
                  )}
              </form>
            </div>
          </section>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Manage existing accounts</h2>
                <p>Assign a saved role, then review the setting groups you want to apply.</p>
              </div>
              <span className="roles-count">{selectedTargets.length} selected</span>
            </div>
            <div className="panel-body form-stack">
              {!role && (
                <p className="roles-help">Select or save a role above to assign it to accounts.</p>
              )}
              {dirty && role && (
                <p className="roles-help">
                  Save your changes or reload the saved role before assigning or applying it.
                </p>
              )}
              <div className="field">
                <label htmlFor="roles-user-search">Find Jellyfin accounts</label>
                <input
                  id="roles-user-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoComplete="off"
                  placeholder="Search usernames"
                  disabled={busy}
                />
              </div>
              {targets.length ? (
                <div className="roles-targets">
                  <label className="roles-target roles-select-all">
                    <input
                      className="checkbox"
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={
                        busy ||
                        !visibleTargets.length ||
                        (selectedTargets.length >= 100 && !visibleSelected)
                      }
                      onChange={() =>
                        setSelected((ids) =>
                          allVisibleSelected
                            ? ids.filter((id) => !visibleTargets.some((user) => user.Id === id))
                            : [
                                ...new Set([
                                  ...ids.filter((id) => targets.some((user) => user.Id === id)),
                                  ...visibleTargets.map((user) => user.Id),
                                ]),
                              ].slice(0, 100),
                        )
                      }
                    />
                    <span>Select up to 100 visible accounts</span>
                  </label>
                  {visibleTargets.map((user) => {
                    const assignment = assignments.find((item) => item.user_id === user.Id);
                    const assignedRole =
                      assignment && roles.find((item) => item.id === assignment.role_id);
                    return (
                      <label className="roles-target" key={user.Id}>
                        <input
                          className="checkbox"
                          type="checkbox"
                          checked={selected.includes(user.Id)}
                          disabled={
                            busy || (selectedTargets.length >= 100 && !selected.includes(user.Id))
                          }
                          onChange={() =>
                            setSelected((ids) =>
                              ids.includes(user.Id)
                                ? ids.filter((id) => id !== user.Id)
                                : [
                                    ...ids.filter((id) =>
                                      targets.some((target) => target.Id === id),
                                    ),
                                    user.Id,
                                  ].slice(0, 100),
                            )
                          }
                        />
                        <span>
                          <strong>{user.Name}</strong>
                          <small>
                            {assignedRole
                              ? `${assignedRole.name} · ${assignment?.applied_revision === assignedRole.revision ? 'Up to date' : 'Not fully applied'}`
                              : assignment
                                ? 'Assigned role unavailable'
                                : 'No role assigned'}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                  {!visibleTargets.length && (
                    <p className="roles-help roles-no-match">No matching accounts.</p>
                  )}
                </div>
              ) : (
                <p className="roles-help">
                  No eligible Jellyfin accounts. Administrators, disabled accounts, and the template
                  account are excluded.
                </p>
              )}
              <div className="roles-assignment-actions">
                <small>Update up to 100 accounts at a time.</small>
                {selectedTargets.length > 0 && (
                  <button className="btn" disabled={busy} onClick={() => setSelected([])}>
                    Clear selection
                  </button>
                )}
              </div>
              <div className="roles-assignment-actions">
                <button
                  className="btn"
                  disabled={busy || !readyRole || !selectedTargets.length}
                  onClick={assign}
                >
                  Assign role
                </button>
                <button
                  className="btn"
                  disabled={
                    busy ||
                    !selectedTargets.some((user) =>
                      assignments.some((assignment) => assignment.user_id === user.Id),
                    )
                  }
                  onClick={unassign}
                >
                  Unassign role
                </button>
                <small>Assignment alone does not change Jellyfin settings.</small>
              </div>
              <fieldset className="roles-section-picker" disabled={busy || !readyRole}>
                <legend>Setting groups to apply</legend>
                {sections.map((section) => (
                  <label key={section.id}>
                    <input
                      className="checkbox"
                      type="checkbox"
                      checked={chosenSections.includes(section.id)}
                      disabled={!role || !Object.keys(role.parameters[section.id] || {}).length}
                      onChange={() =>
                        setChosenSections((selectedSections) =>
                          selectedSections.includes(section.id)
                            ? selectedSections.filter((id) => id !== section.id)
                            : [...selectedSections, section.id],
                        )
                      }
                    />
                    <span>
                      <strong>{section.name}</strong>
                      <small>{section.description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {role &&
                selectedTargets.length > 0 &&
                selectedTargets.some(
                  (user) =>
                    !assignments.some(
                      (assignment) =>
                        assignment.user_id === user.Id && assignment.role_id === roleId,
                    ),
                ) && (
                  <p className="roles-help">
                    Assign this role to every selected account before applying settings.
                  </p>
                )}
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || !canApply}
                  onClick={() => {
                    if (readyRole) {
                      setError('');
                      setReview({
                        role: readyRole,
                        userIds: selectedTargets.map((user) => user.Id),
                        usernames: selectedTargets.map((user) => user.Name),
                        sections: [...chosenSections],
                      });
                    }
                  }}
                >
                  Review changes
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {review && (
        <Modal
          title="Apply role settings?"
          description={`Apply ${review.role.name} to ${review.userIds.length} ${review.userIds.length === 1 ? 'account' : 'accounts'}.`}
          close={() => {
            if (!busy) setReview(null);
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setReview(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={apply}>
                {busy ? 'Queuing…' : 'Apply settings'}
              </button>
            </>
          }
        >
          {error && (
            <div className="error-block" role="alert">
              {error}
            </div>
          )}
          <p>
            The selected groups will replace the corresponding Jellyfin settings. Passwords, watch
            history, favorites, and playlists are preserved.
          </p>
          <div className="roles-review">
            <h3>Accounts</h3>
            <ul>
              {review.usernames.map((username, index) => (
                <li key={review.userIds[index]}>{username}</li>
              ))}
            </ul>
            <h3>Setting groups</h3>
            <ul>
              {review.sections.map((section) => (
                <li key={section}>{sections.find((item) => item.id === section)?.name}</li>
              ))}
            </ul>
          </div>
          <p className="roles-help">
            Client-local settings cannot be controlled by a role. You can track per-account results
            in Activity.
          </p>
        </Modal>
      )}
      {removing && (
        <Modal
          title="Remove account role?"
          description={removing.name}
          close={() => {
            if (!busy) setRemoving(null);
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={remove}>
                Remove role
              </button>
            </>
          }
        >
          {error && (
            <div className="error-block" role="alert">
              {error}
            </div>
          )}
          <p>This removes the saved role. Jellyfin accounts and their settings are preserved.</p>
        </Modal>
      )}
    </>
  );
}
