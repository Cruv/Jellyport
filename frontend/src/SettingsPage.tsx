import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Callout, Heading, Icon } from './components';
import { Tabs, TabPanel } from './ui-layout';
import AdminAlertsPanel from './AdminAlertsPanel';
import SourceSnapshotsPanel from './SourceSnapshotsPanel';
import DestinationCatalogPanel from './DestinationCatalogPanel';
import {
  DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
  MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH,
  renderCredentialMessage,
  validateCredentialMessageTemplate,
} from '../../server/credential-message';
import {
  safeUrl,
  defaultMembershipTiers,
  type Api,
  type Connections,
  type Notify,
  type Settings,
  type Users,
  type AccountRole,
  type MembershipTier,
} from './types';

const settingsTabs = [
  { id: 'media', label: 'Servers' },
  { id: 'accounts', label: 'Account defaults' },
  { id: 'discord', label: 'Discord' },
  { id: 'automation', label: 'Automation' },
  { id: 'history', label: 'Saved history' },
];
function settingsTabFromHash() {
  const value = window.location.hash.replace('#settings-', '');
  return settingsTabs.some((tab) => tab.id === value) ? value : 'media';
}
const toggleNames = [
  'discord_enabled',
  'discord_role_events',
  'discord_message_events',
  'auto_provision',
  'auto_disable',
  'disable_on_cancel',
] as const;
function Field({
  name,
  label,
  value = '',
  secret = false,
  saved = false,
  type = 'text',
  placeholder,
  hint,
  optional = false,
  numeric = false,
  readOnly = false,
}: {
  name: string;
  label: string;
  value?: string;
  secret?: boolean;
  saved?: boolean;
  type?: string;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  numeric?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={`setting-${name}`}>
        {label}
        {optional && <span className="optional">optional</span>}
        {secret && saved && <span className="optional mint">saved</span>}
      </label>
      <input
        id={`setting-${name}`}
        name={name}
        type={type}
        defaultValue={secret ? '' : value}
        placeholder={placeholder || (secret && saved ? 'Saved · leave blank to keep' : '')}
        inputMode={numeric ? 'numeric' : undefined}
        pattern={numeric ? '[0-9]*' : undefined}
        autoComplete={secret ? 'new-password' : 'off'}
        readOnly={readOnly}
      />
      {hint && <small>{hint}</small>}
    </div>
  );
}
function Toggle({
  name,
  label,
  description,
  checked,
}: {
  name: string;
  label: string;
  description: string;
  checked: boolean;
}) {
  return (
    <div className="toggle-row">
      <div>
        <label htmlFor={`setting-${name}`} className="switch-label">
          {label}
        </label>
        <p className="muted text-tiny mt-4">{description}</p>
      </div>
      <label className="toggle">
        <input id={`setting-${name}`} name={name} type="checkbox" defaultChecked={checked} />
        <span className="toggle-track" />
      </label>
    </div>
  );
}
function Section({
  icon,
  title,
  description,
  children,
}: {
  icon?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="setting-heading">
          {icon && (
            <span className={`server-icon ${icon}`}>
              <Icon name={icon} />
            </span>
          )}
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
export function ConnectionRows({ connections }: { connections: Partial<Connections> }) {
  return (
    <div className="server-list">
      {(['emby', 'jellyfin', 'discord'] as const).map((key) => {
        const conn = connections[key] || {};
        const configured = key === 'discord' ? conn.enabled : conn.configured;
        const detail = conn.connected
          ? [conn.name || (key === 'discord' ? 'Bot online' : 'Server connected'), conn.version]
              .filter(Boolean)
              .join(' · ')
          : conn.error ||
            (configured
              ? 'Connection needs attention'
              : key === 'discord'
                ? 'Optional account delivery'
                : 'Add server details in Settings');
        return (
          <div className="server-row" key={key}>
            <span className={`server-icon ${key}`}>
              <Icon name={key} />
            </span>
            <div className="server-name">
              <strong>{{ emby: 'Emby', jellyfin: 'Jellyfin', discord: 'Discord' }[key]}</strong>
              <small title={detail}>{detail}</small>
            </div>
            <span className={`status ${conn.connected ? 'good' : configured ? 'warn' : ''}`}>
              {conn.connected
                ? 'Connected'
                : configured
                  ? 'Offline'
                  : key === 'discord'
                    ? 'Optional'
                    : 'Not set up'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
export function UserWarnings({ users }: { users: Users }) {
  return (
    <>
      {Object.entries(users.errors || {}).map(([server, message]) => (
        <Callout
          key={server}
          icon="warning"
          warning
          title={`${server === 'jellyfin' ? 'Jellyfin' : 'Emby'} users could not be loaded.`}
        >
          {message} Check the saved connection and try again.
        </Callout>
      ))}
    </>
  );
}
export default function SettingsPage({
  settings: s,
  users,
  demo,
  api,
  notify,
  refresh,
}: {
  settings: Settings;
  users: Users;
  demo: boolean;
  api: Api;
  notify: Notify;
  refresh: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState(settingsTabFromHash);
  const [serverTab, setServerTab] = useState('emby');
  const [accountTab, setAccountTab] = useState('permissions');
  const [discordTab, setDiscordTab] = useState('connection');
  const [automationTab, setAutomationTab] = useState('tiers');
  const [selectedTier, setSelectedTier] = useState(0);
  const [historyTab, setHistoryTab] = useState('emby');
  const [dirty, setDirty] = useState(false);
  const [validationRevision, setValidationRevision] = useState(0);
  const pendingFocus = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(
    null,
  );
  useEffect(() => {
    const update = () => setActiveTab(settingsTabFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const element = pendingFocus.current;
    if (!element) return;
    pendingFocus.current = null;
    element.focus();
    element.reportValidity();
  }, [validationRevision]);
  function selectTab(value: string) {
    setActiveTab(value);
    window.history.replaceState(null, '', `#settings-${value}`);
  }
  function revealField(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) {
    if (!element) return;
    const group = element.closest<HTMLElement>('[data-settings-main]')?.dataset.settingsMain;
    const subsection = element.closest<HTMLElement>('[data-settings-sub]')?.dataset.settingsSub;
    const tier = element.closest<HTMLElement>('[data-settings-tier]')?.dataset.settingsTier;
    if (group) selectTab(group);
    if (subsection) {
      if (group === 'media') setServerTab(subsection);
      if (group === 'accounts') setAccountTab(subsection);
      if (group === 'discord') setDiscordTab(subsection);
      if (group === 'automation') setAutomationTab(subsection);
    }
    if (tier !== undefined) setSelectedTier(Number(tier));
    pendingFocus.current = element;
    setValidationRevision((value) => value + 1);
  }
  const [mappings, setMappings] = useState(s.path_mappings || []);
  const [membershipTiers, setMembershipTiers] = useState<MembershipTier[]>(
    (s.membership_tiers || defaultMembershipTiers).map((tier) => ({ ...tier })),
  );
  const [busy, setBusy] = useState('');
  const [tested, setTested] = useState<Partial<Connections> | null>(null);
  const [roles, setRoles] = useState<AccountRole[]>([]);
  const [rolesError, setRolesError] = useState('');
  const [defaultRoleId, setDefaultRoleId] = useState(s.default_role_id || '');
  const [passwordLength, setPasswordLength] = useState(String(s.password_length ?? 12));
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(s.password_exclude_ambiguous ?? true);
  const [credentialTemplate, setCredentialTemplate] = useState(
    s.credential_message_template ?? DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
  );
  const replacementKey = useRef<HTMLInputElement | null>(null);
  const serviceKeyRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const keyField = replacementKey.current;
    return () => {
      if (keyField) keyField.value = '';
      serviceKeyRequest.current?.abort();
    };
  }, []);
  useEffect(() => setDefaultRoleId(s.default_role_id || ''), [s.default_role_id]);
  useEffect(() => setPasswordLength(String(s.password_length ?? 12)), [s.password_length]);
  useEffect(
    () => setExcludeAmbiguous(s.password_exclude_ambiguous ?? true),
    [s.password_exclude_ambiguous],
  );
  useEffect(
    () =>
      setCredentialTemplate(s.credential_message_template ?? DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE),
    [s.credential_message_template],
  );
  useEffect(() => {
    const controller = new AbortController();
    void api<{ roles: AccountRole[] }>('/api/account-roles', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setRoles(value.roles);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRolesError('Account roles could not be loaded. Refresh before changing the default.');
      });
    return () => controller.abort();
  }, [api]);
  const jfUsers = users.jellyfin.filter(
    (user) => !user.Policy?.IsAdministrator && !user.Policy?.IsDisabled,
  );
  const invite = safeUrl(s.bot_invite_url);
  let credentialPreview = '';
  let credentialPreviewError = '';
  try {
    credentialPreview = renderCredentialMessage(credentialTemplate, {
      username: 'example_user',
      password: 'B7mQ4rX9sT6v',
      server_url: 'https://jellyfin.example.com',
    });
  } catch (error) {
    credentialPreviewError =
      error instanceof Error ? error.message : 'Enter a valid credential message template.';
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (replacementKey.current) replacementKey.current.value = '';
    setBusy('save');
    try {
      const data: Record<string, unknown> = {};
      new FormData(form).forEach((value, key) => {
        data[key] = String(value).trim();
      });
      toggleNames.forEach((key) => {
        data[key] = (form.elements.namedItem(key) as HTMLInputElement).checked;
      });
      if (!/^\d+$/.test(passwordLength)) {
        revealField(form.querySelector('#setting-password_length'));
        throw new Error('Password length must be a whole number from 12 to 64.');
      }
      data.password_length = Number(passwordLength);
      if (Number(passwordLength) < 12 || Number(passwordLength) > 64) {
        revealField(form.querySelector('#setting-password_length'));
        throw new Error('Password length must be a whole number from 12 to 64.');
      }
      data.password_exclude_ambiguous = excludeAmbiguous;
      try {
        validateCredentialMessageTemplate(credentialTemplate);
      } catch (error) {
        revealField(form.querySelector('#setting-credential_message_template'));
        throw error;
      }
      data.credential_message_template = credentialTemplate;
      data.path_mappings = mappings
        .map((row) => ({ source: row.source.trim(), target: row.target.trim() }))
        .filter((row) => row.source || row.target);
      if ((data.path_mappings as typeof mappings).some((row) => !row.source || !row.target)) {
        const index = mappings.findIndex((row) => !!row.source.trim() !== !!row.target.trim());
        revealField(
          form.querySelectorAll<HTMLInputElement>('[aria-label="Emby path prefix"]')[index] || null,
        );
        throw new Error('Each path mapping needs both an Emby prefix and a Jellyfin prefix.');
      }
      data.membership_tiers = membershipTiers.map((tier) => ({
        id: tier.id.trim(),
        name: tier.name.trim(),
        plan_name: tier.plan_name.trim(),
        account_limit: tier.account_limit,
      }));
      if (!membershipTiers.length) {
        selectTab('automation');
        setAutomationTab('tiers');
        throw new Error('Configure at least one membership tier.');
      }
      if (
        new Set(membershipTiers.map((tier) => tier.id.trim().toLowerCase())).size !==
        membershipTiers.length
      ) {
        revealField(form.querySelector('#membership-tier-id-0'));
        throw new Error('Each membership tier needs a unique stable ID.');
      }
      if (
        new Set(membershipTiers.map((tier) => tier.plan_name.trim().toLowerCase())).size !==
        membershipTiers.length
      ) {
        revealField(form.querySelector('#membership-tier-plan-0'));
        throw new Error('Each membership tier needs a unique subscription plan name.');
      }
      const invalid = [
        ...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          'input, select, textarea',
        ),
      ].find((element) => element.willValidate && !element.checkValidity());
      if (invalid) {
        revealField(invalid);
        notify(invalid.validationMessage || 'Check the highlighted setting.', true);
        return;
      }
      await api('/api/settings', { method: 'PUT', body: data });
      setDirty(false);
      notify('Settings saved. Your connections are ready to test.');
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Settings could not be saved.', true);
    } finally {
      setBusy('');
    }
  }
  async function test() {
    setBusy('test');
    try {
      const result = await api<Connections | { connections: Connections }>(
        '/api/connections/test',
        { method: 'POST', body: {} },
      );
      setTested('connections' in result ? result.connections : result);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Connection test failed.', true);
    } finally {
      setBusy('');
    }
  }
  async function replaceServiceKey() {
    if (serviceKeyRequest.current) return;
    const apiKey = replacementKey.current?.value.trim() || '';
    if (replacementKey.current) replacementKey.current.value = '';
    if (!apiKey) {
      notify('Enter a new Jellyfin API key first.', true);
      return;
    }
    const controller = new AbortController();
    serviceKeyRequest.current = controller;
    setBusy('service-key');
    try {
      await api<Settings>('/api/auth/service-key', {
        method: 'POST',
        body: { api_key: apiKey },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      notify('Jellyfin API key replaced.');
      await refresh();
    } catch (error) {
      if (controller.signal.aborted) return;
      notify(
        error instanceof Error ? error.message : 'The Jellyfin API key could not be replaced.',
        true,
      );
    } finally {
      if (serviceKeyRequest.current === controller) serviceKeyRequest.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  }
  return (
    <div className="page-stack settings-focus">
      <Heading
        title="Settings"
        description="Manage connections, account defaults, and automation one section at a time."
      />
      <UserWarnings users={users} />
      <Tabs
        id="settings"
        label="Settings sections"
        tabs={settingsTabs}
        value={activeTab}
        onChange={selectTab}
      />
      <form
        id="settings-form"
        noValidate
        onSubmit={save}
        onChange={(event) => {
          if (!['replacement-jellyfin-api-key', 'membership-tier-editor'].includes(event.target.id))
            setDirty(true);
        }}
      >
        <div className="view-toolbar settings-save-bar" hidden={activeTab === 'history'}>
          <p className="section-note">
            {dirty
              ? 'Unsaved changes · save all settings together.'
              : 'Changes across tabs save together. Secrets stay private.'}
          </p>
          <div className="button-row">
            <button className="btn btn-quiet" type="button" onClick={test} disabled={!!busy}>
              {busy === 'test' ? <span className="spinner" /> : <Icon name="refresh" />}
              {busy === 'test' ? 'Testing…' : 'Test saved connections'}
            </button>
            <button className="btn btn-primary" type="submit" disabled={demo || !!busy}>
              {busy === 'save' ? <span className="spinner" /> : <Icon name="check" />}
              {busy === 'save' ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
        {tested && activeTab !== 'history' && (
          <section className="panel connection-test-results">
            <div className="panel-header">
              <h2>Saved connection test</h2>
            </div>
            <ConnectionRows connections={tested} />
          </section>
        )}
        <TabPanel id="settings" tabId="media" active={activeTab === 'media'}>
          <section className="settings-group" data-settings-main="media" aria-label="Media servers">
            <Tabs
              id="settings-servers"
              label="Media server settings"
              tabs={[
                { id: 'emby', label: 'Emby' },
                { id: 'jellyfin', label: 'Jellyfin' },
                { id: 'paths', label: 'Path mapping' },
              ]}
              value={serverTab}
              onChange={setServerTab}
            />
            <TabPanel id="settings-servers" tabId="emby" active={serverTab === 'emby'}>
              <section
                className="settings-group"
                data-settings-main="media"
                data-settings-sub="emby"
              >
                <Section
                  icon="emby"
                  title="Emby · source server"
                  description="Where your existing users and watch history live."
                >
                  <div className="field-row">
                    <Field
                      name="emby_url"
                      label="Server URL"
                      value={s.emby_url}
                      type="url"
                      placeholder="http://emby:8096"
                      hint="Use a URL reachable from the Jellyport container."
                    />
                    <Field
                      name="emby_api_key"
                      label="API key"
                      type="password"
                      secret
                      saved={s.emby_api_key_set}
                      hint="Generate a key in Emby Dashboard → API Keys."
                    />
                  </div>
                </Section>
              </section>
            </TabPanel>
            <TabPanel id="settings-servers" tabId="jellyfin" active={serverTab === 'jellyfin'}>
              <section
                className="settings-group"
                data-settings-main="media"
                data-settings-sub="jellyfin"
              >
                <Section
                  icon="jellyfin"
                  title="Jellyfin · destination server"
                  description="The new home for your community."
                >
                  <div className="form-stack">
                    <div className="field-row">
                      <Field
                        name="jellyfin_url"
                        label="Server URL"
                        value={s.jellyfin_url}
                        type="url"
                        placeholder="http://jellyfin:8096"
                        readOnly={s.jellyfin_auth_managed}
                        hint={
                          s.jellyfin_auth_managed
                            ? 'Linked during setup. Jellyfin also verifies administrator sign-in.'
                            : 'Used by Jellyport to reach the Jellyfin API.'
                        }
                      />
                      {s.jellyfin_auth_managed ? (
                        <div className="field">
                          <label htmlFor="replacement-jellyfin-api-key">
                            Replacement Jellyfin API key
                          </label>
                          <input
                            ref={replacementKey}
                            id="replacement-jellyfin-api-key"
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            placeholder="Paste a newly created API key"
                            disabled={!!busy || demo}
                          />
                          <button
                            className="btn btn-small btn-quiet"
                            type="button"
                            onClick={() => void replaceServiceKey()}
                            disabled={!!busy || demo}
                          >
                            <Icon name="refresh" />
                            {busy === 'service-key' ? 'Replacing key…' : 'Replace Jellyfin API key'}
                          </button>
                          <small>
                            Create a key in Jellyfin Dashboard → Advanced → API Keys. We recommend
                            naming it Jellyport; any name works. The saved key is never displayed.
                          </small>
                        </div>
                      ) : (
                        <Field
                          name="jellyfin_api_key"
                          label="API key"
                          type="password"
                          secret
                          saved={s.jellyfin_api_key_set}
                          hint="Generate a key in Jellyfin Dashboard → Advanced → API Keys."
                        />
                      )}
                    </div>
                    <Field
                      name="jellyfin_public_url"
                      label="Public sign-in URL"
                      value={s.jellyfin_public_url}
                      type="url"
                      optional
                      placeholder="https://jellyfin.example.com"
                      hint="Include this address in the user’s credential message."
                    />
                  </div>
                </Section>
              </section>
            </TabPanel>
            <TabPanel id="settings-servers" tabId="paths" active={serverTab === 'paths'}>
              <section
                className="settings-group"
                data-settings-main="media"
                data-settings-sub="paths"
              >
                <Section
                  title="Media path mapping"
                  description="Help Jellyport match media when your servers use different root paths."
                >
                  <div className="path-header">
                    <div>
                      <h4>Path prefixes</h4>
                      <p>
                        Map an Emby prefix to the equivalent Jellyfin prefix. Provider IDs are
                        matched first.
                      </p>
                    </div>
                    <button
                      className="btn btn-small btn-quiet"
                      type="button"
                      onClick={() => {
                        setMappings((rows) => [...rows, { source: '', target: '' }]);
                        setDirty(true);
                      }}
                    >
                      <Icon name="plus" />
                      Add mapping
                    </button>
                  </div>
                  <div id="path-mappings">
                    {mappings.map((mapping, index) => (
                      <div className="path-map" key={index}>
                        <input
                          aria-label="Emby path prefix"
                          value={mapping.source}
                          onChange={(event) =>
                            setMappings((rows) =>
                              rows.map((row, i) =>
                                i === index ? { ...row, source: event.target.value } : row,
                              ),
                            )
                          }
                          placeholder="Emby: /mnt/media"
                        />
                        <Icon name="arrow" />
                        <input
                          aria-label="Jellyfin path prefix"
                          value={mapping.target}
                          onChange={(event) =>
                            setMappings((rows) =>
                              rows.map((row, i) =>
                                i === index ? { ...row, target: event.target.value } : row,
                              ),
                            )
                          }
                          placeholder="Jellyfin: /media"
                        />
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => {
                            setMappings((rows) => rows.filter((_, i) => i !== index));
                            setDirty(true);
                          }}
                          aria-label="Remove path mapping"
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="subtle text-tiny mt-13">
                    Example: /mnt/emby/media → /media. Leave empty when paths already match.
                  </p>
                </Section>
              </section>
            </TabPanel>
          </section>
        </TabPanel>
        <TabPanel id="settings" tabId="accounts" active={activeTab === 'accounts'}>
          <section
            className="settings-group"
            data-settings-main="accounts"
            aria-label="Account defaults"
          >
            <Tabs
              id="settings-account-defaults"
              label="Account default settings"
              tabs={[
                { id: 'permissions', label: 'Permissions' },
                { id: 'passwords', label: 'Passwords & messages' },
              ]}
              value={accountTab}
              onChange={setAccountTab}
            />
            <TabPanel
              id="settings-account-defaults"
              tabId="permissions"
              active={accountTab === 'permissions'}
            >
              <section
                className="settings-group"
                data-settings-main="accounts"
                data-settings-sub="permissions"
              >
                <Section
                  title="New account permissions"
                  description="Choose the role or fallback account used to configure new Jellyfin users."
                >
                  <div className="form-stack">
                    <div className="field-row">
                      <div className="field">
                        <label htmlFor="setting-default_role_id">Default account role</label>
                        <select
                          id="setting-default_role_id"
                          name="default_role_id"
                          value={defaultRoleId}
                          onChange={(event) => setDefaultRoleId(event.target.value)}
                        >
                          <option value="">Use fallback template</option>
                          {roles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                          {s.default_role_id &&
                            !roles.some((role) => role.id === s.default_role_id) && (
                              <option value={s.default_role_id}>Saved default role</option>
                            )}
                        </select>
                        <small>
                          Create and update presets on Account roles. The default applies only to
                          new accounts and inspected incomplete-account recovery. Existing
                          migrations keep current permissions and preferences.
                        </small>
                        {rolesError && <small role="alert">{rolesError}</small>}
                      </div>
                      <div className="field">
                        <label htmlFor="setting-template_user_id">Fallback template user</label>
                        <select
                          id="setting-template_user_id"
                          name="template_user_id"
                          defaultValue={s.template_user_id}
                        >
                          <option value="">No fallback template</option>
                          {jfUsers.map((user) => (
                            <option key={user.Id} value={user.Id}>
                              {user.Name}
                            </option>
                          ))}
                          {s.template_user_id &&
                            !jfUsers.some((user) => user.Id === s.template_user_id) && (
                              <option value={s.template_user_id}>
                                Saved template · reconnect to view name
                              </option>
                            )}
                        </select>
                        <small>
                          New accounts copy this user’s permissions. Existing Jellyfin accounts keep
                          their current policy.
                        </small>
                      </div>
                    </div>
                    <div className="support-note">
                      A default account role takes priority over the fallback template. Role
                      settings are saved in Jellyport and do not depend on the source account
                      remaining available.
                    </div>
                  </div>
                </Section>
              </section>
            </TabPanel>
            <TabPanel
              id="settings-account-defaults"
              tabId="passwords"
              active={accountTab === 'passwords'}
            >
              <section
                className="settings-group"
                data-settings-main="accounts"
                data-settings-sub="passwords"
              >
                <Section
                  title="New account passwords and messages"
                  description="Choose easy-to-type passwords and the message you copy or send privately to new users."
                >
                  <div className="form-stack">
                    <div className="field-row">
                      <div className="field">
                        <label htmlFor="setting-password_length">Generated password length</label>
                        <input
                          id="setting-password_length"
                          name="password_length"
                          type="number"
                          min={12}
                          max={64}
                          step={1}
                          inputMode="numeric"
                          value={passwordLength}
                          onChange={(event) => setPasswordLength(event.target.value)}
                        />
                        <small>
                          12–64 characters, using uppercase letters, lowercase letters, and numbers.
                          No special characters. Changes apply to new passwords; existing accounts
                          keep theirs.
                        </small>
                      </div>
                      <div className="toggle-row">
                        <div>
                          <label
                            htmlFor="setting-password_exclude_ambiguous"
                            className="switch-label"
                          >
                            Avoid ambiguous characters
                          </label>
                          <p className="muted text-tiny mt-4">
                            Exclude 0, O, o, 1, I, i, l, and L to make passwords easier to read and
                            type.
                          </p>
                        </div>
                        <label className="toggle">
                          <input
                            id="setting-password_exclude_ambiguous"
                            name="password_exclude_ambiguous"
                            type="checkbox"
                            checked={excludeAmbiguous}
                            onChange={(event) => setExcludeAmbiguous(event.target.checked)}
                          />
                          <span className="toggle-track" />
                        </label>
                      </div>
                    </div>
                    <div className="form-stack">
                      <div className="field">
                        <label htmlFor="setting-credential_message_template">
                          New account message
                        </label>
                        <textarea
                          id="setting-credential_message_template"
                          name="credential_message_template"
                          rows={9}
                          maxLength={MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH}
                          value={credentialTemplate}
                          onChange={(event) => setCredentialTemplate(event.target.value)}
                          aria-describedby="credential-template-help"
                        />
                        <small id="credential-template-help">
                          Plain text, up to{' '}
                          {MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH.toLocaleString()} characters.
                          Include each placeholder: <code>{'{username}'}</code>,{' '}
                          <code>{'{password}'}</code>, and <code>{'{server_url}'}</code>. Use this
                          message when copying credentials and for private Discord delivery.
                        </small>
                        <button
                          className="btn btn-small btn-quiet"
                          type="button"
                          onClick={() => {
                            setCredentialTemplate(DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE);
                            setDirty(true);
                          }}
                        >
                          Reset message to default
                        </button>
                      </div>
                      <details className="help-disclosure">
                        <summary>Preview new account message</summary>
                        <div
                          className="inline-panel form-stack"
                          aria-label="New account message preview"
                        >
                          <strong>Message preview · fictional example</strong>
                          <p className="text-tiny">This preview uses example credentials only.</p>
                          {credentialPreviewError ? (
                            <p role="alert">{credentialPreviewError}</p>
                          ) : (
                            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                              {credentialPreview}
                            </div>
                          )}
                        </div>
                      </details>
                    </div>
                  </div>
                </Section>
              </section>
            </TabPanel>
          </section>
        </TabPanel>
        <TabPanel id="settings" tabId="discord" active={activeTab === 'discord'}>
          <section
            className="settings-group"
            data-settings-main="discord"
            aria-label="Discord & access"
          >
            <Tabs
              id="settings-bot"
              label="Discord settings"
              tabs={[
                { id: 'connection', label: 'Bot connection' },
                { id: 'alerts', label: 'Private alerts & commands' },
              ]}
              value={discordTab}
              onChange={setDiscordTab}
            />
            <TabPanel id="settings-bot" tabId="connection" active={discordTab === 'connection'}>
              <section
                className="settings-group"
                data-settings-main="discord"
                data-settings-sub="connection"
              >
                <Section
                  icon="discord"
                  title="Discord · optional"
                  description="Create accounts by command and deliver credentials privately."
                >
                  <div className="form-stack">
                    <Toggle
                      name="discord_enabled"
                      label="Enable Discord bot"
                      description="The bot needs a token, a server, and an authorized admin role."
                      checked={s.discord_enabled}
                    />
                    <div className="field-row">
                      <Field
                        name="discord_bot_token"
                        label="Bot token"
                        type="password"
                        secret
                        saved={s.discord_bot_token_set}
                        hint="Stored on the server. Leaving this blank keeps your existing token."
                      />
                      <Field
                        name="discord_application_id"
                        label="Application ID"
                        value={s.discord_application_id}
                        numeric
                        placeholder="Discord application ID"
                        hint="Used to generate the bot invite link."
                      />
                    </div>
                    <div className="field-row">
                      <Field
                        name="discord_guild_id"
                        label="Discord server ID"
                        value={s.discord_guild_id}
                        numeric
                        placeholder="Server ID"
                      />
                      <Field
                        name="discord_admin_role_id"
                        label="Authorized admin role ID"
                        value={s.discord_admin_role_id}
                        numeric
                        placeholder="Role ID"
                        hint="Only this role and server administrators can run admin commands."
                      />
                    </div>
                    <Field
                      name="discord_member_role_id"
                      label="Active membership role ID"
                      value={s.discord_member_role_id}
                      numeric
                      optional
                      placeholder="Role granted to active subscribers"
                      hint="Links subscription access to a Discord role. Its removal can be treated as expiration when role events are enabled."
                    />
                    {invite ? (
                      <div>
                        <a
                          className="btn btn-quiet"
                          href={invite}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Icon name="discord" />
                          Invite bot to your server
                        </a>
                      </div>
                    ) : (
                      <p className="subtle text-tiny">
                        Save your application ID to generate an invite link.
                      </p>
                    )}
                    <details className="help-disclosure">
                      <summary>Bot setup instructions</summary>
                      <div className="support-note">
                        Enable Developer Mode in Discord to copy user, server, channel, and role
                        IDs. Create your bot in the{' '}
                        <a
                          href="https://discord.com/developers/applications"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Discord Developer Portal
                        </a>
                        . Enable the Server Members intent for role events, and Message Content
                        intent for message events.
                      </div>
                    </details>
                  </div>
                </Section>
              </section>
            </TabPanel>
            <TabPanel id="settings-bot" tabId="alerts" active={discordTab === 'alerts'}>
              <section
                className="settings-group"
                data-settings-main="discord"
                data-settings-sub="alerts"
              >
                <AdminAlertsPanel api={api} notify={notify} demo={demo} />
                <details className="help-disclosure">
                  <summary>Account and migration commands</summary>
                  <div className="discord-commands">
                    <h4>Bot commands</h4>
                    <div className="command-row">
                      <code>/jellyport create user:@member tier:brigantine</code>
                      <p>
                        Provision every account included in the selected tier and deliver new
                        credentials privately. Omit tier to use the member’s saved tier or Sloop.
                      </p>
                    </div>
                    <div className="command-row">
                      <code>/jellyport migrate user:@member emby_username:alex</code>
                      <p>
                        Migrate an Emby account and link the member. New links require matching
                        usernames.
                      </p>
                    </div>
                    <div className="command-row">
                      <code>/jellyport status job_id:…</code>
                      <p>Check the result of an account or migration operation.</p>
                    </div>
                  </div>
                </details>
              </section>
            </TabPanel>
          </section>
        </TabPanel>
        <TabPanel id="settings" tabId="automation" active={activeTab === 'automation'}>
          <section
            className="settings-group"
            data-settings-main="automation"
            aria-label="Membership automation"
          >
            <Tabs
              id="settings-membership"
              label="Membership automation settings"
              tabs={[
                { id: 'tiers', label: 'Membership tiers' },
                { id: 'rules', label: 'Automation rules' },
              ]}
              value={automationTab}
              onChange={setAutomationTab}
            />
            <TabPanel id="settings-membership" tabId="tiers" active={automationTab === 'tiers'}>
              <section
                className="settings-group"
                data-settings-main="automation"
                data-settings-sub="tiers"
              >
                <Section
                  title="Membership tiers"
                  description="Set the number of accounts included in each subscription plan."
                >
                  <div className="form-stack">
                    <details className="help-disclosure">
                      <summary>How tier matching and allowances work</summary>
                      <p className="muted text-small">
                        All account slots belong to one Discord member. Trusted subscription
                        messages match the plan name exactly. Keep saved tier IDs stable so existing
                        memberships remain associated with their plan.
                      </p>
                    </details>
                    <div className="view-toolbar">
                      <div className="field">
                        <label htmlFor="membership-tier-editor">Edit membership tier</label>
                        <select
                          id="membership-tier-editor"
                          value={selectedTier}
                          onChange={(event) => setSelectedTier(Number(event.target.value))}
                        >
                          {membershipTiers.map((tier, index) => (
                            <option key={index} value={index}>
                              {tier.name || `New tier ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        className="btn btn-small btn-quiet"
                        type="button"
                        disabled={membershipTiers.length >= 20}
                        onClick={() => {
                          setSelectedTier(membershipTiers.length);
                          setMembershipTiers((rows) => [
                            ...rows,
                            { id: '', name: '', plan_name: '', account_limit: 1 },
                          ]);
                          setDirty(true);
                        }}
                      >
                        <Icon name="plus" /> Add tier
                      </button>
                    </div>
                    {membershipTiers.map((tier, index) => (
                      <fieldset
                        className="membership-tier-fields"
                        key={index}
                        data-settings-tier={index}
                        hidden={selectedTier !== index}
                      >
                        <legend>Tier {index + 1}</legend>
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor={`membership-tier-id-${index}`}>Stable tier ID</label>
                            <input
                              id={`membership-tier-id-${index}`}
                              value={tier.id}
                              required
                              maxLength={64}
                              pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                              autoComplete="off"
                              onChange={(event) =>
                                setMembershipTiers((rows) =>
                                  rows.map((row, i) =>
                                    i === index ? { ...row, id: event.target.value } : row,
                                  ),
                                )
                              }
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`membership-tier-name-${index}`}>Tier name</label>
                            <input
                              id={`membership-tier-name-${index}`}
                              value={tier.name}
                              required
                              maxLength={64}
                              autoComplete="off"
                              onChange={(event) =>
                                setMembershipTiers((rows) =>
                                  rows.map((row, i) =>
                                    i === index ? { ...row, name: event.target.value } : row,
                                  ),
                                )
                              }
                            />
                          </div>
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor={`membership-tier-plan-${index}`}>
                              Subscription plan name
                            </label>
                            <input
                              id={`membership-tier-plan-${index}`}
                              value={tier.plan_name}
                              required
                              maxLength={100}
                              autoComplete="off"
                              onChange={(event) =>
                                setMembershipTiers((rows) =>
                                  rows.map((row, i) =>
                                    i === index ? { ...row, plan_name: event.target.value } : row,
                                  ),
                                )
                              }
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`membership-tier-limit-${index}`}>
                              Account allowance
                            </label>
                            <select
                              id={`membership-tier-limit-${index}`}
                              value={tier.account_limit}
                              onChange={(event) =>
                                setMembershipTiers((rows) =>
                                  rows.map((row, i) =>
                                    i === index
                                      ? { ...row, account_limit: Number(event.target.value) }
                                      : row,
                                  ),
                                )
                              }
                            >
                              <option value={1}>1 account</option>
                              <option value={2}>2 accounts</option>
                              <option value={3}>3 accounts</option>
                            </select>
                          </div>
                        </div>
                        <button
                          className="btn btn-small btn-quiet"
                          type="button"
                          disabled={membershipTiers.length === 1}
                          aria-label={`Remove tier ${tier.name || index + 1}`}
                          onClick={() => {
                            setMembershipTiers((rows) => rows.filter((_, i) => i !== index));
                            setSelectedTier(Math.max(0, index - 1));
                            setDirty(true);
                          }}
                        >
                          Remove tier
                        </button>
                      </fieldset>
                    ))}
                    <div className="support-note">
                      Saving tier definitions does not change existing accounts. Review and apply a
                      member’s tier on Memberships. A downgrade disables extras and keeps their
                      data; a later upgrade restores the same Jellyport-disabled accounts.
                    </div>
                  </div>
                </Section>
              </section>
            </TabPanel>
            <TabPanel id="settings-membership" tabId="rules" active={automationTab === 'rules'}>
              <section
                className="settings-group"
                data-settings-main="automation"
                data-settings-sub="rules"
              >
                <Section
                  title="Membership automation"
                  description="Opt in to automatic changes, or keep membership events in your review queue."
                >
                  <div className="form-stack">
                    <Toggle
                      name="discord_role_events"
                      label="Watch membership role changes"
                      description="Adding the active role is a subscription event; removing it is an expiration event."
                      checked={s.discord_role_events}
                    />
                    <Toggle
                      name="discord_message_events"
                      label="Watch trusted subscription messages"
                      description="Only messages from the configured bot and channel are considered."
                      checked={s.discord_message_events}
                    />
                    <div className="field-row">
                      <Field
                        name="discord_subscription_channel_id"
                        label="Subscription channel ID"
                        value={s.discord_subscription_channel_id}
                        numeric
                        optional
                        placeholder="Trusted announcement channel"
                      />
                      <Field
                        name="discord_subscription_bot_id"
                        label="Subscription bot user ID"
                        value={s.discord_subscription_bot_id}
                        numeric
                        optional
                        placeholder="Your membership bot’s user ID"
                      />
                    </div>
                    <hr className="m-0" />
                    <Toggle
                      name="auto_provision"
                      label="Automatically provision subscribed members"
                      description="Provision accounts for the member’s tier and deliver new credentials automatically. Automatic downgrades also require automatic disabling. With role events enabled, active members are scanned on startup and every five minutes."
                      checked={s.auto_provision}
                    />
                    <Toggle
                      name="auto_disable"
                      label="Automatically disable expired memberships"
                      description="Disable all linked accounts when paid access expires. Also required for automatic tier downgrades. Accounts and their data are retained."
                      checked={s.auto_disable}
                    />
                    <Toggle
                      name="disable_on_cancel"
                      label="Disable access when a subscription is canceled"
                      description="Enable only if access should end at cancellation rather than at the end of the paid period."
                      checked={s.disable_on_cancel}
                    />
                    <Callout warning title="Start with the review queue." className="mb-0">
                      Keep automatic creation and disabling off until your membership events are
                      working as expected. Discord IDs keep links stable when usernames change.
                    </Callout>
                  </div>
                </Section>
              </section>
            </TabPanel>
          </section>
        </TabPanel>
      </form>
      <TabPanel id="settings" tabId="history" active={activeTab === 'history'}>
        <section className="settings-group" data-settings-main="history" aria-label="Saved history">
          <p className="section-note">
            Import actions and schedules save independently from account and connection settings.
          </p>
          <Tabs
            id="settings-backups"
            label="Saved history source"
            tabs={[
              { id: 'emby', label: 'Emby backup' },
              { id: 'jellyfin', label: 'Jellyfin catalog' },
            ]}
            value={historyTab}
            onChange={setHistoryTab}
          />
          <TabPanel id="settings-backups" tabId="emby" active={historyTab === 'emby'}>
            <section
              className="settings-group"
              data-settings-main="history"
              data-settings-sub="emby"
            >
              <SourceSnapshotsPanel api={api} notify={notify} demo={demo} />
            </section>
          </TabPanel>
          <TabPanel id="settings-backups" tabId="jellyfin" active={historyTab === 'jellyfin'}>
            <section
              className="settings-group"
              data-settings-main="history"
              data-settings-sub="jellyfin"
            >
              <DestinationCatalogPanel api={api} notify={notify} demo={demo} />
            </section>
          </TabPanel>
        </section>
      </TabPanel>
    </div>
  );
}
