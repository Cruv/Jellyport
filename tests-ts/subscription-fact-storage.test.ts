import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { SubscriptionEvent } from '../server/service.js';
import type { StripeEntitlementFact } from '../server/stripe-entitlements.js';

const fact: StripeEntitlementFact = {
  provider: 'stripe',
  event_id: 'stripe-synthetic-receipt',
  action: 'subscribe',
  discord_user_id: '100001',
  customer_id: 'cus_privateSyntheticCustomer',
  subscription_id: 'sub_privateSyntheticSubscription',
  invoice_id: 'in_privateSyntheticInvoice',
  tier_id: 'sloop',
  price_id: 'price_privateSyntheticPrice',
  created_at: '2026-10-23T00:00:00.000Z',
  paid_through: '2026-11-23T00:00:00.000Z',
  observed_at: '2026-10-23T00:01:00.000Z',
  activation_revision: 'synthetic-activation',
  generation: 'synthetic-generation',
  authority_revision: 'synthetic-authority',
  is_new: true,
};
const event: SubscriptionEvent = {
  id: fact.event_id,
  action: 'subscribe',
  source: 'stripe',
  status: 'pending',
  created_at: '2026-10-23T00:01:00.000Z',
  discord_user_id: '100001',
  job_id: 'synthetic-job',
  stripe_entitlement: fact,
};
describe('encrypted nested subscription entitlement facts', () => {
  let directory: string, store: Store;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-subscription-fact-'));
    store = new Store(directory);
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function raw(id = event.id): string {
    return store.db.prepare('SELECT payload FROM subscriptions WHERE id=?').get(id)!
      .payload as string;
  }
  it('round-trips encrypted paid proof without writing financial identifiers or periods into JSON', () => {
    store.saveSubscription(event);
    const payload = raw();
    for (const value of [
      fact.customer_id,
      fact.invoice_id,
      fact.subscription_id,
      fact.price_id,
      fact.paid_through,
    ])
      expect(payload).not.toContain(value);
    expect(JSON.parse(payload).stripe_entitlement).toBeUndefined();
    expect(JSON.parse(payload)._stripe_entitlement_encrypted).toEqual(expect.any(String));
    expect(store.subscription(event.id)).toEqual(event);
    expect(store.subscriptions()).toEqual([event]);
    expect(JSON.stringify(store.subscription(event.id))).not.toContain(
      '_stripe_entitlement_encrypted',
    );
    expect(
      store.db
        .prepare(
          "SELECT id FROM subscriptions WHERE json_extract(payload,'$.job_id')=? AND json_extract(payload,'$.status')='pending'",
        )
        .get('synthetic-job')!.id,
    ).toBe(event.id);
  });
  it('continues reading legacy plain facts and encrypts them on their next save', () => {
    store.db.prepare('INSERT INTO subscriptions VALUES (?,?)').run(event.id, JSON.stringify(event));
    expect(store.subscription(event.id)).toEqual(event);
    expect(store.subscriptions()).toEqual([event]);
    store.saveSubscription(store.subscription(event.id)!);
    expect(raw()).not.toContain(fact.invoice_id);
    expect(store.subscription(event.id)).toEqual(event);
  });
  it('preserves ordinary legacy events, ordering and filtered startup recovery', () => {
    const ordinary = {
      id: 'ordinary',
      action: 'subscribe' as const,
      source: 'mee6_message',
      status: 'pending',
      created_at: '2026-10-22T00:00:00.000Z',
    };
    store.saveSubscription(ordinary);
    store.saveSubscription({ ...event, status: 'processing' });
    store.close();
    store = new Store(directory);
    expect(store.subscriptions().map((value) => value.id)).toEqual([event.id, ordinary.id]);
    expect(store.subscription(event.id)).toMatchObject({
      status: 'failed',
      stripe_entitlement: fact,
    });
    expect(store.subscription(ordinary.id)).toEqual(ordinary);
    expect(raw()).not.toContain(fact.invoice_id);
  });
  it('authenticates the fact against the exact event when an encrypted value is transplanted', () => {
    store.saveSubscription(event);
    const payload = { ...JSON.parse(raw()), id: 'different-event' };
    store.db
      .prepare('INSERT INTO subscriptions VALUES (?,?)')
      .run(payload.id, JSON.stringify(payload));
    expect(() => store.subscription(payload.id)).toThrow('different subscription event');
    expect(() => store.subscriptions()).toThrow('different subscription event');
  });
});
