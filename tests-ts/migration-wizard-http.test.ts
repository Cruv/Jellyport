import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import type { StripePaidPeriod, StripeSnapshot } from '../server/stripe-client.js';

const owner = '123456789012345678';
const ids = ['e-harbor', 'e-cabin', 'e-studio'];
const resources: Array<{ app: JellyportApp; directory: string }> = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-wizard-http-'));
  const servers = new DemoServers();
  servers.users.emby = ids.map((Id, index) => ({
    Id,
    Name: ['Harbor', 'Cabin', 'Studio'][index]!,
    Policy: { IsAdministrator: false, IsDisabled: false },
  }));
  servers.users.jellyfin = [
    ...servers.users.jellyfin.filter((user) => user.Id === 'template'),
    { Id: 'j-cabin', Name: 'GuestCabin', Policy: { IsAdministrator: false, IsDisabled: false } },
  ];
  const time = Math.floor(Date.now() / 1000);
  const snapshot: StripeSnapshot = {
    mode: 'live',
    completed_at: new Date().toISOString(),
    products: [{ id: 'prod_Crew', name: 'Crew', active: true }],
    subscriptions: [
      {
        id: 'sub_Crew',
        customer_id: 'cus_Crew',
        customer_name: 'Synthetic crew owner',
        customer_email: 'crew@example.test',
        created: time - 86400,
        status: 'active',
        collection_method: 'charge_automatically',
        pause_collection: false,
        cancel_at_period_end: false,
        items: [{ id: 'si_Crew', price_id: 'price_Crew', product_id: 'prod_Crew', quantity: 1 }],
        identity_candidates: [
          { discord_user_id: owner, source: 'customer_metadata', field: 'discord_id' },
        ],
      },
    ],
  };
  const paid: StripePaidPeriod = {
    invoice_id: 'in_Crew',
    customer_id: 'cus_Crew',
    subscription_id: 'sub_Crew',
    price_id: 'price_Crew',
    paid_at: time - 86400,
    created: time - 86400,
    start: time - 86400,
    end: time + 29 * 86400,
  };
  const customerRead = vi.fn(async (id: string) =>
    structuredClone(snapshot.subscriptions.filter((item) => item.customer_id === id)),
  );
  const snapshotRead = vi.fn(async () => structuredClone(snapshot));
  const identity = {
    serverId: 'demo-jellyfin',
    userId: 'admin',
    username: 'admin',
    accessToken: 'synthetic-session',
  };
  const app = await createApp({
    dataDir: directory,
    clientFactory: servers.factory,
    stripeClientFactory: () => ({
      mode: 'live',
      snapshot: snapshotRead,
      checkoutIdentityCandidates: async () => [],
      customerSubscriptions: customerRead,
      paidPeriod: async () => structuredClone(paid),
    }),
    authClient: {
      authenticate: async () => identity,
      validateSession: async () => identity,
      signOut: async () => {},
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
    },
  });
  resources.push({ app, directory });
  const { store, service, stripe } = app.jellyport;
  const pending = store.authState();
  if (pending?.kind !== 'pending') throw new Error('Expected fresh synthetic setup');
  store.completeAuth(
    pending.generation,
    {
      kind: 'configured',
      serverId: identity.serverId,
      serverUrl: 'http://jellyfin.example.test',
      apiKeyName: 'synthetic',
    },
    (settings) => ({
      ...settings,
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-source',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-target',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '223456789012345678',
      new_subscriber_source: 'trusted_messages',
      auto_provision: false,
      auto_disable: false,
    }),
  );
  service.bot = {
    status: () => ({ connected: true }),
    recipientIdentity: vi.fn(async (id) => ({ id, username: 'crew_owner' })),
    validateRecipient: vi.fn(async () => {}),
    sendCredentials: vi.fn(async () => {}),
    membershipActive: async () => true,
    activeMembers: async () => [],
  };
  await stripe.configure({
    api_key: 'rk_live_syntheticWizardOnly',
    sync_enabled: false,
    automation_enabled: false,
    expected_revision: stripe.status().revision,
  });
  vi.spyOn(service as unknown as { schedule: () => void }, 'schedule').mockImplementation(() => {});
  async function login() {
    const anonymous = await app.inject('/api/session');
    const signed = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'admin', password: 'synthetic-password' },
    });
    expect(signed.statusCode).toBe(200);
    return {
      cookie: `jellyport_session=${signed.cookies[0]!.value}`,
      'x-csrf-token': signed.json().csrf_token as string,
    };
  }
  const headers = await login();
  const start = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    headers,
    payload: { source_user_ids: ids },
  });
  expect(start.statusCode).toBe(202);
  const previewId = start.json().id as string;
  await vi.waitFor(async () => {
    const value = await app.inject({ url: `/api/migrations/preview/${previewId}`, headers });
    expect(value.json().status).toBe('ready');
  });
  const post = (action: string, payload: unknown, override = headers) =>
    app.inject({
      method: 'POST',
      url: `/api/migrations/preview/${previewId}/${action}`,
      headers: override,
      payload: payload as object,
    });
  const billing = {
    customer_ids: ['cus_Crew'],
    price_tiers: [{ price_id: 'price_Crew', tier_id: 'galleon' }],
  };
  async function resolve() {
    const directory = await post('billing', { discord_user_id: owner, refresh: true });
    expect(directory.statusCode).toBe(200);
    const membership = await post('membership', { discord_user_id: owner, billing });
    expect(membership.statusCode).toBe(200);
    const target = await post('account', { source_user_id: ids[1], target_user_id: 'j-cabin' });
    expect(target.statusCode).toBe(200);
    return { directory: directory.json(), membership: membership.json(), target: target.json() };
  }
  const accept = (membershipToken: string, accountToken?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers,
      payload: {
        source_user_ids: ids,
        preview_id: previewId,
        discord_recipients: Object.fromEntries(ids.map((id) => [id, owner])),
        membership_slots: Object.fromEntries(ids.map((id, index) => [id, index + 1])),
        membership_review_tokens: { [owner]: membershipToken },
        ...(accountToken ? { account_review_tokens: { [ids[1]!]: accountToken } } : {}),
      },
    });
  return {
    app,
    store,
    service,
    stripe,
    servers,
    headers,
    login,
    post,
    resolve,
    accept,
    previewId,
    customerRead,
    snapshotRead,
    snapshot,
  };
}

