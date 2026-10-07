import { useState, type FormEvent, type ReactNode } from 'react';
import { Callout, Heading, Icon } from './components';
import {
  safeUrl,
  type Api,
  type Connections,
  type Notify,
  type Settings,
  type Users,
} from './types';

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
            <h2>{title}</h2>
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
  const [mappings, setMappings] = useState(s.path_mappings || []);
  const [busy, setBusy] = useState('');
  const [tested, setTested] = useState<Partial<Connections> | null>(null);
  const jfUsers = users.jellyfin.filter(
    (user) => !user.Policy?.IsAdministrator && !user.Policy?.IsDisabled,
  );
  const invite = safeUrl(s.bot_invite_url);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy('save');
    try {
      const data: Record<string, unknown> = {};
      new FormData(form).forEach((value, key) => {
        data[key] = String(value).trim();
      });
      toggleNames.forEach((key) => {
        data[key] = (form.elements.namedItem(key) as HTMLInputElement).checked;
      });
      data.path_mappings = mappings
        .map((row) => ({ source: row.source.trim(), target: row.target.trim() }))
        .filter((row) => row.source || row.target);
      if ((data.path_mappings as typeof mappings).some((row) => !row.source || !row.target))
        throw new Error('Each path mapping needs both an Emby prefix and a Jellyfin prefix.');
      await api('/api/settings', { method: 'PUT', body: data });
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
  return (
    <>
      <Heading
        title="Set your course."
        description="Connect your servers, choose account permissions, and make Discord delivery your own."
      />
      <UserWarnings users={users} />
      <form id="settings-form" onSubmit={save}>
        <div className="settings-sections">
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
                  hint="Used by Jellyport to reach the Jellyfin API."
                />
                <Field
                  name="jellyfin_api_key"
                  label="API key"
                  type="password"
                  secret
                  saved={s.jellyfin_api_key_set}
                  hint="Generate a key in Jellyfin Dashboard → API Keys."
                />
              </div>
              <div className="field-row">
                <Field
                  name="jellyfin_public_url"
                  label="Public sign-in URL"
                  value={s.jellyfin_public_url}
                  type="url"
                  optional
                  placeholder="https://jellyfin.example.com"
                  hint="Include this address in the user’s credential message."
                />
                <div className="field">
                  <label htmlFor="setting-template_user_id">Template user</label>
                  <select
                    id="setting-template_user_id"
                    name="template_user_id"
                    defaultValue={s.template_user_id}
                  >
                    <option value="">Choose a Jellyfin user…</option>
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
                    New accounts copy this user’s permissions. Existing Jellyfin accounts keep their
                    current policy.
                  </small>
                </div>
              </div>
              <div className="support-note">
                After saving a new Jellyfin connection, reload Settings to fetch its template users.
                Use a regular account with the library access you want new members to have.
              </div>
            </div>
          </Section>
          <Section
            title="Media path mapping"
            description="Help Jellyport match media when your servers use different root paths."
          >
            <div className="path-header">
              <div>
                <h3>Path prefixes</h3>
                <p>
                  Map an Emby prefix to the equivalent Jellyfin prefix. Provider IDs are matched
                  first.
                </p>
              </div>
              <button
                className="btn btn-small btn-quiet"
                type="button"
                onClick={() => setMappings((rows) => [...rows, { source: '', target: '' }])}
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
                    onClick={() => setMappings((rows) => rows.filter((_, i) => i !== index))}
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
              <div className="support-note">
                Enable Developer Mode in Discord to copy user, server, channel, and role IDs. Create
                your bot in the{' '}
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Discord Developer Portal
                </a>
                . Enable the Server Members intent for role events, and Message Content intent for
                message events.
              </div>
              <div className="discord-commands">
                <h3>Bot commands</h3>
                <div className="command-row">
                  <code>/jellyport create user:@member</code>
                  <p>
                    Create a fresh account using the member’s Discord username and deliver
                    credentials privately.
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
            </div>
          </Section>
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
                description="Create and deliver accounts automatically. With role events enabled, existing active members are also scanned on startup and every five minutes."
                checked={s.auto_provision}
              />
              <Toggle
                name="auto_disable"
                label="Automatically disable expired memberships"
                description="Disable the linked Jellyfin account when paid access expires. The account and its history are retained."
                checked={s.auto_disable}
              />
              <Toggle
                name="disable_on_cancel"
                label="Disable access when a subscription is canceled"
                description="Enable only if access should end at cancellation rather than at the end of the paid period."
                checked={s.disable_on_cancel}
              />
              <Callout warning title="Start with the review queue." className="mb-0">
                Keep automatic creation and disabling off until your membership events are working
                as expected. Discord IDs keep links stable when usernames change.
              </Callout>
            </div>
          </Section>
        </div>
        <div className="settings-actions">
          <p>
            Secret values are never returned to this browser.
            <br />
            Save changes before testing your connections.
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
      </form>
      {tested && (
        <div className="connection-test-results">
          <section className="panel">
            <div className="panel-header">
              <h2>Saved connection test</h2>
            </div>
            <ConnectionRows connections={tested} />
          </section>
        </div>
      )}
    </>
  );
}
