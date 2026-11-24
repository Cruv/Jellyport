import { createHash, randomUUID } from 'node:crypto';
import type { MembershipAccessTarget } from './membership-access-targets.js';
import type { Store } from './store.js';
import type { SubscriptionEvent } from './service.js';
import type { StripePaidPeriod, StripeSnapshot, StripeSubscription } from './stripe-client.js';
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
export interface StripeEntitlementCheck {
  evidenceOnly?: true;
  plannedReduction?: { targets: MembershipAccessTarget[]; hasEnabledTarget: boolean };
  wouldDisable?: true;
}
interface Activation {
  scope: string;
  generation: string;
  enabled_at: string;
  revision: string;
  baseline: string[];
  checked_at: string | null;
  latest: StripeEntitlementFact[];
  receipts: Array<{
    id: string;
    outcome: 'deferred' | 'claimed' | 'complete' | 'review' | 'superseded';
  }>;
  error: string | null;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A still-fresh reread of the same paid decision keeps review evidence valid. */
export function stripeDecisionKey(fact: StripeEntitlementFact): string {
  const { observed_at: _observation, ...decision } = fact;
  return digest(decision);
}
export function stripeAuthorityScope(store: Store): string {
  const settings = store.settings();
  const auth = store.authState();
  return digest([
    settings.discord_enabled,
    settings.discord_guild_id,
    settings.discord_member_role_id,
    settings.new_subscriber_source,
    settings.emby_url,
    settings.jellyfin_url,
    auth?.kind === 'configured' ? auth.serverId : null,
    (settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS)
      .map((tier) => [tier.id, tier.account_limit])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
export function stripeAuthority(
  links: Array<{ customer_id: string; discord_user_id: string }>,
  prices: Array<{ price_id: string; tier_id: string }>,
  store: Store,
): string {
  return digest([
    stripeAuthorityScope(store),
    links
      .map((link) => [link.customer_id, link.discord_user_id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    prices
      .map((price) => [price.price_id, price.tier_id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
export const stripeInvoiceFreshMs = 30 * 60_000;
export function freshStripeInvoice(observedAt: number, now: number): boolean {
  return (
    Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= stripeInvoiceFreshMs
  );
}
/** Older releases saved an untouched pending event and marked its receipt for
 * review. The exact pending expiry shape proves processing never started. */
export function isDeferredStripeExpiry(event: SubscriptionEvent | null): boolean {
  return (
    event?.source === 'stripe' &&
    event.action === 'expire' &&
    event.status === 'pending' &&
    event.stripe_entitlement?.event_id === event.id &&
    event.stripe_entitlement.action === event.action &&
    event.stripe_entitlement.discord_user_id === event.discord_user_id &&
    !event.job_id &&
    !event.error &&
    (event.stripe_expiry_deferred === true || event.result === undefined)
  );
}
function untouchedStripeReduction(
  event: SubscriptionEvent | null,
): event is SubscriptionEvent & { stripe_entitlement: StripeEntitlementFact } {
  return (
    event?.source === 'stripe' &&
    event.action === 'subscribe' &&
    !event.stripe_price_review_accepted &&
    !event.job_id &&
    !event.report_cleared &&
    event.stripe_entitlement?.event_id === event.id &&
    event.stripe_entitlement.action === event.action &&
    event.stripe_entitlement.discord_user_id === event.discord_user_id
  );
}
export function isHeldStripePriceReduction(event: SubscriptionEvent | null): boolean {
  return (
    untouchedStripeReduction(event) &&
    event.status === 'pending' &&
    event.stripe_price_review_required === true
  );
}
/** Older releases put these exact superseded events in their completed receipt bucket. */
export function isSupersededStripePriceReduction(
  event: SubscriptionEvent | null,
  fact: StripeEntitlementFact,
): boolean {
  if (
    !untouchedStripeReduction(event) ||
    event.status !== 'superseded' ||
    fact.action !== 'subscribe'
  )
    return false;
  const previous = event.stripe_entitlement;
  return (
    previous.event_id === fact.event_id &&
    previous.discord_user_id === fact.discord_user_id &&
    previous.generation === fact.generation &&
    previous.customer_id === fact.customer_id &&
    previous.subscription_id === fact.subscription_id &&
    previous.invoice_id === fact.invoice_id &&
    previous.paid_through === fact.paid_through &&
    previous.price_id === fact.price_id &&
    previous.tier_id === fact.tier_id
  );
}
export interface StripeBillingDecision {
  owner: string;
  action: 'subscribe' | 'expire';
  subscriptions: StripeSubscription[];
  subscription: StripeSubscription;
  period: StripePaidPeriod;
  tier: string;
}
/** Invoice-backed decisions shared by media automation and the independent
 * Discord cleanup backstop. Unknown billing and any still-active replacement
 * preserve access across every approved customer owned by the member. */
export function stripeBillingDecisions(
  snapshot: StripeSnapshot,
  links: Array<{ customer_id: string; discord_user_id: string }>,
  priceTiers: Array<{ price_id: string; tier_id: string }>,
  periods: Map<string, StripePaidPeriod | null>,
  time: number,
): StripeBillingDecision[] {
  if (snapshot.mode !== 'live') return [];
  const decisions: StripeBillingDecision[] = [];
  const customersByOwner = new Map<string, Set<string>>();
  for (const link of links) {
    const customers = customersByOwner.get(link.discord_user_id) ?? new Set();
    customers.add(link.customer_id);
    customersByOwner.set(link.discord_user_id, customers);
  }
  const subscriptionsByCustomer = new Map<string, StripeSubscription[]>();
  const position = new Map(snapshot.subscriptions.map((entry, index) => [entry.id, index]));
  for (const subscription of snapshot.subscriptions) {
    const entries = subscriptionsByCustomer.get(subscription.customer_id) ?? [];
    entries.push(subscription);
    subscriptionsByCustomer.set(subscription.customer_id, entries);
  }
  const tierByPrice = new Map(priceTiers.map(({ price_id, tier_id }) => [price_id, tier_id]));
  for (const [owner, customers] of customersByOwner) {
    if ([...customers].some((customer) => !subscriptionsByCustomer.has(customer))) continue;
    const subscriptions = [...customers]
      .flatMap((customer) => subscriptionsByCustomer.get(customer)!)
      .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    const recognized = subscriptions.map((subscription) => {
      const period = periods.get(subscription.id),
        item = subscription.items[0];
      const tier = item ? tierByPrice.get(item.price_id) : null;
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
    if (selected) decisions.push({ owner, action, subscriptions, ...selected });
  }
  return decisions;
}
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
        state?.receipts.filter((receipt) => ['claimed', 'review'].includes(receipt.outcome))
          .length ?? 0,
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
      this.now() - Date.parse(lastSync!) > stripeInvoiceFreshMs
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
    observedByOwner?: ReadonlyMap<string, number>,
  ): StripeEntitlementFact[] {
    if (!this.enabled(generation) || snapshot.mode !== 'live') return [];
    const state = this.state!,
      facts: StripeEntitlementFact[] = [],
      time = this.now();
    const authorityRevision = stripeAuthority(links, priceTiers, this.store);
    const baseline = new Set(state.baseline);
    for (const {
      owner,
      action,
      subscriptions,
      subscription,
      period,
      tier,
    } of stripeBillingDecisions(snapshot, links, priceTiers, periods, time)) {
      const observedAt = observedByOwner?.get(owner) ?? time;
      if (!freshStripeInvoice(observedAt, time)) continue;
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
        observed_at: new Date(observedAt).toISOString(),
        activation_revision: state.revision,
        generation,
        authority_revision: authorityRevision,
        is_new:
          action === 'subscribe' &&
          !baseline.has(subscription.id) &&
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
  claim(fact: StripeEntitlementFact, deferred = false): boolean {
    this.assert(fact);
    const previous = this.state!.receipts.find((receipt) => receipt.id === fact.event_id);
    if (previous) {
      if (deferred) return false;
      const event =
        previous.outcome === 'review' ||
        (fact.action === 'subscribe' &&
          (previous.outcome === 'superseded' || previous.outcome === 'complete'))
          ? this.store.subscription(fact.event_id)
          : null;
      if (
        previous.outcome === 'review' &&
        event?.stripe_price_review_accepted &&
        event.status === 'applied'
      ) {
        this.finish(fact, true);
        return false;
      }
      const canRecheck =
        (fact.action === 'expire' && previous.outcome === 'deferred') ||
        (fact.action === 'expire'
          ? isDeferredStripeExpiry(event)
          : (previous.outcome === 'review' && isHeldStripePriceReduction(event)) ||
            isSupersededStripePriceReduction(event, fact));
      if (!canRecheck) return false;
      previous.outcome = 'claimed';
      this.persist();
      return true;
    }
    if (this.state!.receipts.length >= 10_000)
      throw new ServiceError(
        'Stripe automation reached its safe receipt limit; review stored billing events.',
      );
    this.state!.receipts.push({ id: fact.event_id, outcome: deferred ? 'deferred' : 'claimed' });
    this.persist();
    return true;
  }
  supersedeHeldPriceReductions(fact: StripeEntitlementFact): void {
    this.assert(fact);
    const held = this.store
      .heldStripePriceReviews(fact.discord_user_id)
      .filter((event) => event.id !== fact.event_id && isHeldStripePriceReduction(event));
    if (!held.length) return;
    const ids = new Set(held.map(({ id }) => id));
    const receipts = this.state!.receipts;
    try {
      this.store.transaction(() => {
        for (const event of held) {
          event.status = 'superseded';
          delete event.stripe_price_review_required;
          event.error = null;
          event.result = 'A newer verified Stripe billing decision replaced this held reduction.';
          this.store.saveSubscription(event);
        }
        this.state!.receipts = receipts.map((receipt) =>
          ids.has(receipt.id) && (receipt.outcome === 'review' || receipt.outcome === 'claimed')
            ? { ...receipt, outcome: 'superseded' }
            : receipt,
        );
        this.persist();
      });
    } catch (error) {
      this.state!.receipts = receipts;
      throw error;
    }
  }
  finish(fact: StripeEntitlementFact, succeeded: boolean | 'deferred'): void {
    if (!this.enabled(fact.generation)) return;
    const receipt = this.state!.receipts.find((entry) => entry.id === fact.event_id);
    if (receipt && receipt.outcome !== 'superseded') {
      if (receipt.outcome === 'deferred' && succeeded === false) return;
      receipt.outcome = succeeded === 'deferred' ? 'deferred' : succeeded ? 'complete' : 'review';
      this.persist();
    }
  }
  currentForOwner(discordId: string): StripeEntitlementFact | undefined {
    return this.state?.latest.find((entry) => entry.discord_user_id === discordId);
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
      stripeDecisionKey(current) !== stripeDecisionKey(fact) ||
      !freshStripeInvoice(Date.parse(current.observed_at), this.now())
    )
      throw new ServiceError(
        'Stripe entitlement evidence changed or expired. Refresh billing and review the member.',
      );
  }
}
