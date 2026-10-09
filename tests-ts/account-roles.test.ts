import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AccountRoles, type SaveAccountRole } from '../server/account-roles.js';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import type { JellyfinAuthentication } from '../server/jellyfin-auth.js';
import type { MediaUser } from '../server/media.js';

const directories: string[] = [];
const stores: Store[] = [];
const apps: JellyportApp[] = [];
const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  jellyfin_url: 'https://jellyfin.example',
  jellyfin_api_key: 'private-api-key',
  template_user_id: 'template',
};
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'jellyport-roles-'));
  directories.push(value);
  return value;
}
function bind(store: Store, config = settings, serverId = 'bound-server') {
  const pending = store.resetAuth(config.jellyfin_url);
  expect(
    store.completeAuth(
      pending.generation,
      { kind: 'configured', serverUrl: config.jellyfin_url, serverId, apiKeyName: 'test' },
      () => structuredClone(config),
    ),
  ).toBe(true);
}
function fixture() {
  const path = directory();
  const store = new Store(path);
  stores.push(store);
  bind(store);
  return { path, store, roles: new AccountRoles(store) };
}
function input(overrides: Partial<SaveAccountRole> = {}): SaveAccountRole {
  return {
    name: 'Members',
    parameters: {
      policy: { IsAdministrator: false, EnableMediaPlayback: true },
      configuration: { AudioLanguagePreference: 'en', EnableNextEpisodeAutoPlay: true },
      display: null,
    },
    ...overrides,
  };
}
const member = { Id: 'member-id', Name: 'private-member' };
async function apiFixture(demo = false) {
  const servers = new DemoServers();
  servers.users.jellyfin.push(
    { Id: 'admin', Name: 'private-admin', Policy: { IsAdministrator: true, IsDisabled: false } },
    {
      Id: 'disabled',
      Name: 'private-disabled',
      Policy: { IsAdministrator: false, IsDisabled: true },
    },
    { Id: 'unknown', Name: 'private-unknown', Policy: {} },
  );
  const identity = {
    serverId: 'bound-server',
    userId: 'admin',
    username: 'admin',
    accessToken: 'private-session-token',
  };
  const authClient: JellyfinAuthentication = {
    authenticate: async () => identity,
    validateSession: async () => identity,
    signOut: async () => {},
    validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'test API key' }),
  };
  const close = vi.fn(async () => {});
  let currentServerId = 'bound-server';
  let onUser: ((user: MediaUser) => void) | undefined;
  let unavailableDisplay = false;
  const app = await createApp({
    demo,
    dataDir: directory(),
    authClient,
    clientFactory: (...args) => {
      const client = servers.factory(...args);
      const originalUser = client.user.bind(client);
      client.systemInfo = async () => ({ Id: currentServerId });
      client.user = async (id) => {
        const user = await originalUser(id);
        onUser?.(user);
        return user;
      };
      const originalDisplay = client.displayPreferences?.bind(client);
      client.displayPreferences = async (id) => {
        if (unavailableDisplay) throw new Error('private-server-error');
        return originalDisplay ? originalDisplay(id) : {};
      };
      client.close = close;
      return client;
    },
  });
  apps.push(app);
  if (!demo) bind(app.jellyport.store);
  const session = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${session.cookies[0]!.value}`,
      'x-csrf-token': session.json().csrf_token,
    },
    payload: { username: 'admin', password: demo ? 'demo-jellyport' : 'admin-password' },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: `jellyport_session=${login.cookies[0]!.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  return {
    app,
    servers,
    headers,
    close,
    roles: new AccountRoles(app.jellyport.store),
    setServerId: (value: string) => {
      currentServerId = value;
    },
    setOnUser: (value: (user: MediaUser) => void) => {
      onUser = value;
    },
    unavailableDisplay: () => {
      unavailableDisplay = true;
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('saved account roles and assignments', () => {
  it('saves independent encrypted snapshots and returns defensive copies', () => {
    const { roles, path, store } = fixture();
    const source = input();
    const role = roles.save(source, settings);
    source.parameters.policy.EnableMediaPlayback = false;
    role.parameters.policy.EnableMediaPlayback = false;
    expect(roles.get(role.id, settings)?.parameters.policy.EnableMediaPlayback).toBe(true);
    const [assignment] = roles.assign(role.id, role.revision, [member], settings);
    assignment.username = 'mutated';
    expect(roles.getAssignment(member.Id, settings)?.username).toBe(member.Name);
    store.db.exec('PRAGMA wal_checkpoint(FULL)');
    for (const file of readdirSync(path).filter((name) => name.startsWith('jellyport.db'))) {
      const data = readFileSync(join(path, file));
      for (const privateText of [
        'private-member',
        'AudioLanguagePreference',
        'https://jellyfin.example',
      ])
        expect(data.includes(Buffer.from(privateText))).toBe(false);
    }
  });
  it('requires an exact revision for edits and rejects duplicate role names', () => {
    const { roles } = fixture();
    const role = roles.save(input(), settings);
    expect(() => roles.save(input({ id: role.id }), settings)).toThrow(/changed/);
    expect(() => roles.save(input({ id: role.id, revision: randomUUID() }), settings)).toThrow(
      /changed/,
    );
    expect(() => roles.save(input({ name: ' MEMBERS ' }), settings)).toThrow(/already exists/);
    const edited = roles.save(
      input({ id: role.id, revision: role.revision, name: 'Premium' }),
      settings,
    );
    expect(edited.id).toBe(role.id);
    expect(edited.revision).not.toBe(role.revision);
    expect(() => roles.remove(role.id, role.revision, settings)).toThrow(/changed/);
    roles.remove(edited.id, edited.revision, settings);
    expect(roles.list(settings)).toEqual([]);
  });
  it('isolates records by Jellyfin identity and URL, independent of Emby', () => {
    const { roles, store } = fixture();
    const role = roles.save(input(), settings);
    roles.assign(role.id, role.revision, [member], settings);
    expect(roles.list({ ...settings, emby_url: 'http://different-emby.example' })).toHaveLength(1);
    bind(store, settings, 'another-server');
    expect(roles.list(settings)).toEqual([]);
    expect(roles.assignments(settings)).toEqual([]);
    expect(() => roles.save(input({ id: role.id, revision: role.revision }), settings)).toThrow(
      /changed/,
    );
    const replacement = { ...settings, jellyfin_url: 'https://other-jellyfin.example' };
    bind(store, replacement, 'bound-server');
    expect(roles.list(replacement)).toEqual([]);
    expect(() => roles.save(input(), settings)).toThrow(/authenticate/);
  });
  it('rejects writes after settings change and waits for authenticated setup', () => {
    const { roles, store } = fixture();
    store.saveSettings({ ...settings, jellyfin_url: 'https://changed.example' });
    expect(() => roles.save(input(), settings)).toThrow(/configuration changed/);
    store.resetAuth();
    expect(roles.list(settings)).toEqual([]);
    expect(() => roles.save(input(), settings)).toThrow(/authenticate/);
  });
  it('assigns a single role, preserves same-role application state, and clears it when switching', () => {
    const { roles } = fixture();
    const role = roles.save(input(), settings);
    const alternative = roles.save(input({ name: 'Other' }), settings);
    const [assigned] = roles.assign(role.id, role.revision, [member], settings);
    const applied = roles.markApplied(
      member.Id,
      role.id,
      role.revision,
      assigned.revision,
      settings,
      ['policy', 'configuration'],
    );
    expect(applied.applied_revision).toBe(role.revision);
    expect(roles.assign(role.id, role.revision, [member], settings)).toEqual([applied]);
    const [renamed] = roles.assign(
      role.id,
      role.revision,
      [{ ...member, Name: 'renamed' }],
      settings,
    );
    expect(renamed.revision).not.toBe(assigned.revision);
    expect(renamed.applied_sections).toEqual(applied.applied_sections);
    const [switched] = roles.assign(alternative.id, alternative.revision, [member], settings);
    expect(switched.applied_revision).toBeNull();
    expect(switched.applied_sections).toEqual({});
    expect(roles.assignments(settings)).toHaveLength(1);
  });
  it('tracks partial sections without claiming that the whole role was applied', () => {
    const { roles } = fixture();
    const role = roles.save(
      input({ parameters: { ...input().parameters, display: { ShowBackdrop: true } } }),
      settings,
    );
    const [assigned] = roles.assign(role.id, role.revision, [member], settings);
    const displayOnly = roles.markApplied(
      member.Id,
      role.id,
      role.revision,
      assigned.revision,
      settings,
      ['display'],
    );
    expect(displayOnly.applied_revision).toBeNull();
    expect(displayOnly.applied_sections).toEqual({ display: role.revision });
    const complete = roles.markApplied(
      member.Id,
      role.id,
      role.revision,
      assigned.revision,
      settings,
      ['policy', 'configuration'],
    );
    expect(complete.applied_revision).toBe(role.revision);
    const edited = roles.save(
      input({ id: role.id, revision: role.revision, parameters: role.parameters }),
      settings,
    );
    const partial = roles.markApplied(
      member.Id,
      edited.id,
      edited.revision,
      assigned.revision,
      settings,
      ['display'],
    );
    expect(partial.applied_revision).toBeNull();
    expect(partial.applied_sections.policy).toBe(role.revision);
  });
  it('refuses stale application markers after role, assignment, or server changes', () => {
    const { roles } = fixture();
    const role = roles.save(input(), settings);
    const [assigned] = roles.assign(role.id, role.revision, [member], settings);
    const edited = roles.save(input({ id: role.id, revision: role.revision }), settings);
    expect(() =>
      roles.markApplied(member.Id, role.id, role.revision, assigned.revision, settings, ['policy']),
    ).toThrow(/changed/);
    roles.unassign([member.Id], settings);
    expect(() =>
      roles.markApplied(member.Id, edited.id, edited.revision, assigned.revision, settings, [
        'policy',
      ]),
    ).toThrow(/changed/);
    const [reassigned] = roles.assign(edited.id, edited.revision, [member], settings);
    expect(reassigned.revision).not.toBe(assigned.revision);
    expect(() =>
      roles.markApplied(member.Id, edited.id, edited.revision, assigned.revision, settings, [
        'policy',
      ]),
    ).toThrow(/changed/);
    expect(() =>
      roles.markApplied(member.Id, edited.id, edited.revision, reassigned.revision, settings, [
        'display',
      ]),
    ).toThrow(/does not contain/);
  });
  it('refuses to delete assigned and default roles', () => {
    const { roles, store } = fixture();
    const role = roles.save(input(), settings);
    roles.assign(role.id, role.revision, [member], settings);
    expect(() => roles.remove(role.id, role.revision, settings)).toThrow(/Unassign/);
    roles.unassign([member.Id], settings);
    store.saveSettings({ ...settings, default_role_id: role.id });
    expect(() => roles.remove(role.id, role.revision, settings)).toThrow(/default role/);
    store.saveSettings(settings);
    roles.remove(role.id, role.revision, settings);
  });
  it('enforces bounded roles, batches, unique users, and protected template targets', () => {
    const { roles } = fixture();
    const role = roles.save(input(), settings);
    expect(() => roles.assign(role.id, role.revision, [member, member], settings)).toThrow(
      /distinct/,
    );
    expect(() =>
      roles.assign(role.id, role.revision, [{ Id: 'template', Name: 'Template' }], settings),
    ).toThrow(/template/);
    expect(() =>
      roles.assign(
        role.id,
        role.revision,
        Array.from({ length: 101 }, (_, index) => ({ Id: String(index), Name: String(index) })),
        settings,
      ),
    ).toThrow(/100/);
    expect(() => roles.unassign([], settings)).toThrow(/100/);
    for (let index = 1; index < 100; index++)
      roles.save(input({ name: `Role ${index}` }), settings);
    expect(() => roles.save(input({ name: 'Overflow' }), settings)).toThrow(/100/);
  });
  it('rechecks the current template when assigning from a captured settings snapshot', () => {
    const { roles, store } = fixture();
    const role = roles.save(input(), settings);
    store.saveSettings({ ...settings, template_user_id: member.Id });
    expect(() => roles.assign(role.id, role.revision, [member], settings)).toThrow(
      /template account changed/,
    );
    expect(roles.assignments(settings)).toEqual([]);
  });
  it.each(['', '  ', 'bad\nname', 'a'.repeat(65)])('rejects malformed role name %j', (name) => {
    const { roles } = fixture();
    expect(() => roles.save(input({ name }), settings)).toThrow(/Role names/);
  });
  it('rejects privilege escalation, unsupported parameters, and bad identifiers', () => {
    const { roles } = fixture();
    expect(() =>
      roles.save(
        input({ parameters: { ...input().parameters, policy: { IsAdministrator: true } } }),
        settings,
      ),
    ).toThrow();
    expect(() =>
      roles.save(
        input({ parameters: { ...input().parameters, configuration: { Token: 'secret' } } }),
        settings,
      ),
    ).toThrow();
    expect(() => roles.save(input({ id: 'bad-id' }), settings)).toThrow(/identifier/);
  });
  it('prevents production role data from opening in demo mode', () => {
    const path = directory();
    const store = new Store(path);
    store.saveAccountRoleRecord(randomUUID(), { name: 'private-production-role' });
    store.close();
    expect(() => new Store(path, { demo: true })).toThrow(/separate empty data directory/);
  });
});

describe('authenticated role routes', () => {
  it('requires administrator sessions and CSRF before reading or writing roles', async () => {
    const { app, headers } = await apiFixture();
    expect((await app.inject('/api/account-roles')).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-roles',
      headers: { cookie: headers.cookie },
      payload: input(),
    });
    expect(response.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/account-roles', headers })).json(),
    ).toEqual({ roles: [], assignments: [] });
  });
  it('protects role application with administrator authentication and CSRF before invoking the service', async () => {
    const { app, headers } = await apiFixture();
    const apply = vi.spyOn(app.jellyport.service, 'applyRole');
    const payload = {
      role_id: randomUUID(),
      role_revision: randomUUID(),
      user_ids: ['j-river'],
      sections: ['policy'],
    };
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/account-roles/apply',
      payload,
    });
    expect(anonymous.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/account-roles/apply',
      headers: { cookie: headers.cookie },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await app.inject({
      method: 'POST',
      url: '/api/account-roles/apply',
      headers: { ...headers, 'x-csrf-token': 'not-the-session-token' },
      payload,
    });
    expect(wrongCsrf.statusCode).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });
  it('validates role application strictly and forwards only the reviewed users and sections', async () => {
    const { app, headers } = await apiFixture();
    const job = {
      id: 'queued-role-job',
      kind: 'role_update',
      status: 'queued',
      created_at: '2026-10-08T12:00:00.000Z',
      updated_at: '2026-10-08T12:00:00.000Z',
      progress: { processed: 0, total: 1 },
      results: [],
    };
    const apply = vi.spyOn(app.jellyport.service, 'applyRole').mockResolvedValue(job);
    const payload = {
      role_id: randomUUID(),
      role_revision: randomUUID(),
      user_ids: ['j-river'],
      sections: ['configuration', 'display'],
    };
    const malformed = [
      { ...payload, server_url: 'https://another-server.example' },
      { ...payload, role_id: '' },
      { ...payload, role_revision: 42 },
      { ...payload, user_ids: [] },
      { ...payload, user_ids: ['j-river', 'j-river'] },
      { ...payload, user_ids: Array.from({ length: 101 }, (_, index) => String(index)) },
      { ...payload, user_ids: ['x'.repeat(129)] },
      { ...payload, sections: [] },
      { ...payload, sections: ['policy', 'policy'] },
      { ...payload, sections: ['policy', 'configuration', 'display', 'policy'] },
      { ...payload, sections: ['password'] },
      { ...payload, sections: [true] },
      { role_id: payload.role_id, user_ids: payload.user_ids, sections: payload.sections },
    ];
    for (const body of malformed) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/account-roles/apply',
        headers,
        payload: body,
      });
      expect([400, 422]).toContain(response.statusCode);
    }
    expect(apply).not.toHaveBeenCalled();
    const valid = await app.inject({
      method: 'POST',
      url: '/api/account-roles/apply',
      headers,
      payload,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual(job);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(
      payload.role_id,
      payload.role_revision,
      payload.user_ids,
      payload.sections,
    );
  });
  it('rejects missing and out-of-scope default roles without changing stored settings', async () => {
    const { app, headers, roles } = await apiFixture();
    const before = app.jellyport.store.settings();
    const saved = roles.save(input(), settings);
    const foreign = { ...saved, id: randomUUID(), server_id: 'another-server' };
    app.jellyport.store.saveAccountRoleRecord(foreign.id, foreign);
    for (const defaultRoleId of [randomUUID(), foreign.id]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: { default_role_id: defaultRoleId },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/role saved for this Jellyfin server/);
      expect(app.jellyport.store.settings()).toEqual(before);
    }
    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { default_role_id: saved.id, template_user_id: '' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ default_role_id: saved.id, template_user_id: '' });
    expect(accepted.body).not.toContain('private-api-key');
    expect(app.jellyport.store.settings().default_role_id).toBe(saved.id);
  });
  it('can complete first-time setup without a template and then configure saved roles', async () => {
    const servers = new DemoServers();
    const identity = {
      serverId: 'new-bound-server',
      userId: 'admin',
      username: 'admin',
      accessToken: 'private-setup-token',
    };
    const validateKey = vi.fn(async () => ({
      serverId: identity.serverId,
      apiKeyName: 'Jellyport',
    }));
    const authClient: JellyfinAuthentication = {
      authenticate: async () => identity,
      validateSession: async () => identity,
      signOut: async () => {},
      validateApiKey: validateKey,
    };
    const userReads = vi.fn();
    const app = await createApp({
      dataDir: directory(),
      authClient,
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        const readUser = client.user.bind(client);
        client.user = async (id) => {
          userReads(id);
          return readUser(id);
        };
        return client;
      },
    });
    apps.push(app);
    const initial = await app.inject('/api/session');
    const connected = await app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      headers: {
        cookie: `jellyport_session=${initial.cookies[0]!.value}`,
        'x-csrf-token': initial.json().csrf_token,
      },
      payload: {
        jellyfin_url: 'http://jellyfin:8096',
        api_key: 'private-managed-key',
      },
    });
    expect(connected.statusCode).toBe(200);
    const complete = await app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      headers: {
        cookie: `jellyport_session=${connected.cookies[0]!.value}`,
        'x-csrf-token': connected.json().session.csrf_token,
      },
      payload: { template_user_id: '', jellyfin_public_url: 'https://watch.example/' },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().authenticated).toBe(false);
    expect(validateKey).toHaveBeenCalled();
    expect(userReads).not.toHaveBeenCalled();
    expect(app.jellyport.store.settings()).toMatchObject({
      template_user_id: '',
      default_role_id: '',
      jellyfin_public_url: 'https://watch.example',
    });
    expect(complete.body).not.toMatch(
      /private-setup-token|private-managed-key|private-admin-password/,
    );
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `jellyport_session=${complete.cookies[0]!.value}`,
        'x-csrf-token': complete.json().csrf_token,
      },
      payload: { username: 'admin', password: 'private-admin-password' },
    });
    expect(signedIn.statusCode).toBe(200);
    const headers = {
      cookie: `jellyport_session=${signedIn.cookies[0]!.value}`,
      'x-csrf-token': signedIn.json().csrf_token,
    };
    const saved = await app.inject({
      method: 'POST',
      url: '/api/account-roles',
      headers,
      payload: input(),
    });
    expect(saved.statusCode).toBe(200);
    const selected = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { default_role_id: saved.json().id },
    });
    expect(selected.statusCode).toBe(200);
    expect(app.jellyport.store.settings().default_role_id).toBe(saved.json().id);
  });
  it('imports enabled account and home preferences without exposing identity or secrets', async () => {
    const { app, headers, servers, close } = await apiFixture();
    Object.assign(servers.users.jellyfin[0]!, {
      AccessToken: 'secret-import-token',
      Password: 'secret-password',
      Configuration: {
        ...servers.users.jellyfin[0]!.Configuration,
        EnableLocalPassword: true,
        AudioLanguagePreference: 'en',
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-roles/import',
      headers,
      payload: { user_id: 'template' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().parameters.policy.IsAdministrator).toBe(false);
    expect(response.json().parameters.configuration.AudioLanguagePreference).toBe('en');
    expect(response.json().parameters.display.CustomPrefs.homesection2).toBe('nextup');
    expect(response.body).not.toContain('secret-import-token');
    expect(response.body).not.toContain('secret-password');
    expect(response.body).not.toContain('EnableLocalPassword');
    expect(response.body).not.toContain('Member template');
    expect(close).toHaveBeenCalled();
  });
  it.each(['admin', 'disabled', 'unknown'])('rejects unsafe import source %s', async (userId) => {
    const { app, headers } = await apiFixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-roles/import',
      headers,
      payload: { user_id: userId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/enabled non-administrator/);
  });
  it('allows unsupported display imports with sanitized warnings', async () => {
    const { app, headers, unavailableDisplay } = await apiFixture();
    unavailableDisplay();
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-roles/import',
      headers,
      payload: { user_id: 'template' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().parameters.display).toBeNull();
    expect(response.json().warnings.join(' ')).toMatch(/could not be read/);
    expect(response.body).not.toContain('private-server-error');
  });
  it('rejects a different server identity and configuration changes during import', async () => {
    const { app, headers, setServerId, setOnUser } = await apiFixture();
    setServerId('another-server');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/account-roles/import',
      headers,
      payload: { user_id: 'template' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toMatch(/different server/);
    setServerId('bound-server');
    setOnUser(() =>
      app.jellyport.store.saveSettings({ ...settings, template_user_id: 'changed-template' }),
    );
    const changed = await app.inject({
      method: 'POST',
      url: '/api/account-roles/import',
      headers,
      payload: { user_id: 'template' },
    });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().detail).toMatch(/configuration changed/);
  });
  it('saves roles, assigns existing disabled accounts without remote changes, and unassigns them', async () => {
    const { app, headers, servers } = await apiFixture();
    const before = structuredClone(servers.users.jellyfin);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/account-roles',
      headers,
      payload: input(),
    });
    expect(saved.statusCode).toBe(200);
    const role = saved.json();
    const assigned = await app.inject({
      method: 'POST',
      url: '/api/account-roles/assign',
      headers,
      payload: {
        role_id: role.id,
        role_revision: role.revision,
        user_ids: ['j-river', 'disabled'],
      },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().assignments).toHaveLength(2);
    expect(servers.users.jellyfin).toEqual(before);
    const unassigned = await app.inject({
      method: 'POST',
      url: '/api/account-roles/unassign',
      headers,
      payload: { user_ids: ['j-river', 'disabled'] },
    });
    expect(unassigned.statusCode).toBe(200);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/account-roles/${role.id}`,
      headers,
      payload: { revision: role.revision },
    });
    expect(removed.statusCode).toBe(200);
  });
  it.each(['admin', 'template', 'unknown'])(
    'refuses protected or unverifiable assignment %s',
    async (userId) => {
      const { app, headers, roles } = await apiFixture();
      const role = roles.save(input(), settings);
      const response = await app.inject({
        method: 'POST',
        url: '/api/account-roles/assign',
        headers,
        payload: { role_id: role.id, role_revision: role.revision, user_ids: ['j-river', userId] },
      });
      expect(response.statusCode).toBe(400);
      expect(roles.assignments(settings)).toEqual([]);
    },
  );
  it('rejects additional properties, unsupported edits, duplicate users, and oversized batches', async () => {
    const { app, headers, roles } = await apiFixture();
    const role = roles.save(input(), settings);
    const requests = [
      { url: '/api/account-roles', payload: { ...input(), server_id: 'attacker-server' } },
      {
        url: '/api/account-roles',
        payload: input({
          parameters: { ...input().parameters, policy: { IsAdministrator: true } },
        }),
      },
      { url: '/api/account-roles/import', payload: { user_id: 'template', emby: true } },
      {
        url: '/api/account-roles/assign',
        payload: {
          role_id: role.id,
          role_revision: role.revision,
          user_ids: ['j-river', 'j-river'],
        },
      },
      {
        url: '/api/account-roles/unassign',
        payload: { user_ids: Array.from({ length: 101 }, (_, index) => String(index)) },
      },
    ];
    for (const request of requests)
      expect([400, 422]).toContain(
        (await app.inject({ method: 'POST', headers, ...request })).statusCode,
      );
  });
  it('keeps demo role mutations read-only', async () => {
    const { app, headers } = await apiFixture(true);
    expect(
      (await app.inject({ method: 'GET', url: '/api/account-roles', headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/account-roles', headers, payload: input() }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/account-roles/import',
          headers,
          payload: { user_id: 'template' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
