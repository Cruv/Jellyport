import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import type { MediaKind, MediaUser } from '../server/media.js';
import { Service, type HouseholdAccessInput } from '../server/service.js';
import { Store } from '../server/store.js';
import type { StripeEntitlementFact } from '../server/stripe-entitlements.js';

const owner = '123456789';
const primary: HouseholdAccessInput = {
  kind: 'emby',
  user_id: 'source-primary',
  disabled: false,
  expected_username: 'Source Primary',
  expected_profile_revision: '',
  expected_discord_user_id: owner,
};
const otherOwner = '987654321';
const jellyfinUrl = 'https://jellyfin.example.test';

function mediaUser(Id: string, Name: string): MediaUser {
  return {
    Id,
    Name,
    Policy: { IsAdministrator: false, IsDisabled: true, EnableAllFolders: true },
    Configuration: { DisplayMissingEpisodes: true },
  };
}

describe('reviewed household account access', () => {
  let directory: string;
  let store: Store;
  let media: DemoServers;
  let service: Service;
  let source: MediaUser;
  let target: MediaUser;
  let extra: MediaUser;
  let unrelated: MediaUser;
  let sourceServerId: string;
  let afterRead: ((kind: MediaKind, id: string) => void) | undefined;
  let lostResponse: { id: string; applied: boolean } | undefined;
  let writes: Array<[MediaKind, string]>;

  function saveTier(tier_id: string, account_limit: number) {
    service.memberships.save(
      { discord_user_id: owner, base_username: 'example-owner', tier_id, account_limit },
      store.settings(),
    );
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-household-access-'));
    store = new Store(directory);
    const pending = store.resetAuth(jellyfinUrl);
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: jellyfinUrl,
        serverId: 'demo-jellyfin',
        apiKeyName: 'synthetic',
      },
      (settings) => ({
        ...settings,
        emby_url: 'https://emby.example.test',
        emby_api_key: 'synthetic-emby-key',
        jellyfin_url: jellyfinUrl,
        jellyfin_api_key: 'synthetic-jellyfin-key',
      }),
    );
    media = new DemoServers();
    source = mediaUser(primary.user_id, primary.expected_username);
    target = mediaUser('target-primary', 'Target Primary');
    extra = mediaUser('target-extra', 'Target Extra');
    unrelated = mediaUser('unrelated', source.Name);
    media.users.emby.push(source);
    media.users.jellyfin.push(target, extra, unrelated);
    sourceServerId = 'demo-emby';
    afterRead = undefined;
    lostResponse = undefined;
    writes = [];
    service = new Service(store, {
      clientFactory: (url, apiKey, kind = 'jellyfin') => {
        const client = media.factory(url, apiKey, kind);
        const info = client.systemInfo.bind(client);
        const read = client.user.bind(client);
        const write = client.setPolicy.bind(client);
        client.systemInfo = async (options) => {
          const value = await info(options);
          return kind === 'emby' ? { ...value, Id: sourceServerId } : value;
        };
        client.user = async (id) => {
          const account = await read(id);
          afterRead?.(kind, id);
          return account;
        };
        client.setPolicy = async (id, policy) => {
          writes.push([kind, id]);
          const failure = lostResponse?.id === id ? lostResponse : undefined;
          if (!failure || failure.applied) await write(id, policy);
          if (failure) throw new MediaError('Synthetic lost policy response.');
        };
        return client;
      },
    });
    saveTier('brigantine', 2);
    service.mediaOwnerships.save(
      [
        {
          kind: 'emby',
          server_id: sourceServerId,
          account_id: source.Id,
          username: source.Name,
          discord_user_id: owner,
          slot: 1,
        },
      ],
      store.settings(),
    );
    store.saveLink(owner, target.Name, target.Id, true, 1);
    store.saveLink(owner, extra.Name, extra.Id, true, 2);
    store.saveLink(otherOwner, unrelated.Name, unrelated.Id);
  });

  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects an approval made before a tier reduction and enables only the remaining slot in a new review', async () => {
    const before = await service.reviewHouseholdAccess(primary);
    expect(before.summary.account_limit).toBe(2);
    expect(before.summary.accounts.map(({ user_id, eligible }) => [user_id, eligible])).toEqual([
      [source.Id, true],
      [target.Id, true],
      [extra.Id, true],
    ]);
    saveTier('sloop', 1);
    await expect(service.applyHouseholdAccess(before)).rejects.toThrow(/changed|review/i);
    expect(writes).toEqual([]);

    const reviewed = await service.reviewHouseholdAccess(primary);
    expect(reviewed.summary).toMatchObject({
      account_limit: 1,
      accounts: [
        { user_id: source.Id, slot: 1, eligible: true },
        { user_id: target.Id, slot: 1, eligible: true },
        { user_id: extra.Id, slot: 2, eligible: false, exclusion: 'tier' },
      ],
    });
    await expect(service.applyHouseholdAccess(reviewed)).resolves.toMatchObject({ changed: 2 });
    expect(writes).toEqual([
      ['emby', source.Id],
      ['jellyfin', target.Id],
    ]);
    expect(extra.Policy?.IsDisabled).toBe(true);
    expect(unrelated.Policy?.IsDisabled).toBe(true);
    expect(store.link(owner, 1)?.disabled_by_jellyport).toBe(0);
    expect(store.link(owner, 2)?.disabled_by_jellyport).toBe(1);
  });

  it('uses the current verified Stripe tier while its reduction is pending and rejects the earlier review', async () => {
    store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
    const base: StripeEntitlementFact = {
      provider: 'stripe',
      event_id: `stripe-${'1'.repeat(64)}`,
      discord_user_id: owner,
      action: 'subscribe',
      customer_id: 'cus_synthetic',
      subscription_id: 'sub_synthetic',
      invoice_id: 'in_synthetic',
      tier_id: 'brigantine',
      price_id: 'price_synthetic_two',
      generation: 'synthetic-generation',
      authority_revision: 'synthetic-authority',
      activation_revision: 'synthetic-activation',
      created_at: '2026-11-01T00:00:00.000Z',
      observed_at: '2026-11-20T00:00:00.000Z',
      paid_through: '2026-12-01T00:00:00.000Z',
      is_new: false,
    };
    let currentFact = base;
    service.currentStripeAccountEntitlement = (discordId) =>
      discordId === owner ? currentFact : undefined;
    store.saveSubscription({
      id: base.event_id,
      action: base.action,
      source: 'stripe',
      discord_user_id: owner,
      status: 'applied',
      created_at: base.observed_at,
      stripe_entitlement: base,
    });
    const before = await service.reviewHouseholdAccess(primary);
    expect(before.summary.account_limit).toBe(2);

    const reduction = {
      ...base,
      event_id: `stripe-${'2'.repeat(64)}`,
      tier_id: 'sloop',
      price_id: 'price_synthetic_one',
      observed_at: '2026-11-21T00:00:00.000Z',
    };
    currentFact = reduction;
    store.saveSubscription({
      id: reduction.event_id,
      action: reduction.action,
      source: 'stripe',
      discord_user_id: owner,
      status: 'pending',
      stripe_price_review_required: true,
      created_at: reduction.observed_at,
      stripe_entitlement: reduction,
    });
    await expect(service.applyHouseholdAccess(before)).rejects.toThrow(/changed|review/i);
    expect(writes).toEqual([]);

    const current = await service.reviewHouseholdAccess(primary);
    expect(current.summary.account_limit).toBe(1);
    expect(current.summary.accounts.find(({ user_id }) => user_id === extra.Id)).toMatchObject({
      eligible: false,
      exclusion: 'tier',
    });
    await expect(service.applyHouseholdAccess(current)).resolves.toMatchObject({ changed: 2 });
    expect(extra.Policy?.IsDisabled).toBe(true);
    expect(service.memberships.get(owner, store.settings())?.account_limit).toBe(2);
    expect(store.subscription(reduction.event_id)).toMatchObject({
      status: 'pending',
      stripe_price_review_required: true,
    });
  });

  it('includes a manually flagged Family account beyond the paid tier', async () => {
    saveTier('sloop', 1);
    const family = await service.saveAccountProfile({
      kind: 'jellyfin',
      user_id: extra.Id,
      family: true,
      owner_name: '',
      notes: '',
      expected_revision: '',
    });
    const reviewed = await service.reviewHouseholdAccess(primary);
    expect(reviewed.summary.account_limit).toBe(1);
    expect(reviewed.summary.accounts.find(({ user_id }) => user_id === extra.Id)).toMatchObject({
      slot: 2,
      eligible: true,
    });
    await expect(service.applyHouseholdAccess(reviewed)).resolves.toMatchObject({ changed: 3 });
    expect(extra.Policy?.IsDisabled).toBe(false);
    expect(service.profiles.get('jellyfin', extra.Id, store.settings())).toEqual(family);
  });

  it('rejects a replacement Emby server with the same URL, account ID, and name at the write boundary', async () => {
    const reviewed = await service.reviewHouseholdAccess(primary);
    let reads = 0;
    afterRead = (kind, id) => {
      if (kind === 'emby' && id === source.Id && ++reads === 2) sourceServerId = 'replacement-emby';
    };
    await expect(service.applyHouseholdAccess(reviewed)).rejects.toThrow(/Emby|server changed/i);
    expect(reads).toBe(2);
    expect(writes).toEqual([]);
    expect([source, target, extra].map(({ Policy }) => Policy?.IsDisabled)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it.each([
    ['another owner', otherOwner, 1],
    ['another slot', owner, 2],
  ] as const)(
    'rejects a formerly reviewed target claimed by %s',
    async (_conflict, discord_user_id, slot) => {
      const reviewed = await service.reviewHouseholdAccess(primary);
      service.mediaOwnerships.save(
        [
          {
            kind: 'jellyfin',
            server_id: 'demo-jellyfin',
            account_id: target.Id,
            username: target.Name,
            discord_user_id,
            slot,
          },
        ],
        store.settings(),
      );
      await expect(service.applyHouseholdAccess(reviewed)).rejects.toThrow(/ownership|slot/i);
      expect(writes).toEqual([]);
    },
  );

  it('preserves a pending automatic access decision without starting a household write', async () => {
    const reviewed = await service.reviewHouseholdAccess(primary);
    store.setLinkPending(owner, true, 2);
    await expect(service.applyHouseholdAccess(reviewed)).rejects.toThrow(/unfinished|review/i);
    expect(store.link(owner, 2)?.pending_disabled).toBe(1);
    expect(store.link(owner, 2)?.disabled_by_jellyport).toBe(1);
    expect(writes).toEqual([]);
  });

  it('verifies an applied write after a lost response and keeps its manual attribution', async () => {
    const reviewed = await service.reviewHouseholdAccess(primary);
    lostResponse = { id: target.Id, applied: true };
    await expect(service.applyHouseholdAccess(reviewed)).resolves.toMatchObject({ changed: 3 });
    expect(writes).toEqual([
      ['emby', source.Id],
      ['jellyfin', target.Id],
      ['jellyfin', extra.Id],
    ]);
    expect(target.Policy?.IsDisabled).toBe(false);
    expect(store.link(owner, 1)).toMatchObject({
      disabled_by_jellyport: 0,
      pending_disabled: null,
    });
  });

  it('keeps confirmed changes and untouched links when a later write cannot be confirmed', async () => {
    const reviewed = await service.reviewHouseholdAccess(primary);
    lostResponse = { id: target.Id, applied: false };
    await expect(service.applyHouseholdAccess(reviewed)).rejects.toThrow(
      /Target Primary.*1 earlier.*confirmed/i,
    );
    expect(writes).toEqual([
      ['emby', source.Id],
      ['jellyfin', target.Id],
    ]);
    expect(source.Policy?.IsDisabled).toBe(false);
    expect(target.Policy?.IsDisabled).toBe(true);
    expect(extra.Policy?.IsDisabled).toBe(true);
    expect(store.link(owner, 1)?.disabled_by_jellyport).toBe(1);
    expect(store.householdAccessChanges(owner, store.settings())).toMatchObject([
      { kind: 'emby', username: source.Name, disabled: false },
    ]);

    lostResponse = undefined;
    const remaining = await service.reviewHouseholdAccess(primary);
    await expect(service.applyHouseholdAccess(remaining)).resolves.toMatchObject({ changed: 2 });
    expect(writes).toEqual([
      ['emby', source.Id],
      ['jellyfin', target.Id],
      ['jellyfin', target.Id],
      ['jellyfin', extra.Id],
    ]);
  });
});
