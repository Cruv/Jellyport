import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { StripePaidPeriod, StripeSnapshot } from './stripe-client.js';
import { ServiceError } from './errors.js';
import { DEFAULT_MEMBERSHIP_TIERS } from './memberships.js';

export interface StripeEntitlementFact {
  provider: 'stripe';
  event_id: string;
  action: 'subscribe' | 'expire';
  discord_user_id: string;
  customer_id: string;
  subscription_id: string;
  invoice_id: string;
  tier_id: string;
  price_id: string;
  created_at: string;
  paid_through: string;
  observed_at: string;
  activation_revision: string;
  generation: string;
  authority_revision: string;
  is_new: boolean;
}
interface Activation {
  scope: string;
  generation: string;
  enabled_at: string;
  revision: string;
  baseline: string[];
  checked_at: string | null;
  latest: StripeEntitlementFact[];
  receipts: Array<{ id: string; outcome: 'claimed' | 'complete' | 'review' }>;
  error: string | null;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stripeAuthority(
  links: Array<{ customer_id: string; discord_user_id: string }>,
  prices: Array<{ price_id: string; tier_id: string }>,
  store: Store,
): string {
  return digest([
    links
      .map((link) => [link.customer_id, link.discord_user_id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    prices
      .map((price) => [price.price_id, price.tier_id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    (store.settings().membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS)
      .map((tier) => [tier.id, tier.account_limit])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const freshMs = 30 * 60_000;
export class StripeEntitlements {
  private state: Activation | null;
  constructor(
    readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS stripe_entitlement_policy (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL)',
    );
    const row = store.db
      .prepare('SELECT encrypted FROM stripe_entitlement_policy WHERE id=1')
      .get();
    this.state = row ? store.decrypt<Activation>(row.encrypted as Uint8Array) : null;
    if (this.state) {
      if (
        !Array.isArray(this.state.baseline) ||
        !Array.isArray(this.state.latest) ||
        !Array.isArray(this.state.receipts) ||
        this.state.receipts.length > 10_000
      )
        throw new ServiceError('The Stripe automation policy could not be verified.');
      for (const receipt of this.state.receipts)
        if (receipt.outcome === 'claimed') receipt.outcome = 'review';
      this.persist();
    }
  }
  private scope(): string {
    const settings = this.store.settings(),
      auth = this.store.authState();
    return digest([
      settings.discord_guild_id,
      settings.emby_url,
      settings.jellyfin_url,
      auth?.kind === 'configured' ? auth.serverId : null,
      settings.new_subscriber_source,
    ]);
  }
  private persist(): void {
    if (this.state)
      this.store.db
        .prepare('INSERT OR REPLACE INTO stripe_entitlement_policy VALUES (1,?)')
        .run(this.store.encrypt(this.state));
    else this.store.db.prepare('DELETE FROM stripe_entitlement_policy WHERE id=1').run();
  }
  enabled(generation: string): boolean {
    return (
      !!this.state && this.state.generation === generation && this.state.scope === this.scope()
    );
  }
  status(generation: string) {
    const enabled = this.enabled(generation),
      state = enabled ? this.state : null;
    return {
      automation_enabled: enabled,
      automation_enabled_at: state?.enabled_at ?? null,
      automation_error: state?.error ?? null,
      automation_review_count:
        state?.receipts.filter((receipt) => receipt.outcome !== 'complete').length ?? 0,
    };
  }
  configure(
    enabled: boolean,
    generation: string,
    snapshot: StripeSnapshot | null,
    lastSync: string | null,
  ): void {
    if (!enabled) {
      this.state = null;
      this.persist();
      return;
    }
    if (this.enabled(generation)) return;
    if (
      !snapshot ||
      snapshot.mode !== 'live' ||
      !Number.isFinite(Date.parse(lastSync ?? '')) ||
      this.now() - Date.parse(lastSync!) > freshMs
    )
      throw new ServiceError(
        'Sync a live Stripe connection successfully before enabling billing automation.',
      );
    const settings = this.store.settings();
    if (!settings.discord_enabled || settings.new_subscriber_source !== 'stripe')
      throw new ServiceError(
        'Select Stripe as the subscription source and connect Discord before enabling billing automation.',
      );
    this.state = {
      scope: this.scope(),
      generation,
      enabled_at: new Date(this.now()).toISOString(),
      revision: randomUUID(),
      baseline: snapshot.subscriptions.map((subscription) => subscription.id),
      checked_at: null,
      latest: [],
      receipts: [],
      error: null,
    };
    this.persist();
  }
  fail(message: string): void {
    if (!this.state) return;
    this.state.error = message;
    this.state.latest = [];
    this.persist();
  }
  /** Aggregate every subscription belonging to every approved customer for an
   * owner. Unmapped/multiple/unknown billing never becomes an expiry decision. */
  prepare(
    generation: string,
    snapshot: StripeSnapshot,
    links: Array<{ customer_id: string; discord_user_id: string }>,
    priceTiers: Array<{ price_id: string; tier_id: string }>,
    periods: Map<string, StripePaidPeriod | null>,
  ): StripeEntitlementFact[] {
    if (!this.enabled(generation) || snapshot.mode !== 'live') return [];
    const state = this.state!,
      facts: StripeEntitlementFact[] = [],
      time = this.now();
    const owners = new Set(links.map((link) => link.discord_user_id));
    for (const owner of owners) {
      const customers = new Set(
        links.filter((link) => link.discord_user_id === owner).map((link) => link.customer_id),
      );
      const subscriptions = snapshot.subscriptions.filter((subscription) =>
        customers.has(subscription.customer_id),
      );
      if (!subscriptions.length) continue;
      const recognized = subscriptions.map((subscription) => {
        const period = periods.get(subscription.id),
          item = subscription.items[0];
        const tier = item
          ? priceTiers.find((entry) => entry.price_id === item.price_id)?.tier_id
          : null;
        if (
          !period ||
          !tier ||
          subscription.items.length !== 1 ||
          item?.quantity !== 1 ||
          subscription.pause_collection ||
          period.customer_id !== subscription.customer_id ||
          period.subscription_id !== subscription.id ||
          period.price_id !== item.price_id ||
          !Number.isSafeInteger(subscription.created) ||
          subscription.created! * 1000 > time + 30_000 ||
          period.paid_at * 1000 > time + 30_000
        )
          return null;
        return { subscription, period, tier };
      });
      if (recognized.some((entry) => !entry)) continue;
      const paid = recognized.filter((entry) => entry !== null);
      const active = paid.filter(
        (entry) =>
          entry.subscription.status === 'active' &&
          entry.period.start * 1000 <= time &&
          entry.period.end * 1000 > time,
      );
      let selected =
        active.length === 1 &&
        paid.every(
          (entry) =>
            entry === active[0] ||
            (['canceled', 'incomplete_expired'].includes(entry.subscription.status) &&
              typeof entry.subscription.ended_at === 'number' &&
              entry.subscription.ended_at * 1000 <= time &&
              entry.period.end * 1000 <= time),
        )
          ? active[0]
          : undefined;
      let action: 'subscribe' | 'expire' = 'subscribe';
      if (
        !selected &&
        paid.every(
          (entry) =>
            ['canceled', 'incomplete_expired'].includes(entry.subscription.status) &&
            typeof entry.subscription.ended_at === 'number' &&
            entry.subscription.ended_at * 1000 <= time &&
            entry.period.end * 1000 <= time,
        )
      ) {
        selected = [...paid].sort((a, b) => b.period.end - a.period.end)[0];
        action = 'expire';
      }
      if (!selected) continue;
      const { subscription, period, tier } = selected;
      const event_id = `stripe-${digest([generation, owner, action, subscriptions.map((sub) => sub.id).sort(), period.invoice_id, period.end, tier])}`;
      facts.push({
        provider: 'stripe',
        event_id,
        action,
        discord_user_id: owner,
        customer_id: subscription.customer_id,
        subscription_id: subscription.id,
        invoice_id: period.invoice_id,
        tier_id: tier,
        price_id: period.price_id,
        created_at: iso(subscription.created!),
        paid_through: iso(period.end),
        observed_at: new Date(time).toISOString(),
        activation_revision: state.revision,
        generation,
        authority_revision: stripeAuthority(links, priceTiers, this.store),
        is_new:
          action === 'subscribe' &&
          !state.baseline.includes(subscription.id) &&
          subscription.created! * 1000 >= Date.parse(state.enabled_at) &&
          time - subscription.created! * 1000 <= 48 * 60 * 60_000,
      });
    }
    state.latest = facts;
    state.checked_at = new Date(time).toISOString();
    state.error = null;
    this.persist();
    return structuredClone(facts);
  }
  claim(fact: StripeEntitlementFact): boolean {
    this.assert(fact);
    if (this.state!.receipts.some((receipt) => receipt.id === fact.event_id)) return false;
    if (this.state!.receipts.length >= 10_000)
      throw new ServiceError(
        'Stripe automation reached its safe receipt limit; review stored billing events.',
      );
    this.state!.receipts.push({ id: fact.event_id, outcome: 'claimed' });
    this.persist();
    return true;
  }
  finish(fact: StripeEntitlementFact, succeeded: boolean): void {
    if (!this.enabled(fact.generation)) return;
    const receipt = this.state!.receipts.find((entry) => entry.id === fact.event_id);
    if (receipt) {
      receipt.outcome = succeeded ? 'complete' : 'review';
      this.persist();
    }
  }
  assert(fact: StripeEntitlementFact, authorityRevision?: string): void {
    const state = this.state;
    const current = state?.latest.find((entry) => entry.event_id === fact.event_id);
    if (
      !this.enabled(fact.generation) ||
      (authorityRevision !== undefined && fact.authority_revision !== authorityRevision) ||
      !state ||
      state.error ||
      state.revision !== fact.activation_revision ||
      !current ||
      digest({ ...current, observed_at: fact.observed_at }) !== digest(fact) ||
      !Number.isFinite(Date.parse(state.checked_at ?? '')) ||
      this.now() - Date.parse(state.checked_at!) > freshMs
    )
      throw new ServiceError(
        'Stripe entitlement evidence changed or expired. Refresh billing and review the member.',
      );
  }
}
