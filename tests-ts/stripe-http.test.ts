import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import type { StripeSnapshot } from '../server/stripe-client.js';

const directories: string[] = [];
const apps: JellyportApp[] = [];
const member = '234567890123456789';
const key = 'rk_test_syntheticKeyOnly123';
async function fixture(demo = false, live = false, paid = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-http-'));
  directories.push(directory);
  const identity = {
    serverId: 'demo-jellyfin',
    userId: 'admin',
    username: 'admin',
    accessToken: 'synthetic-admin-token',
  };
  const servers = new DemoServers();
  const snapshot = vi.fn(async (): Promise<StripeSnapshot> => ({
    mode: live ? 'live' : 'test',
    completed_at: new Date().toISOString(),
    products: [],
    subscriptions: [
      {
        id: 'sub_Crew',
        customer_id: 'cus_Crew',
        customer_email: 'synthetic@example.test',
        status: live && !paid ? 'canceled' : 'active',
        ...(live
          ? {
              created: Math.floor(Date.now() / 1000) - 100_000,
              ...(paid ? {} : { ended_at: Math.floor(Date.now() / 1000) - 100 }),
            }
          : {}),
        collection_method: 'charge_automatically',
        cancel_at_period_end: false,
        pause_collection: false,
        items: live
          ? [{ id: 'si_Crew', price_id: 'price_Crew', product_id: 'prod_Crew', quantity: 1 }]
          : [],
        identity_candidates: [
          { discord_user_id: member, source: 'subscription_metadata', field: 'discord_user_id' },
        ],
      },
    ],
  }));
  const app = await createApp({
    demo,
    dataDir: directory,
    clientFactory: servers.factory,
    authClient: {
      authenticate: async () => identity,
      validateSession: async () => identity,
      signOut: async () => {},
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
    },
    stripeClientFactory: () => ({
      mode: live ? 'live' : 'test',
      snapshot,
      checkoutIdentityCandidates: async () => [],
      paidPeriod: async () => ({
        invoice_id: 'in_Crew',
        customer_id: 'cus_Crew',
        subscription_id: 'sub_Crew',
        price_id: 'price_Crew',
        created: Math.floor(Date.now() / 1000) - 100_000,
        paid_at: Math.floor(Date.now() / 1000) - 1,
        start: Math.floor(Date.now() / 1000) - 90_000,
        end: Math.floor(Date.now() / 1000) + (paid ? 3600 : -3600),
      }),
    }),
  });
  apps.push(app);
  const { store, service } = app.jellyport;
  if (!demo) {
    const pending = store.authState();
    if (pending?.kind !== 'pending') throw new Error('Isolated setup expected');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'https://jellyfin.example.test',
        serverId: identity.serverId,
        apiKeyName: 'synthetic',
      },
      (current) => ({
        ...current,
        jellyfin_url: 'https://jellyfin.example.test',
        jellyfin_api_key: 'synthetic-media-key',
        discord_enabled: true,
        discord_guild_id: '123456789012345678',
      }),
    );
  }
  service.bot = {
    status: () => ({ connected: true }),
    recipientIdentity: async (id) => ({ id, username: 'synthetic-member' }),
    validateRecipient: async () => {},
    sendCredentials: async () => {},
    membershipActive: async () => true,
    activeMemberPage: async () => ({ members: [] }),
  };
  const session = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${session.cookies[0]!.value}`,
      'x-csrf-token': session.json().csrf_token,
    },
    payload: { username: 'admin', password: demo ? 'demo-jellyport' : 'synthetic-password' },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: `jellyport_session=${login.cookies[0]!.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  const revision = () => app.jellyport.stripe.status().revision;
  const configure = () =>
    app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers,
      payload: { api_key: key, sync_enabled: false, expected_revision: revision() },
    });
  return { app, store, headers, revision, configure, snapshot, servers };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('private Stripe integration HTTP boundary', () => {
  it('requires an administrator and CSRF for sensitive reads and changes', async () => {
    const { app, headers, revision } = await fixture();
    for (const url of [
      '/api/stripe/status',
      '/api/stripe/subscriptions',
      '/api/stripe/cleanup-roles',
    ])
      expect((await app.inject(url)).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers: { cookie: headers.cookie },
      payload: { api_key: key, sync_enabled: false, expected_revision: revision() },
    });
    expect(response.statusCode).toBe(403);
    expect(app.jellyport.stripe.status().configured).toBe(false);
    expect(
      (
        await app.inject({
          url: '/api/stripe/status',
          headers: { ...headers, origin: 'https://foreign.example.test' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('protects role selection and accepts only the bounded cleanup configuration schema', async () => {
    const { app, headers, revision, configure } = await fixture();
    const listRoles = vi.fn(async () => ({
      roles: [
        { id: '555555555555555555', name: 'Subscriber', manageable: true },
        { id: '999999999999999999', name: 'Administrator', manageable: false },
      ],
      can_manage_roles: true,
    }));
    Object.assign(app.jellyport.service.bot!, { listSubscriberRoles: listRoles });
    expect((await configure()).statusCode).toBe(200);
    const selected = await app.inject({ url: '/api/stripe/cleanup-roles', headers });
    expect(selected.statusCode).toBe(200);
    expect(selected.headers['cache-control']).toBe('no-store');
    expect(selected.json()).toEqual(await listRoles());
    listRoles.mockClear();
    expect(
      (
        await app.inject({
          url: '/api/stripe/cleanup-roles',
          headers: { ...headers, origin: 'https://foreign.example.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(listRoles).not.toHaveBeenCalled();
    for (const role_cleanup_role_ids of [
      ['555555555555555555', '555555555555555555'],
      ['not-an-id'],
      Array.from({ length: 21 }, (_, i) => String(555555 + i)),
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/stripe/config',
            headers,
            payload: {
              sync_enabled: false,
              role_cleanup_enabled: false,
              role_cleanup_role_ids,
              expected_revision: revision(),
            },
          })
        ).statusCode,
      ).toBe(422);
    }
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers: { cookie: headers.cookie },
      payload: {
        sync_enabled: false,
        role_cleanup_enabled: false,
        role_cleanup_role_ids: [],
        expected_revision: revision(),
      },
    });
    expect(noCsrf.statusCode).toBe(403);
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers,
      payload: {
        sync_enabled: false,
        role_cleanup_enabled: false,
        role_cleanup_role_ids: [],
        expected_revision: revision(),
      },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().role_cleanup.enabled).toBe(false);
  });

  it('saves encrypted credentials, shares read-only sync, and approves only current member links', async () => {
    const { app, store, headers, revision, configure, snapshot } = await fixture();
    const saved = await configure();
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(key);
    expect(saved.json()).toMatchObject({ configured: true, review_only: true });
    const sync = await app.inject({ method: 'POST', url: '/api/stripe/sync', headers });
    expect(sync.statusCode).toBe(202);
    await vi.waitFor(() => expect(app.jellyport.stripe.status().running).toBe(false));
    expect(snapshot).toHaveBeenCalledTimes(1);
    const status = await app.inject({ url: '/api/stripe/status', headers });
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).not.toContain('synthetic@example.test');
    const rows = await app.inject({ url: '/api/stripe/subscriptions', headers });
    expect(rows.json().subscriptions[0]).toMatchObject({
      customer_id: 'cus_Crew',
      linked_discord_id: null,
    });
    const suggested = await app.inject({
      method: 'POST',
      url: '/api/stripe/resolve-candidate',
      headers,
      payload: { customer_id: 'cus_Crew', expected_revision: revision() },
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.json().member).toEqual({
      id: member,
      username: 'synthetic-member',
      display_name: null,
      nickname: null,
      membership_active: null,
    });
    expect(app.jellyport.stripe.subscriptions()[0]!.linked_discord_id).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/stripe/links',
          headers,
          payload: { customer_id: 'cus_Crew', discord_user_id: member, expected_revision: 'stale' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/stripe/links',
          headers,
          payload: {
            customer_id: 'cus_Crew',
            discord_user_id: member,
            expected_revision: revision(),
          },
        })
      ).statusCode,
    ).toBe(200);
    const linked = await app.inject({ url: '/api/stripe/subscriptions', headers });
    expect(linked.json().subscriptions[0].linked_discord_id).toBe(member);
    const settings = await app.inject({ url: '/api/settings', headers });
    expect(settings.body).not.toContain(key);
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
  });

  it('uses the real app cleanup adapter and preserves a standalone customer approval after linking', async () => {
    const { app, store, headers, revision } = await fixture(false, true);
    store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
    const subscriberRole = '555555555555555555';
    let present = true;
    const removeSubscriberRole = vi.fn(
      async (_id: string, _role: string, _allowed: string[], guard: () => void) => {
        guard();
        present = false;
      },
    );
    Object.assign(app.jellyport.service.bot!, {
      listSubscriberRoles: async () => ({
        roles: [{ id: subscriberRole, name: 'Subscriber', manageable: true }],
        can_manage_roles: true,
      }),
      memberTagState: async (id: string) => ({
        id,
        username: 'synthetic-member',
        roles: present ? [subscriberRole] : [],
      }),
      removeSubscriberRole,
    });
    const config = (body: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/stripe/config',
        headers,
        payload: { sync_enabled: true, expected_revision: revision(), ...body },
      });
    expect(
      (
        await config({
          api_key: 'rk_live_syntheticKeyOnly123',
          price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }],
        })
      ).statusCode,
    ).toBe(200);
    await app.jellyport.stripe.sync();
    expect(
      (await config({ price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }] })).statusCode,
    ).toBe(200);
    await app.jellyport.stripe.linkCustomer({
      customer_id: 'cus_Crew',
      discord_user_id: member,
      expected_revision: revision(),
    });
    const settings = store.settings();
    app.jellyport.service.mediaOwnerships.annotate(
      'stripe:cus_Crew',
      {
        kind: 'non_media',
        note: 'Synthetic administrator-approved access.',
        approved_at: new Date().toISOString(),
      },
      settings,
    );
    const enabled = await config({
      role_cleanup_enabled: true,
      role_cleanup_role_ids: [subscriberRole],
      price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }],
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      automation_enabled: false,
      role_cleanup: { enabled: true },
    });
    await app.jellyport.stripe.sync();
    expect(present).toBe(true);
    expect(removeSubscriberRole).not.toHaveBeenCalled();
    app.jellyport.service.mediaOwnerships.annotate('stripe:cus_Crew', null, settings);
    await app.jellyport.stripe.sync();
    expect(removeSubscriberRole).toHaveBeenCalledExactlyOnceWith(
      member,
      subscriberRole,
      [subscriberRole],
      expect.any(Function),
    );
    expect(present).toBe(false);
    expect(app.jellyport.stripe.status().role_cleanup.reports[0]).toMatchObject({
      status: 'removed',
      discord_user_id: member,
      removed_role_ids: [subscriberRole],
    });
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
  });
  it('blocks demo credentials and rejects unknown configuration fields', async () => {
    const { app, headers, configure } = await fixture(true);
    expect((await configure()).statusCode).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: '/api/stripe/config',
      headers,
      payload: {
        api_key: key,
        sync_enabled: false,
        expected_revision: 'review',
        auto_disable: true,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(app.jellyport.stripe.status().configured).toBe(false);
  });

  it.each([false, true])(
    'reviews a live price downgrade, rejects stale approvals, and applies only the reviewed slots (%s)',
    async (replaceAfterApproval) => {
      const { app, store, headers, revision, servers } = await fixture(false, true, true);
      const { stripe, service } = app.jellyport;
      store.saveSettings({
        ...store.settings(),
        new_subscriber_source: 'stripe',
        template_user_id: 'template',
        auto_provision: false,
        auto_disable: true,
      });
      const config = (body: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/api/stripe/config',
          headers,
          payload: { sync_enabled: false, expected_revision: revision(), ...body },
        });
      expect((await config({ api_key: 'rk_live_syntheticKeyOnly123' })).statusCode).toBe(200);
      const before = [{ price_id: 'price_Crew', tier_id: 'galleon' }];
      const after = [{ price_id: 'price_Crew', tier_id: 'sloop' }];
      expect((await config({ price_tiers: before })).statusCode).toBe(200);
      await stripe.sync();
      await stripe.linkCustomer({
        customer_id: 'cus_Crew',
        discord_user_id: member,
        expected_revision: revision(),
      });
      service.memberships.save(
        {
          discord_user_id: member,
          base_username: 'synthetic-member',
          tier_id: 'galleon',
          account_limit: 3,
        },
        store.settings(),
      );
      for (const slot of [1, 2, 3]) {
        const account = {
          Id: `reviewed-slot-${slot}`,
          Name: slot === 1 ? 'synthetic-member' : `synthetic-member_${slot}`,
          Policy: { IsAdministrator: false, IsDisabled: false },
        };
        servers.users.jellyfin.push(account);
        store.saveLink(member, account.Name, account.Id, false, slot);
      }
      expect((await config({ automation_enabled: true })).statusCode).toBe(200);
      await stripe.sync();

      const timeline = async () =>
        (
          await app.inject({
            url: `/api/memberships/${member}/timeline`,
            headers,
          })
        ).json();
      expect((await timeline()).stripe.invoice?.tier_id).toBe('galleon');
      const denied = await config({ price_tiers: after });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().detail).toContain('exact account slots');
      expect(stripe.status().price_tiers).toEqual(before);
      expect(service.memberships.get(member, store.settings())?.account_limit).toBe(3);

      const review = async () =>
        app.inject({
          method: 'POST',
          url: '/api/stripe/config/price-review',
          headers,
          payload: { expected_revision: revision(), price_tiers: after },
        });
      const first = await review();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.json()).toMatchObject({
        revision: revision(),
        mappings: [
          {
            price_id: 'price_Crew',
            previous_tier_id: 'galleon',
            tier_id: 'sloop',
            account_limit: 1,
          },
        ],
        affected: [
          {
            discord_user_id: member,
            slots: 3,
            price_ids: ['price_Crew'],
            accounts: [1, 2, 3].map((slot) => ({
              kind: 'jellyfin',
              id: `reviewed-slot-${slot}`,
              slot,
            })),
          },
        ],
      });
      store.saveLink(member, 'synthetic-member_3', 'replacement-slot-3', false, 3);
      expect(
        (await config({ price_tiers: after, price_review_token: first.json().review_token }))
          .statusCode,
      ).toBe(400);
      store.saveLink(member, 'synthetic-member_3', 'reviewed-slot-3', false, 3);
      expect(
        (await config({ price_tiers: after, price_review_token: first.json().review_token }))
          .statusCode,
      ).toBe(400);

      const revised = (await review()).json();
      await stripe.sync();
      expect(
        (await config({ price_tiers: after, price_review_token: revised.review_token })).statusCode,
      ).toBe(400);
      const valid = (await review()).json();
      const accepted = await config({ price_tiers: after, price_review_token: valid.review_token });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await timeline()).stripe.invoice).toBeNull();
      expect((await timeline()).milestones).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'subscription',
            invoice: expect.objectContaining({ tier_id: 'galleon' }),
          }),
        ]),
      );

      if (replaceAfterApproval) {
        const slot3 = servers.users.jellyfin.find(({ Id }) => Id === 'reviewed-slot-3')!;
        slot3.Id = 'replacement-slot-3';
        store.saveLink(member, slot3.Name, slot3.Id, false, 3);
      }
      store.saveSettings({ ...store.settings(), auto_provision: true });
      await stripe.sync();
      expect(
        service.memberships.get(member, store.settings())?.account_limit,
        JSON.stringify(
          store
            .subscriptions()
            .map(({ error, result, status, tier_id }) => ({ error, result, status, tier_id })),
        ),
      ).toBe(replaceAfterApproval ? 3 : 1);
      expect(
        store.linksForMember(member).map(({ disabled_by_jellyport }) => disabled_by_jellyport),
      ).toEqual(replaceAfterApproval ? [0, 0, 0] : [0, 1, 1]);
      if (!replaceAfterApproval) expect((await timeline()).stripe.invoice?.tier_id).toBe('sloop');

      stripe.unlinkCustomer({ customer_id: 'cus_Crew', expected_revision: revision() });
      const unlinked = await timeline();
      expect(unlinked.stripe).toMatchObject({ customer_count: 0, invoice: null });
      expect(unlinked.milestones).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'subscription',
            invoice: expect.objectContaining({ tier_id: 'galleon' }),
          }),
        ]),
      );
    },
  );
});
