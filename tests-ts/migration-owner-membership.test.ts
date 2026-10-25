import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoServers } from '../server/demo.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { Service, type ReviewedMigrationMembership } from '../server/service.js';
import type { StripeMigrationMembershipReview } from '../server/stripe-integration.js';

const owner = '123456789012345678';
const sourceIds = ['harbor', 'cabin', 'studio'];
describe('membership assignment during reviewed migration', () => {
  let directory: string, store: Store, service: Service, servers: DemoServers;
  let lookup: ReturnType<
    typeof vi.fn<(id: string, signal?: AbortSignal) => Promise<StripeMigrationMembershipReview>>
  >;
  const billing = (limit = 3): StripeMigrationMembershipReview => ({
    status: 'verified',
    tier_id: limit === 3 ? 'galleon' : 'sloop',
    tier_name: limit === 3 ? 'Galleon' : 'Sloop',
    account_limit: limit,
    message: 'Verified synthetic billing',
    proof: {
      token: 'synthetic-private-proof',
      owner_id: owner,
      tier_id: limit === 3 ? 'galleon' : 'sloop',
      tier_name: limit === 3 ? 'Galleon' : 'Sloop',
      account_limit: limit,
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      paid_through: '2099-01-01T00:00:00.000Z',
      context: 'synthetic-authority',
    },
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-migration-owner-membership-'));
    store = new Store(directory);
    servers = new DemoServers();
    servers.users.emby = sourceIds.map((Id, index) => ({
      Id,
      Name: ['Harbor', 'Cabin', 'Studio'][index]!,
      Policy: { IsAdministrator: false, IsDisabled: false },
    }));
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id === 'template');
    servers.media = sourceIds.map((_, index) => ({
      Id: String(index + 1),
      Name: `Synthetic movie ${index + 1}`,
      Type: 'Movie',
      ProviderIds: { Tmdb: `synthetic-${index + 1}` },
    }));
    servers.played = Object.fromEntries(
      sourceIds.map((id, index) => [id, new Set([String(index + 1)])]),
    );
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-source',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-target',
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
    service = new Service(store, { clientFactory: servers.factory });
    service.bot = {
      status: () => ({ connected: true }),
      recipientIdentity: vi.fn(async (id) => ({ id, username: 'crew_owner' })),
      validateRecipient: vi.fn(async () => {}),
      sendCredentials: vi.fn(async () => {}),
      membershipActive: async () => true,
      activeMembers: async () => [],
    };
    lookup = vi.fn(async () => billing());
    service.reviewStripeMigrationMembership = lookup;
    service.verifyStripeMigrationMembership = vi.fn();
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function prepare() {
    const preview = await service.preview(sourceIds);
    const review = await service.reviewMigrationMembership(owner);
    const accept = (
      reviews: Record<string, ReviewedMigrationMembership> = { [owner]: review },
      guard?: () => void,
    ) =>
      service.migrateUsers(
        sourceIds,
        Object.fromEntries(sourceIds.map((id) => [id, owner])),
        Object.fromEntries(
          preview.users.map((user) => [user.source_user_id, user.mapping_revision ?? null]),
        ),
        'watched_only',
        undefined,
        undefined,
        undefined,
        undefined,
        Object.fromEntries(
          sourceIds.map((id, index) => [
            id,
            { ...preview.owner_assignment_sources![id]!, discord_user_id: owner, slot: index + 1 },
          ]),
        ),
        guard,
        reviews,
      );
    return { review, accept };
  }
  it('derives a Galleon allowance for one selected owner and atomically assigns only the three reviewed arbitrary accounts', async () => {
    const original = structuredClone(servers.users.emby);
    const { review, accept } = await prepare();
    expect(review.summary).toMatchObject({
      source: 'stripe',
      tier_name: 'Galleon',
      account_limit: 3,
      allowed_slots: [1, 2, 3],
    });
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(store.jobs()).toEqual([]);
    const job = await accept();
    await service.jobTasks.get(job.id);
    expect(service.getJob(job.id).status).toBe('completed');
    expect(lookup).toHaveBeenCalledTimes(2); // One view and one admission, never per account.
    const member = service.memberships.get(owner, store.settings())!;
    expect(member).toMatchObject({
      tier_id: 'galleon',
      account_limit: 3,
      active: true,
      provision_jellyfin: false,
    });
    expect(
      store
        .links()
        .map((link) => [link.username, link.membership_slot])
        .sort(),
    ).toEqual([
      ['Cabin', 2],
      ['Harbor', 1],
      ['Studio', 3],
    ]);
    for (let index = 0; index < sourceIds.length; index++) {
      const target = servers.users.jellyfin.find(
        (user) => user.Name === ['Harbor', 'Cabin', 'Studio'][index],
      )!;
      expect([...servers.played[target.Id]!]).toEqual([String(index + 1)]);
    }
    expect(servers.users.emby).toEqual(original);
    expect(service.bot!.sendCredentials).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(service.bot!.sendCredentials).mock.calls.every((call) => call[0] === owner),
    ).toBe(true);
    expect(store.jobs()).toHaveLength(1);
  });
  it('rolls back new membership, source ownership, adopted mapping and queue if persistence fails', async () => {
    const mapping = service.mappings.save(
      {
        source_user_id: 'cabin',
        source_username: 'Cabin',
        target_user_id: null,
        target_username: 'CabinAlias',
        discord_user_id: null,
        discord_username: null,
      },
      store.settings(),
    );
    const { accept } = await prepare();
    vi.spyOn(store, 'saveJob').mockImplementationOnce(() => {
      expect(service.memberships.get(owner, store.settings())?.account_limit).toBe(3);
      throw new Error('Synthetic persistence failure');
    });
    await expect(accept()).rejects.toThrow('Synthetic persistence failure');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(service.mediaOwnerships.list(store.settings())).toEqual([]);
    expect(service.mappings.get(mapping.id, store.settings())).toEqual(mapping);
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(servers.users.jellyfin.map((user) => user.Id)).toEqual(['template']);
    expect(service.bot!.sendCredentials).not.toHaveBeenCalled();
  });
  it('requires a new review if the verified tier changes after display', async () => {
    const { accept } = await prepare();
    lookup.mockResolvedValue(billing(1));
    await expect(accept()).rejects.toThrow('membership tier or access changed');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(store.jobs()).toEqual([]);
  });
  it('preserves an administrator complimentary policy without any billing lookup', async () => {
    const member = service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'FamilyOwner',
        tier_id: 'complimentary',
        access_mode: 'complimentary',
        account_limit: 3,
        active: true,
        provision_jellyfin: false,
      },
      store.settings(),
    );
    const { review, accept } = await prepare();
    expect(review.summary.status).toBe('complimentary');
    const job = await accept();
    await service.jobTasks.get(job.id);
    expect(service.getJob(job.id).status).toBe('completed');
    expect(lookup).not.toHaveBeenCalled();
    expect(service.memberships.get(owner, store.settings())).toEqual(member);
  });
  it.each(['inactive', 'pending'] as const)(
    'preserves a saved %s hold instead of deriving a fresh paid membership',
    async (kind) => {
      const member = service.memberships.save(
        {
          discord_user_id: owner,
          base_username: 'crew_owner',
          tier_id: 'galleon',
          account_limit: 3,
          active: kind !== 'inactive',
          provision_jellyfin: false,
          ...(kind === 'pending'
            ? { new_subscriber_pending: true as const }
            : { inactive_reason: 'cancel' as const }),
        },
        store.settings(),
      );
      const { review, accept } = await prepare();
      expect(review.summary.allowed_slots).toEqual([]);
      await expect(accept()).rejects.toThrow('reviewed membership does not cover');
      expect(lookup).not.toHaveBeenCalled();
      expect(service.memberships.get(owner, store.settings())).toEqual(member);
      expect(store.jobs()).toEqual([]);
    },
  );
  it('does not infer an allowance from a generic active Discord role or an unlinked billing customer', async () => {
    lookup.mockResolvedValue({
      status: 'unlinked',
      message: 'Approve the billing identity link first.',
    });
    const { review, accept } = await prepare();
    expect(review.summary).toMatchObject({
      status: 'unlinked',
      account_limit: null,
      allowed_slots: [1],
    });
    await expect(accept()).rejects.toThrow('reviewed membership does not cover account 2');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(store.jobs()).toEqual([]);
  });
  it('rejects a configuration change or withdrawn approval before saving any membership', async () => {
    const { accept } = await prepare();
    let withdrawn = false;
    lookup.mockImplementation(async () => {
      withdrawn = true;
      return billing();
    });
    await expect(
      accept(undefined, () => {
        if (withdrawn) throw new Error('Synthetic review canceled');
      }),
    ).rejects.toThrow('Synthetic review canceled');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(store.jobs()).toEqual([]);
  });
  it('serializes the committed membership revision into every durable request for restart guards', async () => {
    const { accept } = await prepare();
    vi.spyOn(service as unknown as { schedule: () => void }, 'schedule').mockImplementation(
      () => {},
    );
    const job = await accept();
    const revision = service.memberships.get(owner, store.settings())!.revision;
    const queued = store.queuedJobs().find((entry) => entry.job.id === job.id)!;
    expect(queued.requests).toHaveLength(3);
    expect(queued.requests.every((request) => request.membership_revision === revision)).toBe(true);
  });
});
