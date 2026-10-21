import { describe, expect, it } from 'vitest';
import {
  STRIPE_API_VERSION,
  StripeClient,
  StripeClientError,
  type StripeClientOptions,
} from '../server/stripe-client.js';

const key = 'rk_test_syntheticRestrictedKey';
const discordId = '123456789012345678';
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const list = (data: unknown[], has_more = false) => ({ object: 'list', data, has_more });
const product = (suffix = 'a') => ({
  id: `prod_${suffix}`,
  object: 'product',
  name: 'Synthetic membership',
  active: true,
  livemode: false,
});
const subscription = (suffix = 'a') => ({
  id: `sub_${suffix}`,
  object: 'subscription',
  livemode: false,
  customer: {
    id: `cus_${suffix}`,
    object: 'customer',
    livemode: false,
    name: 'Synthetic member',
    email: 'synthetic@example.invalid',
    address: { line1: 'private-address-never-retain' },
    metadata: { discord_id: discordId, unrelated: 'private-metadata-never-retain' },
  },
  status: 'active',
  collection_method: 'charge_automatically',
  cancel_at_period_end: true,
  cancel_at: 1_800_000_000,
  canceled_at: 1_799_000_000,
  pause_collection: null,
  metadata: {},
  latest_invoice: 'in_a',
  items: {
    has_more: false,
    data: [
      {
        id: `si_${suffix}`,
        quantity: 1,
        current_period_start: 1_797_000_000,
        current_period_end: 1_800_000_000,
        price: { id: 'price_a', product: 'prod_a', nickname: 'Synthetic recurring price' },
      },
    ],
  },
});
const client = (options: StripeClientOptions) =>
  new StripeClient(key, { requestGapMs: 0, retryDelayMs: 1, ...options });

