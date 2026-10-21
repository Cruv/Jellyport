import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import {
  StripeClientError,
  type StripeSnapshot,
  type StripeIdentityCandidate,
} from '../server/stripe-client.js';
import { StripeIntegration, type StripeIntegrationOptions } from '../server/stripe-integration.js';

const guild = '123456789012345678',
  member = '234567890123456789';
const key = 'rk_test_syntheticOnly123';
const resources: Array<{ store: Store; integration: StripeIntegration; directory: string }> = [];
function snapshot(count = 1): StripeSnapshot {
  return {
    mode: 'test',
    completed_at: '2026-10-20T12:00:00Z',
    products: [{ id: 'prod_Crew', name: 'Sloop Crewman Plan', active: true }],
    subscriptions: Array.from({ length: count }, (_, index) => ({
      id: `sub_${index}`,
      customer_id: `cus_${index}`,
      customer_name: index === 0 ? 'jim' : `member${index}`,
      customer_email: `member${index}@example.test`,
      status: 'active',
      collection_method: 'charge_automatically',
      pause_collection: false,
      cancel_at_period_end: false,
      items: [
        {
          id: `si_${index}`,
          price_id: 'price_Crew',
          product_id: 'prod_Crew',
          quantity: 1,
          current_period_end: 1_800_000_000,
        },
      ],
      identity_candidates: [],
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(overrides: StripeIntegrationOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-integration-'));
  const store = new Store(directory);
  store.saveSettings({ ...store.settings(), discord_guild_id: guild });
  let data = snapshot(),
    fail = false,
    clock = Date.parse('2026-10-20T12:00:00Z');
  const checkout = vi.fn(async (_subscriptionId: string): Promise<StripeIdentityCandidate[]> => []);
  const read = vi.fn(async () => {
    if (fail) throw new StripeClientError('forbidden');
    return structuredClone(data);
  });
  const memberLookup = vi.fn(async (id: string) => ({ id, username: 'jim' }));
  const integration = new StripeIntegration(store, {
    clientFactory: () => ({ mode: 'test', snapshot: read, checkoutIdentityCandidates: checkout }),
    resolveDiscordMember: memberLookup,
    now: () => clock,
    ...overrides,
  });
  resources.push({ store, integration, directory });
  const configure = (input: Partial<Parameters<StripeIntegration['configure']>[0]> = {}) =>
    integration.configure({
      api_key: key,
      sync_enabled: false,
      expected_revision: integration.status().revision,
      ...input,
    });
  return {
    store,
    integration,
    directory,
    read,
    checkout,
    memberLookup,
    configure,
    setData: (value: StripeSnapshot) => {
      data = value;
    },
    fail: () => {
      fail = true;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
afterEach(async () => {
  for (const { store, integration, directory } of resources.splice(0)) {
    await integration.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('read-only Stripe billing integration', () => {
  it('proposes MEE6 Checkout identities only for the configured Discord guild', async () => {
    const { integration, configure, setData } = fixture();
    const foreign = snapshot();
    foreign.subscriptions[0]!.identity_candidates = [
      {
        discord_user_id: member,
        source: 'checkout_metadata',
        field: 'user_id',
        guild_id: '999999999999999999',
      },
    ];
    setData(foreign);
    await configure();
    await integration.sync();
    expect(integration.subscriptions()[0]!.proposed_discord_id).toBeNull();
    const matching = snapshot();
    matching.subscriptions[0]!.identity_candidates = [
      {
        discord_user_id: member,
        source: 'checkout_metadata',
        field: 'user_id',
        guild_id: guild,
      },
    ];
    setData(matching);
    await integration.sync();
    expect(integration.subscriptions()[0]).toMatchObject({
      proposed_discord_id: member,
      linked_discord_id: null,
    });
  });
  it('encrypts billing details and keys, exposes no secrets in status, and makes no media account or membership changes', async () => {
    const { store, integration, directory, configure, checkout } = fixture();
    await configure();
    expect(integration.status()).toMatchObject({
      configured: true,
      mode: 'test',
      sync_enabled: false,
      review_only: true,
      last_sync: null,
    });
    expect(checkout).not.toHaveBeenCalled();
    await integration.sync();
    expect(integration.status()).toMatchObject({
      running: false,
      subscription_count: 1,
      last_error: null,
    });
    expect(integration.subscriptions()[0]).toMatchObject({
      customer_id: 'cus_0',
      customer_email: 'member0@example.test',
      linked_discord_id: null,
    });
    expect(JSON.stringify(integration.status())).not.toContain(key);
    expect(JSON.stringify(integration)).not.toContain(key);
    expect(JSON.stringify(integration.status())).not.toContain('member0@example.test');
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const disk = readFileSync(join(directory, 'jellyport.db')).toString('utf8');
    for (const secret of [key, 'member0@example.test', 'Sloop Crewman Plan', 'cus_0'])
      expect(disk).not.toContain(secret);
    const restarted = new StripeIntegration(store);
    expect(restarted.status().subscription_count).toBe(1);
    await restarted.stop();
  });
  it('rejects full-access keys, stale configuration, malformed price maps and keyless automatic polling', async () => {
    const { integration, configure } = fixture();
    await expect(configure({ api_key: 'sk_live_syntheticOnly123' })).rejects.toThrow('restricted');
    await expect(configure({ api_key: '', sync_enabled: true })).rejects.toThrow('restricted');
    await configure();
    await expect(configure({ expected_revision: 'old-review' })).rejects.toThrow('changed');
    await expect(
      configure({ price_tiers: [{ price_id: 'price_Crew', tier_id: 'unknown' }] }),
    ).rejects.toThrow('configured');
    await expect(
      configure({
        price_tiers: [
          { price_id: 'price_Crew', tier_id: 'sloop' },
          { price_id: 'price_Crew', tier_id: 'brigantine' },
        ],
      }),
    ).rejects.toThrow('once');
  });
  it('shares overlapping sync work and reuses successful checkout identity discovery including empty results', async () => {
    const blocked = deferred<StripeSnapshot>();
    const { integration, configure, read, checkout } = fixture();
    await configure();
    read.mockImplementationOnce(() => blocked.promise);
    const first = integration.sync(),
      second = integration.sync();
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    expect(integration.status().running).toBe(true);
    blocked.resolve(snapshot(3));
    await first;
    expect(checkout).toHaveBeenCalledTimes(3);
    await integration.sync();
    expect(checkout).toHaveBeenCalledTimes(3);
  });
  it('bounds checkout discovery and eventually fills missing identity lookups without restarting old work', async () => {
    const { integration, configure, checkout, setData } = fixture();
    setData(snapshot(125));
    await configure();
    await integration.sync();
    expect(checkout).toHaveBeenCalledTimes(100);
    await integration.sync();
    expect(checkout).toHaveBeenCalledTimes(125);
    expect(integration.subscriptions()).toHaveLength(125);
  });
  it('preserves the previous successful catalog and reviewed links when a later billing read fails', async () => {
    const { integration, configure, fail } = fixture();
    await configure();
    await integration.sync();
    await integration.linkCustomer({
      customer_id: 'cus_0',
      discord_user_id: member,
      expected_revision: integration.status().revision,
    });
    const last = integration.status().last_sync;
    fail();
    await expect(integration.sync()).rejects.toThrow('permission');
    expect(integration.status()).toMatchObject({
      last_sync: last,
      subscription_count: 1,
      linked_customer_count: 1,
    });
    expect(integration.status().last_error).toContain('permission');
    expect(integration.subscriptions()[0]?.linked_discord_id).toBe(member);
  });
  it('requires reviewed customer ownership and a fresh exact Discord identity; metadata and username hints never create a link', async () => {
    const { integration, configure, checkout, memberLookup } = fixture();
    checkout.mockResolvedValue([
      {
        discord_user_id: member,
        source: 'checkout_client_reference',
        field: 'client_reference_id',
      },
    ]);
    await configure();
    integration.recordDiscordHint({
      id: member,
      username: 'jim',
      tier: '',
      source_event: 'message-1',
    });
    await integration.sync();
    expect(integration.subscriptions()[0]).toMatchObject({
      proposed_discord_id: member,
      linked_discord_id: null,
    });
    expect(memberLookup).not.toHaveBeenCalled();
    memberLookup.mockResolvedValueOnce({ id: guild, username: 'someone-else' });
    await expect(
      integration.linkCustomer({
        customer_id: 'cus_0',
        discord_user_id: member,
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('verified');
    expect(integration.status().linked_customer_count).toBe(0);
    await integration.linkCustomer({
      customer_id: 'cus_0',
      discord_user_id: member,
      expected_revision: integration.status().revision,
    });
    expect(memberLookup).toHaveBeenLastCalledWith(member);
    expect(integration.subscriptions()[0]?.linked_discord_username).toBe('jim');
    await expect(
      integration.linkCustomer({
        customer_id: 'cus_0',
        discord_user_id: guild,
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('Unlink');
  });
  it('does not suggest contradictory identity fields or infer tier allowances from plan names', async () => {
    const { integration, configure, setData } = fixture();
    const data = snapshot();
    data.subscriptions[0]!.identity_candidates = [
      { discord_user_id: member, source: 'customer_metadata', field: 'discord_id' },
      { discord_user_id: guild, source: 'subscription_metadata', field: 'discord_id' },
    ];
    setData(data);
    await configure();
    await integration.sync();
    expect(integration.subscriptions()[0]).toMatchObject({
      proposed_discord_id: null,
      tier_id: null,
    });
    await configure({ api_key: '', price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }] });
    expect(integration.subscriptions()[0]?.tier_id).toBe('sloop');
  });
  it('checks Checkout identity even when customer or subscription metadata contains an ID and exposes paused collection', async () => {
    const { integration, configure, setData, checkout } = fixture();
    const data = snapshot();
    data.subscriptions[0]!.identity_candidates = [
      { discord_user_id: member, source: 'subscription_metadata', field: 'discord_id' },
    ];
    data.subscriptions[0]!.pause_collection = true;
    data.subscriptions[0]!.collection_method = 'send_invoice';
    checkout.mockResolvedValue([
      { discord_user_id: guild, source: 'checkout_metadata', field: 'discord_id' },
    ]);
    setData(data);
    await configure();
    await integration.sync();
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(integration.subscriptions()[0]).toMatchObject({
      proposed_discord_id: null,
      identity_source: 'Conflicting Stripe identity fields; review required',
      pause_collection: true,
      collection_method: 'send_invoice',
    });
    await integration.sync();
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(integration.subscriptions()[0]?.proposed_discord_id).toBeNull();
  });
  it('invalidates customer links, mappings and cached discoveries on key replacement and Discord server changes', async () => {
    const { store, integration, configure, checkout } = fixture();
    await configure();
    await integration.sync();
    await integration.linkCustomer({
      customer_id: 'cus_0',
      discord_user_id: member,
      expected_revision: integration.status().revision,
    });
    await configure({ api_key: '', price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }] });
    await configure({
      api_key: 'rk_test_replacementOnly456',
      price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }],
    });
    expect(integration.status()).toMatchObject({
      subscription_count: 0,
      linked_customer_count: 0,
      price_tiers: [],
    });
    await integration.sync();
    expect(checkout).toHaveBeenCalledTimes(2);
    store.saveSettings({ ...store.settings(), discord_guild_id: member });
    expect(integration.status()).toMatchObject({
      configured: true,
      sync_enabled: false,
      subscription_count: 0,
      linked_customer_count: 0,
    });
  });
  it('does not adopt a stale in-flight sync after configuration changes and rejects concurrent customer link review', async () => {
    const blocked = deferred<StripeSnapshot>();
    const { integration, configure, read } = fixture();
    await configure();
    await integration.sync();
    read.mockImplementationOnce(() => blocked.promise);
    const syncing = integration.sync();
    await expect(
      integration.linkCustomer({
        customer_id: 'cus_0',
        discord_user_id: member,
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('finish');
    const changed = configure({ api_key: 'rk_test_replacementOnly456' });
    blocked.resolve(snapshot(10));
    await expect(syncing).rejects.toThrow('preserved');
    await changed;
    expect(integration.status()).toMatchObject({ subscription_count: 0, running: false });
  });
  it('rejects a changed configuration during Discord identity verification and stale catalog links', async () => {
    const blocked = deferred<{ id: string; username: string }>();
    const { integration, configure, memberLookup, advance } = fixture();
    await configure();
    await integration.sync();
    memberLookup.mockImplementationOnce(() => blocked.promise);
    const linking = integration.linkCustomer({
      customer_id: 'cus_0',
      discord_user_id: member,
      expected_revision: integration.status().revision,
    });
    await configure({ api_key: '' });
    blocked.resolve({ id: member, username: 'jim' });
    await expect(linking).rejects.toThrow('changed');
    expect(integration.status().linked_customer_count).toBe(0);
    advance(25 * 60 * 60 * 1000);
    await expect(
      integration.linkCustomer({
        customer_id: 'cus_0',
        discord_user_id: member,
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('Refresh');
  });
  it('deduplicates trusted identity hints, bounds retained members and never treats a name hint as verified ownership', async () => {
    const { integration, configure } = fixture();
    await configure();
    integration.recordDiscordHint({
      id: member,
      username: 'jim',
      tier: '',
      source_event: 'message-1',
    });
    integration.recordDiscordHint({
      id: member,
      username: 'jim-new',
      tier: '',
      source_event: 'message-2',
    });
    integration.recordDiscordHint({
      id: member,
      username: 'jim',
      tier: '',
      source_event: 'message-1',
    });
    expect(integration.status().hints[0]?.username).toBe('jim-new');
    integration.recordDiscordHint({
      id: member,
      username: 'jim',
      tier: 'sloop',
      source_event: 'message-3',
    });
    await integration.sync();
    expect(integration.subscriptions()[0]).toMatchObject({
      proposed_discord_id: member,
      identity_source: 'MEE6 username hint; unverified',
      linked_discord_id: null,
    });
    for (let index = 0; index < 550; index++)
      integration.recordDiscordHint({
        id: `34567890123456${String(index).padStart(4, '0')}`,
        username: `member${index}`,
        tier: '',
        source_event: `new-${index}`,
      });
    expect(integration.status().hints).toHaveLength(500);
    expect(JSON.stringify(integration.status())).not.toContain('source_event');
  });
  it('aborts an active read promptly on stop', async () => {
    const started = deferred<void>();
    const { integration, configure } = fixture({
      clientFactory: () => ({
        mode: 'test',
        checkoutIdentityCandidates: async () => [],
        snapshot: (signal) => {
          started.resolve();
          return new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(new StripeClientError('cancelled')), {
              once: true,
            });
          });
        },
      }),
    });
    await configure();
    const read = integration.sync();
    await started.promise;
    const rejected = expect(read).rejects.toThrow('cancelled');
    await integration.stop();
    await rejected;
    expect(integration.status().running).toBe(false);
    await expect(integration.sync()).rejects.toThrow('stopping');
  });
  it('shows only a single shared known billing period end and never interprets it as paid access', async () => {
    const { integration, configure, setData } = fixture();
    const data = snapshot();
    data.subscriptions[0]!.items.push({
      ...data.subscriptions[0]!.items[0]!,
      id: 'si_second',
      current_period_end: 1_900_000_000,
    });
    setData(data);
    await configure();
    await integration.sync();
    expect(integration.subscriptions()[0]?.current_period_end).toBeNull();
    data.subscriptions[0]!.items[1]!.current_period_end =
      data.subscriptions[0]!.items[0]!.current_period_end;
    setData(data);
    await integration.sync();
    expect(integration.subscriptions()[0]?.current_period_end).toBe(
      new Date(1_800_000_000_000).toISOString(),
    );
    delete data.subscriptions[0]!.items[1]!.current_period_end;
    setData(data);
    await integration.sync();
    expect(integration.subscriptions()[0]?.current_period_end).toBeNull();
  });
  it('rejects malformed or overflowing Discord IDs and securely disconnects the read-only connection', async () => {
    const { integration, configure, store } = fixture();
    await configure();
    await integration.sync();
    for (const id of ['0', '012345678901234567', '18446744073709551616', '99999999999999999999']) {
      integration.recordDiscordHint({ id, username: 'jim', tier: '', source_event: `bad-${id}` });
      await expect(
        integration.linkCustomer({
          customer_id: 'cus_0',
          discord_user_id: id,
          expected_revision: integration.status().revision,
        }),
      ).rejects.toThrow('current member');
    }
    expect(integration.status().hints).toEqual([]);
    await integration.linkCustomer({
      customer_id: 'cus_0',
      discord_user_id: member,
      expected_revision: integration.status().revision,
    });
    await integration.disconnect({ expected_revision: integration.status().revision });
    expect(integration.status()).toMatchObject({
      configured: false,
      mode: null,
      sync_enabled: false,
      subscription_count: 0,
      linked_customer_count: 0,
      hints: [],
      price_tiers: [],
    });
    expect(integration.subscriptions()).toEqual([]);
    const saved = store.decrypt(
      store.db.prepare('SELECT encrypted FROM stripe_integration_state WHERE id=1').get()!
        .encrypted as Uint8Array,
    );
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(JSON.stringify(saved)).not.toContain('member0@example.test');
  });
  it('finds a fresh suggested Discord member without approving ownership or mutating accounts', async () => {
    const { integration, store, configure, checkout, memberLookup } = fixture();
    checkout.mockResolvedValue([
      { discord_user_id: member, source: 'checkout_metadata', field: 'discord_id' },
    ]);
    await configure();
    await integration.sync();
    const before = integration.status();
    expect(
      await integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: before.revision,
      }),
    ).toEqual({ id: member, username: 'jim' });
    expect(memberLookup).toHaveBeenLastCalledWith(member);
    expect(integration.status()).toEqual(before);
    expect(integration.subscriptions()[0]?.linked_discord_id).toBeNull();
    expect(store.links()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
    expect(store.jobs()).toEqual([]);
  });
  it('rejects missing or conflicting suggestions across every subscription belonging to a customer', async () => {
    const { integration, configure, setData, checkout, memberLookup } = fixture();
    const data = snapshot(2);
    data.subscriptions[1]!.customer_id = 'cus_0';
    checkout.mockImplementation(async (subscriptionId: string) => [
      {
        discord_user_id: subscriptionId === 'sub_0' ? member : guild,
        source: 'checkout_metadata',
        field: 'discord_id',
      },
    ]);
    setData(data);
    await configure();
    await integration.sync();
    await expect(
      integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('no unique');
    expect(memberLookup).not.toHaveBeenCalled();
    await integration.disconnect({ expected_revision: integration.status().revision });
    checkout.mockResolvedValue([]);
    setData(snapshot());
    await configure();
    await integration.sync();
    await expect(
      integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('no unique');
    expect(memberLookup).not.toHaveBeenCalled();
  });
  it('rejects a customer with contradictory metadata even when another subscription suggests one identity', async () => {
    const { integration, configure, setData, checkout, memberLookup } = fixture();
    const data = snapshot(2);
    data.subscriptions[1]!.customer_id = 'cus_0';
    data.subscriptions[0]!.identity_candidates = [
      { discord_user_id: guild, source: 'subscription_metadata', field: 'discord_id' },
    ];
    checkout.mockResolvedValue([
      { discord_user_id: member, source: 'checkout_metadata', field: 'discord_id' },
    ]);
    setData(data);
    await configure();
    await integration.sync();
    await expect(
      integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('no unique');
    expect(memberLookup).not.toHaveBeenCalled();
  });
  it('rejects changed reviews, wrong member responses, stale data and active syncs when resolving suggestions', async () => {
    const { integration, configure, checkout, memberLookup, advance, read } = fixture();
    checkout.mockResolvedValue([
      { discord_user_id: member, source: 'checkout_metadata', field: 'discord_id' },
    ]);
    await configure();
    await integration.sync();
    const blocked = deferred<{ id: string; username: string }>();
    memberLookup.mockImplementationOnce(() => blocked.promise);
    const resolving = integration.resolveCandidate({
      customer_id: 'cus_0',
      expected_revision: integration.status().revision,
    });
    await configure({ api_key: '' });
    blocked.resolve({ id: member, username: 'jim' });
    await expect(resolving).rejects.toThrow('changed');
    memberLookup.mockResolvedValueOnce({ id: guild, username: 'wrong-member' });
    await expect(
      integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('verified');
    const scan = deferred<StripeSnapshot>();
    read.mockImplementationOnce(() => scan.promise);
    const syncing = integration.sync();
    await expect(
      integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('finish');
    scan.resolve(snapshot());
    await syncing;
    advance(25 * 60 * 60 * 1000);
    await expect(
      integration.resolveCandidate({
        customer_id: 'cus_0',
        expected_revision: integration.status().revision,
      }),
    ).rejects.toThrow('Refresh');
    expect(integration.status().linked_customer_count).toBe(0);
  });
});
