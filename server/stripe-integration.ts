import { randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { DEFAULT_MEMBERSHIP_TIERS } from './memberships.js';
import {
  StripeClient,
  StripeClientError,
  type StripeSnapshot,
  type StripeIdentityCandidate,
} from './stripe-client.js';
import type { Store } from './store.js';

export interface StripePriceTier {
  price_id: string;
  tier_id: string;
}
export interface StripeDiscordHint {
  id: string;
  username: string;
  tier: string;
  observed_at: string;
}
interface StoredHint extends StripeDiscordHint {
  source_event: string;
}
interface CustomerLink {
  customer_id: string;
  discord_user_id: string;
  username: string;
}
interface CheckoutCache {
  subscription_id: string;
  checked_at: number;
  candidates: StripeIdentityCandidate[];
}
interface StripeState {
  version: 1;
  revision: string;
  generation: string;
  guild_id: string;
  api_key: string;
  sync_enabled: boolean;
  last_sync: string | null;
  last_error: string | null;
  snapshot: StripeSnapshot | null;
  links: CustomerLink[];
  price_tiers: StripePriceTier[];
  hints: StoredHint[];
  hint_receipts: string[];
  checkout_cache: CheckoutCache[];
}
export interface StripeIntegrationStatus {
  configured: boolean;
  mode: 'live' | 'test' | null;
  review_only: true;
  revision: string;
  running: boolean;
  sync_enabled: boolean;
  last_sync: string | null;
  last_error: string | null;
  subscription_count: number;
  linked_customer_count: number;
  price_tiers: StripePriceTier[];
  hints: StripeDiscordHint[];
}
export interface StripeSubscriptionReview {
  subscription_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  status: string;
  collection_method: 'charge_automatically' | 'send_invoice';
  pause_collection: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  prices: Array<{ id: string; product_id: string | null; name: string | null }>;
  proposed_discord_id: string | null;
  identity_source: string | null;
  linked_discord_id: string | null;
  linked_discord_username: string | null;
  tier_id: string | null;
}
export interface StripeIntegrationConfiguration {
  api_key?: string;
  sync_enabled: boolean;
  expected_revision: string;
  price_tiers?: StripePriceTier[];
}
type BillingClient = Pick<StripeClient, 'mode' | 'snapshot' | 'checkoutIdentityCandidates'>;
export interface StripeIntegrationOptions {
  clientFactory?: (key: string) => BillingClient;
  resolveDiscordMember?: (id: string) => Promise<{ id?: string; username: string }>;
  now?: () => number;
}

function validSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) < 2n ** 64n;
}
const stripeCustomer = /^cus_[A-Za-z0-9]{1,240}$/;
const stripePrice = /^price_[A-Za-z0-9]{1,240}$/;
const checkoutTtl = 24 * 60 * 60 * 1000;
const maxHints = 500;
const maxCheckoutLookups = 100;

function cleanText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function blankState(guild: string, key = ''): StripeState {
  return {
    version: 1,
    revision: randomUUID(),
    generation: randomUUID(),
    guild_id: guild,
    api_key: key,
    sync_enabled: false,
    last_sync: null,
    last_error: null,
    snapshot: null,
    links: [],
    price_tiers: [],
    hints: [],
    hint_receipts: [],
    checkout_cache: [],
  };
}

/** Read-only billing observations and explicitly reviewed identity links. This
 * connector deliberately has no media-server or membership mutation capability. */