describe('session-owned end-to-end migration relationship wizard', () => {
  it('provides target-template metadata without requiring a Settings page read or exposing upstream private fields', async () => {
    const f = await fixture();
    Object.assign(f.servers.users.jellyfin[0]!, {
      Configuration: { PrivatePreference: 'synthetic-private-value' },
      AccessToken: 'synthetic-upstream-secret',
    });
    const response = await f.app.inject({ url: '/api/users', headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().template_user_id).toBe('template');
    expect(response.json().jellyfin[0]).toEqual({
      Id: 'template',
      Name: f.servers.users.jellyfin[0]!.Name,
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    expect(response.body).not.toContain('synthetic-private-value');
    expect(response.body).not.toContain('synthetic-upstream-secret');
  });

  it('reviews and accepts a new complimentary allowance for a roleless human without billing or other-screen setup', async () => {
    const f = await fixture();
    f.service.bot!.recipientIdentity = vi.fn(async (id, requireMembership) => {
      if (requireMembership) throw new Error('No synthetic subscriber role');
      return { id, username: 'family_owner' };
    });
    f.service.bot!.validateRecipient = vi.fn(async (_id, requireMembership) => {
      if (requireMembership) throw new Error('No synthetic subscriber role');
    });
    const review = await f.post('membership', {
      discord_user_id: owner,
      complimentary: { account_limit: 3 },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({
      status: 'complimentary',
      account_limit: 3,
      allowed_slots: [1, 2, 3],
      existing_member: null,
    });
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.jobs()).toEqual([]);
    const accepted = await f.accept(review.json().review_token);
    expect(accepted.statusCode).toBe(202);
    expect(f.service.memberships.get(owner, f.store.settings())).toMatchObject({
      access_mode: 'complimentary',
      account_limit: 3,
      active: true,
      provision_jellyfin: false,
    });
    expect(f.store.queuedJobs()[0]!.requests).toHaveLength(3);
    expect(f.customerRead).not.toHaveBeenCalled();
    expect(f.snapshotRead).not.toHaveBeenCalled();
    expect(f.stripe.status()).toMatchObject({ linked_customer_count: 0, price_tiers: [] });
    expect(f.service.bot!.sendCredentials).not.toHaveBeenCalled();
  });
  it('rejects mixed billing/complimentary drafts, invalid allowances and attempts to override a saved access hold', async () => {
    const f = await fixture();
    expect(
      (
        await f.post('membership', {
          discord_user_id: owner,
          billing: { customer_ids: [], price_tiers: [] },
          complimentary: { account_limit: 3 },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await f.post('membership', { discord_user_id: owner, complimentary: { account_limit: 4 } }))
        .statusCode,
    ).toBe(422);
    const member = f.service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'crew_owner',
        tier_id: 'galleon',
        account_limit: 3,
        active: false,
        provision_jellyfin: false,
      },
      f.store.settings(),
    );
    expect(
      (await f.post('membership', { discord_user_id: owner, complimentary: { account_limit: 3 } }))
        .statusCode,
    ).toBe(400);
    expect(f.service.memberships.get(owner, f.store.settings())).toEqual(member);
    expect(f.customerRead).not.toHaveBeenCalled();
    expect(f.store.jobs()).toEqual([]);
  });
  it('discards an unaccepted complimentary decision on cancellation', async () => {
    const f = await fixture();
    const review = await f.post('membership', {
      discord_user_id: owner,
      complimentary: { account_limit: 3 },
    });
    expect(review.statusCode).toBe(200);
    await f.app.inject({
      method: 'DELETE',
      url: `/api/migrations/preview/${f.previewId}`,
      headers: f.headers,
    });
    expect((await f.accept(review.json().review_token)).statusCode).toBe(400);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.jobs()).toEqual([]);
  });
  it('round-trips the generated billing search cursor through the authenticated API without duplicate customers', async () => {
    const f = await fixture();
    const base = f.snapshot.subscriptions[0]!;
    for (let index = 0; index < 30; index++)
      f.snapshot.subscriptions.push({
        ...structuredClone(base),
        id: `sub_Extra${index}`,
        customer_id: `cus_Extra${index}`,
        customer_name: `Synthetic extra ${index}`,
        identity_candidates: [],
      });
    const first = await f.post('billing', { discord_user_id: owner, refresh: true });
    expect(first.statusCode).toBe(200);
    expect(first.json().customers).toHaveLength(25);
    expect(first.json().next_cursor.length).toBeGreaterThan(64);
    const second = await f.post('billing', {
      discord_user_id: owner,
      cursor: first.json().next_cursor,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().customers).toHaveLength(6);
    expect(second.json().next_cursor).toBeNull();
    expect(
      new Set(
        [...first.json().customers, ...second.json().customers].map(
          (row: { id: string }) => row.id,
        ),
      ).size,
    ).toBe(31);
    expect(f.snapshotRead).toHaveBeenCalledTimes(1);
    expect(f.customerRead).not.toHaveBeenCalled();
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.store.jobs()).toEqual([]);
  });
  it('reviews customer, missing tier mapping and existing Jellyfin destination without writes, then commits them with membership and durable work', async () => {
    const f = await fixture();
    const initialRevision = f.stripe.status().revision;
    const { directory, membership, target } = await f.resolve();
    expect(directory.customers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'cus_Crew', name: 'Synthetic crew owner' }),
      ]),
    );
    expect(directory.tiers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'galleon', account_limit: 3 })]),
    );
    expect(membership).toMatchObject({
      account_limit: 3,
      allowed_slots: [1, 2, 3],
      source: 'stripe',
      billing_changes: {
        customer_links: [expect.objectContaining({ customer_id: 'cus_Crew' })],
        price_mappings: [expect.objectContaining({ price_id: 'price_Crew', tier_id: 'galleon' })],
      },
    });
    expect(JSON.stringify(membership)).not.toMatch(/stripe_proof|draft_hash|rk_live|invoice_id/);
    expect(target).toMatchObject({
      source_user_id: ids[1],
      target_user_id: 'j-cabin',
      target_username: 'GuestCabin',
    });
    expect(target).not.toHaveProperty('identity_hash');
    expect(target).not.toHaveProperty('settings_hash');
    expect(f.stripe.status()).toMatchObject({
      revision: initialRevision,
      linked_customer_count: 0,
      price_tiers: [],
      last_sync: null,
    });
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    const accepted = await f.accept(membership.review_token, target.review_token);
    expect(accepted.statusCode).toBe(202);
    expect(f.stripe.status()).toMatchObject({
      linked_customer_count: 1,
      price_tiers: [{ price_id: 'price_Crew', tier_id: 'galleon' }],
      automation_enabled: false,
    });
    expect(f.service.memberships.get(owner, f.store.settings())).toMatchObject({
      account_limit: 3,
      provision_jellyfin: false,
    });
    const mapping = f.service.mappings.getForSource(ids[1]!, f.store.settings())!;
    expect(mapping).toMatchObject({
      target_user_id: 'j-cabin',
      target_username: 'GuestCabin',
      discord_user_id: owner,
      membership_slot: 2,
    });
    const queued = f.store.queuedJobs().find((entry) => entry.job.id === accepted.json().id)!;
    expect(queued.requests).toHaveLength(3);
    expect(queued.requests.find((request) => request.source_user_id === ids[1])).toMatchObject({
      mapping_id: mapping.id,
      mapping_revision: mapping.revision,
    });
    expect(f.store.settings().new_subscriber_source).toBe('trusted_messages');
    expect(f.service.bot!.sendCredentials).not.toHaveBeenCalled();
  });
  it('cancels the draft without retaining any relationship changes or accepting its tokens', async () => {
    const f = await fixture();
    const { membership, target } = await f.resolve();
    await f.app.inject({
      method: 'DELETE',
      url: `/api/migrations/preview/${f.previewId}`,
      headers: f.headers,
    });
    expect((await f.accept(membership.review_token, target.review_token)).statusCode).toBe(400);
    expect(f.stripe.status()).toMatchObject({
      linked_customer_count: 0,
      price_tiers: [],
      last_sync: null,
    });
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
  });
  it('rejects foreign sessions and missing CSRF before disclosing billing candidates or target identities', async () => {
    const f = await fixture();
    const other = await f.login();
    expect(
      (await f.post('billing', { discord_user_id: owner, refresh: true }, other)).statusCode,
    ).toBe(404);
    expect(
      (await f.post('account', { source_user_id: ids[1], target_user_id: 'j-cabin' }, other))
        .statusCode,
    ).toBe(404);
    const denied = await f.app.inject({
      method: 'POST',
      url: `/api/migrations/preview/${f.previewId}/billing`,
      headers: { cookie: f.headers.cookie },
      payload: { discord_user_id: owner },
    });
    expect(denied.statusCode).toBe(403);
    expect(f.snapshotRead).not.toHaveBeenCalled();
  });
  it('rejects swapped membership/account tokens instead of trusting browser-provided relationship fields', async () => {
    const f = await fixture();
    const { membership, target } = await f.resolve();
    expect((await f.accept(target.review_token)).statusCode).toBe(400);
    expect((await f.accept(membership.review_token, membership.review_token)).statusCode).toBe(400);
    expect(
      (await f.post('account', { source_user_id: 'outside', target_user_id: 'j-cabin' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.post('membership', { discord_user_id: owner, account_limit: 3 })).statusCode,
    ).toBe(422);
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.store.jobs()).toEqual([]);
  });
  it('rejects protected destinations inside the wizard without saving a mapping', async () => {
    const f = await fixture();
    expect(
      (await f.post('account', { source_user_id: ids[1], target_user_id: 'template' })).statusCode,
    ).toBe(400);
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
  });
});
