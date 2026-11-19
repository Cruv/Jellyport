import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import type { StripeSnapshot } from '../server/stripe-client.js';
import { StripeIntegration } from '../server/stripe-integration.js';

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
  const billing: { priceId: string; invoiceId: string; previousPriceId?: string } = {
    priceId: 'price_Crew',
    invoiceId: 'in_Crew',
  };
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
        latest_invoice_id: billing.invoiceId,
        cancel_at_period_end: false,
        pause_collection: false,
        items: live
          ? [{ id: 'si_Crew', price_id: billing.priceId, product_id: 'prod_Crew', quantity: 1 }]
          : [],
        identity_candidates: [
          { discord_user_id: member, source: 'subscription_metadata', field: 'discord_user_id' },
        ],
      },
      ...(billing.previousPriceId
        ? [
            {
              id: 'sub_Previous',
              customer_id: 'cus_Crew',
              status: 'canceled',
              created: Math.floor(Date.now() / 1000) - 200_000,
              ended_at: Math.floor(Date.now() / 1000) - 3_600,
              collection_method: 'charge_automatically' as const,
              cancel_at_period_end: false,
              pause_collection: false,
              items: [
                {
                  id: 'si_Previous',
                  price_id: billing.previousPriceId,
                  product_id: 'prod_Crew',
                  quantity: 1,
                },
              ],
              identity_candidates: [],
            },
          ]
        : []),
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
      paidPeriod: async (id) => ({
        invoice_id: id === 'sub_Previous' ? 'in_Previous' : billing.invoiceId,
        customer_id: 'cus_Crew',
        subscription_id: id,
        price_id: id === 'sub_Previous' ? billing.previousPriceId! : billing.priceId,
        created: Math.floor(Date.now() / 1000) - 100_000,
        paid_at: Math.floor(Date.now() / 1000) - 1,
        start: Math.floor(Date.now() / 1000) - 90_000,
        end: Math.floor(Date.now() / 1000) + (paid && id !== 'sub_Previous' ? 3600 : -3600),
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
  return { app, store, headers, revision, configure, snapshot, servers, billing, directory };
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

  it.each(['linked', 'replacement', 'unlinked'] as const)(
    'reviews a live price downgrade, rejects stale approvals, and applies only the reviewed slots (%s)',
    async (accountPlan) => {
      const replaceAfterApproval = accountPlan === 'replacement';
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
        if (accountPlan === 'unlinked' && slot > 1)
          service.mediaOwnerships.save(
            [
              {
                kind: 'jellyfin',
                server_id: 'demo-jellyfin',
                account_id: account.Id,
                username: account.Name,
                discord_user_id: member,
                slot,
              },
            ],
            store.settings(),
          );
        else store.saveLink(member, account.Name, account.Id, false, slot);
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
      if (accountPlan !== 'unlinked') {
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
      }

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
        store
          .linksForMember(member)
          .map(({ remote_id, disabled_by_jellyport }) => [remote_id, disabled_by_jellyport]),
      ).toEqual([
        ['reviewed-slot-1', 0],
        ['reviewed-slot-2', replaceAfterApproval ? 0 : 1],
        [
          replaceAfterApproval ? 'replacement-slot-3' : 'reviewed-slot-3',
          replaceAfterApproval ? 0 : 1,
        ],
      ]);
      expect(
        servers.users.jellyfin
          .filter(({ Id }) => /^reviewed-slot-[23]$/.test(Id))
          .map(({ Policy }) => Policy?.IsDisabled),
      ).toEqual(replaceAfterApproval ? [false] : [true, true]);
      const currentEvent = store
        .subscriptionsForMember(member, 'stripe')
        .find(({ tier_id }) => tier_id === 'sloop');
      expect(currentEvent).toMatchObject(
        replaceAfterApproval
          ? { status: 'pending', stripe_price_review_required: true }
          : { status: 'applied', job_id: expect.any(String) },
      );
      if (currentEvent?.job_id)
        expect(service.getJob(currentEvent.job_id).status).toBe('completed');
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

  it.each([
    'empty cached impact',
    'unchanged fallback after removal',
    'verified higher renewal',
    'approved Family exemption',
    'independent Family exemption',
    'already disabled outside Jellyport',
    'queued review survives restart',
    'queued review with changed event fails closed',
  ] as const)(
    'holds a fresh price switch requiring a new exact-household review (%s)',
    async (scenario) => {
      const { app, store, headers, revision, servers, billing, directory } = await fixture(
        false,
        true,
        true,
      );
      const { stripe, service } = app.jellyport;
      store.saveSettings({
        ...store.settings(),
        new_subscriber_source: 'stripe',
        template_user_id: 'template',
        auto_provision: false,
        auto_disable: true,
      });
      const post = (url: string, payload: Record<string, unknown>) =>
        app.inject({ method: 'POST', url, headers, payload });
      const config = (body: Record<string, unknown>) =>
        post('/api/stripe/config', { sync_enabled: false, expected_revision: revision(), ...body });
      const review = async (price_tiers: Array<{ price_id: string; tier_id: string }>) => {
        const response = await post('/api/stripe/config/price-review', {
          expected_revision: revision(),
          price_tiers,
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json();
      };
      expect((await config({ api_key: 'rk_live_syntheticKeyOnly123' })).statusCode).toBe(200);
      const high = { price_id: 'price_Crew', tier_id: 'galleon' };
      const low = { price_id: 'price_Low', tier_id: 'sloop' };
      expect(
        (await config({ price_tiers: [high, { ...low, tier_id: 'brigantine' }] })).statusCode,
      ).toBe(200);
      if (scenario === 'unchanged fallback after removal') billing.priceId = low.price_id;
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
          Id: `cached-slot-${slot}`,
          Name: `cached-slot-${slot}`,
          Policy: { IsAdministrator: false, IsDisabled: false },
        };
        servers.users.jellyfin.push(account);
        store.saveLink(member, account.Name, account.Id, false, slot);
      }
      const priceReview = await review([high, low]);
      if (scenario !== 'unchanged fallback after removal') {
        expect(priceReview.affected).toEqual([]);
        expect((await config({ price_tiers: [high, low] })).statusCode).toBe(200);
        const row = store.db
          .prepare('SELECT encrypted FROM stripe_integration_state WHERE id=1')
          .get()!;
        expect(store.decrypt(row.encrypted as Uint8Array)).toMatchObject({
          price_cutovers: expect.arrayContaining([{ price_id: low.price_id, owners: [] }]),
        });
      } else {
        expect(priceReview.affected[0].discord_user_id).toBe(member);
        expect(
          (await config({ price_tiers: [high, low], price_review_token: priceReview.review_token }))
            .statusCode,
        ).toBe(200);
        billing.priceId = high.price_id;
        await stripe.sync();
        const remove = await review([low]);
        expect(remove.affected[0]).toMatchObject({
          discord_user_id: member,
          price_ids: [high.price_id],
        });
        expect(
          (await config({ price_tiers: [low], price_review_token: remove.review_token }))
            .statusCode,
        ).toBe(200);
        // Another effective but unrelated mapping save cannot erase the hold.
        expect(
          (
            await config({
              price_tiers: [low, { price_id: 'price_Unrelated', tier_id: 'galleon' }],
            })
          ).statusCode,
        ).toBe(200);
      }
      expect((await config({ automation_enabled: true })).statusCode).toBe(200);
      store.saveSettings({ ...store.settings(), auto_provision: true });
      billing.priceId = low.price_id;
      const jobs = store.jobCount();
      if (scenario === 'unchanged fallback after removal') {
        billing.previousPriceId = high.price_id;
        await stripe.sync();
        expect(store.subscriptionsForMember(member, 'stripe')).toEqual([]);
        expect(store.jobCount()).toBe(jobs);
        billing.previousPriceId = undefined;
      }
      await stripe.sync();
      expect(service.memberships.get(member, store.settings())?.account_limit).toBe(3);
      expect(store.jobCount()).toBe(jobs);
      expect(
        servers.users.jellyfin
          .filter(({ Id }) => Id.startsWith('cached-slot-'))
          .map(({ Policy }) => Policy?.IsDisabled),
      ).toEqual([false, false, false]);
      const events = await app.inject({ url: '/api/subscriptions', headers });
      expect(events.statusCode, events.body).toBe(200);
      const held = events
        .json()
        .events.find(
          ({ stripe_price_review_required }: { stripe_price_review_required?: boolean }) =>
            stripe_price_review_required,
        );
      expect(held).toMatchObject({
        discord_user_id: member,
        tier_id: 'sloop',
        account_limit: 1,
        status: 'pending',
        error: expect.stringContaining('exact account slots'),
      });
      expect(held).not.toHaveProperty('stripe_entitlement');
      expect(await service.applySubscription(held.id)).toMatchObject({
        status: 'pending',
        stripe_price_review_required: true,
      });
      expect(store.jobCount()).toBe(jobs);

      const membership = service.memberships.get(member, store.settings())!;
      const hasFamily =
        scenario === 'approved Family exemption' || scenario === 'independent Family exemption';
      if (hasFamily) {
        const profile = await post('/api/account-profiles', {
          kind: 'jellyfin',
          user_id: 'cached-slot-3',
          family: true,
          owner_name: '',
          notes: '',
          expected_revision: '',
        });
        expect(profile.statusCode, profile.body).toBe(200);
      }
      const manual = {
        discord_user_id: member,
        access_mode: 'subscription',
        tier_id: 'sloop',
        expected_revision: membership.revision,
        provision_jellyfin: false,
      };
      const bound = { ...manual, stripe_price_review_event_id: held.id };
      if (scenario === 'verified higher renewal') {
        const approvePath = '/api/memberships/workflow/accept';
        const reviewPath = '/api/memberships/workflow/review';
        store.saveSettings({ ...store.settings(), auto_provision: false });
        const pendingReview = await post(reviewPath, bound);
        const wrongOwner = await post(reviewPath, {
          ...bound,
          discord_user_id: '234567890123456780',
        });
        const wrongTier = await post(reviewPath, { ...bound, tier_id: high.tier_id });
        // The billing decision replaces the held event without revising the household.
        billing.priceId = high.price_id;
        billing.invoiceId = 'in_HigherRenewal';
        await stripe.sync();
        expect(store.subscription(held.id)).toMatchObject({ status: 'superseded', error: null });
        expect(stripe.status().automation_review_count).toBe(1);
        expect(service.memberships.get(member, store.settings())).toMatchObject({
          account_limit: 3,
          revision: membership.revision,
        });
        expect(pendingReview.statusCode, pendingReview.body).toBe(200);
        expect(wrongOwner.statusCode, wrongOwner.body).toBe(400);
        expect(wrongTier.statusCode, wrongTier.body).toBe(400);
        const declined = await post(approvePath, {
          review_token: pendingReview.json().review_token,
        });
        expect(declined.statusCode, declined.body).toBe(400);
        expect(declined.json().detail).toContain('superseded');
        const reopening = await post(reviewPath, bound);
        expect(reopening.statusCode, reopening.body).toBe(400);
        expect(store.jobCount()).toBe(jobs);
        const independent = await post(reviewPath, manual);
        expect(independent.statusCode, independent.body).toBe(200);
        const manualAccept = await post(approvePath, {
          review_token: independent.json().review_token,
        });
        expect(manualAccept.statusCode, manualAccept.body).toBe(202);
        await vi.waitFor(() =>
          expect(service.getJob(manualAccept.json().job.id).status).toBe('completed'),
        );
        expect(service.memberships.get(member, store.settings())?.account_limit).toBe(1);
        expect(store.subscription(held.id)?.status).toBe('superseded');
        return;
      }
      const independentFamily = scenario === 'independent Family exemption';
      const alreadyDisabled = scenario === 'already disabled outside Jellyport';
      if (alreadyDisabled)
        servers.users.jellyfin.find(({ Id }) => Id === 'cached-slot-2')!.Policy!.IsDisabled = true;
      const manualReview = await post(
        '/api/memberships/workflow/review',
        independentFamily ? manual : bound,
      );
      expect(manualReview.statusCode, manualReview.body).toBe(200);
      if (hasFamily)
        expect(manualReview.json().accounts).toContainEqual(
          expect.objectContaining({
            target_user_id: 'cached-slot-3',
            slot: 3,
            action: 'family_preserved',
          }),
        );
      const restart =
        scenario === 'queued review survives restart' ||
        scenario === 'queued review with changed event fails closed';
      const queuedOnly = restart
        ? vi.spyOn(store, 'claimQueuedJob').mockReturnValue(false)
        : undefined;
      const accept = await post('/api/memberships/workflow/accept', {
        review_token: manualReview.json().review_token,
      });
      expect(accept.statusCode, accept.body).toBe(202);
      if (queuedOnly) {
        const jobId = accept.json().job.id;
        await service.jobTasks.get(jobId);
        queuedOnly.mockRestore();
        expect(store.subscription(held.id)).toMatchObject({ status: 'processing', job_id: jobId });
        const bot = service.bot;
        apps.splice(apps.indexOf(app), 1);
        await app.close();
        const reopened = new Store(directory);
        const resumed = new Service(reopened, { clientFactory: servers.factory });
        const stripeAfterRestart = new StripeIntegration(reopened);
        try {
          const event = reopened.subscription(held.id)!;
          expect(event).toMatchObject({ status: 'processing', job_id: jobId });
          expect(
            reopened
              .queuedJobs()[0]
              ?.requests.map((request) => request.stripe_price_review?.job_id),
          ).toEqual([jobId, jobId, jobId]);
          const changed = scenario === 'queued review with changed event fails closed';
          if (changed) reopened.saveSubscription({ ...event, status: 'failed' });
          resumed.bot = bot;
          resumed.verifyStripeEntitlement = (fact, check) =>
            stripeAfterRestart.assertEntitlement(fact, check);
          resumed.finishStripePriceReview = (fact) => stripeAfterRestart.finishPriceReview(fact);
          await resumed.start();
          await resumed.jobTasks.get(jobId);
          const report = resumed.getJob(jobId);
          expect(report.status).toBe(changed ? 'failed' : 'completed');
          if (changed)
            expect(report.results.map(({ error }) => error)).toEqual(
              Array(3).fill(expect.stringContaining('accepted Stripe event changed')),
            );
          expect(reopened.subscription(held.id)?.status).toBe(changed ? 'failed' : 'applied');
          expect(
            servers.users.jellyfin
              .filter(({ Id }) => Id.startsWith('cached-slot-'))
              .map(({ Policy }) => Policy?.IsDisabled),
          ).toEqual(changed ? [false, false, false] : [false, true, true]);
        } finally {
          await resumed.stop();
          await stripeAfterRestart.stop();
          reopened.close();
        }
        return;
      }
      await vi.waitFor(() =>
        expect(service.getJob(accept.json().job.id).status).toBe(
          hasFamily ? 'partial' : 'completed',
        ),
      );
      expect(
        servers.users.jellyfin
          .filter(({ Id }) => Id.startsWith('cached-slot-'))
          .map(({ Policy }) => Policy?.IsDisabled),
      ).toEqual([false, true, !hasFamily]);
      if (!independentFamily)
        expect(store.subscription(held.id)).toMatchObject({
          status: 'applied',
          job_id: accept.json().job.id,
        });
      await stripe.sync();
      expect(store.subscription(held.id)).toMatchObject({ status: 'applied', error: null });
      expect(store.subscription(held.id)).not.toHaveProperty('stripe_price_review_required');
      expect(stripe.status().automation_review_count).toBe(0);
      if (alreadyDisabled) {
        expect(store.link(member, 2)?.disabled_by_jellyport).toBe(0);
        return;
      }

      billing.invoiceId = 'in_Renewal';
      await stripe.sync();
      const renewal = store
        .subscriptionsForMember(member, 'stripe')
        .find(({ stripe_entitlement }) => stripe_entitlement?.invoice_id === 'in_Renewal');
      expect(renewal).toMatchObject({ status: 'applied' });
      expect(renewal).not.toHaveProperty('stripe_price_review_required');
    },
  );
});
