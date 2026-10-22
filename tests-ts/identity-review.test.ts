import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { StripeIntegration } from '../server/stripe-integration.js';
import { StripeClientError, type StripeSnapshot } from '../server/stripe-client.js';
import { UserOrganization } from '../server/user-organization.js';
import { IdentityReview } from '../server/identity-review.js';
import { MediaOwnerships } from '../server/media-ownership.js';
import type {
  IdentityApproval,
  IdentityDiscordMember,
  IdentityReviewRow,
  IdentityRoster,
} from '../server/identity-review-types.js';

const guild = '123456789012345678';
const embyRole = '900001';
const jellyfinRole = '900002';
const restrictedKey = 'rk_test_syntheticIdentityReviewOnly123';
const resources: Array<{
  store: Store;
  service: Service;
  stripe: StripeIntegration;
  review: IdentityReview;
  directory: string;
}> = [];

class IdentityBot implements BotAdapter {
  members: IdentityDiscordMember[] = [];
  complete = true;
  rosterFailure = false;
  roleFailure = false;
  readonly listIdentityMembers = vi.fn(async (): Promise<IdentityRoster> => {
    if (this.rosterFailure) throw new Error('synthetic Discord failure');
    return {
      members: structuredClone(this.members),
      complete: this.complete,
      fetched_at: new Date().toISOString(),
    };
  });
  readonly listTagRoles = vi.fn(async () => ({
    can_manage_roles: true,
    roles: [
      { id: embyRole, name: 'Emby', manageable: true },
      { id: jellyfinRole, name: 'Jellyfin', manageable: true },
    ],
  }));
  readonly memberTagState = vi.fn(async (id: string) => {
    const member = this.members.find((value) => value.id === id);
    return member ? { id, username: member.username, roles: [...member.roles] } : null;
  });
  readonly updateTagRoles = vi.fn(async (id: string, add: string[], remove: string[]) => {
    if (this.roleFailure) throw new Error('synthetic Discord role error');
    const member = this.members.find((value) => value.id === id);
    if (!member) throw new Error('synthetic missing member');
    member.roles = [...new Set([...member.roles.filter((role) => !remove.includes(role)), ...add])];
  });
  readonly sendCredentials = vi.fn(async () => {});
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string) {
    const member = this.members.find((value) => value.id === id);
    if (!member) throw new Error('synthetic missing member');
    return { id, username: member.username };
  }
  async validateRecipient(id: string) {
    await this.recipientIdentity(id);
  }
  async membershipActive(id: string) {
    return this.members.some((value) => value.id === id);
  }
  async activeMembers() {
    return this.members.map(({ id, username }) => ({ id, username }));
  }
}

