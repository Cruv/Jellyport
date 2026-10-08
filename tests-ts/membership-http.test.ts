import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { createApp, type JellyportApp } from '../server/main.js';
import { JellyfinAuthError, type JellyfinAuthentication } from '../server/jellyfin-auth.js';
import { DEFAULT_SETTINGS } from '../server/types.js';
import type { BotAdapter } from '../server/service.js';

const owner = '123456789';
const directories: string[] = [];
const apps: JellyportApp[] = [];
async function fixture(demo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-membership-http-'));
  directories.push(directory);
  const servers = new DemoServers();
  let revoked = false;
  const identity = {
    serverId: 'demo-jellyfin',
    userId: 'administrator-id',
    username: 'admin',
    accessToken: 'private-interactive-session-token',
  };
  const authClient: JellyfinAuthentication = {
    authenticate: vi.fn(async (_url, username) => {
      if (username !== 'admin')
        throw new JellyfinAuthError('An enabled administrator account is required.', 403);
      return identity;
    }),
    validateSession: vi.fn(async () => {
      if (revoked) throw new JellyfinAuthError('The administrator account was disabled.', 403);
      return identity;
    }),
    signOut: vi.fn(async () => {}),
    createApiKey: async () => 'private-managed-api-key',
    deleteApiKey: async () => {},
  };
  const app = await createApp({
    demo,
    dataDir: directory,
    authClient,
    clientFactory: servers.factory,
  });
  apps.push(app);
  if (!demo) {
    const pending = app.jellyport.store.authState();
    if (pending?.kind !== 'pending') throw new Error('Expected isolated first-time fixture');
    app.jellyport.store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example',
        serverId: identity.serverId,
        apiKeyName: 'fixture',
      },
      () => ({
        ...structuredClone(DEFAULT_SETTINGS),
        jellyfin_url: 'https://jellyfin.example',
        jellyfin_public_url: 'https://jellyfin.example',
        jellyfin_api_key: 'private-managed-api-key',
        template_user_id: 'template',
      }),
    );
  }
  const deliveries: Array<{ username: string; password: string }> = [];
  app.jellyport.service.bot = {
    status: () => ({ connected: true }),
    recipientIdentity: async (id) => ({ id, username: 'Jim' }),
    validateRecipient: async () => {},
    sendCredentials: async (_id, username, password) => {
      deliveries.push({ username, password });
    },
    membershipActive: async () => true,
    activeMembers: async () => [{ id: owner, username: 'Jim' }],
  } satisfies BotAdapter;
  const anonymous = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
      'x-csrf-token': anonymous.json().csrf_token,
    },
    payload: { username: 'admin', password: demo ? 'demo-jellyport' : 'private-admin-password' },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: `jellyport_session=${login.cookies[0]!.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  async function provision(tier_id = 'sloop', expected_revision?: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: {
        discord_user_id: owner,
        tier_id,
        ...(expected_revision ? { expected_revision } : {}),
      },
    });
    expect(response.statusCode).toBe(202);
    await app.jellyport.service.jobTasks.get(response.json().id);
    expect(app.jellyport.service.getJob(response.json().id).status).toBe('completed');
    return response;
  }
  return {
    app,
    servers,
    headers,
    deliveries,
    authClient,
    provision,
    revoke: () => {
      revoked = true;
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('administrator membership HTTP endpoints', () => {
  it('rejects unsafe organization configuration and requests Manage Roles only when tags are configured', async () => {
    const { app, headers } = await fixture();
    const before = app.jellyport.store.settings();
    for (const payload of [
      { discord_emby_role_id: '123456', discord_jellyfin_role_id: '123456' },
      { discord_emby_role_id: '123456', discord_member_role_id: '123456' },
      { discord_emby_role_id: '123456', discord_admin_role_id: '123456' },
      { discord_emby_role_id: '123456', discord_guild_id: '123456' },
      { discord_emby_role_id: 'bad-role' },
      { discord_auto_role_sync: true },
      {
        membership_tiers: [
          { id: 'complimentary', name: 'Reserved', plan_name: 'Reserved Plan', account_limit: 1 },
        ],
      },
    ]) {
      const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
      expect(response.statusCode).toBe(400);
      expect(app.jellyport.store.settings()).toEqual(before);
    }
    const base = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { discord_application_id: '999999999' },
    });
    expect(base.statusCode).toBe(200);
    expect(new URL(base.json().bot_invite_url).searchParams.get('permissions')).toBe('68608');
    const tagged = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { discord_emby_role_id: '444444444', discord_jellyfin_role_id: '555555555' },
    });
    expect(tagged.statusCode).toBe(200);
    expect(new URL(tagged.json().bot_invite_url).searchParams.get('permissions')).toBe('268504064');
  });

  it('protects organization and complimentary endpoints with administrator authentication and CSRF', async () => {
    const { app, headers } = await fixture();
    for (const url of ['/api/user-directory', '/api/discord/tag-roles']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const requests = [
      {
        url: '/api/memberships/access',
        payload: { discord_user_id: owner, access_mode: 'complimentary' },
      },
      { url: '/api/accounts/link', payload: { discord_user_id: owner, jellyfin_user_id: 'alice' } },
      { url: '/api/discord/tags/preview', payload: {} },
      {
        url: '/api/discord/tags/apply',
        payload: { token: '12345678-1234-4123-8123-123456789abc' },
      },
    ];
    for (const request of requests) {
      expect((await app.inject({ method: 'POST', ...request })).statusCode).toBe(401);
      for (const invalid of [
        { cookie: headers.cookie },
        { ...headers, origin: 'https://untrusted.example' },
      ]) {
        const response = await app.inject({ method: 'POST', ...request, headers: invalid });
        expect(response.statusCode).toBe(403);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    expect(app.jellyport.store.links()).toEqual([]);
    expect(app.jellyport.service.listMemberships()).toEqual([]);
  });

  it('saves complimentary policy without provisioning, and projects safe user directory fields', async () => {
    const { app, headers, servers } = await fixture();
    const create = vi.spyOn(servers, 'factory');
    const response = await app.inject({
      method: 'POST',
      url: '/api/memberships/access',
      headers,
      payload: { discord_user_id: owner, access_mode: 'complimentary', account_limit: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ access_mode: 'complimentary', account_limit: 2 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(app.jellyport.store.jobs()).toEqual([]);
    expect(app.jellyport.store.links()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    servers.users.jellyfin[0]!.Configuration = { SecretProfileSetting: 'private-profile-token' };
    const directory = await app.inject({ url: '/api/user-directory', headers });
    expect(directory.statusCode).toBe(200);
    expect(directory.headers['cache-control']).toBe('no-store');
    expect(directory.json().users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          discord_user_id: owner,
          access_mode: 'complimentary',
          emby: [],
          jellyfin: [],
        }),
      ]),
    );
    for (const secret of [
      'private-profile-token',
      'private-managed-api-key',
      'private-interactive-session-token',
    ])
      expect(directory.body).not.toContain(secret);
    for (const row of directory.json().users) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'emby',
          'jellyfin',
          'discord_user_id',
          'discord_username',
          'access_mode',
          'account_limit',
          'protected',
        ].sort(),
      );
      for (const account of [...row.emby, ...row.jellyfin])
        expect(Object.keys(account).sort()).toEqual(['id', 'name', 'disabled'].sort());
    }
  });

  it('requires administrator authentication and CSRF before exposing or provisioning members', async () => {
    const { app, headers } = await fixture();
    const list = vi.spyOn(app.jellyport.service, 'listMemberships');
    const provision = vi.spyOn(app.jellyport.service, 'provisionMembership');
    for (const url of ['/api/memberships', '/api/%6demberships']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(owner);
    }
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      payload: { discord_user_id: owner, tier_id: 'galleon' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    for (const requestHeaders of [
      { cookie: headers.cookie },
      { ...headers, 'x-csrf-token': 'wrong-token' },
      { ...headers, origin: 'https://untrusted.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/memberships/provision',
        headers: requestHeaders,
        payload: { discord_user_id: owner, tier_id: 'galleon' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(list).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(app.jellyport.store.jobs()).toEqual([]);
    expect((await app.inject({ url: '/api/memberships', headers })).json()).toEqual({
      memberships: [],
    });
  });

  it('rejects non-administrator sign-in and revalidates administrator access on membership requests', async () => {
    const { app, headers, provision, authClient, revoke } = await fixture();
    const anonymous = await app.inject('/api/session');
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'ordinary-member', password: 'member-password' },
    });
    expect(rejected.statusCode).toBe(403);
    await provision('brigantine');
    const knownMembers = vi.spyOn(app.jellyport.service, 'listMemberships');
    revoke();
    const denied = await app.inject({ url: '/api/memberships', headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.body).not.toContain(owner);
    expect(denied.body).not.toContain('Jim');
    expect(knownMembers).not.toHaveBeenCalled();
    expect(authClient.validateSession).toHaveBeenCalled();
    expect(authClient.signOut).toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/memberships/provision',
          headers,
          payload: { discord_user_id: owner, tier_id: 'galleon' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('returns only approved owner/account fields and never includes credentials, encrypted values, or session metadata', async () => {
    const { app, headers, provision, deliveries } = await fixture();
    const created = await provision('galleon');
    expect(created.headers['cache-control']).toBe('no-store');
    const { store, service } = app.jellyport;
    const record = store.membershipRecords<Record<string, unknown>>()[0]!;
    store.saveMembershipRecord(record.id, {
      ...record.value,
      password: 'private-record-password',
      access_token: 'private-record-token',
      session: 'private-record-session',
      billing_customer: 'private-customer-id',
    });
    store.saveAccount('Jim', store.link(owner)!.remote_id, 'ready', 'private-recovery-password');
    const listed = await app.inject({ url: '/api/memberships', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const member = listed.json().memberships[0];
    expect(Object.keys(member).sort()).toEqual(
      [
        'discord_user_id',
        'base_username',
        'tier_id',
        'access_mode',
        'account_limit',
        'active',
        'server_url',
        'server_id',
        'revision',
        'links',
      ].sort(),
    );
    expect(member).toMatchObject({
      discord_user_id: owner,
      base_username: 'Jim',
      tier_id: 'galleon',
      account_limit: 3,
      active: true,
    });
    expect(member.links.map((link: { username: string }) => link.username)).toEqual([
      'Jim',
      'Jim_2',
      'Jim_3',
    ]);
    for (const link of member.links)
      expect(Object.keys(link).sort()).toEqual(
        [
          'discord_user_id',
          'membership_slot',
          'username',
          'remote_id',
          'disabled_by_jellyport',
          'pending_disabled',
        ].sort(),
      );
    for (const secret of [
      'private-record-password',
      'private-record-token',
      'private-record-session',
      'private-customer-id',
      'private-recovery-password',
      'private-admin-password',
      'private-managed-api-key',
      'private-interactive-session-token',
      record.id,
      ...deliveries.map((delivery) => delivery.password),
    ]) {
      expect(listed.body).not.toContain(secret);
      expect(created.body).not.toContain(secret);
      expect(JSON.stringify(service.listMemberships())).not.toContain(secret);
    }
    expect(store.takeCredentials(created.json().id)).toEqual([]);
  });

  it.each([
    {},
    { discord_user_id: 'invalid', tier_id: 'sloop' },
    { discord_user_id: 123456789, tier_id: 'sloop' },
    { discord_user_id: owner, tier_id: '../tier' },
    { discord_user_id: owner, tier_id: 'sloop', membership_slot: 4 },
    { discord_user_id: owner, tier_id: 'sloop', account_limit: 3 },
    { discord_user_id: owner, tier_id: 'sloop', expected_revision: 1 },
    { discord_user_id: owner, tier_id: 'sloop', password: 'injected-password' },
    { discord_user_id: owner, tier_id: 'sloop', server_url: 'https://untrusted.example' },
  ])(
    'rejects malformed and unexpected membership inputs %# before invoking provisioning',
    async (payload) => {
      const { app, headers } = await fixture();
      const operation = vi.spyOn(app.jellyport.service, 'provisionMembership');
      const response = await app.inject({
        method: 'POST',
        url: '/api/memberships/provision',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(operation).not.toHaveBeenCalled();
      expect(app.jellyport.store.links()).toEqual([]);
      expect(app.jellyport.store.jobs()).toEqual([]);
      expect(app.jellyport.store.membershipRecords()).toEqual([]);
    },
  );

  it('rejects unconfigured tiers and stale review revisions without changing remote accounts', async () => {
    const { app, servers, headers, provision, deliveries } = await fixture();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: { discord_user_id: owner, tier_id: 'unconfigured' },
    });
    expect(unknown.statusCode).toBe(400);
    expect(app.jellyport.store.jobs()).toEqual([]);
    await provision('sloop');
    const stale = app.jellyport.service.memberships.get(
      owner,
      app.jellyport.store.settings(),
    )!.revision;
    await provision('brigantine', stale);
    const before = structuredClone(servers.users.jellyfin),
      count = app.jellyport.store.jobs().length;
    const response = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: { discord_user_id: owner, tier_id: 'galleon', expected_revision: stale },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('changed');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(servers.users.jellyfin).toEqual(before);
    expect(app.jellyport.store.jobs()).toHaveLength(count);
    expect(deliveries).toHaveLength(2);
  });

  it('rejects a reviewed allowance after its configured tier limit changes without modifying accounts or membership', async () => {
    const { app, servers, headers, provision, deliveries } = await fixture();
    await provision('sloop');
    const { store, service } = app.jellyport;
    const member = service.memberships.get(owner, store.settings())!;
    const before = structuredClone(servers.users.jellyfin),
      jobsBefore = store.jobs().length;
    store.saveSettings({
      ...store.settings(),
      membership_tiers: store
        .settings()
        .membership_tiers!.map((tier) =>
          tier.id === 'brigantine' ? { ...tier, account_limit: 3 } : tier,
        ),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: {
        discord_user_id: owner,
        tier_id: 'brigantine',
        expected_revision: member.revision,
        expected_account_limit: 2,
        expected_usernames: ['Jim', 'Jim_2'],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('allowance');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(servers.users.jellyfin).toEqual(before);
    expect(service.memberships.get(owner, store.settings())).toEqual(member);
    expect(store.jobs()).toHaveLength(jobsBefore);
    expect(store.linksForMember(owner)).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it('rejects reviewed usernames after a secondary account mapping changes without modifying accounts or membership', async () => {
    const { app, servers, headers, provision, deliveries } = await fixture();
    await provision('sloop');
    const { store, service } = app.jellyport;
    const member = service.memberships.get(owner, store.settings())!;
    store.saveSettings({
      ...store.settings(),
      emby_url: 'http://emby',
      emby_api_key: 'private-emby-key',
    });
    service.mappings.save(
      {
        source_user_id: 'e-sam',
        source_username: 'sam',
        target_user_id: null,
        target_username: 'Approved.secondary',
        discord_user_id: owner,
        discord_username: 'Jim',
        membership_slot: 2,
      },
      store.settings(),
    );
    const before = structuredClone(servers.users.jellyfin),
      jobsBefore = store.jobs().length;
    const response = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: {
        discord_user_id: owner,
        tier_id: 'brigantine',
        expected_revision: member.revision,
        expected_account_limit: 2,
        expected_usernames: ['Jim', 'Jim_2'],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('names or mappings changed');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(servers.users.jellyfin).toEqual(before);
    expect(service.memberships.get(owner, store.settings())).toEqual(member);
    expect(store.jobs()).toHaveLength(jobsBefore);
    expect(store.linksForMember(owner)).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it('requires the reviewed account limit and usernames together before invoking provisioning', async () => {
    const { app, servers, headers, deliveries } = await fixture();
    const before = structuredClone(servers.users.jellyfin);
    const operation = vi.spyOn(app.jellyport.service, 'provisionMembership');
    for (const reviewed of [{ expected_account_limit: 1 }, { expected_usernames: ['Jim'] }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/memberships/provision',
        headers,
        payload: { discord_user_id: owner, tier_id: 'sloop', ...reviewed },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toContain('both');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(operation).not.toHaveBeenCalled();
    expect(servers.users.jellyfin).toEqual(before);
    expect(app.jellyport.store.jobs()).toEqual([]);
    expect(app.jellyport.store.links()).toEqual([]);
    expect(app.jellyport.store.membershipRecords()).toEqual([]);
    expect(deliveries).toEqual([]);
  });

  it('keeps demo membership mutations read-only while allowing authenticated listing', async () => {
    const { app, headers, servers } = await fixture(true);
    const before = structuredClone(servers.users.jellyfin);
    const listed = await app.inject({ url: '/api/memberships', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const response = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: { discord_user_id: owner, tier_id: 'galleon' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('read-only');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(servers.users.jellyfin).toEqual(before);
    expect(app.jellyport.store.membershipRecords()).toEqual([]);
  });
  it('does not synthesize a lower-tier legacy membership from links belonging to another paired URL', async () => {
    const { app, headers, servers, provision } = await fixture();
    await provision('galleon');
    const { store } = app.jellyport;
    const before = structuredClone(servers.users.jellyfin);
    const pending = store.resetAuth('https://renamed-jellyfin.example');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'https://renamed-jellyfin.example',
        serverId: 'demo-jellyfin',
        apiKeyName: 'fixture',
      },
      (settings) => ({ ...settings, jellyfin_url: 'https://renamed-jellyfin.example' }),
    );
    const listed = await app.inject({ url: '/api/memberships', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ memberships: [] });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/memberships/provision',
      headers,
      payload: { discord_user_id: owner, tier_id: 'sloop' },
    });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().detail).toContain('different paired server');
    expect(servers.users.jellyfin).toEqual(before);
    expect(store.linksForMember(owner)).toHaveLength(3);
    expect(store.membershipRecords()).toHaveLength(1);
    const restore = store.resetAuth('https://jellyfin.example');
    store.completeAuth(
      restore.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example',
        serverId: 'demo-jellyfin',
        apiKeyName: 'fixture',
      },
      (settings) => ({ ...settings, jellyfin_url: 'https://jellyfin.example' }),
    );
    expect(
      (await app.inject({ url: '/api/memberships', headers })).json().memberships[0],
    ).toMatchObject({ tier_id: 'galleon', account_limit: 3 });
  });
  it('still recognizes genuine legacy single-account links without scoped membership records', async () => {
    const { app, headers } = await fixture();
    app.jellyport.store.saveLink(owner, 'river', 'j-river');
    const response = await app.inject({ url: '/api/memberships', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().memberships).toHaveLength(1);
    expect(response.json().memberships[0]).toMatchObject({
      discord_user_id: owner,
      base_username: 'river',
      tier_id: 'sloop',
      account_limit: 1,
      revision: '',
    });
  });
});
