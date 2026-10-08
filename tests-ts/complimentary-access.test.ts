import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { ServiceError } from '../server/errors.js';
import { Service, type BotAdapter, type Job, type SubscriptionInput } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

const owner = '123456789';
const other = '987654321';
type AccessMode = 'subscription' | 'complimentary';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Rejects a non-paying recipient unless the service explicitly resolves their exemption. */
class MembershipBot implements BotAdapter {
  paid = false;
  present = true;
  checks: Array<{ method: string; id: string; requireMembership: boolean }> = [];
  delivered: Array<{ id: string; username: string; password: string; requireMembership: boolean }> =
    [];
  membershipLookups: string[] = [];
  status() {
    return { enabled: true, connected: true };
  }
  private check(method: string, id: string, requireMembership = true) {
    this.checks.push({ method, id, requireMembership });
    if (!this.present) throw new ServiceError('Recipient is not in the configured Discord server.');
    if (requireMembership && !this.paid) throw new ServiceError('Paid membership role is missing.');
  }
  async recipientIdentity(id: string, requireMembership = true) {
    this.check('identity', id, requireMembership);
    return { id, username: id === owner ? 'Jim' : 'Morgan' };
  }
  async validateRecipient(id: string, requireMembership = true) {
    this.check('validate', id, requireMembership);
  }
  async sendCredentials(
    id: string,
    username: string,
    password: string,
    _url: string,
    requireMembership = true,
  ) {
    this.check('delivery', id, requireMembership);
    this.delivered.push({ id, username, password, requireMembership });
  }
  async membershipActive(id: string) {
    this.membershipLookups.push(id);
    return this.present && this.paid;
  }
  async activeMembers() {
    return this.present && this.paid ? [{ id: owner, username: 'Jim' }] : [];
  }
}