export class StripeIntegration {
  private state: StripeState;
  private task: Promise<StripeIntegrationStatus> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private readonly clientFactory: (key: string) => BillingClient;
  private readonly now: () => number;
  constructor(
    readonly store: Store,
    readonly options: StripeIntegrationOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? ((key) => new StripeClient(key));
    this.now = options.now ?? Date.now;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS stripe_integration_state (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL)',
    );
    const record = store.db
      .prepare('SELECT encrypted FROM stripe_integration_state WHERE id=1')
      .get();
    this.state = record
      ? store.decrypt<StripeState>(record.encrypted as Uint8Array)
      : blankState(this.guild());
    if (
      this.state.version !== 1 ||
      !cleanText(this.state.revision, 128) ||
      !cleanText(this.state.generation, 128)
    )
      throw new ServiceError(
        'The saved Stripe connection could not be read. Restore a valid Jellyport backup.',
      );
    this.scope();
    if (!record) this.persist();
  }
  private guild(): string {
    return this.store.settings().discord_guild_id ?? '';
  }
  private persist(): void {
    this.store.db
      .prepare('INSERT OR REPLACE INTO stripe_integration_state (id,encrypted) VALUES (1,?)')
      .run(this.store.encrypt(this.state));
  }
  /** Changing Discord servers invalidates reviewed ownership and disables polling. */
  private scope(): void {
    if (this.state.guild_id === this.guild()) return;
    this.controller?.abort();
    this.state = blankState(this.guild(), this.state.api_key);
    this.persist();
  }
  private checkRevision(revision: string): void {
    this.scope();
    if (this.stopped) throw new ServiceError('The Stripe connection is stopping.');
    if (revision !== this.state.revision)
      throw new ServiceError('The Stripe connection changed. Refresh and review before retrying.');
  }
  status(): StripeIntegrationStatus {
    this.scope();
    const s = this.state;
    return {
      configured: Boolean(s.api_key),
      mode: s.api_key ? (s.api_key.startsWith('rk_live_') ? 'live' : 'test') : null,
      review_only: true,
      revision: s.revision,
      running: this.task !== null,
      sync_enabled: s.sync_enabled,
      last_sync: s.last_sync,
      last_error: s.last_error,
      subscription_count: s.snapshot?.subscriptions.length ?? 0,
      linked_customer_count: s.links.length,
      price_tiers: structuredClone(s.price_tiers),
      hints: s.hints.map(({ source_event: _source, ...hint }) => ({ ...hint })),
    };
  }
  toJSON(): StripeIntegrationStatus {
    return this.status();
  }
  async disconnect(input: { expected_revision: string }): Promise<StripeIntegrationStatus> {
    this.checkRevision(input.expected_revision);
    this.controller?.abort();
    this.state = blankState(this.guild());
    this.persist();
    await this.task?.catch(() => {});
    return this.status();
  }
  async configure(input: StripeIntegrationConfiguration): Promise<StripeIntegrationStatus> {
    this.checkRevision(input.expected_revision);
    if (typeof input.sync_enabled !== 'boolean')
      throw new ServiceError('Choose whether automatic Stripe syncing is enabled.');
    if (
      input.api_key !== undefined &&
      (typeof input.api_key !== 'string' ||
        (input.api_key !== '' && !/^rk_(?:live|test)_[A-Za-z0-9]{8,256}$/.test(input.api_key)))
    )
      throw new ServiceError('Use a Stripe restricted key beginning with rk_live_ or rk_test_.');
    const key = input.api_key || this.state.api_key;
    if (input.sync_enabled && !key)
      throw new ServiceError('Save a restricted Stripe key before enabling automatic sync.');
    const tiers = this.store.settings().membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS;
    const priceTiers = input.price_tiers ?? this.state.price_tiers;
    if (
      !Array.isArray(priceTiers) ||
      priceTiers.length > 100 ||
      new Set(priceTiers.map((entry) => entry?.price_id)).size !== priceTiers.length ||
      priceTiers.some(
        (entry) =>
          !entry ||
          Object.keys(entry).sort().join(',') !== 'price_id,tier_id' ||
          !stripePrice.test(entry.price_id) ||
          !tiers.some((tier) => tier.id === entry.tier_id),
      )
    )
      throw new ServiceError(
        'Map each Stripe price once to a configured Jellyport membership tier.',
      );
    this.controller?.abort();
    const keyChanged = key !== this.state.api_key;
    if (keyChanged) this.state = blankState(this.guild(), key);
    this.state.sync_enabled = input.sync_enabled;
    // Existing mappings never silently cross a replacement key/account boundary.
    this.state.price_tiers = keyChanged ? [] : structuredClone(priceTiers);
    this.state.revision = randomUUID();
    this.persist();
    await this.task?.catch(() => {});
    return this.status();
  }
  subscriptions(): StripeSubscriptionReview[] {
    this.scope();
    const snapshot = this.state.snapshot;
    if (!snapshot) return [];
    return snapshot.subscriptions.map((subscription) => {
      const link = this.state.links.find((item) => item.customer_id === subscription.customer_id);
      const candidates = subscription.identity_candidates.filter(
        (item) =>
          validSnowflake(item.discord_user_id) &&
          (!item.guild_id || item.guild_id === this.guild()),
      );
      const ids = new Set(candidates.map((candidate) => candidate.discord_user_id));
      const proposed = ids.size === 1 ? [...ids][0]! : null;
      const hint =
        !proposed && ids.size === 0 && subscription.customer_name
          ? this.state.hints.filter(
              (item) => item.username.toLowerCase() === subscription.customer_name!.toLowerCase(),
            )
          : [];
      const hintedIds = new Set(hint.map((item) => item.id));
      const mapped = subscription.items.map(
        (item) => this.state.price_tiers.find((entry) => entry.price_id === item.price_id)?.tier_id,
      );
      const tierIds = new Set(mapped.filter((id): id is string => Boolean(id)));
      const ends = subscription.items.map((item) => item.current_period_end);
      const end =
        ends.length > 0 &&
        ends.every(
          (value) =>
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= 8_640_000_000_000,
        ) &&
        new Set(ends).size === 1
          ? ends[0]!
          : null;
      return {
        subscription_id: subscription.id,
        customer_id: subscription.customer_id,
        customer_name: subscription.customer_name ?? null,
        customer_email: subscription.customer_email ?? null,
        status: subscription.status,
        collection_method: subscription.collection_method,
        pause_collection: subscription.pause_collection,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_end: end !== null ? new Date(end * 1000).toISOString() : null,
        prices: subscription.items.map((item) => ({
          id: item.price_id,
          product_id: item.product_id ?? null,
          name:
            snapshot.products.find((product) => product.id === item.product_id)?.name ??
            item.price_nickname ??
            null,
        })),
        proposed_discord_id: proposed ?? (hintedIds.size === 1 ? [...hintedIds][0]! : null),
        identity_source:
          ids.size > 1
            ? 'Conflicting Stripe identity fields; review required'
            : proposed
              ? 'Stripe identity field; administrator approval required'
              : hintedIds.size === 1
                ? 'MEE6 username hint; unverified'
                : null,
        linked_discord_id: link?.discord_user_id ?? null,
        linked_discord_username: link?.username ?? null,
        tier_id:
          mapped.length > 0 && mapped.every(Boolean) && tierIds.size === 1
            ? [...tierIds][0]!
            : null,
      };
    });
  }
  sync(): Promise<StripeIntegrationStatus> {
    this.scope();
    if (this.task) return this.task;
    if (this.stopped) return Promise.reject(new ServiceError('The Stripe connection is stopping.'));
    if (!this.state.api_key)
      return Promise.reject(new ServiceError('Save a restricted Stripe key before syncing.'));
    const generation = this.state.generation,
      revision = this.state.revision;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    timer.unref();
    const current = () => {
      this.scope();
      return (
        !controller.signal.aborted &&
        !this.stopped &&
        this.state.generation === generation &&
        this.state.revision === revision
      );
    };
    const work = async () => {
      try {
        const client = this.clientFactory(this.state.api_key);
        const snapshot = await client.snapshot(controller.signal);
        if (!current())
          throw new ServiceError('Stripe sync canceled because the connection changed or stopped.');
        if (snapshot.mode !== client.mode || snapshot.subscriptions.length > 10_000)
          throw new ServiceError(
            'Stripe returned an unexpected billing catalog. The previous saved data was preserved.',
          );
        const cache = new Map(
          this.state.checkout_cache.map((entry) => [entry.subscription_id, entry]),
        );
        let lookups = 0;
        for (const subscription of snapshot.subscriptions) {
          if (!current())
            throw new ServiceError(
              'Stripe sync canceled because the connection changed or stopped.',
            );
          let saved = cache.get(subscription.id);
          if (
            (!saved || this.now() - saved.checked_at >= checkoutTtl) &&
            lookups < maxCheckoutLookups
          ) {
            const candidates = await client.checkoutIdentityCandidates(
              subscription.id,
              controller.signal,
            );
            if (!current())
              throw new ServiceError(
                'Stripe sync canceled because the connection changed or stopped.',
              );
            saved = { subscription_id: subscription.id, checked_at: this.now(), candidates };
            cache.set(subscription.id, saved);
            lookups++;
          }
          if (saved && this.now() - saved.checked_at < checkoutTtl)
            subscription.identity_candidates.push(...structuredClone(saved.candidates));
        }
        if (!current())
          throw new ServiceError('Stripe sync canceled because the connection changed or stopped.');
        const activeIds = new Set(snapshot.subscriptions.map((subscription) => subscription.id));
        this.state.snapshot = snapshot;
        this.state.checkout_cache = [...cache.values()]
          .filter((entry) => activeIds.has(entry.subscription_id))
          .slice(0, 10_000);
        this.state.last_sync = new Date(this.now()).toISOString();
        this.state.last_error = null;
        this.state.revision = randomUUID();
        this.persist();
        return this.status();
      } catch (error) {
        this.scope();
        if (
          !this.stopped &&
          this.state.generation === generation &&
          this.state.revision === revision
        ) {
          this.state.last_error =
            error instanceof StripeClientError
              ? error.message
              : controller.signal.aborted
                ? 'Stripe sync reached its time limit. The previous saved billing data was preserved.'
                : 'Stripe sync failed. The previous saved billing data was preserved.';
          this.persist();
        }
        throw new ServiceError(
          error instanceof StripeClientError
            ? error.message
            : 'Stripe sync could not complete. The previous saved billing data was preserved.',
        );
      }
    };
    this.task = work()
      .finally(() => {
        clearTimeout(timer);
        this.task = null;
        if (this.controller === controller) this.controller = null;
      })
      .then(() => this.status());
    return this.task;
  }
  private requireCurrentReview(revision: string): void {
    this.checkRevision(revision);
    if (this.task)
      throw new ServiceError(
        'Wait for the Stripe sync to finish before reviewing a customer link.',
      );
    const lastSync = Date.parse(this.state.last_sync ?? '');
    if (!Number.isFinite(lastSync) || this.now() - lastSync > checkoutTtl)
      throw new ServiceError('Refresh Stripe billing data before linking a customer.');
    if (!validSnowflake(this.guild()))
      throw new ServiceError(
        'Configure and connect your Discord server before reviewing a customer link.',
      );
  }
  /** Resolve an untrusted suggestion to a fresh guild member for administrator
   * review. Finding a member never approves or saves customer ownership. */
  async resolveCandidate(input: {
    customer_id: string;
    expected_revision: string;
  }): Promise<{ id: string; username: string }> {
    this.requireCurrentReview(input.expected_revision);
    if (!stripeCustomer.test(input.customer_id))
      throw new ServiceError('Select a valid Stripe customer.');
    const rows = this.subscriptions().filter((row) => row.customer_id === input.customer_id);
    if (!rows.length) throw new ServiceError('Sync Stripe before reviewing this customer.');
    const ids = new Set(
      rows.map((row) => row.proposed_discord_id).filter((id): id is string => Boolean(id)),
    );
    if (ids.size !== 1 || rows.some((row) => row.identity_source?.startsWith('Conflicting')))
      throw new ServiceError(
        'This customer has no unique Discord identity suggestion. Select and verify the member manually.',
      );
    if (!this.options.resolveDiscordMember)
      throw new ServiceError('Connect the Discord bot before finding a suggested member.');
    const id = [...ids][0]!;
    let identity: { id?: string; username: string };
    try {
      identity = await this.options.resolveDiscordMember(id);
    } catch {
      throw new ServiceError(
        'Discord member identity could not be verified. Refresh and select the member again.',
      );
    }
    this.requireCurrentReview(input.expected_revision);
    if (identity.id !== id || !cleanText(identity.username, 64))
      throw new ServiceError(
        'Discord member identity could not be verified. Refresh and select the member again.',
      );
    return { id, username: identity.username };
  }
  async linkCustomer(input: {
    customer_id: string;
    discord_user_id: string;
    expected_revision: string;
  }): Promise<StripeIntegrationStatus> {
    this.checkRevision(input.expected_revision);
    if (this.task)
      throw new ServiceError(
        'Wait for the Stripe sync to finish before reviewing a customer link.',
      );
    const lastSync = Date.parse(this.state.last_sync ?? '');
    if (!Number.isFinite(lastSync) || this.now() - lastSync > checkoutTtl)
      throw new ServiceError('Refresh Stripe billing data before linking a customer.');
    if (
      !stripeCustomer.test(input.customer_id) ||
      !validSnowflake(input.discord_user_id) ||
      !validSnowflake(this.guild())
    )
      throw new ServiceError(
        'Select a saved Stripe customer and a current member of your configured Discord server.',
      );
    if (
      !this.state.snapshot?.subscriptions.some(
        (subscription) => subscription.customer_id === input.customer_id,
      )
    )
      throw new ServiceError('Sync Stripe before linking this customer.');
    if (!this.options.resolveDiscordMember)
      throw new ServiceError('Connect the Discord bot before linking a Stripe customer.');
    const existing = this.state.links.find((link) => link.customer_id === input.customer_id);
    if (existing && existing.discord_user_id !== input.discord_user_id)
      throw new ServiceError(
        'Unlink this Stripe customer before assigning a different Discord owner.',
      );
    let identity: { id?: string; username: string };
    try {
      identity = await this.options.resolveDiscordMember(input.discord_user_id);
    } catch {
      throw new ServiceError(
        'Discord member identity could not be verified. Refresh and select the member again.',
      );
    }
    this.checkRevision(input.expected_revision);
    if (identity.id !== input.discord_user_id || !cleanText(identity.username, 64))
      throw new ServiceError(
        'Discord member identity could not be verified. Refresh and select the member again.',
      );
    this.state.links = this.state.links.filter((link) => link.customer_id !== input.customer_id);
    this.state.links.push({
      customer_id: input.customer_id,
      discord_user_id: input.discord_user_id,
      username: identity.username,
    });
    this.state.revision = randomUUID();
    this.persist();
    return this.status();
  }
  /** Internal identity-review commit. The caller has just obtained a complete,
   * fresh Discord roster and preflighted exact media IDs. One SQLite transaction
   * persists all reviewed associations; no billing or media API write occurs. */
  commitReviewedIdentities(
    input: {
      expected_revision: string;
      links: Array<{ customer_id: string; discord_user_id: string; username: string }>;
    },
    writeLocal: () => void,
  ): void {
    this.checkRevision(input.expected_revision);
    if (this.task)
      throw new ServiceError('Wait for Stripe synchronization, then refresh the identity review.');
    if (input.links.length > 2500)
      throw new ServiceError('Review fewer customer identities at once.');
    if (input.links.length) {
      const last = Date.parse(this.state.last_sync ?? '');
      if (!this.state.api_key || !Number.isFinite(last) || this.now() - last > checkoutTtl)
        throw new ServiceError('Refresh Stripe billing data before linking a customer.');
    }
    const next = structuredClone(this.state);
    const seen = new Set<string>();
    for (const link of input.links) {
      if (
        !stripeCustomer.test(link.customer_id) ||
        !validSnowflake(link.discord_user_id) ||
        !cleanText(link.username, 64) ||
        seen.has(link.customer_id) ||
        !next.snapshot?.subscriptions.some((item) => item.customer_id === link.customer_id)
      )
        throw new ServiceError(
          'Select each saved Stripe customer once and verify its Discord owner.',
        );
      seen.add(link.customer_id);
      const existing = next.links.find((item) => item.customer_id === link.customer_id);
      if (existing && existing.discord_user_id !== link.discord_user_id)
        throw new ServiceError(
          'Unlink the existing Stripe customer owner before changing ownership.',
        );
      if (existing) Object.assign(existing, link);
      else next.links.push({ ...link });
    }
    if (input.links.length) next.revision = randomUUID();
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      writeLocal();
      if (input.links.length)
        this.store.db
          .prepare('INSERT OR REPLACE INTO stripe_integration_state (id,encrypted) VALUES (1,?)')
          .run(this.store.encrypt(next));
      this.store.db.exec('COMMIT');
      this.state = next;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  unlinkCustomer(input: {
    customer_id: string;
    expected_revision: string;
  }): StripeIntegrationStatus {
    this.checkRevision(input.expected_revision);
    if (!stripeCustomer.test(input.customer_id))
      throw new ServiceError('Select a valid Stripe customer.');
    this.state.links = this.state.links.filter((link) => link.customer_id !== input.customer_id);
    this.state.revision = randomUUID();
    this.persist();
    return this.status();
  }
  recordDiscordHint(input: {
    id: string;
    username: string;
    tier: string;
    source_event: string;
  }): void {
    this.scope();
    if (
      this.stopped ||
      !validSnowflake(this.guild()) ||
      !validSnowflake(input.id) ||
      !cleanText(input.username, 64) ||
      (input.tier !== '' && !cleanText(input.tier, 100)) ||
      !cleanText(input.source_event, 256)
    )
      return;
    if (this.state.hint_receipts.includes(input.source_event)) return;
    this.state.hint_receipts.unshift(input.source_event);
    this.state.hint_receipts = this.state.hint_receipts.slice(0, 2_000);
    this.state.hints = this.state.hints.filter((hint) => hint.id !== input.id);
    this.state.hints.unshift({ ...input, observed_at: new Date(this.now()).toISOString() });
    this.state.hints = this.state.hints.slice(0, maxHints);
    this.persist();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.task?.catch(() => {});
  }
}
