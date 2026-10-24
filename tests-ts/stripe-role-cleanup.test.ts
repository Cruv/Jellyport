import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StripeRoleCleanup, type StripeRoleCleanupAdapter } from '../server/stripe-role-cleanup.js';
import type {
  StripePaidPeriod,
  StripeSnapshot,
  StripeSubscription,
} from '../server/stripe-client.js';

const base = 1_800_000_000,
  owner = '100001',
  guild = '200001',
  subscriber = '300001',
  tier = '300002',
  unrelated = '300003';
const prices = [{ price_id: 'price_member', tier_id: 'sloop' }];
const resources: Array<{ directory: string; store: Store; policy: StripeRoleCleanup }> = [];
function subscription(id = 'old', member = owner): StripeSubscription {
  return {
    id: `sub_${id}`,
    created: base - 100_000,
    customer_id: `cus_${member}`,
    status: 'canceled',
    ended_at: base - 100,
    collection_method: 'charge_automatically',
    cancel_at_period_end: false,
    pause_collection: false,
    items: [{ id: `si_${id}`, price_id: 'price_member', product_id: 'prod_member', quantity: 1 }],
    identity_candidates: [],
  };
}
function paid(id = 'old', member = owner): StripePaidPeriod {
  return {
    invoice_id: `in_${id}`,
    customer_id: `cus_${member}`,
    subscription_id: `sub_${id}`,
    created: base - 100_000,
    paid_at: base - 90_000,
    start: base - 90_000,
    end: base - 3600,
    price_id: 'price_member',
  };
}
function snapshot(subscriptions = [subscription()]): StripeSnapshot {
  return {
    mode: 'live',
    completed_at: new Date(base * 1000).toISOString(),
    subscriptions,
    products: [],
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-stripe-role-cleanup-'));
  const store = new Store(directory);
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: guild,
    new_subscriber_source: 'stripe',
  });
  let clock = base * 1000,
    authority = 'approved-v1',
    context = 'discord-v1';
  const exempt = new Set<string>();
  const members = new Map([[owner, [subscriber, tier, unrelated]]]);
  const roles = vi.fn(async () => ({
    can_manage_roles: true,
    roles: [subscriber, tier].map((id) => ({
      id,
      name: 'Synthetic subscriber role',
      manageable: true,
    })),
  }));
  const member = vi.fn(async (id: string) =>
    members.has(id) ? { id, roles: [...members.get(id)!] } : null,
  );
  const remove = vi.fn(async (id: string, role: string, allowed: string[], guard: () => void) => {
    guard();
    if (!allowed.includes(role)) throw new Error('not allowed');
    members.set(
      id,
      members.get(id)!.filter((entry) => entry !== role),
    );
  });
  const adapter: StripeRoleCleanupAdapter = {
    listRoles: roles,
    memberState: member,
    removeRole: remove,
    isExempt: (id) => exempt.has(id),
    context: () => context,
  };
  const policy = new StripeRoleCleanup(
    store,
    adapter,
    () => authority,
    () => clock,
  );
  resources.push({ directory, store, policy });
  const enable = () => policy.configure(true, 'generation', [subscriber, tier]);
  const proof = (
    data = snapshot(),
    links = [{ customer_id: `cus_${owner}`, discord_user_id: owner }],
    periods: Map<string, StripePaidPeriod | null> = new Map([['sub_old', paid()]]),
  ) => policy.recordProof('generation', data, links, prices, periods);
  return {
    directory,
    store,
    policy,
    adapter,
    roles,
    member,
    remove,
    members,
    exempt,
    enable,
    proof,
    advance: (ms: number) => {
      clock += ms;
    },
    changeAuthority: () => {
      authority += '-changed';
    },
    changeContext: () => {
      context += '-changed';
    },
    now: () => clock,
  };
}
afterEach(async () => {
  for (const { directory, store, policy } of resources.splice(0)) {
    await policy.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Stripe-backed subscriber role cleanup', () => {
  it('is opt-in, removal-only, and independent of media automation receipts', async () => {
    const f = fixture();
    f.proof();
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
    f.enable();
    f.proof();
    await f.policy.reconcile('generation');
    expect(f.members.get(owner)).toEqual([unrelated]);
    expect(f.remove.mock.calls.map((call) => call[1])).toEqual([subscriber, tier]);
    expect(f.policy.status('generation')).toMatchObject({
      enabled: true,
      removed_roles: 2,
      failed_members: 0,
    });
    f.proof();
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(f.store.links()).toEqual([]);
    expect(f.store.subscriptions()).toEqual([]);
  });
  it('removes expired roles after old debt is paid late, without treating payment as renewed access', async () => {
    const f = fixture();
    f.enable();
    f.proof(
      snapshot(),
      undefined,
      new Map([['sub_old', { ...paid(), paid_at: base - 1, invoice_id: 'in_debt_paid_late' }]]),
    );
    await f.policy.reconcile('generation');
    expect(f.members.get(owner)).toEqual([unrelated]);
    expect(JSON.stringify(f.policy.status('generation'))).not.toContain('in_debt_paid_late');
  });
  it('protects a currently paid replacement across all approved customers', async () => {
    const f = fixture();
    f.enable();
    const replacement = { ...subscription('new', '100002'), status: 'active', ended_at: undefined };
    f.proof(
      snapshot([subscription(), replacement]),
      [
        { customer_id: `cus_${owner}`, discord_user_id: owner },
        { customer_id: 'cus_100002', discord_user_id: owner },
      ],
      new Map([
        ['sub_old', paid()],
        ['sub_new', { ...paid('new', '100002'), start: base - 1, end: base + 86_400 }],
      ]),
    );
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('preserves access when any approved customer has missing or unknown subscriptions', async () => {
    const f = fixture();
    f.enable();
    const links = [
      { customer_id: `cus_${owner}`, discord_user_id: owner },
      { customer_id: 'cus_other', discord_user_id: owner },
    ];
    f.proof(snapshot(), links);
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
    const unknown = { ...subscription('unknown'), customer_id: 'cus_other', status: 'past_due' };
    f.proof(
      snapshot([subscription(), unknown]),
      links,
      new Map([
        ['sub_old', paid()],
        ['sub_unknown', { ...paid('unknown'), customer_id: 'cus_other' }],
      ]),
    );
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(['past_due', 'unpaid', 'trialing', 'paused', 'unknown'])(
    'preserves roles for unknown %s subscription state',
    async (status) => {
      const f = fixture();
      f.enable();
      f.proof(snapshot([{ ...subscription(), status }]));
      await f.policy.reconcile('generation');
      expect(f.remove).not.toHaveBeenCalled();
    },
  );
  it.each([
    'missing invoice',
    'unmapped price',
    'paused collection',
    'multiple items',
    'test mode',
  ])('preserves roles for %s billing', async (kind) => {
    const f = fixture();
    f.enable();
    const data = snapshot();
    const periods = new Map<string, StripePaidPeriod | null>([['sub_old', paid()]]);
    if (kind === 'missing invoice') periods.set('sub_old', null);
    if (kind === 'unmapped price') data.subscriptions[0]!.items[0]!.price_id = 'price_other';
    if (kind === 'paused collection') data.subscriptions[0]!.pause_collection = true;
    if (kind === 'multiple items')
      data.subscriptions[0]!.items.push({ ...data.subscriptions[0]!.items[0]!, id: 'si_extra' });
    if (kind === 'test mode') data.mode = 'test';
    f.proof(data, undefined, periods);
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not act on stale or failed verification, or reuse evidence after a restart', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.advance(30 * 60_000 + 1);
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
    f.proof();
    f.policy.invalidateProof('verification failed');
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
    f.proof();
    const restarted = new StripeRoleCleanup(f.store, f.adapter, () => 'approved-v1', f.now);
    await restarted.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
    await restarted.stop();
  });
  it('preserves exempt members and checks a new exemption after each awaited read', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.exempt.add(owner);
    await f.policy.reconcile('generation');
    expect(f.member).not.toHaveBeenCalled();
    f.exempt.clear();
    f.member.mockImplementationOnce(async (id) => {
      f.exempt.add(id);
      return { id, roles: [subscriber, tier] };
    });
    await f.policy.reconcile('generation');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(['authority', 'context', 'source', 'generation'])(
    'stops when %s changes while Discord is awaited',
    async (kind) => {
      const f = fixture();
      f.enable();
      f.proof();
      f.member.mockImplementationOnce(async (id) => {
        if (kind === 'authority') f.changeAuthority();
        if (kind === 'context') f.changeContext();
        if (kind === 'source')
          f.store.saveSettings({
            ...f.store.settings(),
            new_subscriber_source: 'trusted_messages',
          });
        if (kind === 'generation') f.policy.configure(false, 'generation', []);
        return { id, roles: [subscriber, tier] };
      });
      await f.policy.reconcile('generation');
      expect(f.remove).not.toHaveBeenCalled();
    },
  );
  it('supplies a final guard for settings changes inside the adapter and never removes unrelated roles', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.remove.mockImplementationOnce(async (_id, _role, _allowed, guard) => {
      f.changeAuthority();
      guard();
    });
    await f.policy.reconcile('generation');
    expect(f.members.get(owner)).toEqual([subscriber, tier, unrelated]);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it('checks bot role hierarchy before reading members or attempting removals', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.roles.mockResolvedValueOnce({
      can_manage_roles: true,
      roles: [{ id: subscriber, name: 'Subscriber', manageable: false }],
    });
    await f.policy.reconcile('generation');
    expect(f.member).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.policy.status('generation').last_error).toBeTruthy();
  });
  it('reconciles a DELETE that succeeded before an error without repeating it or exposing upstream errors', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.remove.mockImplementationOnce(async (id, role, _allowed, guard) => {
      guard();
      f.members.set(
        id,
        f.members.get(id)!.filter((value) => value !== role),
      );
      throw new Error('private upstream token and customer details');
    });
    await f.policy.reconcile('generation');
    expect(f.policy.status('generation')).toMatchObject({ failed_members: 1, removed_roles: 0 });
    expect(JSON.stringify(f.policy.status('generation'))).not.toContain('private upstream');
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(1);
    f.advance(60_001);
    await f.policy.reconcile('generation');
    expect(f.remove.mock.calls.map((call) => call[1])).toEqual([subscriber, tier]);
    expect(f.policy.status('generation')).toMatchObject({ failed_members: 0, removed_roles: 2 });
  });
  it('persists uncertain writes encrypted and reconciles them using fresh billing and member state after restart', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.remove.mockImplementationOnce(async (id, role, _allowed, guard) => {
      guard();
      f.members.set(id, [tier, unrelated]);
      throw new Error('uncertain');
    });
    await f.policy.reconcile('generation');
    expect(readFileSync(join(f.directory, 'jellyport.db')).includes(Buffer.from(owner))).toBe(
      false,
    );
    const restarted = new StripeRoleCleanup(f.store, f.adapter, () => 'approved-v1', f.now);
    f.advance(60_001);
    restarted.recordProof(
      'generation',
      snapshot(),
      [{ customer_id: `cus_${owner}`, discord_user_id: owner }],
      prices,
      new Map([['sub_old', paid()]]),
    );
    await restarted.reconcile('generation');
    expect(f.remove.mock.calls.map((call) => call[1])).toEqual([subscriber, tier]);
    expect(restarted.status('generation').removed_roles).toBe(2);
    await restarted.stop();
  });
  it('bounds failures and reports repeatedly re-added roles without fighting MEE6', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    await f.policy.reconcile('generation');
    f.members.set(owner, [subscriber, unrelated]);
    await f.policy.reconcile('generation');
    expect(f.policy.status('generation')).toMatchObject({ readded_members: 1 });
    expect(f.policy.status('generation').reports[0]).toMatchObject({ status: 'readded' });
    f.proof();
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(2);
  });
  it('retries temporary role failures with bounded backoff and stops after three failures', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    f.remove.mockRejectedValue(new Error('private token'));
    await f.policy.reconcile('generation');
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(1);
    f.advance(60_000);
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(2);
    f.advance(5 * 60_000);
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(3);
    f.advance(60_000);
    f.proof();
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(3);
    expect(f.policy.status('generation')).toMatchObject({ failed_members: 1, removed_roles: 0 });
  });
  it('allows legitimate renewed paid access to begin a new role lifecycle', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    await f.policy.reconcile('generation');
    const active = { ...subscription(), status: 'active', ended_at: undefined };
    f.proof(
      snapshot([active]),
      undefined,
      new Map([['sub_old', { ...paid(), start: base - 1, end: base + 86_400 }]]),
    );
    f.members.set(owner, [subscriber, tier, unrelated]);
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(2);
    f.proof();
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(4);
    expect(f.policy.status('generation').readded_members).toBe(0);
  });
  it('bounds each pass and concurrent callers share the same serial work', async () => {
    const f = fixture();
    f.enable();
    const ids = Array.from({ length: 30 }, (_, index) => String(100001 + index));
    for (const id of ids) f.members.set(id, [subscriber, unrelated]);
    f.proof(
      snapshot(ids.map((id) => subscription(id, id))),
      ids.map((id) => ({ customer_id: `cus_${id}`, discord_user_id: id })),
      new Map(ids.map((id) => [`sub_${id}`, paid(id, id)])),
    );
    await Promise.all([f.policy.reconcile('generation'), f.policy.reconcile('generation')]);
    expect(f.remove).toHaveBeenCalledTimes(25);
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(30);
  });
  it('reports a member split across pass budgets as deferred until every selected role is verified absent', async () => {
    const f = fixture();
    const selected = Array.from({ length: 20 }, (_, index) => String(300010 + index));
    const other = '100002';
    f.roles.mockResolvedValue({
      can_manage_roles: true,
      roles: selected.map((id) => ({ id, name: 'Synthetic tier', manageable: true })),
    });
    f.policy.configure(true, 'generation', selected);
    f.members.set(owner, [...selected, unrelated]);
    f.members.set(other, [...selected, unrelated]);
    f.proof(
      snapshot([subscription('a'), subscription('b', other)]),
      [
        { customer_id: `cus_${owner}`, discord_user_id: owner },
        { customer_id: `cus_${other}`, discord_user_id: other },
      ],
      new Map([
        ['sub_a', paid('a')],
        ['sub_b', paid('b', other)],
      ]),
    );
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(25);
    expect(f.policy.status('generation').reports[0]).toMatchObject({
      discord_user_id: other,
      status: 'skipped',
      message: expect.stringMatching(/deferred/),
    });
    expect(f.members.get(other)).toHaveLength(16);
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(40);
    expect(f.members.get(other)).toEqual([unrelated]);
    expect(f.policy.status('generation')).toMatchObject({ readded_members: 0, removed_roles: 40 });
    expect(f.policy.status('generation').reports[0]).toMatchObject({
      discord_user_id: other,
      status: 'removed',
    });
  });
  it('stops promptly between writes and never resumes after shutdown', async () => {
    const f = fixture();
    f.enable();
    f.proof();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.remove.mockImplementationOnce(async () => {
      await pending;
    });
    const run = f.policy.reconcile('generation');
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledTimes(1));
    const stopped = f.policy.stop();
    release();
    await Promise.all([run, stopped]);
    await f.policy.reconcile('generation');
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
});
