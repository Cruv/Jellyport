/** A deliberately read-only, bounded boundary around Stripe's public API. */
export const STRIPE_API_VERSION = '2025-06-30.basil';
export type StripeMode = 'live' | 'test';
export type StripeClientErrorCode =
  | 'invalid_key'
  | 'authentication'
  | 'forbidden'
  | 'rate_limit'
  | 'timeout'
  | 'cancelled'
  | 'response_limit'
  | 'invalid_response'
  | 'network'
  | 'upstream';

const messages: Record<StripeClientErrorCode, string> = {
  invalid_key: 'Use a Stripe restricted API key beginning with rk_live_ or rk_test_.',
  authentication:
    'Stripe rejected the restricted API key. Check whether it has expired or been revoked.',
  forbidden: 'The Stripe restricted key is missing a required read permission.',
  rate_limit: 'Stripe is rate limiting requests. Try the connection again later.',
  timeout: 'The Stripe read request timed out. Previous saved billing data is preserved.',
  cancelled: 'The Stripe read was cancelled. Previous saved billing data is preserved.',
  response_limit:
    'Stripe returned more data than the safe read limit. Previous saved billing data is preserved.',
  invalid_response:
    'Stripe returned an unexpected response. Previous saved billing data is preserved.',
  network: 'Stripe could not be reached. Previous saved billing data is preserved.',
  upstream: 'Stripe could not complete the read. Previous saved billing data is preserved.',
};

export class StripeClientError extends Error {
  constructor(readonly code: StripeClientErrorCode) {
    super(messages[code]);
    this.name = 'StripeClientError';
  }
}

export interface StripeIdentityCandidate {
  discord_user_id: string;
  /** Checkout's explicit Discord server scope; still an untrusted identity hint. */
  guild_id?: string;
  source:
    | 'subscription_metadata'
    | 'customer_metadata'
    | 'checkout_metadata'
    | 'checkout_client_reference';
  field: string;
}

export interface StripeSubscriptionItem {
  id: string;
  price_id: string;
  product_id: string;
  quantity: number;
  current_period_start?: number;
  current_period_end?: number;
  price_nickname?: string;
}

export interface StripeSubscription {
  id: string;
  created?: number;
  customer_id: string;
  customer_name?: string;
  /** Private correlation hint only; never proves Discord ownership. */
  customer_email?: string;
  status: string;
  collection_method: 'charge_automatically' | 'send_invoice';
  cancel_at_period_end: boolean;
  pause_collection: boolean;
  cancel_at?: number;
  canceled_at?: number;
  ended_at?: number;
  trial_end?: number;
  latest_invoice_id?: string;
  items: StripeSubscriptionItem[];
  /** Untrusted hints requiring a verified guild member and administrator approval. */
  identity_candidates: StripeIdentityCandidate[];
}
export interface StripePaidPeriod {
  invoice_id: string;
  customer_id: string;
  subscription_id: string;
  paid_at: number;
  created: number;
  price_id: string;
  start: number;
  end: number;
}

export interface StripeProduct {
  id: string;
  name: string;
  active: boolean;
}

export interface StripeSnapshot {
  mode: StripeMode;
  subscriptions: StripeSubscription[];
  products: StripeProduct[];
  completed_at: string;
}

export interface StripeClientOptions {
  signal?: AbortSignal;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxPages?: number;
  maxItems?: number;
  maxResponseBytes?: number;
  maxTotalBytes?: number;
  /** Lower values are useful for synthetic tests; defaults stay below Stripe's API limits. */
  requestGapMs?: number;
  retryDelayMs?: number;
}

type ObjectValue = Record<string, unknown>;
interface ReadBudget {
  bytes: number;
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StripeClientError('invalid_response');
  return value as ObjectValue;
}

function id(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !new RegExp(`^(?:${prefix})_[A-Za-z0-9]{1,200}$`).test(value))
    throw new StripeClientError('invalid_response');
  return value;
}

function optionalLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label && label.length <= max && !/[\u0000-\u001f\u007f]/u.test(label) ? label : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function discordIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback : Math.max(1, Math.min(max, Math.floor(value) || 1));
}

