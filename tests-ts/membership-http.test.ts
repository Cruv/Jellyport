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
async function saveSettings(
  app: JellyportApp,
  headers: Record<string, string>,
  changes: Record<string, unknown>,
  authorityReviewToken?: string,
) {
  const settings = await app.inject({ url: '/api/settings', headers });
  expect(settings.statusCode).toBe(200);
  const revisions = settings.json<{ field_revisions: Record<string, string> }>().field_revisions;
  return app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: {
      changes,
      expected_revisions: Object.fromEntries(
        Object.keys(changes).map((key) => [key, revisions[key] ?? '0']),
      ),
      ...(authorityReviewToken ? { authority_review_token: authorityReviewToken } : {}),
    },
  });
}
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
    validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'test API key' }),
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
    activeMemberPage: async () => ({ members: [{ id: owner, username: 'Jim' }] }),
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
  it('recovers the original membership job after the review has been consumed', async () => {
    const { app, headers, servers } = await fixture();
    const reviewed = await app.inject({
      method: 'POST',
      url: '/api/memberships/workflow/review',
      headers,
      payload: {
        discord_user_id: owner,
        access_mode: 'subscription',
        tier_id: 'sloop',
        provision_jellyfin: true,
      },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const payload = { review_token: reviewed.json().review_token };
    const receipt = 'a1000000-1234-4abc-8123-000000000000';
    const request = {
      method: 'POST' as const,
      url: '/api/memberships/workflow/accept',
      headers,
      payload,
    };
    const submit = { ...request, headers: { ...headers, 'x-jellyport-submission': receipt } };
    const [accepted, parallel] = await Promise.all([app.inject(submit), app.inject(submit)]);
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(parallel.statusCode, parallel.body).toBe(202);
    const id = accepted.json().job.id;
    expect(parallel.json().job.id).toBe(id);
    expect((await app.inject(request)).statusCode).toBe(400);

    const lookup = `/api/jobs/receipts/${receipt}`;
    expect((await app.inject(lookup)).statusCode).toBe(401);
    const recovered = await app.inject({ url: lookup, headers });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ job_id: id });
    const replay = await app.inject(submit);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().job.id).toBe(id);
    const changed = await app.inject({
      ...submit,
      payload: { review_token: 'a2000000-1234-4abc-8123-000000000000' },
    });
    expect(changed.statusCode).toBe(409);
    await app.jellyport.service.jobTasks.get(id);
    expect(app.jellyport.store.jobs().map(({ id }) => id)).toEqual([id]);
    const target = app.jellyport.store.link(owner, 1);
    expect(target?.remote_id).toBeTruthy();
    expect(
      servers.users.jellyfin.filter((account) => account.Name === target?.username),
    ).toHaveLength(1);
  });

  it('looks up a membership job submitted directly with a receipt', async () => {
    const { app, headers } = await fixture();
    const receipt = 'a3000000-1234-4abc-8123-000000000000';
    const request = {
      method: 'POST' as const,
      url: '/api/memberships/provision',
      headers: { ...headers, 'x-jellyport-submission': receipt },
      payload: { discord_user_id: owner, tier_id: 'sloop' },
    };
    const accepted = await app.inject(request);
    expect(accepted.statusCode, accepted.body).toBe(202);
    const id = accepted.json().id;
    expect((await app.inject({ url: `/api/jobs/receipts/${receipt}`, headers })).json()).toEqual({
      job_id: id,
    });
    expect((await app.inject(request)).json().id).toBe(id);
    await app.jellyport.service.jobTasks.get(id);
    expect(app.jellyport.store.jobs().map(({ id }) => id)).toEqual([id]);
    expect(app.jellyport.service.getJob(id).status).toBe('completed');
  });

  it('combines exact household accounts, redacted billing evidence and confirmed access changes', async () => {
    const { app, headers, servers } = await fixture();
    const { service, store } = app.jellyport;
    const source = servers.users.emby.find(({ Id }) => Id === 'e-river')!;
    source.Name = 'River source';
    source.Policy = { IsAdministrator: false, IsDisabled: false };
    const settings = {
      ...store.settings(),
      emby_url: 'https://emby.example',
      emby_api_key: 'synthetic-emby-key',
    };
    store.saveSettings(settings);
    service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'Jim',
        tier_id: 'brigantine',
        account_limit: 2,
      },
      settings,
    );
    store.saveLink(owner, 'river', 'j-river');
    service.mediaOwnerships.save(
      [
        {
          kind: 'emby',
          server_id: 'demo-emby',
          account_id: 'e-river',
          username: 'River source',
          discord_user_id: owner,
          slot: 1,
        },
        {
          kind: 'jellyfin',
          server_id: 'demo-jellyfin',
          account_id: 'j-river',
          username: 'river',
          discord_user_id: owner,
          slot: 1,
        },
        {
          kind: 'emby',
          server_id: 'demo-emby',
          account_id: 'other',
          username: 'Different household',
          discord_user_id: '555555555',
          slot: 1,
        },
      ],
      settings,
    );
    const observed = '2026-11-18T00:00:00.000Z';
    const paidThrough = '2026-12-18T00:00:00.000Z';
    store.saveSubscription({
      id: 'paid-observation',
      action: 'subscribe',
      status: 'applied',
      created_at: observed,
      discord_user_id: owner,
      source: 'stripe',
      job_id: 'fixture-membership-operation',
      stripe_entitlement: {
        provider: 'stripe',
        action: 'subscribe',
        event_id: 'paid-observation',
        discord_user_id: owner,
        customer_id: 'private-customer-id',
        subscription_id: 'private-subscription-id',
        invoice_id: 'private-invoice-id',
        tier_id: 'brigantine',
        price_id: 'private-price-id',
        created_at: observed,
        paid_through: paidThrough,
        observed_at: observed,
        activation_revision: 'synthetic-activation',
        generation: 'synthetic-generation',
        authority_revision: 'synthetic-authority',
        is_new: false,
      },
    });
    store.saveSubscription({
      id: 'other-event',
      action: 'expire',
      status: 'applied',
      created_at: observed,
      discord_user_id: '555555555',
    });
    const url = `/api/memberships/${owner}/timeline`;
    expect((await app.inject(url)).statusCode).toBe(401);
    const input = {
      kind: 'jellyfin',
      user_id: 'j-river',
      disabled: true,
      expected_username: 'river',
      expected_profile_revision: '',
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/accounts/access', headers, payload: input }))
        .statusCode,
    ).toBe(400);
    const review = await app.inject({
      method: 'POST',
      url: '/api/accounts/access/review',
      headers,
      payload: { ...input, expected_discord_user_id: owner },
    });
    expect(review.statusCode, review.body).toBe(200);
    expect(review.headers['cache-control']).toBe('no-store');
    expect(review.json().accounts).toMatchObject([
      { kind: 'emby', username: 'River source', eligible: true, slot: 1 },
      { kind: 'jellyfin', username: 'river', eligible: true, slot: 1 },
    ]);
    const accept = {
      method: 'POST' as const,
      url: '/api/accounts/access/accept',
      headers,
      payload: { review_token: review.json().review_token },
    };
    const anonymous = await app.inject('/api/session');
    const otherLogin = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'admin', password: 'private-admin-password' },
    });
    expect(otherLogin.statusCode).toBe(200);
    const otherHeaders = {
      ...headers,
      cookie: `jellyport_session=${otherLogin.cookies[0]!.value}`,
      'x-csrf-token': otherLogin.json().csrf_token,
    };
    expect((await app.inject({ ...accept, headers: otherHeaders })).statusCode).toBe(400);
    const access = await app.inject(accept);
    expect(access.statusCode).toBe(200);
    expect(access.json()).toEqual({ disabled: true, changed: 2 });
    expect((await app.inject(accept)).statusCode).toBe(400);
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      discord_user_id: owner,
      username: 'Jim',
      membership: { account_limit: 2, active: true },
      accounts: [
        { kind: 'emby', username: 'River source', identity: 'confirmed', slot: 1 },
        { kind: 'jellyfin', username: 'river', identity: 'confirmed', slot: 1 },
      ],
      stripe: { invoice: null },
      milestones: expect.arrayContaining([
        expect.objectContaining({ type: 'access', disabled: true, username: 'river' }),
        expect.objectContaining({ type: 'access', disabled: true, username: 'River source' }),
        expect.objectContaining({
          type: 'subscription',
          job_id: 'fixture-membership-operation',
          invoice: { paid_through: paidThrough, observed_at: observed, tier_id: 'brigantine' },
        }),
      ]),
    });
    expect(response.body).not.toMatch(
      /private-(customer|subscription|invoice|price)-id|other-event|Different household/,
    );
    expect(
      store.db.prepare('SELECT encrypted FROM household_access_history').get()?.encrypted,
    ).toBeInstanceOf(Uint8Array);
  });

  it.each(['discord_guild_id', 'discord_member_role_id'] as const)(
    'reviews the %s cutover and preserves access until the exact household is approved',
    async (field) => {
      const { app, headers, servers } = await fixture();
      const { store, service, bot } = app.jellyport;
      vi.spyOn(bot, 'restart').mockResolvedValue(undefined);
      vi.spyOn(service.bot!, 'membershipActive').mockResolvedValue(false);
      store.saveSettings({
        ...store.settings(),
        discord_enabled: true,
        discord_guild_id: '200001',
        discord_bot_token: 'synthetic-key',
        discord_member_role_id: '200002',
        discord_role_events: true,
        auto_disable: true,
      });
      store.saveLink(owner, 'river', 'j-river');
      const target = servers.users.jellyfin.find((user) => user.Id === 'j-river')!;
      const changes = { [field]: '200003' };
      const save = (token?: string) => saveSettings(app, headers, changes, token);
      expect((await save()).statusCode).toBe(400);
      const preview = await app.inject({
        method: 'POST',
        url: '/api/discord/authority/review',
        headers,
        payload: changes,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().affected).toMatchObject([
        {
          discord_user_id: owner,
          accounts: [{ kind: 'jellyfin', id: 'j-river', username: 'river', slot: 1 }],
        },
      ]);
      expect((await save(preview.json().review_token)).statusCode).toBe(200);
      await service.reconcileMemberships();
      expect(target.Policy?.IsDisabled).toBe(false);
      expect(store.subscriptions()).toEqual([]);
      expect(service.discordAuthorityState(owner)).toBe('held');
      const base = `/api/discord/authority/households/${owner}`;
      const review = await app.inject({ method: 'POST', url: `${base}/review`, headers });
      expect(review.statusCode).toBe(200);
      expect(review.json()).toMatchObject({
        discord_user_id: owner,
        has_role: false,
        accounts: [{ id: 'j-river', disabled: false, pending: false }],
      });
      const approval = await app.inject({
        method: 'POST',
        url: `${base}/approve`,
        headers,
        payload: { review_token: review.json().review_token },
      });
      expect(approval.statusCode).toBe(200);
      expect(service.discordAuthorityState(owner)).toBe('current');
      expect(target.Policy?.IsDisabled).toBe(false);
      await service.reconcileMemberships();
      expect(target.Policy?.IsDisabled).toBe(true);
    },
  );

  it('holds a legacy link with unknown authority even after ordinary edits', async () => {
    const { app, servers } = await fixture();
    const { store, service } = app.jellyport;
    store.saveSettings({
      ...store.settings(),
      discord_enabled: true,
      discord_member_role_id: '200002',
      discord_guild_id: '200001',
      discord_role_events: true,
      auto_disable: true,
    });
    store.db
      .prepare('INSERT INTO links (discord_user_id, username, remote_id) VALUES (?,?,?)')
      .run(owner, 'river', 'j-river');
    store.saveLink(owner, 'river', 'j-river');
    vi.spyOn(service.bot!, 'membershipActive').mockResolvedValue(false);
    await service.reconcileMemberships();
    expect(service.discordAuthorityState(owner)).toBe('legacy');
    expect(servers.users.jellyfin.find((user) => user.Id === 'j-river')?.Policy?.IsDisabled).toBe(
      false,
    );
  });

  it('saves the new-subscriber switch only with current admin, CSRF and origin authority and keeps its cutoff private', async () => {
    const { app, headers, revoke } = await fixture();
    const { store, service, bot } = app.jellyport;
    vi.spyOn(bot, 'restart').mockResolvedValue(undefined);
    const payload = {
      discord_enabled: true,
      discord_guild_id: '123456789',
      discord_bot_token: 'synthetic-onboarding-bot-key',
      discord_message_events: true,
      discord_subscription_channel_id: '234567890',
      discord_subscription_bot_id: '345678901',
      auto_provision: true,
      auto_create_new_subscribers: true,
    };
    for (const rejected of [
      { headers: {}, status: 401 },
      { headers: { cookie: headers.cookie }, status: 403 },
      { headers: { ...headers, origin: 'https://untrusted.example' }, status: 403 },
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload,
        headers: rejected.headers,
      });
      expect(response.statusCode).toBe(rejected.status);
      expect(service.newSubscriberPolicy.activation(store.settings())).toBeNull();
    }
    const backdated = await saveSettings(app, headers, {
      ...payload,
      new_subscriber_enabled_at: '2000-01-01T00:00:00.000Z',
    });
    expect(backdated.statusCode).toBe(400);
    expect(service.newSubscriberPolicy.activation(store.settings())).toBeNull();
    const saved = await saveSettings(app, headers, payload);
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.json()).toMatchObject({ auto_create_new_subscribers: true });
    const activation = service.newSubscriberPolicy.activation(store.settings())!;
    expect(Number.isFinite(Date.parse(activation.enabled_at))).toBe(true);
    const publicRead = await app.inject({ url: '/api/settings', headers });
    for (const response of [saved, publicRead]) {
      expect(response.body).not.toContain(activation.revision);
      expect(response.body).not.toContain('enabled_at');
      expect(response.body).not.toContain(payload.discord_bot_token);
    }
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    revoke();
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { auto_create_new_subscribers: false },
    });
    expect(denied.statusCode).toBe(401);
    expect(service.newSubscriberPolicy.activation(store.settings())).toEqual(activation);
  });

  it('shows private alert status only to admins and rejects a stale recipient stop review', async () => {
    const { app, headers } = await fixture();
    const { store, service } = app.jellyport;
    const settings = {
      ...store.settings(),
      discord_enabled: true,
      discord_guild_id: '123456789',
      discord_bot_token: 'synthetic-bot-token',
    };
    store.saveSettings(settings);
    service.adminAlerts.enable(
      { guild_id: settings.discord_guild_id, user_id: '222222222', username: 'captain' },
      settings,
    );
    const reviewed = await app.inject({ url: '/api/discord/admin-alerts', headers });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.headers['cache-control']).toBe('no-store');
    expect(reviewed.json()).toMatchObject({ enabled: true, recipient_username: 'captain' });
    expect(reviewed.body).not.toContain('synthetic-bot-token');
    expect(reviewed.body).not.toContain('private-managed-api-key');
    for (const url of ['/api/discord/admin-alerts', '/api/discord/%61dmin-alerts']) {
      const denied = await app.inject(url);
      expect(denied.statusCode).toBe(401);
      expect(denied.body).not.toContain('captain');
    }
    service.adminAlerts.enable(
      { guild_id: settings.discord_guild_id, user_id: '333333333', username: 'other_admin' },
      settings,
    );
    const stale = await app.inject({
      method: 'POST',
      url: '/api/discord/admin-alerts/disable',
      headers,
      payload: { expected_revision: reviewed.json().revision },
    });
    expect(stale.statusCode).toBe(400);
    expect(service.adminAlerts.status(settings).enabled).toBe(true);
    const current = service.adminAlerts.status(settings);
    const stopped = await app.inject({
      method: 'POST',
      url: '/api/discord/admin-alerts/disable',
      headers,
      payload: { expected_revision: current.revision },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().enabled).toBe(false);
    expect(store.jobs()).toEqual([]);
  });

  it('keeps unlinked accounts enabled for review and saves manual per-account family notes without Discord', async () => {
    const { app, headers, servers } = await fixture();
    app.jellyport.service.bot = null;
    const before = structuredClone(servers.users.jellyfin);
    const initial = await app.inject({ url: '/api/user-directory', headers });
    const row = initial
      .json()
      .users.find((value: { jellyfin: Array<{ id: string }> }) =>
        value.jellyfin.some((user) => user.id === 'j-river'),
      );
    expect(row).toMatchObject({ discord_user_id: null, family: false, requires_review: true });
    expect(servers.users.jellyfin).toEqual(before);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/account-profiles',
      headers,
      payload: {
        kind: 'jellyfin',
        user_id: 'j-river',
        family: true,
        owner_name: 'Child owner',
        notes: 'PRIVATE-FAMILY-NOTE',
        expected_revision: '',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.json()).toMatchObject({
      kind: 'jellyfin',
      user_id: 'j-river',
      family: true,
      owner_name: 'Child owner',
    });
    expect(servers.users.jellyfin).toEqual(before);
    expect(app.jellyport.service.listMemberships()).toEqual([]);
    const directory = await app.inject({ url: '/api/user-directory', headers });
    const family = directory
      .json()
      .users.find((value: { jellyfin: Array<{ id: string }> }) =>
        value.jellyfin.some((user) => user.id === 'j-river'),
      );
    expect(family).toMatchObject({ family: true, requires_review: false });
    expect(family.jellyfin[0].profile.notes).toBe('PRIVATE-FAMILY-NOTE');
    for (const url of ['/api/user-directory', '/api/%75ser-directory']) {
      const denied = await app.inject(url);
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['cache-control']).toBe('no-store');
      expect(denied.body).not.toContain('PRIVATE-FAMILY-NOTE');
      expect(denied.body).not.toContain('Child owner');
    }
    for (const url of ['/api/settings', '/api/jobs', '/api/memberships'])
      expect((await app.inject({ url, headers })).body).not.toContain('PRIVATE-FAMILY-NOTE');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/account-profiles',
      headers,
      payload: {
        kind: 'jellyfin',
        user_id: 'j-river',
        family: false,
        owner_name: 'Replacement',
        notes: '',
        expected_revision: '',
      },
    });
    expect(stale.statusCode).toBe(400);
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/accounts/access',
      headers,
      payload: {
        kind: 'jellyfin',
        user_id: 'j-river',
        disabled: true,
        expected_username: 'river',
        expected_profile_revision: saved.json().revision,
      },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.headers['cache-control']).toBe('no-store');
    expect(servers.users.jellyfin.find((user) => user.Id === 'j-river')?.Policy?.IsDisabled).toBe(
      true,
    );
    expect(
      app.jellyport.service.profiles.get('jellyfin', 'j-river', app.jellyport.store.settings())
        ?.family,
    ).toBe(true);
  });

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
      const response = await saveSettings(app, headers, payload);
      expect(response.statusCode).toBe(400);
      expect(app.jellyport.store.settings()).toEqual(before);
    }
    const base = await saveSettings(app, headers, { discord_application_id: '999999999' });
    expect(base.statusCode).toBe(200);
    expect(new URL(base.json().bot_invite_url).searchParams.get('permissions')).toBe('68608');
    const tagged = await saveSettings(app, headers, {
      discord_emby_role_id: '444444444',
      discord_jellyfin_role_id: '555555555',
    });
    expect(tagged.statusCode).toBe(200);
    expect(new URL(tagged.json().bot_invite_url).searchParams.get('permissions')).toBe('268504064');
  });

  it('protects organization and complimentary endpoints with administrator authentication and CSRF', async () => {
    const { app, headers } = await fixture();
    for (const url of [
      '/api/user-directory',
      '/api/discord/tag-roles',
      '/api/discord/admin-alerts',
    ]) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const requests = [
      {
        url: '/api/discord/admin-alerts/disable',
        payload: { expected_revision: 'synthetic-reviewed-recipient' },
      },
      {
        url: '/api/account-profiles',
        payload: {
          kind: 'jellyfin',
          user_id: 'j-river',
          family: true,
          owner_name: 'Private owner',
          notes: 'Private notes',
          expected_revision: '',
        },
      },
      {
        url: '/api/accounts/access',
        payload: {
          kind: 'jellyfin',
          user_id: 'j-river',
          disabled: true,
          expected_username: 'river',
          expected_profile_revision: '',
        },
      },
      {
        url: '/api/accounts/access/review',
        payload: {
          kind: 'jellyfin',
          user_id: 'j-river',
          disabled: true,
          expected_username: 'river',
          expected_profile_revision: '',
          expected_discord_user_id: owner,
        },
      },
      {
        url: '/api/accounts/access/accept',
        payload: { review_token: '12345678-1234-4123-8123-123456789abc' },
      },
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
          'family',
          'requires_review',
        ].sort(),
      );
      for (const account of [...row.emby, ...row.jellyfin])
        expect(Object.keys(account).sort()).toEqual(
          ['id', 'name', 'disabled', 'protected', 'profile'].sort(),
        );
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
        'provision_jellyfin',
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
