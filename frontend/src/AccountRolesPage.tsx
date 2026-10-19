import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouteTab } from './routing';
import { useWorkspaceDraftState } from './workspace-drafts';
import { Empty, Heading, Icon, Loading, Modal } from './components';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
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
    description: 'Languages, subtitles, autoplay, library order, and Home library visibility.',
  },
  {
    id: 'display',
    name: 'Home and display preferences',
    description: 'Shared server-backed Home rows, TV layout, and display options.',
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
  const [view, setView] = useRouteTab('roles');
  const [roleQuery, setRoleQuery] = useState('');
  const [roles, setRoles] = useState<AccountRole[]>([]);
  const [assignments, setAssignments] = useState<RoleAssignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [roleId, setRoleId] = useWorkspaceDraftState('roles.roleId', '');
  const [revision, setRevision] = useWorkspaceDraftState('roles.revision', '');
  const [name, setName] = useWorkspaceDraftState('roles.name', '');
  const [parameters, setParameters] = useWorkspaceDraftState<RoleParameters | null>(
    'roles.parameters',
    null,
  );
  const [sourceId, setSourceId] = useWorkspaceDraftState('roles.sourceId', '');
  const [warnings, setWarnings] = useWorkspaceDraftState<string[]>('roles.importNotes', []);
  const [dirty, setDirty] = useWorkspaceDraftState('roles.dirty', false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [chosenSections, setChosenSections] = useState<RoleSection[]>([]);
  const [review, setReview] = useState<ApplyReview | null>(null);
  const [removing, setRemoving] = useState<AccountRole | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    if (busyRef.current) return;
    setReview(null);
    setRemoving(null);
  }, [view]);
  const loadGeneration = useRef(0);
  const importGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const controllers = useRef(new Set<AbortController>());

  const reload = useCallback(
    async (manual = false) => {
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
        if (manual) notify('Account roles refreshed.');
        return true;
      } catch (reason) {
        if (
          mounted.current &&
          !controller.signal.aborted &&
          generation === loadGeneration.current
        ) {
          setError(message(reason));
          if (manual) notify(message(reason), true);
        }
        return false;
      } finally {
        if (mounted.current && generation === loadGeneration.current) setLoading(false);
      }
    },
    [api, notify],
  );

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
  const accountPage = usePagination(visibleTargets, 25, query);
  const filteredRoles = roles.filter((item) =>
    item.name.toLocaleLowerCase().includes(roleQuery.trim().toLocaleLowerCase()),
  );
  const rolePage = usePagination(filteredRoles, 25, roleQuery);
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
  const visibleSelected = accountPage.items.filter((user) => selected.includes(user.Id)).length;
  const allVisibleSelected = Boolean(
    visibleSelected &&
    (visibleSelected === accountPage.items.length || selectedTargets.length >= 100),
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
      if (mounted.current && !controller.signal.aborted) {
        setError(message(reason));
        notify(message(reason), true);
      }
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
      notify('Account settings imported into the role draft. Save the role to keep them.');
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
    <div className="page-stack">
      <Heading
        title="Account roles"
        description="Save reusable permissions and preferences, then review changes before applying them."
        actions={
          <button
            className="btn btn-quiet"
            disabled={busy || loading}
            aria-busy={loading}
            onClick={() => {
              setError('');
              void reload(true);
            }}
          >
            <Icon name="refresh" /> Refresh roles
          </button>
        }
      />
      <UserWarnings users={users} />
      <Tabs
        id="role-views"
        label="Account role tasks"
        tabs={[
          { id: 'list', label: 'Saved roles', count: roles.length },
          { id: 'editor', label: dirty ? 'Role draft' : 'Role editor' },
          { id: 'apply', label: 'Apply role' },
        ]}
        value={view}
        onChange={setView}
      />
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
        <div className="page-stack roles-page">
          <TabPanel id="role-views" tabId="list" active={view === 'list'}>
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Saved roles</h2>
                  <p>Review reusable defaults or apply a saved role to existing accounts.</p>
                </div>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => {
                    selectRole('');
                    setView('editor');
                  }}
                >
                  Create role
                </button>
              </div>
              <div className="panel-body directory-toolbar">
                <div className="field">
                  <label htmlFor="role-search">Find saved roles</label>
                  <input
                    id="role-search"
                    type="search"
                    value={roleQuery}
                    onChange={(event) => setRoleQuery(event.target.value)}
                    placeholder="Search role names"
                  />
                </div>
              </div>
              {rolePage.total ? (
                <div className="panel-body record-list">
                  {rolePage.items.map((item) => (
                    <article className="summary-card" key={item.id}>
                      <div>
                        <h3>{item.name}</h3>
                        <p className="section-note">
                          {item.id === defaultRoleId ? 'Default for new accounts · ' : ''}
                          {
                            assignments.filter((assignment) => assignment.role_id === item.id)
                              .length
                          }{' '}
                          assigned accounts
                        </p>
                        <p className="section-note">
                          {sections
                            .filter(
                              (section) => Object.keys(item.parameters[section.id] || {}).length,
                            )
                            .map((section) => section.name)
                            .join(' · ') || 'No saved parameter groups'}
                        </p>
                      </div>
                      <div className="toolbar">
                        <button
                          className="btn"
                          disabled={busy}
                          aria-label={`Edit role ${item.name}`}
                          onClick={() => {
                            selectRole(item.id);
                            setView('editor');
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          aria-label={`Apply role ${item.name}`}
                          onClick={() => {
                            selectRole(item.id);
                            setView('apply');
                          }}
                        >
                          Apply to accounts
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  icon="settings"
                  title={roles.length ? 'No matching roles' : 'No saved roles'}
                  text="Create a role by copying supported settings from a Jellyfin account."
                />
              )}
              <Pagination
                label="Saved roles"
                page={rolePage.page}
                total={rolePage.total}
                pageSize={rolePage.pageSize}
                onPageChange={rolePage.setPage}
                onPageSizeChange={rolePage.setPageSize}
              />
            </section>
          </TabPanel>
          <div hidden={view === 'list'} className="role-selection-toolbar">
            <div className="field">
              <label htmlFor="roles-saved">Saved role</label>
              <select
                id="roles-saved"
                value={roleId}
                disabled={busy}
                onChange={(event) => selectRole(event.target.value)}
              >
                <option value="">
                  {view === 'apply' ? 'Choose a saved role' : 'Create a new role'}
                </option>
                {roles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.id === defaultRoleId ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <TabPanel id="role-views" tabId="editor" active={view === 'editor'}>
            <section className="panel task-panel">
              <div className="panel-header">
                <div>
                  <h2>{role ? 'Edit saved role' : 'Create an account role'}</h2>
                  <p>Copy from another account whenever you want to revise the defaults.</p>
                </div>
                <span className={`status${stale || dirty ? ' warn' : ''}`}>
                  {stale
                    ? 'Needs refresh'
                    : dirty
                      ? 'Unsaved changes'
                      : role
                        ? 'Saved role'
                        : 'New role'}
                </span>
              </div>
              <div className="panel-body">
                <form className="form-stack" onSubmit={save}>
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
                      aria-busy={busy}
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
                  <details className="help-details">
                    <summary>About copied preferences</summary>
                    <p>
                      Copies shared server-backed Home settings used by Jellyfin Web and compatible
                      TV/mobile apps. Device-local options stay with each client.
                    </p>
                  </details>
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
                      <p className="section-note roles-help">
                        Unassign this role and change the default in Settings before removing it.
                      </p>
                    )}
                </form>
              </div>
            </section>
          </TabPanel>
          <TabPanel id="role-views" tabId="apply" active={view === 'apply'}>
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Apply to existing accounts</h2>
                  <p>Select accounts, assign this role, and review the settings to update.</p>
                </div>
                <span className="status">{selectedTargets.length} selected</span>
              </div>
              <div className="panel-body form-stack">
                {!role && (
                  <p className="section-note roles-help">
                    Select or save a role in the editor to assign it to accounts.
                  </p>
                )}
                {dirty && role && (
                  <p className="section-note roles-help">
                    Save your changes or reload the saved role before assigning or applying it.
                  </p>
                )}
                {stale && (
                  <div className="error-block" role="alert">
                    This saved role changed. Reload it before assigning or applying settings.{' '}
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => role && selectRole(role.id)}
                    >
                      Reload saved role
                    </button>
                  </div>
                )}
                {dirty && role && (
                  <button className="btn" disabled={busy} onClick={() => setView('editor')}>
                    Return to role draft
                  </button>
                )}
                <div className="task-grid">
                  <div className="form-stack">
                    <h3>1. Choose accounts</h3>
                    <div className="field">
                      <label htmlFor="roles-user-search">Find Jellyfin accounts</label>
                      <input
                        id="roles-user-search"
                        type="search"
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
                              !accountPage.items.length ||
                              (selectedTargets.length >= 100 && !visibleSelected)
                            }
                            onChange={() =>
                              setSelected((ids) =>
                                allVisibleSelected
                                  ? ids.filter(
                                      (id) => !accountPage.items.some((user) => user.Id === id),
                                    )
                                  : [
                                      ...new Set([
                                        ...ids.filter((id) =>
                                          targets.some((user) => user.Id === id),
                                        ),
                                        ...accountPage.items.map((user) => user.Id),
                                      ]),
                                    ].slice(0, 100),
                              )
                            }
                          />
                          <span>Select this page</span>
                        </label>
                        {accountPage.items.map((user) => {
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
                                  busy ||
                                  (selectedTargets.length >= 100 && !selected.includes(user.Id))
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
                        {!accountPage.items.length && (
                          <p className="roles-help roles-no-match">No matching accounts.</p>
                        )}
                      </div>
                    ) : (
                      <p className="section-note roles-help">
                        No eligible Jellyfin accounts. Administrators, disabled accounts, and the
                        template account are excluded.
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
                    <Pagination
                      label="Role accounts"
                      page={accountPage.page}
                      total={accountPage.total}
                      pageSize={accountPage.pageSize}
                      onPageChange={accountPage.setPage}
                      onPageSizeChange={accountPage.setPageSize}
                    />
                  </div>
                  <div className="form-stack workflow-controls">
                    <h3>2. Assign the saved role</h3>
                    <div className="toolbar roles-assignment-actions">
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
                    </div>
                    <p className="section-note">
                      Assignment alone does not change Jellyfin settings.
                    </p>
                    <h3>3. Choose settings to update</h3>
                    <fieldset className="roles-section-picker" disabled={busy || !readyRole}>
                      <legend>Setting groups to apply</legend>
                      {sections.map((section) => (
                        <label key={section.id}>
                          <input
                            className="checkbox"
                            type="checkbox"
                            checked={chosenSections.includes(section.id)}
                            disabled={
                              !role || !Object.keys(role.parameters[section.id] || {}).length
                            }
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
                    <p className="section-note roles-help">
                      Include Account preferences to also copy library order, Home library
                      visibility, and Latest Media preferences.
                    </p>
                    {role &&
                      selectedTargets.length > 0 &&
                      selectedTargets.some(
                        (user) =>
                          !assignments.some(
                            (assignment) =>
                              assignment.user_id === user.Id && assignment.role_id === roleId,
                          ),
                      ) && (
                        <p className="section-note roles-help">
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
                </div>
              </div>
            </section>
          </TabPanel>
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
          <p className="section-note roles-help">
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
              <button className="btn btn-danger" disabled={busy} onClick={remove}>
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
    </div>
  );
}
