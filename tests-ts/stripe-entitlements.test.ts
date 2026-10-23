import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StripeEntitlements } from '../server/stripe-entitlements.js';
import {
  StripeClient,
  StripeClientError,
  type StripePaidPeriod,
  type StripeSnapshot,
  type StripeSubscription,
} from '../server/stripe-client.js';

const owner = '100001',
  generation = 'synthetic-generation';
const base = 1_800_000_000;
const links = [{ customer_id: 'cus_new', discord_user_id: owner }];
const prices = [{ price_id: 'price_member', tier_id: 'sloop' }];
function subscription(id = 'new'): StripeSubscription {
  return {
    id: `sub_${id}`,
    created: base + 1,
    customer_id: `cus_${id}`,
    status: 'active',
    collection_method: 'charge_automatically' as const,
    pause_collection: false,
    cancel_at_period_end: false,
    items: [{ id: `si_${id}`, price_id: 'price_member', product_id: 'prod_member', quantity: 1 }],
    identity_candidates: [],
  };
}
function paid(id = 'new'): StripePaidPeriod {
  return {
    invoice_id: `in_${id}`,
    customer_id: `cus_${id}`,
    subscription_id: `sub_${id}`,
    created: base + 1,
    paid_at: base + 2,
    price_id: 'price_member',
    start: base + 1,
    end: base + 86_400,
  };
}
function snapshot(subscriptions = [subscription()]): StripeSnapshot {
  return {
    mode: 'live',
    completed_at: new Date((base + 3) * 1000).toISOString(),
    products: [],
    subscriptions,
  };
}
describe('verified Stripe entitlement policy', () => {
  let directory: string, store: Store, policy: StripeEntitlements, clock: number;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-entitlements-'));
    store = new Store(directory);
    clock = base * 1000;
    store.saveSettings({
      ...store.settings(),
      discord_guild_id: '200001',
      discord_enabled: true,
      new_subscriber_source: 'stripe',
      jellyfin_url: 'http://jellyfin.example.test',
    });
    policy = new StripeEntitlements(store, () => clock);
    policy.configure(true, generation, snapshot([]), new Date(clock).toISOString());
    clock += 3000;
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function prepare(data = snapshot(), periods = new Map([['sub_new', paid()]])) {
    return policy.prepare(generation, data, links, prices, periods);
  }
  it('recognizes a newly created, paid subscription only for the approved identity and mapped price', () => {
    const facts = prepare();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      provider: 'stripe',
      action: 'subscribe',
      discord_user_id: owner,
      tier_id: 'sloop',
      is_new: true,
    });
    expect(() => policy.assert(facts[0]!)).not.toThrow();
    expect(policy.claim(facts[0]!)).toBe(true);
    expect(policy.claim(facts[0]!)).toBe(false);
  });
  it('treats the complete activation population as legacy, including subscriptions with recent timestamps', () => {
    policy.configure(false, generation, null, null);
    policy.configure(true, generation, snapshot(), new Date(clock).toISOString());
    expect(prepare()[0]?.is_new).toBe(false);
  });
  it('does not use email, metadata or unapproved customer names as ownership', () => {
    expect(
      policy.prepare(generation, snapshot(), [], prices, new Map([['sub_new', paid()]])),
    ).toEqual([]);
    expect(
      policy.prepare(generation, snapshot(), links, [], new Map([['sub_new', paid()]])),
    ).toEqual([]);
  });
  it.each(['trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'future_unknown'])(
    'keeps %s subscriptions out of automatic access decisions',
    (status) => {
      expect(prepare(snapshot([{ ...subscription(), status }]))).toEqual([]);
    },
  );
  it('does not disable an account just because cancellation is scheduled', () => {
    expect(prepare(snapshot([{ ...subscription(), cancel_at_period_end: true }]))[0]?.action).toBe(
      'subscribe',
    );
  });
  it('requires a confirmed paid period and past effective end before emitting expiry', () => {
    const expired = { ...subscription(), status: 'canceled', ended_at: base + 1 };
    expect(prepare(snapshot([expired]))).toEqual([]);
    expect(
      prepare(
        snapshot([expired]),
        new Map([['sub_new', { ...paid(), start: base - 10_000, end: base + 1 }]]),
      )[0]?.action,
    ).toBe('expire');
  });
  it('does not renew a canceled subscription when an old past-due invoice is paid after cancellation', () => {
    const day = 86_400;
    const original = subscription();
    const originalPeriod = { ...paid(), end: base + 30 * day };
    const active = prepare(snapshot([original]), new Map([[original.id, originalPeriod]]))[0]!;
    expect(active.action).toBe('subscribe');
    expect(policy.claim(active)).toBe(true);
    policy.finish(active, true);

    clock = (base + 45 * day) * 1000;
    expect(
      prepare(
        snapshot([{ ...original, status: 'past_due' }]),
        new Map([[original.id, originalPeriod]]),
      ),
    ).toEqual([]);
    expect(() => policy.assert(active)).toThrow('changed or expired');

    clock = (base + 61 * day) * 1000;
    const canceled = { ...original, status: 'canceled', ended_at: base + 60 * day };
    const expiry = prepare(snapshot([canceled]), new Map([[original.id, originalPeriod]]))[0]!;
    expect(expiry.action).toBe('expire');
    expect(policy.claim(expiry)).toBe(true);
    policy.finish(expiry, true);

    clock = (base + 62 * day) * 1000;
    const latePaidPeriod = {
      ...paid(),
      invoice_id: 'in_overdue',
      created: base + 30 * day,
      start: base + 30 * day,
      end: base + 60 * day,
      paid_at: base + 62 * day,
    };
    const late = prepare(snapshot([canceled]), new Map([[original.id, latePaidPeriod]]));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      action: 'expire',
      is_new: false,
      paid_through: new Date((base + 60 * day) * 1000).toISOString(),
    });
    expect(policy.claim(late[0]!)).toBe(true);
    policy.finish(late[0]!, true);
    clock += day * 1000;
    const refreshed = prepare(snapshot([canceled]), new Map([[original.id, latePaidPeriod]]))[0]!;
    expect(refreshed.action).toBe('expire');
    expect(policy.claim(refreshed)).toBe(false);
  });
  it('restores entitlement only for a genuinely active paid replacement after an old canceled invoice is paid late', () => {
    const day = 86_400;
    clock = (base + 62 * day) * 1000;
    const canceled = { ...subscription(), status: 'canceled', ended_at: base + 60 * day };
    const oldPeriod = {
      ...paid(),
      start: base + 30 * day,
      end: base + 60 * day,
      paid_at: base + 62 * day,
    };
    const replacement = {
      ...subscription('replacement'),
      customer_id: 'cus_new',
      created: base + 62 * day - 10,
    };
    const replacementPeriod = {
      ...paid('replacement'),
      customer_id: 'cus_new',
      created: replacement.created,
      paid_at: base + 62 * day - 5,
      start: replacement.created,
      end: base + 92 * day,
    };
    const facts = prepare(
      snapshot([canceled, replacement]),
      new Map([
        [canceled.id, oldPeriod],
        [replacement.id, replacementPeriod],
      ]),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      action: 'subscribe',
      subscription_id: replacement.id,
      invoice_id: replacementPeriod.invoice_id,
      paid_through: new Date(replacementPeriod.end * 1000).toISOString(),
      is_new: true,
    });
  });
  it('protects another approved customer’s current payment when a canceled subscription’s old invoice is paid late', () => {
    const day = 86_400;
    clock = (base + 62 * day) * 1000;
    const canceled = { ...subscription(), status: 'canceled', ended_at: base + 60 * day };
    const current = { ...subscription('other'), created: base + 61 * day };
    const oldPeriod = { ...paid(), end: base + 60 * day, paid_at: base + 62 * day };
    const currentPeriod = {
      ...paid('other'),
      created: current.created,
      paid_at: current.created + 1,
      start: current.created,
      end: base + 91 * day,
    };
    const both = [...links, { customer_id: 'cus_other', discord_user_id: owner }];
    const facts = policy.prepare(
      generation,
      snapshot([canceled, current]),
      both,
      prices,
      new Map([
        [canceled.id, oldPeriod],
        [current.id, currentPeriod],
      ]),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      action: 'subscribe',
      customer_id: 'cus_other',
      subscription_id: current.id,
    });
    expect(
      policy.prepare(
        generation,
        snapshot([canceled, current]),
        both,
        prices,
        new Map([[canceled.id, oldPeriod]]),
      ),
    ).toEqual([]);
  });
  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'unknown'])(
    'does not expire an owner when another approved customer has %s access',
    (status) => {
      const data = snapshot([
        { ...subscription(), status: 'canceled', ended_at: base + 1 },
        { ...subscription('other'), status },
      ]);
      const both = [...links, { customer_id: 'cus_other', discord_user_id: owner }];
      expect(
        policy
          .prepare(
            generation,
            data,
            both,
            prices,
            new Map([
              ['sub_new', { ...paid(), end: base + 1, start: base - 100 }],
              ['sub_other', paid('other')],
            ]),
          )
          .some((fact) => fact.action === 'expire'),
      ).toBe(false);
    },
  );
  it('treats missing invoices, quantity bundles and paused collection as unknown', () => {
    expect(prepare(snapshot(), new Map())).toEqual([]);
    expect(prepare(snapshot([{ ...subscription(), pause_collection: true }]))).toEqual([]);
    const bundle = subscription();
    bundle.items[0]!.quantity = 2;
    expect(prepare(snapshot([bundle]))).toEqual([]);
  });
  it('invalidates facts on billing failure, staleness, changed scope and changed source', () => {
    const fact = prepare()[0]!;
    clock += 31 * 60_000;
    expect(() => policy.assert(fact)).toThrow('changed or expired');
    clock -= 31 * 60_000;
    policy.fail('Synthetic unavailable billing');
    expect(() => policy.assert(fact)).toThrow('changed or expired');
    prepare();
    store.saveSettings({ ...store.settings(), discord_guild_id: '200002' });
    expect(() => policy.assert(fact)).toThrow('changed or expired');
  });
  it('never replays an uncertain claimed event after a restart', () => {
    const fact = prepare()[0]!;
    expect(policy.claim(fact)).toBe(true);
    policy = new StripeEntitlements(store, () => clock);
    expect(policy.status(generation).automation_review_count).toBe(1);
    expect(policy.claim(fact)).toBe(false);
  });
  it('accepts unchanged evidence after refresh while rejecting a changed owner or tier', () => {
    const fact = prepare()[0]!;
    clock += 1000;
    prepare();
    expect(() => policy.assert(fact)).not.toThrow();
    expect(() => policy.assert({ ...fact, discord_user_id: '100002' })).toThrow();
    expect(() => policy.assert({ ...fact, tier_id: 'galleon' })).toThrow();
  });
});

