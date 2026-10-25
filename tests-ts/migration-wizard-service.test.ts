import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { Service, type ReviewedMigrationTarget } from '../server/service.js';
import { StripeIntegration, type StripeMigrationDraft } from '../server/stripe-integration.js';
import type { StripePaidPeriod, StripeSnapshot } from '../server/stripe-client.js';

const owner = '123456789012345678';
const sources = ['source-a', 'source-b'];
const draft: StripeMigrationDraft = {
  customer_ids: ['cus_crew'],
  price_tiers: [{ price_id: 'price_crew', tier_id: 'brigantine' }],
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-migration-wizard-'));
  let store = new Store(directory);
  const servers = new DemoServers();
  servers.users.emby = sources.map((Id, index) => ({
    Id,
    Name: ['LegacyOne', 'LegacyTwo'][index]!,
    Policy: { IsAdministrator: false, IsDisabled: false },
  }));
  servers.users.jellyfin = [
    servers.users.jellyfin.find((user) => user.Id === 'template')!,
    {
      Id: 'target-a',
      Name: 'PersonalAlias',
      Policy: { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true },
      Configuration: { DisplayMissingEpisodes: true },
    },
  ];
  servers.media = [1, 2].map((number) => ({
    Id: String(number),
    Name: `Synthetic movie ${number}`,
    Type: 'Movie',
    ProviderIds: { Tmdb: `synthetic-${number}` },
  }));
  servers.played = {
    'source-a': new Set(['1']),
    'source-b': new Set(['2']),
    'target-a': new Set(['2']),
  };
  store.saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    emby_url: 'http://emby.example.test',
    emby_api_key: 'synthetic-emby',
    jellyfin_url: 'http://jellyfin.example.test',
    jellyfin_api_key: 'synthetic-jellyfin',
    template_user_id: 'template',
    discord_enabled: true,
    discord_guild_id: '223456789012345678',
    new_subscriber_source: 'stripe',
  });
  const pending = store.ensureAuthState();
  if (pending.kind !== 'pending') throw new Error('Expected synthetic setup');
  store.completeAuth(
    pending.generation,
    {
      kind: 'configured',
      serverId: 'demo-jellyfin',
      serverUrl: store.settings().jellyfin_url,
      apiKeyName: 'synthetic',
    },
    (settings) => settings,
  );
  let service = new Service(store, { clientFactory: servers.factory });
  const bot = {
    status: () => ({ connected: true }),
    recipientIdentity: vi.fn(async (id: string) => ({ id, username: 'crew_owner' })),
    validateRecipient: vi.fn(async () => {}),
    sendCredentials: vi.fn(async () => {}),
    membershipActive: async () => true,
    activeMembers: async () => [],
  };
  service.bot = bot;
  const base = Math.floor(Date.now() / 1000);
  const data: StripeSnapshot = {
    mode: 'live',
    completed_at: new Date().toISOString(),
    products: [],
    subscriptions: [
      {
        id: 'sub_crew',
        customer_id: 'cus_crew',
        customer_name: 'Synthetic Crew',
        customer_email: 'crew@example.test',
        created: base - 1000,
        status: 'active',
        collection_method: 'charge_automatically',
        pause_collection: false,
        cancel_at_period_end: false,
        identity_candidates: [],
        items: [{ id: 'si_crew', price_id: 'price_crew', product_id: 'prod_crew', quantity: 1 }],
      },
    ],
  };
  const period: StripePaidPeriod = {
    invoice_id: 'in_crew',
    subscription_id: 'sub_crew',
    customer_id: 'cus_crew',
    created: base - 1000,
    paid_at: base - 100,
    price_id: 'price_crew',
    start: base - 100,
    end: base + 3600,
  };
  const stripe = new StripeIntegration(store, {
    clientFactory: () => ({
      mode: 'live',
      snapshot: async () => structuredClone(data),
      checkoutIdentityCandidates: async () => [],
      customerSubscriptions: async (id) =>
        structuredClone(data.subscriptions.filter((row) => row.customer_id === id)),
      paidPeriod: async () => structuredClone(period),
    }),
    resolveDiscordMember: async (id) => ({ id, username: 'crew_owner' }),
  });
  await stripe.configure({
    api_key: 'rk_live_syntheticWizardOnly',
    sync_enabled: false,
    expected_revision: stripe.status().revision,
  });
  await stripe.sync();
  service.reviewStripeMigrationMembership = (id, signal, changes) =>
    stripe.reviewMembership(id, signal, changes);
  service.verifyStripeMigrationMembership = (proof) => stripe.assertMigrationMembership(proof);
  service.stageStripeMigrationMemberships = (proofs, names) =>
    stripe.prepareMigrationCommit(proofs, names);
  cleanup.push(async () => {
    await service.stop();
    await stripe.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = () =>
    service.reviewMigrationTarget({
      source_user_id: 'source-a',
      source_username: 'LegacyOne',
      source_server_id: 'demo-emby',
      target_user_id: 'target-a',
    });
  async function prepare(targets?: Record<string, ReviewedMigrationTarget>, selected = sources) {
    const preview = await service.preview(selected);
    const membership = await service.reviewMigrationMembership(owner, undefined, draft);
    return {
      membership,
      accept: (guard?: () => void) =>
        service.migrateUsers(
          selected,
          Object.fromEntries(selected.map((id) => [id, owner])),
          Object.fromEntries(
            preview.users.map((row) => [row.source_user_id, row.mapping_revision ?? null]),
          ),
          'watched_only',
          undefined,
          undefined,
          undefined,
          undefined,
          Object.fromEntries(
            selected.map((id, index) => [
              id,
              {
                ...preview.owner_assignment_sources![id]!,
                discord_user_id: owner,
                slot: index + 1,
              },
            ]),
          ),
          guard,
          { [owner]: membership },
          targets,
        ),
    };
  }
  return {
    get service() {
      return service;
    },
    get store() {
      return store;
    },
    servers,
    stripe,
    bot,
    data,
    target,
    prepare,
    async restart() {
      await service.stop();
      await stripe.stop();
      store.close();
      store = new Store(directory);
      service = new Service(store, { clientFactory: servers.factory });
      service.bot = bot;
      await service.start();
    },
  };
}

async function complimentaryReview(f: Awaited<ReturnType<typeof fixture>>, accountLimit = 3) {
  const selected = [...sources, 'source-c'];
  f.servers.users.emby.push({
    Id: 'source-c',
    Name: 'LegacyThree',
    Policy: { IsAdministrator: false, IsDisabled: false },
  });
  f.servers.played['source-c'] = new Set(['1', '2']);
  const preview = await f.service.preview(selected);
  const review = await f.service.reviewMigrationMembership(owner, undefined, undefined, {
    account_limit: accountLimit,
  });
  return {
    review,
    accept: (guard?: () => void) =>
      f.service.migrateUsers(
        selected,
        Object.fromEntries(selected.map((id) => [id, owner])),
        Object.fromEntries(selected.map((id) => [id, null])),
        'watched_only',
        undefined,
        undefined,
        undefined,
        undefined,
        Object.fromEntries(
          selected.map((id, index) => [
            id,
            { ...preview.owner_assignment_sources![id]!, discord_user_id: owner, slot: index + 1 },
          ]),
        ),
        guard,
        { [owner]: review },
      ),
  };
}

describe('one-acceptance migration wizard', () => {
  it('reviews and migrates three custom accounts for a roleless complimentary owner without Stripe or automatic Family flags', async () => {
    const f = await fixture();
    f.store.saveSettings({
      ...f.store.settings(),
      new_subscriber_source: 'trusted_messages',
      discord_member_role_id: '423456789012345678',
    });
    const billing = vi.fn(async () => {
      throw new Error('Complimentary review must not contact Stripe');
    });
    f.service.reviewStripeMigrationMembership = billing;
    const recipient = vi.fn(async (id: string, required = true) => {
      if (required) throw new Error('Synthetic member has no subscriber role');
      return { id, username: 'crew_owner' };
    });
    const validate = vi.fn(async (_id: string, required = true) => {
      if (required) throw new Error('Synthetic member has no subscriber role');
    });
    f.service.bot = { ...f.bot, recipientIdentity: recipient, validateRecipient: validate };
    const changes = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    const { review, accept } = await complimentaryReview(f);
    expect(review.summary).toMatchObject({
      status: 'complimentary',
      tier_id: 'complimentary',
      account_limit: 3,
      allowed_slots: [1, 2, 3],
    });
    expect(review.summary.message).toMatch(/Starting migration assigns/);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.jobs()).toEqual([]);
    expect(f.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    const job = await accept();
    await f.service.jobTasks.get(job.id);
    expect(f.service.getJob(job.id).results.map((row) => row.error)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(f.service.getJob(job.id).status).toBe('completed');
    expect(f.service.memberships.get(owner, f.store.settings())).toMatchObject({
      access_mode: 'complimentary',
      account_limit: 3,
      tier_id: 'complimentary',
      active: true,
      provision_jellyfin: false,
    });
    expect(f.store.linksForMember(owner).map((link) => link.username)).toEqual([
      'LegacyOne',
      'LegacyTwo',
      'LegacyThree',
    ]);
    expect(recipient.mock.calls.every(([, required]) => required === false)).toBe(true);
    expect(validate).toHaveBeenCalledTimes(3);
    expect(validate.mock.calls.every(([, required]) => required === false)).toBe(true);
    expect(billing).not.toHaveBeenCalled();
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.bot.sendCredentials).toHaveBeenCalledTimes(3);
    for (const target of f.servers.users.jellyfin)
      expect(f.service.profiles.get('jellyfin', target.Id, f.store.settings())?.family).not.toBe(
        true,
      );
  });

  it.each([0, 4, 1.5, Number.NaN])(
    'rejects an invalid complimentary allowance %s without applying changes',
    async (account_limit) => {
      const f = await fixture();
      await expect(
        f.service.reviewMigrationMembership(owner, undefined, undefined, { account_limit }),
      ).rejects.toThrow('between 1 and 3');
      expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
      expect(f.store.jobs()).toEqual([]);
    },
  );

  it.each(['inactive', 'held', 'complimentary', 'paid'] as const)(
    'does not replace an existing %s policy through a complimentary draft',
    async (policy) => {
      const f = await fixture();
      const member = f.service.memberships.save(
        {
          discord_user_id: owner,
          base_username: 'crew_owner',
          tier_id: policy === 'complimentary' ? 'complimentary' : 'brigantine',
          access_mode: policy === 'complimentary' ? 'complimentary' : 'subscription',
          account_limit: 2,
          active: policy !== 'inactive',
          ...(policy === 'held' ? { new_subscriber_pending: true as const } : {}),
        },
        f.store.settings(),
      );
      await expect(
        f.service.reviewMigrationMembership(owner, undefined, undefined, { account_limit: 3 }),
      ).rejects.toThrow('cannot be replaced');
      expect(f.service.memberships.get(owner, f.store.settings())).toEqual(member);
      expect(f.store.jobs()).toEqual([]);
    },
  );

  it('rejects combining complimentary and Stripe billing drafts', async () => {
    const f = await fixture();
    await expect(
      f.service.reviewMigrationMembership(owner, undefined, draft, { account_limit: 3 }),
    ).rejects.toThrow('not both');
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.store.jobs()).toEqual([]);
  });

  it.each(['cancel', 'persist'] as const)(
    'keeps complimentary membership and ownership unchanged on %s failure',
    async (failure) => {
      const f = await fixture();
      const { accept } = await complimentaryReview(f);
      if (failure === 'persist')
        vi.spyOn(f.store, 'saveJob').mockImplementationOnce(() => {
          throw new Error('Synthetic complimentary persistence failure');
        });
      await expect(
        accept(
          failure === 'cancel'
            ? () => {
                throw new Error('Synthetic complimentary review canceled');
              }
            : undefined,
        ),
      ).rejects.toThrow('Synthetic complimentary');
      expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
      expect(f.store.jobs()).toEqual([]);
      expect(f.bot.sendCredentials).not.toHaveBeenCalled();
    },
  );
  it('keeps customer, price, membership and account mapping drafts read-only until acceptance', async () => {
    const f = await fixture();
    const changes = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    const proof = await f.target();
    const { membership } = await f.prepare({ 'source-a': proof });
    expect(membership.summary.billing_changes).toMatchObject({
      customer_links: [{ customer_id: 'cus_crew' }],
      price_mappings: [{ price_id: 'price_crew', tier_id: 'brigantine' }],
    });
    expect(membership.summary.allowed_slots).toEqual([1, 2]);
    expect(membership.summary.existing_member).toBeNull();
    expect(membership.summary.occupied_slots).toEqual([]);
    expect(f.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    expect(f.stripe.status()).toMatchObject({ linked_customer_count: 0, price_tiers: [] });
    expect(f.service.memberships.list(f.store.settings())).toEqual([]);
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    expect(f.bot.sendCredentials).not.toHaveBeenCalled();
  });

  it('commits reviewed billing, allowance and target mapping together, preserving the existing account and its newer plays', async () => {
    const f = await fixture();
    const original = structuredClone(
      f.servers.users.jellyfin.find((row) => row.Id === 'target-a')!,
    );
    const { accept } = await f.prepare({ 'source-a': await f.target() });
    const job = await accept();
    expect(f.stripe.status()).toMatchObject({
      linked_customer_count: 1,
      price_tiers: draft.price_tiers,
      automation_enabled: false,
      sync_enabled: false,
    });
    await f.service.jobTasks.get(job.id);
    expect(f.service.getJob(job.id).results.map((row) => row.error)).toEqual([
      undefined,
      undefined,
    ]);
    expect(f.service.getJob(job.id).status).toBe('completed');
    expect(f.service.mappings.getForSource('source-a', f.store.settings())).toMatchObject({
      source_username: 'LegacyOne',
      target_user_id: 'target-a',
      target_username: 'PersonalAlias',
      discord_user_id: owner,
    });
    expect(f.servers.users.jellyfin.find((row) => row.Id === 'target-a')).toEqual(original);
    expect([...f.servers.played['target-a']!].sort()).toEqual(['1', '2']);
    expect(f.bot.sendCredentials).toHaveBeenCalledTimes(1);
    expect(f.store.link(owner, 1)?.remote_id).toBe('target-a');
    expect(f.service.memberships.get(owner, f.store.settings())).toMatchObject({
      account_limit: 2,
      provision_jellyfin: false,
    });
  });

  it('rolls back the Stripe row, in-memory authority, membership, new mapping, approvals and queue on persistence failure', async () => {
    const f = await fixture();
    const before = f.stripe.status();
    const { accept } = await f.prepare({ 'source-a': await f.target() });
    vi.spyOn(f.store, 'saveJob').mockImplementationOnce(() => {
      expect(f.service.memberships.get(owner, f.store.settings())?.account_limit).toBe(2);
      expect(f.service.mappings.getForSource('source-a', f.store.settings())?.target_user_id).toBe(
        'target-a',
      );
      expect(f.stripe.status().revision).toBe(before.revision);
      throw new Error('Synthetic queue persistence failure');
    });
    await expect(accept()).rejects.toThrow('Synthetic queue persistence failure');
    expect(f.stripe.status()).toMatchObject({
      revision: before.revision,
      linked_customer_count: 0,
      price_tiers: [],
    });
    const row = f.store.db
      .prepare('SELECT encrypted FROM stripe_integration_state WHERE id=1')
      .get()!;
    expect(
      f.store.decrypt<{ revision: string; links: unknown[]; price_tiers: unknown[] }>(
        row.encrypted as Uint8Array,
      ),
    ).toMatchObject({ revision: before.revision, links: [], price_tiers: [] });
    expect(f.service.memberships.list(f.store.settings())).toEqual([]);
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    expect(f.bot.sendCredentials).not.toHaveBeenCalled();
  });

  it.each(['complimentary', 'inactive', 'held', 'trusted'] as const)(
    'rejects a nonempty billing draft for preserved %s membership',
    async (mode) => {
      const f = await fixture();
      if (mode === 'trusted')
        f.store.saveSettings({ ...f.store.settings(), new_subscriber_source: 'trusted_messages' });
      const member = f.service.memberships.save(
        {
          discord_user_id: owner,
          base_username: 'crew_owner',
          tier_id: mode === 'complimentary' ? 'complimentary' : 'brigantine',
          account_limit: 2,
          access_mode: mode === 'complimentary' ? 'complimentary' : 'subscription',
          active: mode !== 'inactive',
          ...(mode === 'held' ? { new_subscriber_pending: true as const } : {}),
        },
        f.store.settings(),
      );
      await expect(f.service.reviewMigrationMembership(owner, undefined, draft)).rejects.toThrow(
        'preserved access policy',
      );
      expect(f.service.memberships.get(owner, f.store.settings())).toEqual(member);
      expect(f.stripe.status().linked_customer_count).toBe(0);
      expect(f.store.jobs()).toEqual([]);
    },
  );

  it('does not silently discard a billing draft when paid access cannot be verified', async () => {
    const f = await fixture();
    f.data.subscriptions[0]!.status = 'canceled';
    const { membership, accept } = await f.prepare();
    expect(membership.summary.allowed_slots).toEqual([]);
    await expect(accept()).rejects.toThrow('reviewed membership does not cover');
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.service.memberships.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
  });

  it('reports occupied approved slots without changing Family flags or existing member policy', async () => {
    const f = await fixture();
    const member = f.service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'crew_owner',
        tier_id: 'complimentary',
        account_limit: 2,
        access_mode: 'complimentary',
        active: true,
        provision_jellyfin: false,
      },
      f.store.settings(),
    );
    f.service.mediaOwnerships.save(
      [
        {
          kind: 'emby',
          server_id: 'demo-emby',
          account_id: 'source-a',
          username: 'LegacyOne',
          discord_user_id: owner,
          slot: 1,
        },
        {
          kind: 'jellyfin',
          server_id: 'demo-jellyfin',
          account_id: 'target-a',
          username: 'PersonalAlias',
          discord_user_id: owner,
          slot: 1,
        },
      ],
      f.store.settings(),
    );
    f.store.saveLink(owner, 'PersonalAlias', 'target-a', false, 1);
    const profile = f.service.profiles.save(
      {
        kind: 'jellyfin',
        user_id: 'target-a',
        family: true,
        owner_name: 'Synthetic family',
        notes: 'Keep this account manually managed',
      },
      f.store.settings(),
    );
    const reviewed = await f.service.reviewMigrationMembership(owner);
    expect(reviewed.summary.occupied_slots).toEqual([
      { slot: 1, emby_user_id: 'source-a', jellyfin_user_id: 'target-a' },
    ]);
    expect(reviewed.summary.existing_member).toMatchObject({
      access_mode: 'complimentary',
      active: true,
      held: false,
      account_limit: 2,
    });
    expect(f.service.memberships.get(owner, f.store.settings())).toEqual(member);
    expect(f.service.profiles.get('jellyfin', 'target-a', f.store.settings())).toEqual(profile);
  });

  it.each(['administrator', 'disabled', 'renamed'] as const)(
    'rejects a %s target changed after review without committing a mapping',
    async (change) => {
      const f = await fixture();
      const { accept } = await f.prepare({ 'source-a': await f.target() });
      const target = f.servers.users.jellyfin.find((row) => row.Id === 'target-a')!;
      if (change === 'administrator') target.Policy!.IsAdministrator = true;
      else if (change === 'disabled') target.Policy!.IsDisabled = true;
      else target.Name = 'ChangedAlias';
      await expect(accept()).rejects.toThrow();
      expect(f.stripe.status().linked_customer_count).toBe(0);
      expect(f.service.memberships.list(f.store.settings())).toEqual([]);
      expect(f.service.mappings.list(f.store.settings())).toEqual([]);
      expect(f.store.jobs()).toEqual([]);
    },
  );

  it('retains reviewed target mapping IDs and played-status protection after a queued-work restart', async () => {
    const f = await fixture();
    const preview = await f.service.preview(['source-a']);
    const proof = await f.target();
    const schedule = vi
      .spyOn(f.service as unknown as { schedule: (...args: unknown[]) => void }, 'schedule')
      .mockImplementation(() => {});
    const job = await f.service.migrateUsers(
      ['source-a'],
      {},
      { 'source-a': null },
      'watched_only',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { 'source-a': proof },
    );
    expect(preview.users[0]?.target_exists).toBe(false);
    const queued = f.store.queuedJobs()[0]!;
    const mapping = f.service.mappings.getForSource('source-a', f.store.settings())!;
    expect(queued.requests[0]).toMatchObject({
      mapping_id: mapping.id,
      mapping_revision: mapping.revision,
      username: 'PersonalAlias',
    });
    schedule.mockRestore();
    await f.restart();
    await f.service.jobTasks.get(job.id);
    expect(f.service.getJob(job.id).status).toBe('completed');
    expect(f.service.mappings.getForSource('source-a', f.store.settings())?.id).toBe(mapping.id);
    expect([...f.servers.played['target-a']!].sort()).toEqual(['1', '2']);
    expect(f.bot.sendCredentials).not.toHaveBeenCalled();
  });

  it('offers a read-only source proof and accepts a local account mapping without Discord or billing', async () => {
    const f = await fixture();
    f.store.saveSettings({ ...f.store.settings(), discord_enabled: false });
    f.service.bot = null;
    const preview = await f.service.preview(['source-a']);
    expect(preview.owner_assignment_sources?.['source-a']).toEqual({
      source_username: 'LegacyOne',
      server_id: 'demo-emby',
    });
    const job = await f.service.migrateUsers(
      ['source-a'],
      {},
      { 'source-a': null },
      'watched_only',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { 'source-a': await f.target() },
    );
    await f.service.jobTasks.get(job.id);
    expect(f.service.getJob(job.id).status).toBe('completed');
    expect(f.service.mappings.getForSource('source-a', f.store.settings())).toMatchObject({
      target_user_id: 'target-a',
      discord_user_id: null,
    });
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.store.links()).toEqual([]);
  });

  it('rejects stale target ownership before persisting any billing or migration change', async () => {
    const f = await fixture();
    const { accept } = await f.prepare({ 'source-a': await f.target() });
    f.store.saveLink('323456789012345678', 'PersonalAlias', 'target-a', false, 1);
    await expect(accept()).rejects.toThrow('reviewed account mapping changed');
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.service.memberships.list(f.store.settings())).toEqual([]);
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
  });

  it('stops target revalidation immediately after an awaited read when the migration review is canceled', async () => {
    const f = await fixture();
    const { accept } = await f.prepare({ 'source-a': await f.target() });
    const changes = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    const calls: string[] = [];
    let reached!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = f.service.clientFactory;
    f.service.clientFactory = (...args) => {
      const client = factory(...args);
      const kind = args[2];
      const info = client.systemInfo.bind(client);
      client.systemInfo = async () => {
        calls.push(`${kind}:info`);
        if (kind === 'emby') {
          reached();
          await paused;
        }
        return info();
      };
      const user = client.user.bind(client);
      client.user = async (id) => {
        calls.push(`${kind}:user`);
        return user(id);
      };
      const users = client.users.bind(client);
      client.users = async () => {
        calls.push(`${kind}:users`);
        return users();
      };
      return client;
    };
    let authorized = true;
    const admission = accept(() => {
      if (!authorized) throw new Error('Synthetic review canceled');
    });
    await reading;
    authorized = false;
    release();
    await expect(admission).rejects.toThrow('Synthetic review canceled');
    expect(calls).toEqual(['emby:info']);
    expect(f.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    expect(f.service.mappings.list(f.store.settings())).toEqual([]);
    expect(f.service.memberships.list(f.store.settings())).toEqual([]);
    expect(f.store.jobs()).toEqual([]);
    expect(f.stripe.status().linked_customer_count).toBe(0);
    expect(f.bot.sendCredentials).not.toHaveBeenCalled();
  });
});
