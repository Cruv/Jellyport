import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StripeIntegration, type StripeIntegrationOptions } from '../server/stripe-integration.js';
import {
  StripeClientError,
  type StripePaidPeriod,
  type StripeSnapshot,
} from '../server/stripe-client.js';

const base = 1_800_000_000,
  owner = '100001',
  role = '300001';
const resources: Array<{ directory: string; store: Store; integration: StripeIntegration }> = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-cleanup-integration-'));
  const store = new Store(directory);
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '200001',
    new_subscriber_source: 'stripe',
    auto_provision: false,
    auto_disable: false,
  });
  let clock = base * 1000,
    present = true;
  const data: StripeSnapshot = {
    mode: 'live',
    completed_at: new Date(clock).toISOString(),
    products: [],
    subscriptions: [
      {
        id: 'sub_member',
        customer_id: 'cus_member',
        created: base - 100_000,
        status: 'canceled',
        ended_at: base - 100,
        collection_method: 'charge_automatically',
        pause_collection: false,
        cancel_at_period_end: false,
        items: [
          { id: 'si_member', price_id: 'price_member', product_id: 'prod_member', quantity: 1 },
        ],
        identity_candidates: [],
      },
    ],
  };
  const invoice: StripePaidPeriod = {
    invoice_id: 'in_old',
    customer_id: 'cus_member',
    subscription_id: 'sub_member',
    created: base - 100_000,
    paid_at: base - 1,
    price_id: 'price_member',
    start: base - 90_000,
    end: base - 3600,
  };
  const read = vi.fn(async () => structuredClone(data));
  const paid = vi.fn(async (_id: string): Promise<StripePaidPeriod | null> =>
    structuredClone(invoice),
  );
  const remove = vi.fn(
    async (_id: string, _role: string, _allowed: string[], guard: () => void) => {
      guard();
      present = false;
    },
  );
  const onEntitlement = vi.fn(async () => {});
  const adapter = {
    listRoles: vi.fn(async () => ({
      can_manage_roles: true,
      roles: [{ id: role, name: 'Subscriber', manageable: true }],
    })),
    memberState: vi.fn(async (id: string) => ({ id, roles: present ? [role] : [] })),
    removeRole: remove,
    isExempt: vi.fn(() => false),
    context: () => 'discord-v1',
  };
  const options: StripeIntegrationOptions = {
    clientFactory: () => ({
      mode: data.mode,
      snapshot: read,
      checkoutIdentityCandidates: async () => [],
      paidPeriod: paid,
    }),
    resolveDiscordMember: async (id) => ({ id, username: 'synthetic.member' }),
    roleCleanup: adapter,
    now: () => clock,
    onEntitlement,
  };
  const integration = new StripeIntegration(store, options);
  resources.push({ directory, store, integration });
  const configure = (extra: Partial<Parameters<StripeIntegration['configure']>[0]> = {}) =>
    integration.configure({
      sync_enabled: true,
      expected_revision: integration.status().revision,
      ...extra,
    });
  const setup = async () => {
    await configure({ api_key: 'rk_live_syntheticOnly' });
    await integration.sync();
    await configure({ price_tiers: [{ price_id: 'price_member', tier_id: 'sloop' }] });
    await integration.linkCustomer({
      customer_id: 'cus_member',
      discord_user_id: owner,
      expected_revision: integration.status().revision,
    });
  };
  return {
    directory,
    store,
    integration,
    data,
    paid,
    read,
    remove,
    adapter,
    onEntitlement,
    configure,
    setup,
    options,
    invoice,
    advance: (ms: number) => {
      clock += ms;
    },
    readd: () => {
      present = true;
    },
  };
}
afterEach(async () => {
  for (const { directory, store, integration } of resources.splice(0)) {
    await integration.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('independent Stripe role cleanup integration', () => {
  it('enables with one permission probe, waits for complete invoice verification, and needs no media automation', async () => {
    const f = fixture();
    await f.setup();
    const status = await f.configure({ role_cleanup_enabled: true, role_cleanup_role_ids: [role] });
    expect(status).toMatchObject({
      automation_enabled: false,
      role_cleanup: { enabled: true, role_ids: [role], last_run: null },
    });
    expect(f.paid).toHaveBeenCalledTimes(1);
    await f.integration.reconcileRoleCleanup();
    expect(f.remove).not.toHaveBeenCalled();
    await f.integration.sync();
    expect(f.paid).toHaveBeenCalledTimes(2);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.onEntitlement).not.toHaveBeenCalled();
    expect(f.store.links()).toEqual([]);
    expect(f.store.subscriptions()).toEqual([]);
    expect(f.integration.status().role_cleanup.removed_roles).toBe(1);
  });
  it('shares exactly one invoice GET per approved subscription when both policies are enabled', async () => {
    const f = fixture();
    await f.setup();
    await f.configure({
      automation_enabled: true,
      role_cleanup_enabled: true,
      role_cleanup_role_ids: [role],
    });
    f.paid.mockClear();
    await f.integration.sync();
    expect(f.paid).toHaveBeenCalledOnce();
    expect(f.onEntitlement).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledOnce();
    // Existing entitlement receipt does not hide current Discord role conflict.
    f.readd();
    await f.integration.sync();
    expect(f.onEntitlement).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.integration.status().role_cleanup.readded_members).toBe(1);
  });
  it.each(['test', 'stale', 'source', 'sync disabled', 'unmanageable', 'missing invoices'])(
    'rejects unsafe enable for %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'test') f.data.mode = 'test';
      await f.setup();
      if (kind === 'stale') f.advance(30 * 60_000 + 1);
      if (kind === 'source')
        f.store.saveSettings({ ...f.store.settings(), new_subscriber_source: 'trusted_messages' });
      if (kind === 'unmanageable')
        f.adapter.listRoles.mockResolvedValue({ can_manage_roles: false, roles: [] });
      if (kind === 'missing invoices') f.paid.mockRejectedValue(new StripeClientError('forbidden'));
      const request = f.configure({
        role_cleanup_enabled: true,
        role_cleanup_role_ids: [role],
        ...(kind === 'sync disabled' ? { sync_enabled: false } : {}),
      });
      await expect(request).rejects.toThrow();
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.integration.status().role_cleanup.enabled).toBe(false);
    },
  );
  it('does not enable against a configuration that changes during its permission probe', async () => {
    const f = fixture();
    await f.setup();
    f.paid.mockImplementationOnce(async () => {
      await f.configure({ sync_enabled: false });
      return f.invoice;
    });
    await expect(
      f.configure({ role_cleanup_enabled: true, role_cleanup_role_ids: [role] }),
    ).rejects.toThrow(/changed/);
    expect(f.integration.status().role_cleanup.enabled).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('invalidates previous proof during a failed sync and a failed paid-period read', async () => {
    const f = fixture();
    await f.setup();
    await f.configure({ role_cleanup_enabled: true, role_cleanup_role_ids: [role] });
    await f.integration.sync();
    f.readd();
    f.read.mockRejectedValueOnce(new Error('private upstream'));
    await expect(f.integration.sync()).rejects.toThrow();
    await f.integration.reconcileRoleCleanup();
    expect(f.remove).toHaveBeenCalledOnce();
    f.paid.mockRejectedValueOnce(new StripeClientError('forbidden'));
    await f.integration.sync();
    await f.integration.reconcileRoleCleanup();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.integration.status().role_cleanup.last_error).toMatch(/verification/);
    expect(JSON.stringify(f.integration.status())).not.toContain('private upstream');
  });
  it('invalidates proof immediately when approved identity is unlinked', async () => {
    const f = fixture();
    await f.setup();
    await f.configure({ role_cleanup_enabled: true, role_cleanup_role_ids: [role] });
    await f.integration.sync();
    f.readd();
    f.integration.unlinkCustomer({
      customer_id: 'cus_member',
      expected_revision: f.integration.status().revision,
    });
    await f.integration.reconcileRoleCleanup();
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it('disables cleanup when keys, guilds or polling change without silently re-enabling it', async () => {
    const f = fixture();
    await f.setup();
    await f.configure({ role_cleanup_enabled: true, role_cleanup_role_ids: [role] });
    await f.configure({ api_key: 'rk_live_replacementKeyOnly' });
    expect(f.integration.status().role_cleanup.enabled).toBe(false);
    await f.integration.sync();
    expect(f.integration.status().role_cleanup.enabled).toBe(false);
    await f.configure({ role_cleanup_enabled: true, role_cleanup_role_ids: [role] });
    await f.configure({ sync_enabled: false });
    expect(f.integration.status().role_cleanup.enabled).toBe(false);
    await f.configure({
      sync_enabled: true,
      role_cleanup_enabled: true,
      role_cleanup_role_ids: [role],
    });
    f.store.saveSettings({ ...f.store.settings(), discord_guild_id: '200002' });
    expect(f.integration.status().role_cleanup.enabled).toBe(false);
  });
});