function invoice() {
  return {
    id: 'in_paid',
    object: 'invoice',
    status: 'paid',
    livemode: true,
    amount_remaining: 0,
    customer: 'cus_new',
    created: base,
    status_transitions: { paid_at: base + 1 },
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } },
    lines: {
      has_more: false,
      data: [
        {
          object: 'line_item',
          livemode: true,
          quantity: 1,
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: { subscription: 'sub_new', proration: false },
          },
          pricing: { type: 'price_details', price_details: { price: 'price_member' } },
          period: { start: base, end: base + 86_400 },
        },
      ],
    },
  };
}
describe('Stripe paid-invoice API projection', () => {
  function api(data: unknown) {
    return new StripeClient('rk_live_syntheticOnly', {
      requestGapMs: 0,
      transport: async (url, init) => {
        expect(new URL(url).pathname).toBe('/v1/invoices');
        expect(new URL(url).searchParams.get('subscription')).toBe('sub_new');
        expect(new URL(url).searchParams.get('status')).toBe('paid');
        expect(init.method).toBe('GET');
        return new Response(JSON.stringify({ object: 'list', has_more: true, data: [data] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
  }
  it('uses the paid subscription line period rather than invoice.period_end', async () => {
    const value = {
      ...invoice(),
      period_end: base - 10_000,
      customer_email: 'never-retain@example.test',
    };
    const result = await api(value).paidPeriod('sub_new');
    expect(result).toMatchObject({
      end: base + 86_400,
      subscription_id: 'sub_new',
      price_id: 'price_member',
    });
    expect(JSON.stringify(result)).not.toContain('never-retain');
  });
  it('keeps an overdue invoice’s original service period when it is paid much later', async () => {
    const day = 86_400;
    const value = {
      ...invoice(),
      created: base - 90 * day,
      period_end: base + 30 * day,
      status_transitions: { paid_at: base + 1 },
    };
    value.lines.data[0]!.period = { start: base - 90 * day, end: base - 60 * day };
    expect(await api(value).paidPeriod('sub_new')).toMatchObject({
      created: base - 90 * day,
      paid_at: base + 1,
      start: base - 90 * day,
      end: base - 60 * day,
    });
  });
  it('rejects a paid invoice for a different subscription', async () => {
    const value = invoice();
    value.parent.subscription_details.subscription = 'sub_other';
    await expect(api(value).paidPeriod('sub_new')).rejects.toBeInstanceOf(StripeClientError);
  });
  it('fails closed for truncated lines, prorations, bundles and missing paid timestamps', async () => {
    const truncated = invoice();
    truncated.lines.has_more = true;
    expect(await api(truncated).paidPeriod('sub_new')).toBeNull();
    const proration = invoice();
    proration.lines.data[0]!.parent.subscription_item_details.proration = true;
    expect(await api(proration).paidPeriod('sub_new')).toBeNull();
    const bundle = invoice();
    bundle.lines.data[0]!.quantity = 2;
    expect(await api(bundle).paidPeriod('sub_new')).toBeNull();
  });
  it('does not accept mixed test/live mode or unpaid invoice state', async () => {
    await expect(
      api({ ...invoice(), livemode: false }).paidPeriod('sub_new'),
    ).rejects.toBeInstanceOf(StripeClientError);
    await expect(
      api({ ...invoice(), status: 'open' }).paidPeriod('sub_new'),
    ).rejects.toBeInstanceOf(StripeClientError);
  });
});