async function fixture(options: { count?: number; billing?: boolean; roles?: boolean } = {}) {
  const count = options.count ?? 2;
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-identity-review-'));
  const store = new Store(directory);
  store.saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    emby_url: 'http://emby.example.test',
    emby_api_key: 'synthetic-emby-key',
    jellyfin_url: 'http://jellyfin.example.test',
    jellyfin_api_key: 'synthetic-jellyfin-key',
    discord_guild_id: guild,
    discord_enabled: true,
    discord_message_events: true,
    discord_emby_role_id: options.roles === false ? '' : embyRole,
    discord_jellyfin_role_id: options.roles === false ? '' : jellyfinRole,
    discord_emby_only_role: false,
  });
  const pending = store.ensureAuthState();
  if (pending.kind !== 'pending') throw new Error('Expected isolated setup');
  store.completeAuth(
    pending.generation,
    {
      kind: 'configured',
      serverUrl: store.settings().jellyfin_url,
      serverId: 'demo-jellyfin',
      apiKeyName: 'fixture',
    },
    (settings) => settings,
  );
  const bot = new IdentityBot();
  bot.members = Array.from({ length: count }, (_, index) => ({
    id: String(100_000 + index),
    username: `member${index}`,
    roles: ['800001'],
  }));
  const servers = new DemoServers();
  servers.users.emby = bot.members.map((member, index) => ({
    Id: `e-${index}`,
    Name: member.username,
    Policy: { IsAdministrator: false, IsDisabled: false },
  }));
  servers.users.jellyfin = [];
  const calls: Array<{ kind: string; method: string }> = [];
  let failedMedia: 'emby' | 'jellyfin' | null = null;
  const service = new Service(store, {
    clientFactory: (...args) => {
      const client = servers.factory(...args),
        kind = args[2] ?? 'jellyfin';
      return new Proxy(client, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return async (...parameters: unknown[]) => {
            const method = String(property);
            calls.push({ kind, method });
            if (!['users', 'user', 'systemInfo', 'close'].includes(method))
              throw new Error(`Identity review must never use ${method}`);
            if (failedMedia === kind && method !== 'close')
              throw new Error('synthetic media failure');
            return Reflect.apply(value, target, parameters);
          };
        },
      });
    },
  });
  service.bot = bot;
  const data: StripeSnapshot = {
    mode: 'test',
    completed_at: new Date().toISOString(),
    products: [{ id: 'prod_Crew', name: 'Sloop Crewman', active: true }],
    subscriptions: bot.members.map((member, index) => ({
      id: `sub_${index}`,
      customer_id: `cus_${index}`,
      customer_name: member.username,
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
          current_period_end: 1_900_000_000,
        },
      ],
      identity_candidates: [
        { discord_user_id: member.id, source: 'customer_metadata', field: 'discord_id' },
      ],
    })),
  };
  let failStripe = false;
  const billingRead = vi.fn(async () => {
    if (failStripe) throw new StripeClientError('forbidden');
    return structuredClone(data);
  });
  const checkoutRead = vi.fn(async () => []);
  const stripe = new StripeIntegration(store, {
    clientFactory: () => ({
      mode: 'test',
      snapshot: billingRead,
      checkoutIdentityCandidates: checkoutRead,
    }),
    resolveDiscordMember: (id) => bot.recipientIdentity(id),
  });
  const organization = new UserOrganization(service);
  const review = new IdentityReview(service, stripe, organization);
  resources.push({ store, service, stripe, review, directory });
  if (options.billing !== false) {
    await stripe.configure({
      api_key: restrictedKey,
      sync_enabled: false,
      expected_revision: stripe.status().revision,
      price_tiers: [{ price_id: 'price_Crew', tier_id: 'sloop' }],
    });
    await stripe.sync();
  }
  return {
    directory,
    store,
    service,
    servers,
    bot,
    stripe,
    organization,
    review,
    data,
    calls,
    billingRead,
    checkoutRead,
    failStripe: () => {
      failStripe = true;
    },
    failMedia: (kind: 'emby' | 'jellyfin') => {
      failedMedia = kind;
    },
  };
}

