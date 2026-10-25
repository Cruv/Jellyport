import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StripeIntegration } from '../server/stripe-integration.js';
import {
  StripeClient,
  type StripePaidPeriod,
  type StripeSnapshot,
  type StripeSubscription,
} from '../server/stripe-client.js';

const base = 1_800_000_000,
  owner = '100001';
const resources: Array<{ directory: string; store: Store; integration: StripeIntegration }> = [];
const subscription = (customer = 'cus_member', suffix = 'member'): StripeSubscription => ({
  id: `sub_${suffix}`,
  customer_id: customer,
  created: base - 1000,
  status: 'active',
  collection_method: 'charge_automatically',
  pause_collection: false,
  cancel_at_period_end: false,
  identity_candidates: [],
  items: [{ id: `si_${suffix}`, price_id: 'price_member', product_id: 'prod_member', quantity: 1 }],
});
const period = (customer = 'cus_member', suffix = 'member'): StripePaidPeriod => ({
  invoice_id: `in_${suffix}`,
  subscription_id: `sub_${suffix}`,
  customer_id: customer,
  created: base - 1000,
  paid_at: base - 50,
  price_id: 'price_member',
  start: base - 100,
  end: base + 3600,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-stripe-migration-'));
  const store = new Store(directory);
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '200001',
    new_subscriber_source: 'stripe',
    jellyfin_url: 'http://jellyfin.example.test',
    auto_provision: false,
    auto_disable: false,
  });
  let clock = base * 1000;
  const data: StripeSnapshot = {
    mode: 'live',
    completed_at: new Date(clock).toISOString(),
    products: [],
    subscriptions: [subscription()],
  };
  const periods = new Map<string, StripePaidPeriod | null>([['sub_member', period()]]);
  const customerRead = vi.fn(async (id: string, _signal?: AbortSignal) =>
    structuredClone(data.subscriptions.filter((item) => item.customer_id === id)),
  );
  const invoiceRead = vi.fn(async (id: string, _signal?: AbortSignal) =>
    structuredClone(periods.get(id) ?? null),
  );
  const snapshot = vi.fn(async () => structuredClone(data));
  const onEntitlement = vi.fn(async () => {});
  const integration = new StripeIntegration(store, {
    clientFactory: () => ({
      mode: 'live',
      snapshot,
      customerSubscriptions: customerRead,
      paidPeriod: invoiceRead,
      checkoutIdentityCandidates: async () => [],
    }),
    resolveDiscordMember: async (id) => ({ id, username: 'synthetic.member' }),
    now: () => clock,
    onEntitlement,
  });
  resources.push({ directory, store, integration });
  const configure = (extra: Partial<Parameters<StripeIntegration['configure']>[0]> = {}) =>
    integration.configure({
      sync_enabled: false,
      expected_revision: integration.status().revision,
      ...extra,
    });
  await configure({ api_key: 'rk_live_syntheticOnly' });
  await integration.sync();
  await configure({ price_tiers: [{ price_id: 'price_member', tier_id: 'galleon' }] });
  const link = (customer_id = 'cus_member', discord_user_id = owner) =>
    integration.linkCustomer({
      customer_id,
      discord_user_id,
      expected_revision: integration.status().revision,
    });
  await link();
  return {
    store,
    integration,
    data,
    periods,
    customerRead,
    invoiceRead,
    snapshot,
    onEntitlement,
    configure,
    link,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
afterEach(async () => {
  for (const { directory, store, integration } of resources.splice(0)) {
    await integration.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe('owner-scoped Stripe membership evidence for migration', () => {
  it('finds the paid tier with automation disabled, without applying global events or writing memberships', async () => {
    const f = await fixture();
    expect(f.integration.status().automation_enabled).toBe(false);
    const changes = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    f.snapshot.mockClear();
    const result = await f.integration.reviewMembership(owner);
    expect(result).toMatchObject({
      status: 'verified',
      tier_id: 'galleon',
      tier_name: 'Galleon',
      account_limit: 3,
    });
    expect(result.proof).toMatchObject({
      owner_id: owner,
      paid_through: new Date((base + 3600) * 1000).toISOString(),
    });
    expect(() => f.integration.assertMigrationMembership(result.proof!)).not.toThrow();
    expect(f.customerRead.mock.calls.map(([id]) => id)).toEqual(['cus_member']);
    expect(f.invoiceRead.mock.calls.map(([id]) => id)).toEqual(['sub_member']);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.onEntitlement).not.toHaveBeenCalled();
    expect(f.store.membershipRecords()).toEqual([]);
    expect(f.store.subscriptions()).toEqual([]);
    expect(f.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    expect(JSON.stringify(result)).not.toMatch(/cus_member|sub_member|in_member|rk_live/);
  });
  it('never trusts unapproved metadata, names or an unrelated owner', async () => {
    const f = await fixture();
    f.data.subscriptions[0]!.identity_candidates = [
      { discord_user_id: '100009', source: 'customer_metadata', field: 'discord_id' },
    ];
    expect(await f.integration.reviewMembership('100009')).toMatchObject({ status: 'unlinked' });
    expect(f.customerRead).not.toHaveBeenCalled();
    expect(f.invoiceRead).not.toHaveBeenCalled();
  });
  it('reuses one cloned owner proof for multiple accounts and independent callers', async () => {
    const f = await fixture(),
      pending = deferred<StripeSubscription[]>();
    f.customerRead.mockImplementationOnce(async () => pending.promise);
    const abandoned = new AbortController();
    const first = f.integration.reviewMembership(owner, abandoned.signal);
    const canceled = expect(first).rejects.toThrow('canceled');
    const second = f.integration.reviewMembership(owner);
    abandoned.abort();
    await canceled;
    pending.resolve([subscription()]);
    const result = await second;
    expect(result.status).toBe('verified');
    const token = result.proof!.token;
    result.proof = { ...result.proof!, account_limit: 1 };
    expect(() => f.integration.assertMigrationMembership(result.proof!)).toThrow(
      'changed or expired',
    );
    const cached = await f.integration.reviewMembership(owner);
    expect(cached).toMatchObject({ account_limit: 3, proof: { token, account_limit: 3 } });
    expect(f.customerRead).toHaveBeenCalledTimes(1);
    expect(f.invoiceRead).toHaveBeenCalledTimes(1);
  });
  it('includes every approved customer and permits one active replacement after an expired subscription', async () => {
    const f = await fixture();
    const previous = {
      ...subscription('cus_old', 'old'),
      status: 'canceled',
      ended_at: base - 1000,
    };
    f.data.subscriptions.push(previous);
    f.periods.set('sub_old', { ...period('cus_old', 'old'), end: base - 1000, start: base - 2000 });
    await f.integration.sync();
    await f.link('cus_old');
    expect(await f.integration.reviewMembership(owner)).toMatchObject({
      status: 'verified',
      account_limit: 3,
    });
    expect(f.customerRead.mock.calls.map(([id]) => id).sort()).toEqual(['cus_member', 'cus_old']);
    expect(f.invoiceRead.mock.calls.map(([id]) => id).sort()).toEqual(['sub_member', 'sub_old']);
  });
  it('does not restore canceled subscriptions when an old invoice is paid late', async () => {
    const f = await fixture();
    Object.assign(f.data.subscriptions[0]!, { status: 'canceled', ended_at: base - 1000 });
    f.periods.set('sub_member', {
      ...period(),
      start: base - 9000,
      end: base - 2000,
      paid_at: base - 1,
    });
    const review = await f.integration.reviewMembership(owner);
    expect(review).toMatchObject({ status: 'inactive' });
    expect(review.proof).toBeUndefined();
  });
  it.each([
    'multiple-active',
    'missing-invoice',
    'unmapped-price',
    'paused',
    'foreign-invoice',
    'missing-customer',
  ])('leaves uncertain %s billing unresolved', async (caseName) => {
    const f = await fixture();
    if (caseName === 'multiple-active') {
      f.data.subscriptions.push(subscription('cus_member', 'extra'));
      f.periods.set('sub_extra', period('cus_member', 'extra'));
    }
    if (caseName === 'missing-invoice') f.periods.set('sub_member', null);
    if (caseName === 'unmapped-price')
      f.data.subscriptions[0]!.items[0]!.price_id = 'price_unknown';
    if (caseName === 'paused') f.data.subscriptions[0]!.pause_collection = true;
    if (caseName === 'foreign-invoice')
      f.periods.set('sub_member', { ...period(), customer_id: 'cus_other' });
    if (caseName === 'missing-customer') f.data.subscriptions = [];
    const review = await f.integration.reviewMembership(owner);
    expect(review.status).toBe('unavailable');
    expect(review.proof).toBeUndefined();
  });
  it.each(['owner', 'limit', 'token', 'expiry', 'source', 'guild', 'tier', 'sync', 'key', 'link'])(
    'rejects stale or altered %s proof',
    async (change) => {
      const f = await fixture();
      let proof = (await f.integration.reviewMembership(owner)).proof!;
      if (change === 'owner') proof = { ...proof, owner_id: '100009' };
      if (change === 'limit') proof = { ...proof, account_limit: 9 };
      if (change === 'token') proof = { ...proof, token: 'forged' };
      if (change === 'expiry') f.advance(60_000);
      if (change === 'source')
        f.store.saveSettings({ ...f.store.settings(), new_subscriber_source: 'trusted_messages' });
      if (change === 'guild')
        f.store.saveSettings({ ...f.store.settings(), discord_guild_id: '200009' });
      if (change === 'tier')
        f.store.saveSettings({
          ...f.store.settings(),
          membership_tiers: f.store
            .settings()
            .membership_tiers!.map((tier) => ({ ...tier, account_limit: 1 })),
        });
      if (change === 'sync') await f.integration.sync();
      if (change === 'key') await f.configure({ api_key: 'rk_live_replacedOnly' });
      if (change === 'link')
        f.integration.unlinkCustomer({
          customer_id: 'cus_member',
          expected_revision: f.integration.status().revision,
        });
      expect(() => f.integration.assertMigrationMembership(proof)).toThrow('changed or expired');
    },
  );
  it('refreshes unchanged billing facts after expiration with the same authority context', async () => {
    const f = await fixture();
    const original = (await f.integration.reviewMembership(owner)).proof!;
    f.advance(60_001);
    const refreshed = (await f.integration.reviewMembership(owner)).proof!;
    expect(refreshed.token).not.toBe(original.token);
    expect(refreshed).toMatchObject({
      context: original.context,
      owner_id: original.owner_id,
      tier_id: original.tier_id,
      account_limit: original.account_limit,
      paid_through: original.paid_through,
    });
    expect(() => f.integration.assertMigrationMembership(refreshed)).not.toThrow();
    expect(() => f.integration.assertMigrationMembership(original)).toThrow('changed or expired');
    expect(f.customerRead).toHaveBeenCalledTimes(2);
  });
  it('expires at the paid-through boundary even inside the cache interval', async () => {
    const f = await fixture();
    f.periods.set('sub_member', { ...period(), end: base + 2 });
    const proof = (await f.integration.reviewMembership(owner)).proof!;
    f.advance(2000);
    expect(() => f.integration.assertMigrationMembership(proof)).toThrow('changed or expired');
    expect((await f.integration.reviewMembership(owner)).status).toBe('unavailable');
  });
  it('invalidates a pending read after identity authority changes', async () => {
    const f = await fixture(),
      pending = deferred<StripeSubscription[]>();
    f.customerRead.mockImplementationOnce(async () => pending.promise);
    const review = f.integration.reviewMembership(owner);
    await vi.waitFor(() => expect(f.customerRead).toHaveBeenCalledTimes(1));
    await f.configure({ price_tiers: [{ price_id: 'price_member', tier_id: 'sloop' }] });
    pending.resolve([subscription()]);
    expect(await review).toMatchObject({ status: 'unavailable' });
    expect(f.invoiceRead).not.toHaveBeenCalled();
  });
  it('limits parallel owners to four and times out queued and active reads without leaking slots', async () => {
    const f = await fixture();
    for (let index = 2; index <= 8; index++) {
      f.data.subscriptions.push(subscription(`cus_owner${index}`, `owner${index}`));
      f.periods.set(`sub_owner${index}`, period(`cus_owner${index}`, `owner${index}`));
    }
    await f.integration.sync();
    for (let index = 2; index <= 8; index++)
      await f.link(`cus_owner${index}`, String(100000 + index));
    vi.useFakeTimers();
    f.customerRead.mockImplementation(async () => new Promise(() => {}));
    const reviews = Array.from({ length: 8 }, (_, index) =>
      f.integration.reviewMembership(String(100001 + index)),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.customerRead).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await Promise.all(reviews)).every((result) => result.status === 'unavailable')).toBe(
      true,
    );
    f.customerRead.mockImplementation(async (id) =>
      structuredClone(f.data.subscriptions.filter((item) => item.customer_id === id)),
    );
    expect(await f.integration.reviewMembership(owner)).toMatchObject({ status: 'verified' });
  });
  it('caps retained proofs and duplicate work rather than growing for every owner forever', async () => {
    const f = await fixture();
    for (let index = 2; index <= 129; index++) {
      f.data.subscriptions.push(subscription(`cus_owner${index}`, `owner${index}`));
      f.periods.set(`sub_owner${index}`, period(`cus_owner${index}`, `owner${index}`));
    }
    await f.integration.sync();
    for (let index = 2; index <= 129; index++)
      await f.link(`cus_owner${index}`, String(100000 + index));
    const first = (await f.integration.reviewMembership(owner)).proof!;
    for (let index = 2; index <= 129; index++)
      expect((await f.integration.reviewMembership(String(100000 + index))).status).toBe(
        'verified',
      );
    expect(() => f.integration.assertMigrationMembership(first)).toThrow('changed or expired');
    expect(f.customerRead).toHaveBeenCalledTimes(129);
  });
  it('returns a safe failure for invoice permission denial and aborts pending work on shutdown', async () => {
    const f = await fixture();
    f.invoiceRead.mockRejectedValueOnce(new Error('private invoice details never display'));
    expect(await f.integration.reviewMembership(owner)).toMatchObject({ status: 'unavailable' });
    f.advance(10_001);
    f.customerRead.mockImplementationOnce(async () => new Promise(() => {}));
    const work = f.integration.reviewMembership(owner);
    await vi.waitFor(() => expect(f.customerRead).toHaveBeenCalledTimes(2));
    await f.integration.stop();
    expect(await work).toMatchObject({ status: 'unavailable' });
  });
});

const json = (data: unknown[], has_more = false) =>
  new Response(JSON.stringify({ object: 'list', data, has_more }), {
    headers: { 'content-type': 'application/json' },
  });
function rawSubscription(suffix = 'member', customer = 'cus_member') {
  return {
    id: `sub_${suffix}`,
    object: 'subscription',
    livemode: true,
    customer,
    status: 'active',
    collection_method: 'charge_automatically',
    cancel_at_period_end: false,
    pause_collection: null,
    items: {
      has_more: false,
      data: [
        { id: `si_${suffix}`, quantity: 1, price: { id: 'price_member', product: 'prod_member' } },
      ],
    },
  };
}
describe('Stripe customer subscription API filtering', () => {
  it('uses documented customer and status filters with stable cursor pages and validates scope', async () => {
    const urls: URL[] = [];
    const client = new StripeClient('rk_live_syntheticOnly', {
      requestGapMs: 0,
      transport: async (address, init) => {
        const url = new URL(address);
        urls.push(url);
        expect(init.method).toBe('GET');
        expect(url.pathname).toBe('/v1/subscriptions');
        expect(url.searchParams.get('customer')).toBe('cus_member');
        expect(url.searchParams.get('status')).toBe('all');
        expect(url.searchParams.get('limit')).toBe('100');
        return urls.length === 1
          ? json([rawSubscription()], true)
          : json([rawSubscription('second')]);
      },
    });
    expect((await client.customerSubscriptions('cus_member')).map((row) => row.id)).toEqual([
      'sub_member',
      'sub_second',
    ]);
    expect(urls[1]!.searchParams.get('starting_after')).toBe('sub_member');
    await expect(client.customerSubscriptions('invalid')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const wrong = new StripeClient('rk_live_syntheticOnly', {
      requestGapMs: 0,
      transport: async () => json([rawSubscription('wrong', 'cus_other')]),
    });
    await expect(wrong.customerSubscriptions('cus_member')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('bounds a single owner customer catalog to 100 subscriptions', async () => {
    let calls = 0;
    const client = new StripeClient('rk_live_syntheticOnly', {
      requestGapMs: 0,
      transport: async () => {
        calls++;
        return calls === 1
          ? json(
              Array.from({ length: 100 }, (_, index) => rawSubscription(String(index))),
              true,
            )
          : json([rawSubscription('extra')]);
      },
    });
    await expect(client.customerSubscriptions('cus_member')).rejects.toMatchObject({
      code: 'response_limit',
    });
    expect(calls).toBe(2);
  });
});