function abortError(): Error {
  return new StripeClientError('cancelled');
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (milliseconds <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => (timer = setTimeout(resolve, milliseconds))),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

function identityHints(
  value: unknown,
  source: StripeIdentityCandidate['source'],
): StripeIdentityCandidate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const metadata = value as ObjectValue;
  return ['discord_id', 'discord_user_id'].flatMap((field) => {
    const candidate = metadata[field];
    return discordIdentity(candidate) ? [{ discord_user_id: candidate, source, field }] : [];
  });
}

export class StripeClient {
  readonly mode: StripeMode;
  readonly #key: string;
  private readonly transport: (url: string, init: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxItems: number;
  private readonly maxResponseBytes: number;
  private readonly maxTotalBytes: number;
  private readonly gap: number;
  private readonly retryDelay: number;
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    key: string,
    private readonly options: StripeClientOptions = {},
  ) {
    if (!/^rk_(live|test)_[A-Za-z0-9]{8,256}$/.test(key))
      throw new StripeClientError('invalid_key');
    this.#key = key;
    this.mode = key.startsWith('rk_live_') ? 'live' : 'test';
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.timeoutMs = bounded(options.timeoutMs, 15_000, 30_000);
    this.maxPages = bounded(options.maxPages, 100, 100);
    this.maxItems = bounded(options.maxItems, 10_000, 10_000);
    this.maxResponseBytes = bounded(options.maxResponseBytes, 4 * 1024 * 1024, 4 * 1024 * 1024);
    this.maxTotalBytes = bounded(options.maxTotalBytes, 32 * 1024 * 1024, 32 * 1024 * 1024);
    this.gap = options.requestGapMs === 0 ? 0 : bounded(options.requestGapMs, 100, 1_000);
    this.retryDelay = bounded(options.retryDelayMs, 500, 5_000);
  }

  private signal(supplied?: AbortSignal): AbortSignal | undefined {
    const signals = [this.options.signal, supplied].filter((value) => !!value);
    return signals.length ? AbortSignal.any(signals) : undefined;
  }

  private checkMode(value: ObjectValue): void {
    if (value.livemode !== (this.mode === 'live')) throw new StripeClientError('invalid_response');
  }

  private async body(
    response: Response,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<unknown> {
    const length = response.headers.get('content-length');
    if (length && /^[0-9]+$/.test(length) && Number(length) > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw new StripeClientError('response_limit');
    }
    if (!response.body) throw new StripeClientError('invalid_response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let result = '';
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        budget.bytes += chunk.value.byteLength;
        if (bytes > this.maxResponseBytes || budget.bytes > this.maxTotalBytes)
          throw new StripeClientError('response_limit');
        result += decoder.decode(chunk.value, { stream: true });
      }
      result += decoder.decode();
      return JSON.parse(result) as unknown;
    } catch (error) {
      void reader.cancel().catch(() => {});
      if (error instanceof StripeClientError) throw error;
      throw new StripeClientError('invalid_response');
    } finally {
      reader.releaseLock();
    }
  }