describe('complimentary and standalone account access', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: MembershipBot;
  let writes: Array<{ method: string; arguments: unknown[] }>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-complimentary-access-'));
    store = new Store(directory);
    servers = new DemoServers();
    bot = new MembershipBot();
    writes = [];
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      jellyfin_public_url: 'https://jellyfin.example',
      template_user_id: 'template',
    });
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        const methods = client as unknown as Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        >;
        for (const method of [
          'createUser',
          'setPassword',
          'setPolicy',
          'setConfiguration',
          'setDisplayPreferences',
          'markPlayed',
          'updateUserData',
          'markFavorite',
          'createPlaylist',
          'addPlaylistItems',
          'setUserImage',
        ]) {
          const original = methods[method]!.bind(client);
          methods[method] = async (...arguments_) => {
            writes.push({ method, arguments: arguments_ });
            return original(...arguments_);
          };
        }
        return client;
      },
    });
    service.bot = bot;
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  async function complimentary(limit = 1, id = owner) {
    return service.setMembershipAccess({
      discord_user_id: id,
      access_mode: 'complimentary',
      account_limit: limit,
    });
  }
  async function provisionFree(limit = 1) {
    await complimentary(limit);
    return finish(await service.provisionMembership(owner, 'complimentary'));
  }
  function automation() {
    store.saveSettings({
      ...store.settings(),
      auto_provision: true,
      auto_disable: true,
      disable_on_cancel: true,
      discord_role_events: true,
      discord_member_role_id: '555555555',
    });
  }
  function subscription(fields: Partial<SubscriptionInput> = {}): SubscriptionInput {
    return {
      id: 'billing-event',
      action: 'cancel',
      discord_user_id: owner,
      source: 'mee6_message',
      ...fields,
    };
  }

  it('saves a non-paying member exemption and allowance without creating or changing media accounts', async () => {
    const before = structuredClone(servers.users);
    const member = await complimentary(2);
    expect(member).toMatchObject({
      access_mode: 'complimentary',
      tier_id: 'complimentary',
      account_limit: 2,
      active: true,
      base_username: 'Jim',
    });
    expect(bot.checks).toEqual([{ method: 'identity', id: owner, requireMembership: false }]);
    expect(writes).toEqual([]);
    expect(store.jobs()).toEqual([]);
    expect(servers.users).toEqual(before);
    const updated = await service.setMembershipAccess({
      discord_user_id: owner,
      access_mode: 'complimentary',
      account_limit: 3,
      expected_revision: member.revision,
    });
    expect(updated.revision).not.toBe(member.revision);
    await expect(
      service.setMembershipAccess({
        discord_user_id: owner,
        access_mode: 'complimentary',
        account_limit: 1,
        expected_revision: member.revision,
      }),
    ).rejects.toThrow('changed');
    await expect(complimentary(4)).rejects.toThrow('slots');
    expect(service.memberships.get(owner, store.settings())).toEqual(updated);
    expect(writes).toEqual([]);
  });

  it('requires explicit complimentary access before a non-paying member can create an account', async () => {
    await expect(service.createAccount('Jim', owner)).rejects.toThrow('membership role');
    expect(writes).toEqual([]);
    await complimentary();
    bot.checks = [];
    const job = await finish(await service.createAccount('Jim', owner));
    expect(job.status).toBe('completed');
    expect(store.link(owner)?.username).toBe('Jim');
    expect(bot.checks.every((check) => check.requireMembership === false)).toBe(true);
    expect(bot.delivered).toHaveLength(1);
    expect(bot.delivered[0]).toMatchObject({
      id: owner,
      username: 'Jim',
      requireMembership: false,
    });
    expect(bot.delivered[0]!.password).toHaveLength(24);
    expect(JSON.stringify(job)).not.toContain(bot.delivered[0]!.password);
    expect(store.takeCredentials(job.id)).toEqual([]);
  });

  it('provisions the saved free allowance with independent passwords and cannot implicitly turn it into a paid tier', async () => {
    const job = await provisionFree(3);
    expect(job.status).toBe('completed');
    expect(store.linksForMember(owner).map((link) => link.username)).toEqual([
      'Jim',
      'Jim_2',
      'Jim_3',
    ]);
    expect(bot.delivered.map((delivery) => delivery.requireMembership)).toEqual([
      false,
      false,
      false,
    ]);
    expect(new Set(bot.delivered.map((delivery) => delivery.password)).size).toBe(3);
    const saved = service.memberships.get(owner, store.settings());
    writes.length = 0;
    await expect(service.provisionMembership(owner, 'galleon')).rejects.toThrow(
      'complimentary access',
    );
    expect(service.memberships.get(owner, store.settings())).toEqual(saved);
    expect(writes).toEqual([]);
  });

  it('migrates a non-paying member through their approved custom username mapping and delivers credentials', async () => {
    await complimentary();
    service.mappings.save(
      {
        source_user_id: 'e-sam',
        source_username: 'sam',
        target_user_id: null,
        target_username: 'FamilyChild',
        discord_user_id: owner,
        discord_username: 'Jim',
        membership_slot: 1,
      },
      store.settings(),
    );
    const job = await finish(await service.migrateUsers(['e-sam'], { 'e-sam': owner }));
    expect(job.results[0]?.status).not.toBe('failed');
    const target = servers.users.jellyfin.find((user) => user.Name === 'FamilyChild')!;
    expect(target).toBeDefined();
    expect(servers.played[target.Id]).toEqual(new Set(['3']));
    expect(store.link(owner)?.remote_id).toBe(target.Id);
    expect(bot.delivered).toHaveLength(1);
    expect(bot.delivered[0]).toMatchObject({
      id: owner,
      username: 'FamilyChild',
      requireMembership: false,
    });
    expect(bot.checks.every((check) => check.requireMembership === false)).toBe(true);
  });

  it('keeps accounts when a complimentary member leaves Discord, but refuses new credential delivery to an absent member', async () => {
    await provisionFree();
    const before = structuredClone(servers.users.jellyfin);
    bot.present = false;
    automation();
    writes.length = 0;
    await service.reconcileMemberships();
    expect(bot.membershipLookups).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
    expect(servers.users.jellyfin).toEqual(before);
    await expect(service.provisionMembership(owner, 'complimentary')).rejects.toThrow(
      'unavailable',
    );
    expect(writes).toEqual([]);
    expect(bot.delivered).toHaveLength(1);
  });

  it('preserves one-time administrator credentials if a complimentary member leaves Discord during account creation', async () => {
    await complimentary();
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args),
        original = client.setPolicy.bind(client);
      client.setPolicy = async (id, policy) => {
        await original(id, policy);
        bot.present = false;
      };
      return client;
    };
    const job = await finish(await service.createAccount('Jim', owner));
    expect(job.status).toBe('partial');
    expect(job.results[0]?.discord_delivery).toBe('failed');
    expect(bot.delivered).toEqual([]);
    const credentials = store.takeCredentials(job.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.username).toBe('Jim');
    expect(credentials[0]?.password).toHaveLength(24);
    expect(JSON.stringify(job)).not.toContain(credentials[0]!.password);
    expect(store.takeCredentials(job.id)).toEqual([]);
  });

  it('requires the paid role again after an explicit return to subscription management', async () => {
    await provisionFree();
    const free = service.memberships.get(owner, store.settings())!;
    const before = structuredClone(servers.users.jellyfin);
    writes.length = 0;
    const paid = await service.setMembershipAccess({
      discord_user_id: owner,
      access_mode: 'subscription',
      tier_id: 'sloop',
      expected_revision: free.revision,
    });
    expect(paid).toMatchObject({ access_mode: 'subscription', tier_id: 'sloop' });
    expect(paid.revision).not.toBe(free.revision);
    expect(writes).toEqual([]);
    await expect(service.provisionMembership(owner, 'sloop')).rejects.toThrow('membership role');
    expect(servers.users.jellyfin).toEqual(before);
    expect(writes).toEqual([]);
  });

  it.each(['subscribe', 'cancel', 'expire'] as const)(
    'ignores new %s billing events in both automatic and manual paths',
    async (action) => {
      await provisionFree(2);
      automation();
      const member = service.memberships.get(owner, store.settings());
      const before = structuredClone(servers.users.jellyfin);
      const jobs = store.jobs().length;
      writes.length = 0;
      for (const source of ['mee6_message', 'discord_role', 'role_reconciliation']) {
        const event = await service.recordSubscription(
          subscription({
            id: `${source}-${action}`,
            action,
            source,
            detail: 'Unconfigured future subscription plan',
          }),
        );
        expect(event.status).toBe('ignored');
        expect(event.result).toContain('Complimentary');
        expect((await service.applySubscription(event.id)).status).toBe('ignored');
        expect((await service.applySubscription(event.id, true)).status).toBe('ignored');
      }
      expect(service.memberships.get(owner, store.settings())).toEqual(member);
      expect(servers.users.jellyfin).toEqual(before);
      expect(store.jobs()).toHaveLength(jobs);
      expect(writes).toEqual([]);
    },
  );

  it.each(['subscribe', 'cancel', 'expire'] as const)(
    'ignores a pending %s event recorded before the administrator granted complimentary access',
    async (action) => {
      bot.paid = true;
      await finish(await service.provisionMembership(owner, 'sloop'));
      const pending = await service.recordSubscription(
        subscription({ action, detail: 'Galleon Crewman Plan' }),
      );
      expect(pending.status).toBe('pending');
      const member = await complimentary(2);
      bot.paid = false;
      const before = structuredClone(servers.users.jellyfin);
      writes.length = 0;
      expect((await service.applySubscription(pending.id)).status).toBe('ignored');
      expect(service.memberships.get(owner, store.settings())).toEqual(member);
      expect(servers.users.jellyfin).toEqual(before);
      expect(writes).toEqual([]);
    },
  );

  it.each([false, true])(
    'never creates reconciliation events or changes a complimentary allowance with an active paid role of %s',
    async (paid) => {
      await provisionFree(2);
      bot.paid = paid;
      automation();
      const member = service.memberships.get(owner, store.settings());
      const before = structuredClone(servers.users.jellyfin);
      writes.length = 0;
      await service.reconcileMemberships();
      await service.reconcileMemberships();
      expect(bot.membershipLookups).toEqual([]);
      expect(store.subscriptions()).toEqual([]);
      expect(service.memberships.get(owner, store.settings())).toEqual(member);
      expect(servers.users.jellyfin).toEqual(before);
      expect(writes).toEqual([]);
    },
  );

  it.each([
    ['subscription', 'complimentary'],
    ['complimentary', 'subscription'],
  ] as const)(
    'invalidates a queued account job when access changes from %s to %s',
    async (initial: AccessMode, changed: AccessMode) => {
      bot.paid = true;
      const member = await service.setMembershipAccess({
        discord_user_id: owner,
        access_mode: initial,
        tier_id: 'sloop',
        account_limit: 1,
      });
      const job: Job = {
        id: 'queued-before-mode-change',
        kind: 'membership',
        status: 'queued',
        created_at: '2026-10-08T12:00:00Z',
        updated_at: '2026-10-08T12:00:00Z',
        progress: { processed: 0, total: 1 },
        results: [],
        membership_discord_user_id: owner,
      };
      store.saveQueuedJob(
        job,
        [
          {
            username: 'Jim',
            discord_user_id: owner,
            membership_slot: 1,
            membership_revision: member.revision,
          },
        ],
        store.settings(),
      );
      await service.setMembershipAccess({
        discord_user_id: owner,
        access_mode: changed,
        tier_id: 'sloop',
        account_limit: 1,
        expected_revision: member.revision,
      });
      writes.length = 0;
      await service.start();
      expect((await finish(job)).status).toBe('failed');
      expect(writes).toEqual([]);
      expect(store.linksForMember(owner)).toEqual([]);
      expect(bot.delivered).toEqual([]);
      expect(store.takeCredentials(job.id)).toEqual([]);
    },
  );

  it('creates and migrates standalone family accounts without a Discord bot or subscription record', async () => {
    service.bot = null;
    const created = await finish(await service.createAccount('Kids'));
    expect(created.status).toBe('completed');
    expect(store.takeCredentials(created.id)[0]?.username).toBe('Kids');
    const migrated = await finish(await service.migrateUsers(['e-sam']));
    expect(migrated.results[0]?.status).not.toBe('failed');
    const target = servers.users.jellyfin.find((user) => user.Name === 'sam')!;
    expect(servers.played[target.Id]).toEqual(new Set(['3']));
    expect(store.links()).toEqual([]);
    expect(service.listMemberships()).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
  });

  it('links an explicitly selected existing account with a custom username without changing its password, policy, or history', async () => {
    await complimentary();
    const target = servers.users.jellyfin.find((user) => user.Id === 'j-river')!;
    target.Name = 'Family account !';
    target.Policy!.IsDisabled = true;
    servers.userData[target.Id] = { '2': { IsFavorite: true, PlaybackPositionTicks: 500_000 } };
    const before = structuredClone({
      users: servers.users,
      played: servers.played,
      data: servers.userData,
    });
    writes.length = 0;
    expect(await service.linkExistingAccount(owner, target.Id)).toMatchObject({
      discord_user_id: owner,
      remote_id: target.Id,
      username: 'Family account !',
      membership_slot: 1,
      disabled_by_jellyport: 0,
    });
    await service.linkExistingAccount(owner, target.Id);
    expect(writes).toEqual([]);
    expect({ users: servers.users, played: servers.played, data: servers.userData }).toEqual(
      before,
    );
    expect(bot.delivered).toEqual([]);
  });

  it.each(['administrator', 'template', 'unverified-policy', 'unverified-disabled'] as const)(
    'refuses linking a protected or unverifiable %s account',
    async (kind) => {
      await complimentary();
      const target = servers.users.jellyfin.find((user) => user.Id === 'j-river')!;
      let targetId = target.Id;
      if (kind === 'administrator') target.Policy!.IsAdministrator = true;
      else if (kind === 'template') targetId = 'template';
      else if (kind === 'unverified-policy') delete target.Policy;
      else delete target.Policy!.IsDisabled;
      await expect(service.linkExistingAccount(owner, targetId)).rejects.toThrow(
        'cannot be linked',
      );
      expect(store.links()).toEqual([]);
      expect(writes).toEqual([]);
    },
  );

  it('refuses unentitled slots, duplicate ownership, and replacing an occupied slot', async () => {
    await complimentary();
    await expect(service.linkExistingAccount(owner, 'j-river', 2)).rejects.toThrow('allowance');
    await expect(service.linkExistingAccount(owner, 'j-river', 4)).rejects.toThrow('slots');
    await complimentary(2);
    await complimentary(2, other);
    await service.linkExistingAccount(owner, 'j-river');
    await expect(service.linkExistingAccount(owner, 'j-river', 2)).rejects.toThrow('reserved');
    await expect(service.linkExistingAccount(other, 'j-river')).rejects.toThrow('reserved');
    servers.users.jellyfin.push({
      Id: 'j-family',
      Name: 'Family',
      Policy: { IsAdministrator: false, IsDisabled: false },
      Configuration: {},
    });
    await expect(service.linkExistingAccount(owner, 'j-family')).rejects.toThrow('reserved');
    expect(store.links()).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('respects another identity’s approved mapping even before its Jellyfin account has been linked', async () => {
    await complimentary();
    service.mappings.save(
      {
        source_user_id: 'e-river',
        source_username: 'river',
        target_user_id: 'j-river',
        target_username: 'river',
        discord_user_id: other,
        discord_username: 'Morgan',
        membership_slot: 1,
      },
      store.settings(),
    );
    await expect(service.linkExistingAccount(owner, 'j-river')).rejects.toThrow('reserved');
    expect(store.links()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('serializes competing explicit account links and allows only one verified owner', async () => {
    await complimentary();
    await complimentary(1, other);
    const outcomes = await Promise.allSettled([
      service.linkExistingAccount(owner, 'j-river'),
      service.linkExistingAccount(other, 'j-river'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(store.links()).toHaveLength(1);
    expect(store.linkForRemote('j-river')?.discord_user_id).toBe(owner);
    expect(writes).toEqual([]);
  });

  it('rechecks complimentary status after an in-flight Discord expiration lookup', async () => {
    bot.paid = true;
    await finish(await service.provisionMembership(owner, 'sloop'));
    const pending = await service.recordSubscription(
      subscription({ action: 'expire', source: 'discord_role' }),
    );
    const started = deferred<void>(),
      release = deferred<boolean>();
    bot.membershipActive = async () => {
      started.resolve();
      return release.promise;
    };
    const applying = service.applySubscription(pending.id);
    // Retain any rejection until the assertions below so the race cannot become unhandled.
    const outcome = applying.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await started.promise;
      const member = await complimentary();
      const before = structuredClone(servers.users.jellyfin);
      writes.length = 0;
      release.resolve(false);
      const result = await outcome;
      expect(result).not.toHaveProperty('error');
      expect('value' in result && result.value.status).toBe('ignored');
      expect('value' in result && result.value.result).toContain('Complimentary access');
      expect(service.memberships.get(owner, store.settings())).toEqual(member);
      expect(servers.users.jellyfin).toEqual(before);
      expect(writes).toEqual([]);
    } finally {
      release.resolve(false);
      await outcome;
    }
  });
});