function selection(
  row: IdentityReviewRow,
  patch: Partial<IdentityApproval> = {},
): IdentityApproval {
  if (!row.member) throw new Error('Expected current Discord member row');
  return {
    row_id: row.id,
    discord_user_id: row.member.id,
    stripe_customer_ids: row.customers.map((customer) => customer.id),
    accounts: [...row.confirmed_accounts, ...row.suggestions.map((item) => item.account)].map(
      (account) => ({ kind: account.kind, id: account.id, slot: account.slot ?? 1 }),
    ),
    ...patch,
  };
}
function memberRows(rows: IdentityReviewRow[]) {
  return rows.filter((row) => row.member);
}
function assertNoMediaMutation(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    f.calls.every((call) => ['users', 'user', 'systemInfo', 'close'].includes(call.method)),
  ).toBe(true);
  expect(f.store.jobs()).toEqual([]);
  expect(f.store.links()).toEqual([]);
  expect(f.store.membershipRecords()).toEqual([]);
  expect(f.bot.sendCredentials).not.toHaveBeenCalled();
}
afterEach(async () => {
  vi.useRealTimers();
  for (const f of resources.splice(0)) {
    f.review.close();
    await f.stripe.stop();
    await f.service.stop();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

describe('reviewed cross-service identity inventory', () => {
  it('lets the two existing Stripe identity links adopt Emby-only accounts and applies only the Emby role', async () => {
    const f = await fixture();
    for (const [index, member] of f.bot.members.entries())
      await f.stripe.linkCustomer({
        customer_id: `cus_${index}`,
        discord_user_id: member.id,
        expected_revision: f.stripe.status().revision,
      });
    const before = structuredClone(f.servers.users);
    const initial = await f.review.snapshot();
    const rows = memberRows(initial.rows);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.reliable && row.customers[0]?.linked_discord_id === row.member?.id),
    ).toBe(true);
    expect(
      rows.map((row) => row.suggestions.map((item) => [item.account.kind, item.account.name])),
    ).toEqual([[['emby', 'member0']], [['emby', 'member1']]]);
    const applied = await f.review.apply({
      revision: initial.revision,
      selections: rows.map((row) => selection(row)),
    });
    expect(applied).toMatchObject({
      approved: 2,
      roles: { status: 'updated', updated: 2, failed: 0 },
    });
    expect(
      f.bot.members.every(
        (member) => member.roles.includes(embyRole) && !member.roles.includes(jellyfinRole),
      ),
    ).toBe(true);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toHaveLength(2);
    const confirmed = await f.review.snapshot();
    expect(
      memberRows(confirmed.rows).every(
        (row) => row.confirmed_accounts.length === 1 && !row.suggestions.length,
      ),
    ).toBe(true);
    expect(f.servers.users).toEqual(before);
    assertNoMediaMutation(f);
  });

  it('builds and approves 227 suggestions with shared bounded account lists and no billing resync or media catalogs', async () => {
    const f = await fixture({ count: 227 });
    const [first, concurrent] = await Promise.all([
      f.review.snapshot(true),
      f.review.snapshot(true),
    ]);
    expect(first).toEqual(concurrent);
    expect(first.summary.suggestions).toBe(227);
    expect(f.bot.listIdentityMembers).toHaveBeenCalledOnce();
    expect(f.calls.filter((call) => call.method === 'users')).toHaveLength(2);
    await f.review.snapshot();
    expect(f.calls.filter((call) => call.method === 'users')).toHaveLength(2);
    const applied = await f.review.apply({
      revision: first.revision,
      selections: memberRows(first.rows).map((row) => selection(row)),
    });
    expect(applied.approved).toBe(227);
    expect(f.calls.filter((call) => call.method === 'users').length).toBeLessThanOrEqual(10);
    expect(applied.roles).toMatchObject({ status: 'updated', updated: 227, failed: 0 });
    expect(f.bot.listIdentityMembers).toHaveBeenCalledTimes(2);
    expect(f.billingRead).toHaveBeenCalledOnce();
    expect(f.service.mediaOwnerships.list(f.store.settings())).toHaveLength(227);
    expect(f.stripe.status().linked_customer_count).toBe(227);
    assertNoMediaMutation(f);
  });

  it('can confirm existing accounts on both servers without creating an account or granting media access', async () => {
    const f = await fixture({ count: 1 });
    f.servers.users.jellyfin.push({
      Id: 'j-existing',
      Name: 'member0',
      Policy: { IsAdministrator: false, IsDisabled: true },
    });
    const initial = await f.review.snapshot();
    const row = memberRows(initial.rows)[0]!;
    expect(row.suggestions).toHaveLength(2);
    const before = structuredClone(f.servers.users);
    const outcome = await f.review.apply({
      revision: initial.revision,
      selections: [selection(row)],
    });
    expect(outcome.roles.updated).toBe(1);
    expect(f.bot.members[0]!.roles).toEqual(expect.arrayContaining([embyRole, jellyfinRole]));
    expect(f.servers.users).toEqual(before);
    assertNoMediaMutation(f);
  });

  it.each(['revision', 'renamed_media', 'renamed_discord', 'new_owner'])(
    'rejects stale %s before any ownership, Stripe or role changes',
    async (change) => {
      const f = await fixture({ roles: false });
      const initial = await f.review.snapshot();
      const selections = memberRows(initial.rows).map((row) => selection(row));
      if (change === 'renamed_media') f.servers.users.emby[0]!.Name = 'renamed';
      if (change === 'renamed_discord') f.bot.members[0]!.username = 'renamed';
      if (change === 'new_owner')
        f.service.mediaOwnerships.save(
          [
            {
              kind: 'emby',
              server_id: 'demo-emby',
              account_id: 'e-0',
              username: 'member0',
              discord_user_id: '999999',
              slot: 1,
            },
          ],
          f.store.settings(),
        );
      const previous = f.service.mediaOwnerships.list(f.store.settings());
      const billingRevision = f.stripe.status().revision;
      await expect(
        f.review.apply({
          revision: change === 'revision' ? 'invalid-review' : initial.revision,
          selections,
        }),
      ).rejects.toThrow(/changed|expired/i);
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual(previous);
      expect(f.stripe.status()).toMatchObject({
        revision: billingRevision,
        linked_customer_count: 0,
      });
      expect(f.bot.updateTagRoles).not.toHaveBeenCalled();
      assertNoMediaMutation(f);
    },
  );

  it.each(['duplicate_account', 'duplicate_slot', 'conflicting_owner', 'invalid_slot'])(
    'rejects %s atomically before approving an earlier valid Stripe link',
    async (problem) => {
      const f = await fixture({ roles: false });
      if (problem === 'duplicate_slot')
        f.servers.users.emby.push({
          Id: 'e-extra',
          Name: 'member1_2',
          Policy: { IsAdministrator: false, IsDisabled: false },
        });
      if (problem === 'conflicting_owner')
        f.service.mediaOwnerships.save(
          [
            {
              kind: 'emby',
              server_id: 'demo-emby',
              account_id: 'e-1',
              username: 'member1',
              discord_user_id: '999999',
              slot: 1,
            },
          ],
          f.store.settings(),
        );
      const initial = await f.review.snapshot();
      const rows = memberRows(initial.rows);
      const selections = rows.map((row) => selection(row));
      if (problem === 'duplicate_account') selections[1]!.accounts = [...selections[0]!.accounts];
      if (problem === 'duplicate_slot')
        selections[1]!.accounts = selections[1]!.accounts.map((account) => ({
          ...account,
          slot: 1,
        }));
      if (problem === 'conflicting_owner')
        selections[1]!.accounts = [{ kind: 'emby', id: 'e-1', slot: 1 }];
      if (problem === 'invalid_slot') selections[1]!.accounts[0]!.slot = 4;
      const previous = f.service.mediaOwnerships.list(f.store.settings());
      const revision = f.stripe.status().revision;
      await expect(f.review.apply({ revision: initial.revision, selections })).rejects.toThrow(
        /conflict|slot|existing account|owner/i,
      );
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual(previous);
      expect(f.stripe.status()).toMatchObject({ revision, linked_customer_count: 0 });
      assertNoMediaMutation(f);
    },
  );

  it('rolls back media ownership and Stripe state together when an annotation fails validation', async () => {
    const f = await fixture({ roles: false });
    const initial = await f.review.snapshot();
    const rows = memberRows(initial.rows);
    const selections = rows.map((row) => selection(row));
    selections[1]!.exception = { kind: 'non_media', note: '' };
    const revision = f.stripe.status().revision;
    await expect(f.review.apply({ revision: initial.revision, selections })).rejects.toThrow(
      /note|exception/i,
    );
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
    expect(f.service.mediaOwnerships.exceptions(f.store.settings()).size).toBe(0);
    expect(f.stripe.status()).toMatchObject({ revision, linked_customer_count: 0 });
    expect(new StripeIntegration(f.store).status().linked_customer_count).toBe(0);
    assertNoMediaMutation(f);
  });

  it.each(['emby_owner', 'emby_slot', 'jellyfin_owner', 'jellyfin_slot'])(
    'fails closed on contradictory existing registry and legacy mapping records for %s',
    async (conflict) => {
      const f = await fixture({ roles: false });
      f.servers.users.jellyfin.push({
        Id: 'j-0',
        Name: 'member0',
        Policy: { IsAdministrator: false, IsDisabled: false },
      });
      // Simulate already persisted decisions made by separate older workflows.
      // The new review must surface the contradiction, never choose one silently.
      f.service.mappings.save(
        {
          source_user_id: 'e-0',
          source_username: 'member0',
          target_user_id: 'j-0',
          target_username: 'member0',
          discord_user_id: conflict.endsWith('owner') ? '100001' : '100000',
          discord_username: conflict.endsWith('owner') ? 'member1' : 'member0',
          membership_slot: conflict.endsWith('slot') ? 2 : 1,
        },
        f.store.settings(),
      );
      const kind = conflict.startsWith('emby') ? 'emby' : 'jellyfin';
      f.service.mediaOwnerships.save(
        [
          {
            kind,
            server_id: `demo-${kind}`,
            account_id: kind === 'emby' ? 'e-0' : 'j-0',
            username: 'member0',
            discord_user_id: '100000',
            slot: 1,
          },
        ],
        f.store.settings(),
      );
      const initial = await f.review.snapshot();
      const owner = initial.rows.find((row) => row.member?.id === '100000')!;
      expect(owner.gaps).toContain('identity_conflict');
      expect(owner.reliable).toBe(false);
      const previous = f.service.mediaOwnerships.list(f.store.settings());
      await expect(
        f.review.apply({
          revision: initial.revision,
          selections: [
            selection(owner, {
              accounts: [{ kind, id: kind === 'emby' ? 'e-0' : 'j-0', slot: 1 }],
            }),
          ],
        }),
      ).rejects.toThrow(/conflict/i);
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual(previous);
      expect(f.stripe.status().linked_customer_count).toBe(0);
      assertNoMediaMutation(f);
    },
  );

  it('can acknowledge non-media Discord access without configuring Stripe or requiring a media account', async () => {
    const f = await fixture({ count: 1, billing: false, roles: false });
    f.servers.users.emby = [];
    const snapshot = await f.review.snapshot();
    const member = memberRows(snapshot.rows)[0]!;
    await f.review.apply({
      revision: snapshot.revision,
      selections: [
        selection(member, {
          accounts: [],
          stripe_customer_ids: [],
          exception: { kind: 'non_media', note: 'Synthetic community-only approval' },
        }),
      ],
    });
    expect(f.service.mediaOwnerships.exceptions(f.store.settings()).get(member.id)).toMatchObject({
      kind: 'non_media',
    });
    expect(f.stripe.status()).toMatchObject({ configured: false, linked_customer_count: 0 });
    assertNoMediaMutation(f);
  });

  it('rejects an oversized bulk selection without launching another directory read', async () => {
    const f = await fixture({ count: 1, roles: false });
    const initial = await f.review.snapshot();
    const row = memberRows(initial.rows)[0]!;
    await expect(
      f.review.apply({
        revision: initial.revision,
        selections: Array.from({ length: 251 }, () => selection(row)),
      }),
    ).rejects.toThrow('1 and 250');
    expect(f.bot.listIdentityMembers).toHaveBeenCalledOnce();
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
    expect(f.stripe.status().linked_customer_count).toBe(0);
    assertNoMediaMutation(f);
  });

  it('fails closed when administrator authority is lost after refreshing review inputs', async () => {
    const f = await fixture({ count: 1, roles: false });
    const initial = await f.review.snapshot();
    await expect(
      f.review.apply(
        { revision: initial.revision, selections: [selection(memberRows(initial.rows)[0]!)] },
        () => {
          throw new Error('Administrator access revoked');
        },
      ),
    ).rejects.toThrow('revoked');
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.bot.updateTagRoles).not.toHaveBeenCalled();
    assertNoMediaMutation(f);
  });

  it('requires fresh approval after a review expires without adopting any old selection', async () => {
    const f = await fixture({ count: 1, roles: false });
    const initial = await f.review.snapshot();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await expect(
      f.review.apply({
        revision: initial.revision,
        selections: [selection(memberRows(initial.rows)[0]!)],
      }),
    ).rejects.toThrow(/expired|changed/);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
    expect(f.stripe.status().linked_customer_count).toBe(0);
    assertNoMediaMutation(f);
  });

  it('flags colliding normalized Discord usernames instead of offering bulk approval', async () => {
    const f = await fixture({ count: 1, roles: false });
    f.bot.members.push({ id: '200001', username: 'Member0', roles: [] });
    const initial = await f.review.snapshot();
    const rows = memberRows(initial.rows);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.reliable === false && row.gaps.includes('identity_conflict')),
    ).toBe(true);
    await expect(
      f.review.apply({
        revision: initial.revision,
        selections: [selection(rows[0]!, { accounts: [{ kind: 'emby', id: 'e-0', slot: 1 }] })],
      }),
    ).rejects.toThrow(/conflict/i);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
    expect(f.stripe.status().linked_customer_count).toBe(0);
    assertNoMediaMutation(f);
  });

  it('returns independent cached review copies without exposing configuration secrets or triggering actions', async () => {
    const f = await fixture({ count: 1, roles: false });
    const initial = await f.review.snapshot();
    initial.rows[0]!.gaps.length = 0;
    initial.accounts[0]!.name = 'tampered client copy';
    const cached = await f.review.snapshot();
    expect(cached.accounts[0]!.name).toBe('member0');
    expect(cached.rows[0]!.gaps.length).toBeGreaterThan(0);
    for (const secret of [restrictedKey, 'synthetic-emby-key', 'synthetic-jellyfin-key'])
      expect(JSON.stringify(cached)).not.toContain(secret);
    expect(f.bot.listIdentityMembers).toHaveBeenCalledOnce();
    expect(f.bot.updateTagRoles).not.toHaveBeenCalled();
    assertNoMediaMutation(f);
  });

  it('shows social-only Discord members even without a media account or subscription', async () => {
    const f = await fixture({ count: 1, roles: false });
    f.bot.members.push({
      id: '200001',
      username: 'social_only',
      nickname: 'Community friend',
      roles: ['700001'],
    });
    const snapshot = await f.review.snapshot();
    const social = snapshot.rows.find((row) => row.member?.id === '200001')!;
    expect(social.member?.nickname).toBe('Community friend');
    expect(social.gaps).toEqual(
      expect.arrayContaining(['discord_without_media', 'discord_without_active_subscription']),
    );
    expect(social.customers).toEqual([]);
    expect(social.confirmed_accounts).toEqual([]);
    assertNoMediaMutation(f);
  });

  it.each(['not_configured', 'failed_sync'])(
    'treats %s billing as unknown instead of asserting unpaid or missing paid access',
    async (state) => {
      const f = await fixture({ billing: state !== 'not_configured', roles: false });
      if (state === 'failed_sync') {
        f.failStripe();
        await expect(f.stripe.sync()).rejects.toThrow();
      }
      const snapshot = await f.review.snapshot();
      expect(snapshot.sources.stripe.complete).toBe(false);
      for (const row of memberRows(snapshot.rows)) {
        expect(row.gaps).toContain('billing_unknown');
        expect(row.gaps).not.toContain('discord_without_active_subscription');
        expect(row.gaps).not.toContain('media_without_active_subscription');
        expect(row.gaps).not.toContain('active_subscription_no_media');
      }
      assertNoMediaMutation(f);
    },
  );

  it.each(['discord_incomplete', 'discord_failure', 'emby_failure', 'jellyfin_failure'])(
    'does not infer absent access from %s or adopt incomplete identity suggestions',
    async (state) => {
      const f = await fixture({ roles: false });
      if (state === 'discord_incomplete') f.bot.complete = false;
      if (state === 'discord_failure') f.bot.rosterFailure = true;
      if (state === 'emby_failure') f.failMedia('emby');
      if (state === 'jellyfin_failure') f.failMedia('jellyfin');
      const snapshot = await f.review.snapshot();
      if (state.startsWith('discord')) {
        expect(snapshot.sources.discord.complete).toBe(false);
        expect(
          snapshot.rows.every((row) => !row.gaps.includes('active_subscription_no_discord')),
        ).toBe(true);
        const customer = snapshot.rows.find((row) => row.customers.length)!;
        await expect(
          f.review.apply({
            revision: snapshot.revision,
            selections: [
              {
                row_id: customer.id,
                discord_user_id: f.bot.members[0]!.id,
                accounts: [],
                stripe_customer_ids: [customer.customers[0]!.id],
              },
            ],
          }),
        ).rejects.toThrow(/full Discord|current human/i);
      } else {
        expect(snapshot.sources[state === 'emby_failure' ? 'emby' : 'jellyfin'].complete).toBe(
          false,
        );
        expect(
          snapshot.rows.every(
            (row) =>
              !row.gaps.includes('active_subscription_no_media') &&
              !row.gaps.includes('discord_without_media'),
          ),
        ).toBe(true);
      }
      expect(f.stripe.status().linked_customer_count).toBe(0);
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
      assertNoMediaMutation(f);
    },
  );

  it('persists a private non-media annotation encrypted across restart and keeps it within the approved server scope', async () => {
    const f = await fixture({ count: 1, roles: false });
    f.bot.members.push({ id: '200001', username: 'social_only', roles: [] });
    const snapshot = await f.review.snapshot();
    const social = snapshot.rows.find((row) => row.member?.id === '200001')!;
    const note = 'Synthetic friend approved only for the tabletop channel';
    await f.review.apply({
      revision: snapshot.revision,
      selections: [
        selection(social, {
          accounts: [],
          stripe_customer_ids: [],
          exception: { kind: 'non_media', note },
        }),
      ],
    });
    expect(f.service.mediaOwnerships.exceptions(f.store.settings()).get(social.id)).toMatchObject({
      kind: 'non_media',
      note,
    });
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const disk = readFileSync(join(f.directory, 'jellyport.db')).toString('utf8');
    for (const privateField of [note, restrictedKey, 'cus_0', 'member0@example.test'])
      expect(disk).not.toContain(privateField);
    const reopened = new Store(f.directory);
    try {
      const registry = new MediaOwnerships(reopened);
      expect(registry.exceptions(reopened.settings()).get(social.id)).toMatchObject({
        kind: 'non_media',
        note,
      });
      expect(
        registry.exceptions({ ...reopened.settings(), discord_guild_id: '987654321012345678' })
          .size,
      ).toBe(0);
      expect(
        registry.exceptions({
          ...reopened.settings(),
          emby_url: 'http://another-emby.example.test',
        }).size,
      ).toBe(0);
    } finally {
      reopened.close();
    }
    assertNoMediaMutation(f);
  });

  it('preserves confirmed ownership when Discord role delivery fails, exposes retry work, and updates roles on reapproval', async () => {
    const f = await fixture({ count: 1 });
    f.bot.roleFailure = true;
    const snapshot = await f.review.snapshot();
    const result = await f.review.apply({
      revision: snapshot.revision,
      selections: [selection(memberRows(snapshot.rows)[0]!)],
    });
    expect(['failed', 'pending']).toContain(result.roles.status);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toHaveLength(1);
    expect(f.stripe.status().linked_customer_count).toBe(1);
    expect(f.bot.members[0]!.roles).not.toContain(embyRole);
    f.bot.roleFailure = false;
    const retry = await f.review.snapshot();
    const completed = await f.review.apply({
      revision: retry.revision,
      selections: [selection(memberRows(retry.rows)[0]!)],
    });
    expect(completed.roles).toMatchObject({ status: 'updated', updated: 1, failed: 0 });
    expect(f.bot.members[0]!.roles).toContain(embyRole);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toHaveLength(1);
    assertNoMediaMutation(f);
  });
});
