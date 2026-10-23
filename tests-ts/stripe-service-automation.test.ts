import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter } from '../server/service.js';
import { StripeIntegration } from '../server/stripe-integration.js';
import type { StripePaidPeriod, StripeSnapshot } from '../server/stripe-client.js';

const owner = '100001',
  base = 1_800_000_000;
class BillingBot implements BotAdapter {
  joinedAt = new Date((base + 1) * 1000).toISOString();
  sendCredentials = vi.fn(async () => {});
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string, requireRole?: boolean) {
    expect(requireRole).not.toBe(true);
    return { id, username: 'new.member', joined_at: this.joinedAt };
  }
  async validateRecipient(_id: string, requireRole?: boolean) {
    expect(requireRole).not.toBe(true);
  }
  async membershipActive() {
    return false;
  }
  async activeMembers() {
    return [];
  }
}
describe('Stripe-first membership automation without MEE6', () => {
  let directory: string,
    store: Store,
    servers: DemoServers,
    service: Service,
    stripe: StripeIntegration,
    bot: BillingBot;
  let data: StripeSnapshot, period: StripePaidPeriod | null, reads: string[], writes: string[];
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(base * 1000));
    directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-service-'));
    store = new Store(directory);
    servers = new DemoServers();
    reads = [];
    writes = [];
    data = {
      mode: 'live',
      completed_at: new Date().toISOString(),
      subscriptions: [],
      products: [],
    };
    period = null;
    store.saveSettings({
      ...store.settings(),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic',
      jellyfin_public_url: 'https://jellyfin.example.test',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '200001',
      discord_member_role_id: '300001',
      discord_message_events: false,
      discord_role_events: false,
      new_subscriber_source: 'stripe',
      auto_create_new_subscribers: true,
      auto_provision: true,
      auto_disable: true,
    });
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args),
          kind = args[2] ?? 'jellyfin';
        return new Proxy(client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return (...parameters: unknown[]) => {
              if (kind === 'emby') {
                reads.push(String(property));
                if (!['users', 'close'].includes(String(property)))
                  throw new Error('Unexpected source history read');
              }
              if (['createUser', 'setPassword', 'setPolicy'].includes(String(property)))
                writes.push(String(property));
              return Reflect.apply(value, target, parameters);
            };
          },
        });
      },
    });
    bot = new BillingBot();
    service.bot = bot;
    stripe = new StripeIntegration(store, {
      clientFactory: () => ({
        mode: 'live',
        snapshot: async () => structuredClone(data),
        checkoutIdentityCandidates: async () => [],
        paidPeriod: async () => period,
      }),
      resolveDiscordMember: async (id) => ({ id, username: 'new.member' }),
      onEntitlement: (fact) => service.recordStripeEntitlement(fact),
    });
    service.verifyStripeEntitlement = (fact) => stripe.assertEntitlement(fact);
    await stripe.configure({
      api_key: 'rk_live_syntheticOnly',
      sync_enabled: true,
      expected_revision: stripe.status().revision,
    });
    await stripe.sync();
    await stripe.configure({
      automation_enabled: true,
      sync_enabled: true,
      price_tiers: [{ price_id: 'price_member', tier_id: 'sloop' }],
      expected_revision: stripe.status().revision,
    });
  });
  afterEach(async () => {
    await stripe.stop();
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });
  async function newSubscription() {
    vi.setSystemTime(new Date((base + 3) * 1000));
    data.subscriptions = [
      {
        id: 'sub_new',
        created: base + 1,
        customer_id: 'cus_new',
        status: 'active',
        collection_method: 'charge_automatically',
        pause_collection: false,
        cancel_at_period_end: false,
        items: [{ id: 'si_new', price_id: 'price_member', product_id: 'prod_member', quantity: 1 }],
        identity_candidates: [],
      },
    ];
    period = {
      invoice_id: 'in_new',
      subscription_id: 'sub_new',
      customer_id: 'cus_new',
      created: base + 1,
      paid_at: base + 2,
      price_id: 'price_member',
      start: base + 1,
      end: base + 86_400,
    };
    await stripe.sync();
    expect(store.jobs()).toEqual([]);
    await stripe.linkCustomer({
      customer_id: 'cus_new',
      discord_user_id: owner,
      expected_revision: stripe.status().revision,
    });
  }
  it('creates a verified new account, DMs its owner and deduplicates later polls without MEE6 roles', async () => {
    await newSubscription();
    await stripe.sync();
    expect(store.linksForMember(owner)).toHaveLength(1);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(1);
    expect(service.memberships.get(owner, store.settings())).toMatchObject({
      provision_jellyfin: true,
      active: true,
    });
    expect(
      service.memberships.get(owner, store.settings())?.new_subscriber_pending,
    ).toBeUndefined();
    expect(reads.every((name) => ['users', 'close'].includes(name))).toBe(true);
    await stripe.sync();
    expect(store.jobs()).toHaveLength(1);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(1);
  });
  it('creates all three separately credentialed slots for an existing Discord member with a verified new payment', async () => {
    bot.joinedAt = new Date((base - 365 * 86_400) * 1000).toISOString();
    await stripe.configure({
      sync_enabled: true,
      expected_revision: stripe.status().revision,
      price_tiers: [{ price_id: 'price_member', tier_id: 'galleon' }],
    });
    await newSubscription();
    await stripe.sync();
    expect(
      store.linksForMember(owner).map((link) => [link.username, link.membership_slot]),
    ).toEqual([
      ['new.member', 1],
      ['new.member_2', 2],
      ['new.member_3', 3],
    ]);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(3);
    expect(reads.every((name) => ['users', 'close'].includes(name))).toBe(true);
    await stripe.sync();
    expect(bot.sendCredentials).toHaveBeenCalledTimes(3);
  });
  it('does not enroll an existing active subscription captured by the activation baseline', async () => {
    await stripe.configure({
      sync_enabled: true,
      automation_enabled: false,
      expected_revision: stripe.status().revision,
    });
    await newSubscription();
    await stripe.configure({
      sync_enabled: true,
      automation_enabled: true,
      expected_revision: stripe.status().revision,
    });
    await stripe.sync();
    expect(store.jobs()).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
  });
  it('keeps a saved Emby-only opt-out unchanged', async () => {
    await service.setMembershipAccess({
      discord_user_id: owner,
      access_mode: 'subscription',
      tier_id: 'sloop',
      provision_jellyfin: false,
    });
    await newSubscription();
    await stripe.sync();
    expect(store.jobs()).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
  });
  it('disables only after a confirmed ended subscription and expired paid period', async () => {
    await newSubscription();
    await stripe.sync();
    const target = servers.users.jellyfin.find((account) => account.Name === 'new.member')!;
    data.subscriptions[0]!.cancel_at_period_end = true;
    await stripe.sync();
    expect(target.Policy?.IsDisabled).toBe(false);
    vi.setSystemTime(new Date((base + 86_401) * 1000));
    data.subscriptions[0]!.status = 'canceled';
    data.subscriptions[0]!.ended_at = base + 86_400;
    await stripe.sync();
    expect(target.Policy?.IsDisabled).toBe(true);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(1);
  });
  it('preserves active accounts when invoice evidence is unavailable or subscription is past due', async () => {
    await newSubscription();
    await stripe.sync();
    const target = servers.users.jellyfin.find((account) => account.Name === 'new.member')!;
    vi.setSystemTime(new Date((base + 86_401) * 1000));
    period = null;
    data.subscriptions[0]!.status = 'past_due';
    await stripe.sync();
    expect(target.Policy?.IsDisabled).toBe(false);
  });
  it('requires the original approved customer and matching owner for access decisions', async () => {
    await newSubscription();
    await stripe.sync();
    const event = store.subscriptions()[0]!;
    await expect(
      service.recordSubscription({
        id: 'forged',
        action: 'expire',
        source: 'stripe',
        discord_user_id: '100002',
        stripe_entitlement: event.stripe_entitlement,
      }),
    ).rejects.toThrow('does not match');
    await stripe.unlinkCustomer({
      customer_id: 'cus_new',
      expected_revision: stripe.status().revision,
    });
    expect(() => stripe.assertEntitlement(event.stripe_entitlement!)).toThrow('changed');
  });
  it('rejects a pending expiry after another active customer is approved for the same owner', async () => {
    await newSubscription();
    await stripe.sync();
    const target = servers.users.jellyfin.find((account) => account.Name === 'new.member')!;
    store.saveSettings({ ...store.settings(), auto_disable: false });
    vi.setSystemTime(new Date((base + 86_401) * 1000));
    data.subscriptions[0]!.status = 'canceled';
    data.subscriptions[0]!.ended_at = base + 86_400;
    data.subscriptions.push({
      ...data.subscriptions[0]!,
      id: 'sub_other',
      customer_id: 'cus_other',
      status: 'active',
      ended_at: undefined,
    });
    await stripe.sync();
    const pending = store.subscriptions().find((event) => event.action === 'expire')!;
    expect(pending.status).toBe('pending');
    expect(() => stripe.assertEntitlement(pending.stripe_entitlement!)).not.toThrow();
    await stripe.linkCustomer({
      customer_id: 'cus_other',
      discord_user_id: owner,
      expected_revision: stripe.status().revision,
    });
    const before = writes.length;
    expect(() => stripe.assertEntitlement(pending.stripe_entitlement!)).toThrow(
      'changed or expired',
    );
    await expect(service.applySubscription(pending.id)).rejects.toThrow('changed or expired');
    expect(target.Policy?.IsDisabled).toBe(false);
    expect(writes).toHaveLength(before);
  });
  it('does not reactivate an Emby-only entitlement if its Stripe identity is revoked during Discord verification', async () => {
    await service.setMembershipAccess({
      discord_user_id: owner,
      access_mode: 'subscription',
      tier_id: 'sloop',
      provision_jellyfin: false,
    });
    const current = service.memberships.get(owner, store.settings())!;
    service.memberships.save(
      { ...current, active: false, inactive_reason: 'expire' },
      store.settings(),
      current.revision,
    );
    await newSubscription();
    const identity = bot.recipientIdentity.bind(bot);
    vi.spyOn(bot, 'recipientIdentity').mockImplementation(async (id, requireRole) => {
      await stripe.unlinkCustomer({
        customer_id: 'cus_new',
        expected_revision: stripe.status().revision,
      });
      return identity(id, requireRole);
    });
    await stripe.sync();
    expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
    expect(store.subscriptions().find((event) => event.source === 'stripe')?.status).toBe('failed');
    expect(writes).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });
  it('keeps aggregate authority on identity-review rollback and invalidates it only after the atomic commit', async () => {
    await newSubscription();
    await stripe.sync();
    store.saveSettings({ ...store.settings(), auto_disable: false });
    vi.setSystemTime(new Date((base + 86_401) * 1000));
    data.subscriptions[0]!.status = 'canceled';
    data.subscriptions[0]!.ended_at = base + 86_400;
    data.subscriptions.push({
      ...data.subscriptions[0]!,
      id: 'sub_other',
      customer_id: 'cus_other',
      status: 'active',
      ended_at: undefined,
    });
    await stripe.sync();
    const fact = store
      .subscriptions()
      .find((event) => event.action === 'expire')!.stripe_entitlement!;
    const approval = {
      expected_revision: stripe.status().revision,
      links: [{ customer_id: 'cus_other', discord_user_id: owner, username: 'new.member' }],
    };
    expect(() =>
      stripe.commitReviewedIdentities(approval, () => {
        throw new Error('Synthetic rollback');
      }),
    ).toThrow('Synthetic rollback');
    expect(() => stripe.assertEntitlement(fact)).not.toThrow();
    stripe.commitReviewedIdentities(approval, () => {});
    expect(() => stripe.assertEntitlement(fact)).toThrow('changed or expired');
  });
  it('invalidates invoice authority when saved price-to-tier mappings change', async () => {
    await newSubscription();
    await stripe.sync();
    const fact = store.subscriptions()[0]!.stripe_entitlement!;
    await stripe.configure({
      sync_enabled: true,
      expected_revision: stripe.status().revision,
      price_tiers: [{ price_id: 'price_member', tier_id: 'galleon' }],
    });
    expect(() => stripe.assertEntitlement(fact)).toThrow('changed');
  });
  it('preserves the active policy when a replacement-key automation request is rejected', async () => {
    const original = stripe.status();
    await expect(
      stripe.configure({
        api_key: 'rk_live_replacementSynthetic',
        automation_enabled: true,
        sync_enabled: true,
        expected_revision: original.revision,
      }),
    ).rejects.toThrow('Save and sync the replacement key');
    expect(stripe.status()).toMatchObject({
      revision: original.revision,
      automation_enabled: true,
    });
  });
});