describe('read-only Stripe API boundary', () => {
  it('keeps the restricted key out of accidental object serialization', () => {
    expect(JSON.stringify(client({ transport: async () => json(list([])) }))).not.toContain(key);
  });
  it.each([
    'sk_live_unrestricted',
    'pk_live_public',
    'rk_test_short',
    'rk_live_bad space',
    ' rk_test_syntheticRestrictedKey',
  ])('rejects unsupported credential shapes without echoing the input: %s', (value) => {
    try {
      new StripeClient(value);
      expect.unreachable('Expected restricted key validation');
    } catch (error) {
      expect(error).toBeInstanceOf(StripeClientError);
      expect((error as StripeClientError).code).toBe('invalid_key');
      expect(String(error)).not.toContain(value);
    }
  });

  it('reads complete cursor pages and projects only the minimal private billing facts', async () => {
    const requests: URL[] = [];
    const api = client({
      transport: async (address, init) => {
        const url = new URL(address);
        requests.push(url);
        expect(url.origin).toBe('https://api.stripe.com');
        expect(init.method).toBe('GET');
        expect(init.redirect).toBe('error');
        expect(init.headers).toMatchObject({
          Authorization: `Bearer ${key}`,
          'Stripe-Version': STRIPE_API_VERSION,
        });
        expect(address).not.toContain(key);
        if (url.pathname === '/v1/customers' || url.pathname === '/v1/checkout/sessions') {
          expect(url.searchParams.get('limit')).toBe('1');
          return json(list([]));
        }
        if (url.pathname === '/v1/subscriptions') {
          expect(url.searchParams.get('status')).toBe('all');
          expect(url.searchParams.get('expand[]')).toBe('data.customer');
          expect(url.searchParams.get('limit')).toBe('100');
          return url.searchParams.has('starting_after')
            ? json(list([{ ...subscription('b'), status: 'canceled' }]))
            : json(list([subscription()], true));
        }
        if (url.pathname === '/v1/products') return json(list([product()]));
        expect(url.pathname).toBe('/v1/prices');
        expect(url.searchParams.get('limit')).toBe('1');
        return json(list([{ id: 'price_a', object: 'price', livemode: false }]));
      },
    });
    const snapshot = await api.snapshot();
    expect(snapshot.mode).toBe('test');
    expect(snapshot.subscriptions.map((row) => row.id)).toEqual(['sub_a', 'sub_b']);
    expect(snapshot.subscriptions[0]).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      canceled_at: 1_799_000_000,
      cancel_at: 1_800_000_000,
      pause_collection: false,
      items: [{ current_period_end: 1_800_000_000, price_id: 'price_a', product_id: 'prod_a' }],
      identity_candidates: [
        { discord_user_id: discordId, source: 'customer_metadata', field: 'discord_id' },
      ],
    });
    expect(snapshot.products).toEqual([
      { id: 'prod_a', name: 'Synthetic membership', active: true },
    ]);
    expect(
      requests
        .find((url) => url.searchParams.has('starting_after'))
        ?.searchParams.get('starting_after'),
    ).toBe('sub_a');
    expect(requests).toHaveLength(6);
    expect(JSON.stringify(snapshot)).not.toContain('private-');
    expect(snapshot.subscriptions[0]).not.toHaveProperty('metadata');
  });

  it('verifies all five read permissions even when there are no subscriptions or products', async () => {
    const paths: string[] = [];
    const api = client({
      transport: async (address) => {
        paths.push(new URL(address).pathname);
        return json(list([]));
      },
    });
    expect(await api.snapshot()).toMatchObject({ subscriptions: [], products: [] });
    expect(paths.sort()).toEqual([
      '/v1/checkout/sessions',
      '/v1/customers',
      '/v1/prices',
      '/v1/products',
      '/v1/subscriptions',
    ]);
  });

  it.each(['/v1/customers', '/v1/checkout/sessions'])(
    'rejects an incomplete restricted key when its %s read permission is missing',
    async (deniedPath) => {
      const api = client({
        transport: async (address) =>
          new URL(address).pathname === deniedPath
            ? json({ error: { message: 'private billing details' } }, 403)
            : json(list([])),
      });
      await expect(api.snapshot()).rejects.toMatchObject({ code: 'forbidden' });
    },
  );

  it('returns conflicting explicit identity hints without choosing or trusting one', async () => {
    const api = client({
      transport: async (address) => {
        const url = new URL(address);
        expect(url.pathname).toBe('/v1/checkout/sessions');
        expect(url.searchParams.get('subscription')).toBe('sub_a');
        return json(
          list([
            {
              id: 'cs_test_a',
              object: 'checkout.session',
              livemode: false,
              subscription: 'sub_a',
              customer: 'cus_a',
              mode: 'subscription',
              status: 'complete',
              client_reference_id: discordId,
              metadata: {
                discord_user_id: '223456789012345678',
                arbitrary_id: '323456789012345678',
              },
              customer_details: { address: 'private-never-retain' },
            },
            {
              id: 'cs_test_b',
              object: 'checkout.session',
              livemode: false,
              subscription: 'sub_other',
              mode: 'subscription',
              status: 'complete',
              metadata: { discord_id: '423456789012345678' },
            },
            {
              id: 'cs_test_c',
              object: 'checkout.session',
              livemode: false,
              subscription: 'sub_a',
              mode: 'subscription',
              status: 'open',
              metadata: { discord_id: '523456789012345678' },
            },
          ]),
        );
      },
    });
    expect(await api.checkoutIdentityCandidates('sub_a')).toEqual([
      {
        discord_user_id: '223456789012345678',
        source: 'checkout_metadata',
        field: 'discord_user_id',
      },
      {
        discord_user_id: discordId,
        source: 'checkout_client_reference',
        field: 'client_reference_id',
      },
    ]);
    await expect(api.checkoutIdentityCandidates('sub_a?key=leak')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('recognizes the documented MEE6 user and guild pair only within completed Checkout metadata', async () => {
    const guildId = '223456789012345678';
    const session = {
      id: 'cs_test_mee6',
      object: 'checkout.session',
      livemode: false,
      subscription: 'sub_a',
      mode: 'subscription',
      status: 'complete',
      metadata: { plan_id: 'syntheticMee6Plan', user_id: discordId, guild_id: guildId },
    };
    const api = client({ transport: async () => json(list([session])) });
    expect(await api.checkoutIdentityCandidates('sub_a')).toEqual([
      {
        discord_user_id: discordId,
        guild_id: guildId,
        source: 'checkout_metadata',
        field: 'user_id',
      },
    ]);
    const sub = {
      ...subscription(),
      metadata: { user_id: discordId, guild_id: guildId },
      customer: {
        ...subscription().customer,
        metadata: { user_id: discordId, guild_id: guildId },
      },
    };
    const subscriptions = client({ transport: async () => json(list([sub])) });
    expect((await subscriptions.subscriptions())[0]?.identity_candidates).toEqual([]);
  });

  it.each([
    { user_id: discordId },
    { user_id: discordId, guild_id: 'not-a-discord-id' },
    { user_id: discordId, guild_id: '18446744073709551616' },
    { user_id: 123456789012345678, guild_id: '223456789012345678' },
    { user_id: 'not-a-discord-id', guild_id: '223456789012345678' },
  ])(
    'does not interpret a generic or malformed MEE6 identity pair as Discord ownership',
    async (metadata) => {
      const api = client({
        transport: async () =>
          json(
            list([
              {
                id: 'cs_test_bad',
                object: 'checkout.session',
                livemode: false,
                subscription: 'sub_a',
                mode: 'subscription',
                status: 'complete',
                metadata,
              },
            ]),
          ),
      });
      expect(await api.checkoutIdentityCandidates('sub_a')).toEqual([]);
    },
  );

  it('retains the explicit guild context on every Checkout hint so the coordinator can reject another server', async () => {
    const foreignGuild = '323456789012345678';
    const api = client({
      transport: async () =>
        json(
          list([
            {
              id: 'cs_test_foreign',
              object: 'checkout.session',
              livemode: false,
              subscription: 'sub_a',
              mode: 'subscription',
              status: 'complete',
              client_reference_id: discordId,
              metadata: {
                user_id: discordId,
                discord_id: discordId,
                discord_user_id: discordId,
                guild_id: foreignGuild,
              },
            },
          ]),
        ),
    });
    const hints = await api.checkoutIdentityCandidates('sub_a');
    expect(hints).toHaveLength(4);
    expect(hints.every((hint) => hint.guild_id === foreignGuild)).toBe(true);
    expect(hints.map((hint) => hint.field)).toEqual([
      'discord_id',
      'discord_user_id',
      'user_id',
      'client_reference_id',
    ]);
  });

  it('does not downgrade malformed Checkout guild scope into unscoped metadata or reference hints', async () => {
    const api = client({
      transport: async () =>
        json(
          list([
            {
              id: 'cs_test_badScope',
              object: 'checkout.session',
              livemode: false,
              subscription: 'sub_a',
              mode: 'subscription',
              status: 'complete',
              client_reference_id: discordId,
              metadata: { discord_id: discordId, guild_id: 'invalid' },
            },
          ]),
        ),
    });
    expect(await api.checkoutIdentityCandidates('sub_a')).toEqual([]);
  });

  it('retains historical canceled subscriptions whose expanded customer was deleted', async () => {
    const row = { ...subscription(), status: 'canceled', customer: { id: 'cus_a', deleted: true } };
    const api = client({ transport: async () => json(list([row])) });
    expect(await api.subscriptions()).toMatchObject([
      { id: 'sub_a', customer_id: 'cus_a', status: 'canceled', identity_candidates: [] },
    ]);
  });

  it.each([
    [{ ...subscription(), livemode: true }, 'invalid_response'],
    [{ ...subscription(), items: { data: [], has_more: true } }, 'response_limit'],
    [
      {
        ...subscription(),
        items: {
          ...subscription().items,
          data: [{ ...subscription().items.data[0], price: { id: 'price_?', product: 'prod_a' } }],
        },
      },
      'invalid_response',
    ],
    [
      { ...subscription(), customer: { ...subscription().customer, livemode: true } },
      'invalid_response',
    ],
  ])(
    'fails closed on wrong mode or incomplete/malformed subscription identity',
    async (row, code) => {
      const api = client({ transport: async () => json(list([row])) });
      await expect(api.subscriptions()).rejects.toMatchObject({ code });
    },
  );

  it.each([
    { maxPages: 1, maxItems: 100, rows: [product()], hasMore: true },
    { maxPages: 100, maxItems: 1, rows: [product(), product('b')], hasMore: false },
  ])(
    'never returns a partial snapshot when page/item bounds are reached',
    async ({ rows, hasMore, ...limits }) => {
      let calls = 0;
      const api = client({
        ...limits,
        transport: async () => {
          calls++;
          return json(list(rows, hasMore));
        },
      });
      await expect(api.products()).rejects.toMatchObject({ code: 'response_limit' });
      expect(calls).toBe(1);
    },
  );

  it('rejects duplicate cursor work rather than silently dropping or duplicating records', async () => {
    let calls = 0;
    const api = client({
      transport: async () => {
        calls++;
        return json(list([product()], true));
      },
    });
    await expect(api.products()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toBe(2);
  });

  it('bounds streamed bytes and cumulative work before adopting any snapshot', async () => {
    const api = client({ maxResponseBytes: 64, transport: async () => json(list([product()])) });
    await expect(api.products()).rejects.toMatchObject({ code: 'response_limit' });
    const cumulative = client({
      maxTotalBytes: 100,
      transport: async () => json(list([product()])),
    });
    await expect(cumulative.products()).rejects.toMatchObject({ code: 'response_limit' });
  });

  it('serializes concurrent callers through response-body consumption', async () => {
    let active = 0;
    let peak = 0;
    const api = client({
      transport: async (address) => {
        active++;
        peak = Math.max(peak, active);
        const data = new URL(address).pathname === '/v1/products' ? [product()] : [];
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(list(data))));
                active--;
                controller.close();
              }, 5);
            },
          }),
        );
      },
    });
    await Promise.all([api.products(), api.checkPrices(), api.products()]);
    expect(peak).toBe(1);
  });

  it.each([
    [401, 'authentication'],
    [403, 'forbidden'],
    [302, 'invalid_response'],
    [400, 'upstream'],
  ] as const)(
    'returns a fixed safe error for HTTP %s without retrying or leaking Stripe responses',
    async (status, code) => {
      let calls = 0;
      const api = client({
        transport: async () => {
          calls++;
          return json({ error: { message: `${key} private@example.invalid` } }, status);
        },
      });
      try {
        await api.products();
        expect.unreachable('Expected failure');
      } catch (error) {
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain(key);
        expect(String(error)).not.toContain('private@example.invalid');
      }
      expect(calls).toBe(1);
    },
  );

  it('retries only bounded read failures and honors rate-limit backoff', async () => {
    let calls = 0;
    const api = client({
      transport: async () => {
        calls++;
        if (calls === 1) return json({}, 429, { 'retry-after': '0.001' });
        if (calls === 2) return json({}, 503);
        return json(list([product()]));
      },
    });
    expect(await api.products()).toHaveLength(1);
    expect(calls).toBe(3);
    let exhaustedCalls = 0;
    const exhausted = client({
      transport: async () => {
        exhaustedCalls++;
        return json({}, 429);
      },
    });
    await expect(exhausted.products()).rejects.toMatchObject({ code: 'rate_limit' });
    expect(exhaustedCalls).toBe(3);
  });

  it('fails safely on a long Retry-After instead of retrying before Stripe permits it', async () => {
    let calls = 0;
    const api = client({
      transport: async () => {
        calls++;
        return json({}, 429, { 'retry-after': '60' });
      },
    });
    await expect(api.products()).rejects.toMatchObject({ code: 'rate_limit' });
    expect(calls).toBe(1);
  });

  it('cancels promptly during backoff and makes no further requests', async () => {
    const controller = new AbortController();
    let calls = 0;
    const api = client({
      retryDelayMs: 1_000,
      transport: async () => {
        calls++;
        return json({}, 429);
      },
    });
    const pending = api.products(controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(1);
  });

  it('times out a stalled fetch or body without retrying an uncooperative transport', async () => {
    const api = client({ timeoutMs: 5, transport: async () => new Promise<Response>(() => {}) });
    await expect(api.products()).rejects.toMatchObject({ code: 'timeout' });
    const body = client({
      timeoutMs: 5,
      transport: async () => new Response(new ReadableStream({ start() {} })),
    });
    await expect(body.products()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('cancels a queued caller without interrupting another caller or permitting overlap', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const api = client({
      transport: async () => {
        calls++;
        if (calls === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return json(list([product()]));
      },
    });
    const first = api.products();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const queued = api.products(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(1);
    release?.();
    await first;
    await api.products();
    expect(calls).toBe(2);
  });
});