  private async request(
    path: string,
    parameters: URLSearchParams,
    budget: ReadBudget,
    signal?: AbortSignal,
  ): Promise<ObjectValue> {
    const queued = this.tail.then(async () => {
      if (signal?.aborted) throw abortError();
      for (let attempt = 0; attempt < 3; attempt++) {
        await pause(Math.max(0, this.nextRequestAt - Date.now()), signal);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
        const active = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
        let retryAfter = 0;
        try {
          const url = new URL(path, 'https://api.stripe.com');
          url.search = parameters.toString();
          const response = await abortable(
            this.transport(url.href, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${this.#key}`,
                'Stripe-Version': STRIPE_API_VERSION,
                Accept: 'application/json',
              },
              redirect: 'error',
              signal: active,
            }),
            active,
          );
          if (response.redirected) {
            await response.body?.cancel().catch(() => {});
            throw new StripeClientError('invalid_response');
          }
          if (response.ok) return object(await this.body(response, active, budget));
          await response.body?.cancel().catch(() => {});
          if (response.status === 401) throw new StripeClientError('authentication');
          if (response.status === 403) throw new StripeClientError('forbidden');
          if (response.status >= 300 && response.status < 400)
            throw new StripeClientError('invalid_response');
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === 2)
            throw new StripeClientError(response.status === 429 ? 'rate_limit' : 'upstream');
          const retry = response.headers.get('retry-after');
          retryAfter =
            retry && /^[0-9]+(?:\.[0-9]+)?$/.test(retry)
              ? Number(retry) * 1_000
              : retry && Number.isFinite(Date.parse(retry))
                ? Math.max(0, Date.parse(retry) - Date.now())
                : 0;
          // Long rate limits should fail safely rather than block the worker or retry too early.
          if (retryAfter > 5_000)
            throw new StripeClientError(response.status === 429 ? 'rate_limit' : 'upstream');
        } catch (error) {
          if (signal?.aborted) throw abortError();
          if (timeout.signal.aborted) throw new StripeClientError('timeout');
          if (error instanceof StripeClientError) throw error;
          if (attempt === 2) throw new StripeClientError('network');
        } finally {
          clearTimeout(timer);
          this.nextRequestAt = Date.now() + this.gap;
        }
        await pause(Math.max(retryAfter, this.retryDelay * 2 ** attempt), signal);
      }
      throw new StripeClientError('network');
    });
    this.tail = queued.then(
      () => {},
      () => {},
    );
    return abortable(queued, signal);
  }

  private async list<T>(
    path: string,
    parameters: URLSearchParams,
    project: (value: ObjectValue) => T,
    signal?: AbortSignal,
    limit = this.maxItems,
    budget: ReadBudget = { bytes: 0 },
  ): Promise<T[]> {
    const results: T[] = [];
    const seen = new Set<string>();
    parameters.set('limit', '100');
    for (let page = 0; page < this.maxPages; page++) {
      const response = await this.request(path, parameters, budget, signal);
      if (
        response.object !== 'list' ||
        !Array.isArray(response.data) ||
        typeof response.has_more !== 'boolean'
      )
        throw new StripeClientError('invalid_response');
      if (response.data.length > 100 || (response.has_more && response.data.length === 0))
        throw new StripeClientError('invalid_response');
      for (const raw of response.data) {
        const row = object(raw);
        const rowId = optionalLabel(row.id, 204);
        if (!rowId || seen.has(rowId)) throw new StripeClientError('invalid_response');
        seen.add(rowId);
        if (results.length >= limit) throw new StripeClientError('response_limit');
        results.push(project(row));
      }
      if (!response.has_more) return results;
      parameters.set('starting_after', String(object(response.data.at(-1)).id));
    }
    throw new StripeClientError('response_limit');
  }

  async subscriptions(
    signal?: AbortSignal,
    budget: ReadBudget = { bytes: 0 },
  ): Promise<StripeSubscription[]> {
    return this.readSubscriptions(signal, budget);
  }

  /** Stripe's documented customer filter includes every status and retains the
   * same cursor, response, identity and mode validation as the full inventory. */
  async customerSubscriptions(
    customerId: string,
    signal?: AbortSignal,
  ): Promise<StripeSubscription[]> {
    id(customerId, 'cus');
    return this.readSubscriptions(signal, { bytes: 0 }, customerId);
  }

  private async readSubscriptions(
    signal?: AbortSignal,
    budget: ReadBudget = { bytes: 0 },
    customerId?: string,
  ): Promise<StripeSubscription[]> {
    const parameters = new URLSearchParams({ status: 'all', 'expand[]': 'data.customer' });
    if (customerId) parameters.set('customer', customerId);
    return this.list(
      '/v1/subscriptions',
      parameters,
      (row) => {
        if (row.object !== 'subscription') throw new StripeClientError('invalid_response');
        this.checkMode(row);
        const customer = typeof row.customer === 'string' ? undefined : object(row.customer);
        if (customer && customer.deleted !== true) this.checkMode(customer);
        const items = object(row.items);
        if (!Array.isArray(items.data) || items.data.length > 100 || items.has_more !== false)
          throw new StripeClientError('response_limit');
        if (
          typeof row.cancel_at_period_end !== 'boolean' ||
          (row.collection_method !== 'charge_automatically' &&
            row.collection_method !== 'send_invoice')
        )
          throw new StripeClientError('invalid_response');
        const status = optionalLabel(row.status, 40);
        if (!status || !/^[a-z_]+$/.test(status)) throw new StripeClientError('invalid_response');
        const customer_id = id(customer?.id ?? row.customer, 'cus');
        if (customerId && customer_id !== customerId)
          throw new StripeClientError('invalid_response');
        return {
          id: id(row.id, 'sub'),
          created: timestamp(row.created),
          customer_id,
          customer_name: optionalLabel(customer?.name, 200),
          customer_email: optionalLabel(customer?.email, 320),
          status,
          collection_method: row.collection_method,
          cancel_at_period_end: row.cancel_at_period_end,
          pause_collection: row.pause_collection != null,
          cancel_at: timestamp(row.cancel_at),
          canceled_at: timestamp(row.canceled_at),
          ended_at: timestamp(row.ended_at),
          trial_end: timestamp(row.trial_end),
          latest_invoice_id:
            typeof row.latest_invoice === 'string' ? id(row.latest_invoice, 'in') : undefined,
          items: items.data.map((raw) => {
            const item = object(raw);
            const price = object(item.price);
            const quantity = item.quantity;
            if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1)
              throw new StripeClientError('invalid_response');
            return {
              id: id(item.id, 'si'),
              price_id: id(price.id, 'price|plan'),
              product_id: id(
                typeof price.product === 'string' ? price.product : object(price.product).id,
                'prod',
              ),
              quantity,
              current_period_start: timestamp(item.current_period_start),
              current_period_end: timestamp(item.current_period_end),
              price_nickname: optionalLabel(price.nickname, 200),
            };
          }),
          identity_candidates: [
            ...identityHints(row.metadata, 'subscription_metadata'),
            ...identityHints(customer?.metadata, 'customer_metadata'),
          ],
        };
      },
      this.signal(signal),
      customerId ? Math.min(this.maxItems, 100) : this.maxItems,
      budget,
    );
  }

  async products(
    signal?: AbortSignal,
    budget: ReadBudget = { bytes: 0 },
  ): Promise<StripeProduct[]> {
    return this.list(
      '/v1/products',
      new URLSearchParams(),
      (row) => {
        if (row.object !== 'product' || typeof row.active !== 'boolean')
          throw new StripeClientError('invalid_response');
        this.checkMode(row);
        const name = optionalLabel(row.name, 200);
        if (!name) throw new StripeClientError('invalid_response');
        return { id: id(row.id, 'prod'), name, active: row.active };
      },
      this.signal(signal),
      this.maxItems,
      budget,
    );
  }

  async checkPrices(signal?: AbortSignal, budget: ReadBudget = { bytes: 0 }): Promise<void> {
    const result = await this.request(
      '/v1/prices',
      new URLSearchParams({ limit: '1' }),
      budget,
      this.signal(signal),
    );
    if (
      result.object !== 'list' ||
      !Array.isArray(result.data) ||
      result.data.length > 1 ||
      typeof result.has_more !== 'boolean'
    )
      throw new StripeClientError('invalid_response');
    for (const raw of result.data) {
      const price = object(raw);
      if (price.object !== 'price') throw new StripeClientError('invalid_response');
      id(price.id, 'price|plan');
      this.checkMode(price);
    }
  }

  private async checkReadPermission(
    path: '/v1/customers' | '/v1/checkout/sessions',
    signal: AbortSignal | undefined,
    budget: ReadBudget,
  ): Promise<void> {
    const result = await this.request(path, new URLSearchParams({ limit: '1' }), budget, signal);
    if (
      result.object !== 'list' ||
      !Array.isArray(result.data) ||
      result.data.length > 1 ||
      typeof result.has_more !== 'boolean'
    )
      throw new StripeClientError('invalid_response');
    for (const raw of result.data) {
      const row = object(raw);
      if (row.object !== (path === '/v1/customers' ? 'customer' : 'checkout.session'))
        throw new StripeClientError('invalid_response');
      id(row.id, path === '/v1/customers' ? 'cus' : 'cs_(?:test|live)|cs');
      this.checkMode(row);
    }
  }

  async checkoutIdentityCandidates(
    subscriptionId: string,
    signal?: AbortSignal,
  ): Promise<StripeIdentityCandidate[]> {
    id(subscriptionId, 'sub');
    const sessions = await this.list(
      '/v1/checkout/sessions',
      new URLSearchParams({ subscription: subscriptionId }),
      (row) => {
        if (row.object !== 'checkout.session') throw new StripeClientError('invalid_response');
        this.checkMode(row);
        id(row.id, 'cs_(?:test|live)|cs');
        if (
          row.subscription !== subscriptionId ||
          row.mode !== 'subscription' ||
          row.status !== 'complete'
        )
          return [];
        const metadata =
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as ObjectValue)
            : {};
        // MEE6's Checkout metadata pairs user_id with guild_id. A generic user_id alone
        // could identify another application's customer and is never a Discord claim.
        const guildId = discordIdentity(metadata.guild_id) ? metadata.guild_id : undefined;
        if (Object.hasOwn(metadata, 'guild_id') && !guildId) return [];
        const hints = identityHints(metadata, 'checkout_metadata');
        if (guildId && discordIdentity(metadata.user_id))
          hints.push({
            discord_user_id: metadata.user_id,
            source: 'checkout_metadata',
            field: 'user_id',
          });
        if (discordIdentity(row.client_reference_id))
          hints.push({
            discord_user_id: row.client_reference_id,
            source: 'checkout_client_reference',
            field: 'client_reference_id',
          });
        return guildId ? hints.map((hint) => ({ ...hint, guild_id: guildId })) : hints;
      },
      this.signal(signal),
      Math.min(this.maxItems, 100),
    );
    return sessions.flat();
  }

  async snapshot(signal?: AbortSignal): Promise<StripeSnapshot> {
    const budget = { bytes: 0 };
    // Probe identity resources even for empty accounts or previously cached identity lookups.
    // These responses are validated and discarded; no contact/session data is retained.
    await this.checkReadPermission('/v1/customers', this.signal(signal), budget);
    await this.checkReadPermission('/v1/checkout/sessions', this.signal(signal), budget);
    const subscriptions = await this.subscriptions(signal, budget);
    const products = await this.products(signal, budget);
    await this.checkPrices(signal, budget);
    return { mode: this.mode, subscriptions, products, completed_at: new Date().toISOString() };
  }

  /** One bounded read of the most recently created paid invoice. Never infer
   * access from the subscription period, an unpaid invoice or invoice.period_end. */
  async paidPeriod(subscriptionId: string, signal?: AbortSignal): Promise<StripePaidPeriod | null> {
    id(subscriptionId, 'sub');
    const result = await this.request(
      '/v1/invoices',
      new URLSearchParams({
        subscription: subscriptionId,
        status: 'paid',
        limit: '1',
      }),
      { bytes: 0 },
      this.signal(signal),
    );
    if (
      result.object !== 'list' ||
      !Array.isArray(result.data) ||
      result.data.length > 1 ||
      typeof result.has_more !== 'boolean'
    )
      throw new StripeClientError('invalid_response');
    if (!result.data.length) return null;
    const invoice = object(result.data[0]);
    this.checkMode(invoice);
    if (invoice.object !== 'invoice' || invoice.status !== 'paid' || invoice.amount_remaining !== 0)
      throw new StripeClientError('invalid_response');
    const parent = invoice.parent == null ? null : object(invoice.parent);
    const subscription =
      parent?.type === 'subscription_details'
        ? object(parent.subscription_details).subscription
        : null;
    if (subscription !== subscriptionId) throw new StripeClientError('invalid_response');
    const created = timestamp(invoice.created),
      paid_at = timestamp(object(invoice.status_transitions).paid_at);
    if (created === undefined || paid_at === undefined || paid_at < created) return null;
    const lines = object(invoice.lines);
    if (!Array.isArray(lines.data) || lines.has_more !== false || lines.data.length !== 1)
      return null;
    const line = object(lines.data[0]);
    this.checkMode(line);
    const lineParent = object(line.parent);
    if (lineParent.type !== 'subscription_item_details') return null;
    const details = object(lineParent.subscription_item_details);
    if (
      details.subscription !== subscriptionId ||
      details.proration !== false ||
      line.quantity !== 1
    )
      return null;
    const pricing = object(line.pricing),
      period = object(line.period);
    if (pricing.type !== 'price_details') return null;
    const start = timestamp(period.start),
      end = timestamp(period.end);
    if (start === undefined || end === undefined || end <= start) return null;
    return {
      invoice_id: id(invoice.id, 'in'),
      customer_id: id(invoice.customer, 'cus'),
      subscription_id: subscriptionId,
      paid_at,
      created,
      price_id: id(object(pricing.price_details).price, 'price|plan'),
      start,
      end,
    };
  }
}
