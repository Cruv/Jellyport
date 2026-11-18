import { createHash } from 'node:crypto';
import type { StripePaidPeriod, StripeSnapshot, StripeSubscription } from './stripe-client.js';

export interface StripeOwnerEvidence {
  observed_at: number;
  inventory: string;
  periods: StripePaidPeriod[];
}
interface StripeBillingGroup {
  complete: boolean;
  subscriptions: StripeSubscription[];
  customers: string[];
}

export function stripeBillingInventory(
  snapshot: StripeSnapshot,
  links: ReadonlyArray<{ customer_id: string; discord_user_id: string }>,
): Map<string, StripeBillingGroup> {
  const byCustomer = new Map<string, StripeSubscription[]>();
  for (const subscription of snapshot.subscriptions) {
    const entries = byCustomer.get(subscription.customer_id) ?? [];
    entries.push(subscription);
    byCustomer.set(subscription.customer_id, entries);
  }
  const customers = new Map<string, string[]>();
  for (const link of links) {
    const ids = customers.get(link.discord_user_id) ?? [];
    ids.push(link.customer_id);
    customers.set(link.discord_user_id, ids);
  }
  return new Map(
    [...customers].map(([owner, ids]) => {
      const subscriptions = ids.flatMap((id) => byCustomer.get(id) ?? []);
      const complete = ids.every((id) => byCustomer.has(id));
      return [owner, { complete, subscriptions, customers: ids }] as const;
    }),
  );
}

/** Checkout suggestions, customer labels and inventory ordering do not affect invoices.
 * Lifecycle signals and price item identity/quantity do. */
export function stripeOwnerInventoryDigest(group: StripeBillingGroup): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        [...group.customers].sort(),
        group.subscriptions
          .map((entry) => [
            entry.id,
            entry.customer_id,
            entry.status,
            entry.created,
            entry.ended_at,
            entry.pause_collection,
            entry.cancel_at_period_end,
            entry.cancel_at,
            entry.canceled_at,
            entry.trial_end,
            entry.collection_method,
            entry.latest_invoice_id,
            entry.items.map(
              ({ id, price_id, quantity, current_period_start, current_period_end }) => [
                id,
                price_id,
                quantity,
                current_period_start,
                current_period_end,
              ],
            ),
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]),
    )
    .digest('hex');
}
