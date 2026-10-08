import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

const owner = '123456789';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class MemberBot implements BotAdapter {
  delivered: Array<{ id: string; username: string; password: string }> = [];
  status() {
    return { enabled: true, connected: true };
  }
  async validateRecipient(_id: string) {}
  async recipientIdentity(id: string) {
    return { id, username: 'Jim' };
  }
  async membershipActive(_id: string) {
    return true;
  }
  async activeMembers() {
    return [{ id: owner, username: 'Jim' }];
  }
  async sendCredentials(id: string, username: string, password: string) {
    this.delivered.push({ id, username, password });
  }
}

describe('membership lifecycle races and edge cases', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: MemberBot;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-membership-races-'));
    store = new Store(directory);
    servers = new DemoServers();
    bot = new MemberBot();
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      jellyfin_public_url: 'https://jellyfin.example',
      template_user_id: 'template',
    });
    service = new Service(store, { clientFactory: servers.factory });
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
  async function provision(tier = 'sloop') {
    return finish(await service.provisionMembership(owner, tier));
  }
  function accounts() {
    return servers.users.jellyfin.filter(
      (user) => user.Name === 'Jim' || /^Jim_[23]$/.test(user.Name),
    );
  }
  async function cancellation(id: string) {
    await service.recordSubscription({
      id,
      action: 'cancel',
      discord_user_id: owner,
      source: 'mee6_message',
      emitted_at: '2026-10-08T12:00:00Z',
    });
    return service.applySubscription(id);
  }

  function loseCreationResponses(usernames: string[]) {
    const lost = new Set(usernames);
    const passwordResets: string[] = [];
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      const create = client.createUser.bind(client),
        reset = client.setPassword.bind(client);
      client.createUser = async (username, password) => {
        const target = await create(username, password);
        if (lost.delete(username)) throw new MediaError('Synthetic creation response timed out.');
        return target;
      };
      client.setPassword = async (id, password) => {
        passwordResets.push(id);
        await reset(id, password);
      };
      return client;
    };
    return passwordResets;
  }

  it('cancels a saved membership with queued creation before any account has been linked', async () => {
    const member = service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'Jim',
        tier_id: 'brigantine',
        account_limit: 2,
      },
      store.settings(),
    );
    const job: Job = {
      id: 'queued-before-cancellation',
      kind: 'membership',
      status: 'queued',
      created_at: '2026-10-08T11:00:00Z',
      updated_at: '2026-10-08T11:00:00Z',
      progress: { processed: 0, total: 2 },
      results: [],
      membership_discord_user_id: owner,
    };
    store.saveQueuedJob(
      job,
      [1, 2].map((slot) => ({
        username: slot === 1 ? 'Jim' : 'Jim_2',
        discord_user_id: owner,
        membership_slot: slot,
        membership_revision: member.revision,
      })),
      store.settings(),
    );
    expect(store.linksForMember(owner)).toEqual([]);
    expect((await cancellation('cancel-queued')).status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
    await service.start();
    expect((await finish(job)).status).toBe('failed');
    expect(accounts()).toEqual([]);
    expect(bot.delivered).toEqual([]);
    expect(store.takeCredentials(job.id)).toEqual([]);
  });

  it.each(['Jim', 'Jim_2'])(
    'waits for in-flight creation of %s and suspends every account that was linked',
    async (blockedUsername) => {
      const started = deferred<void>(),
        release = deferred<void>();
      const factory = service.clientFactory;
      service.clientFactory = (...args) => {
        const client = factory(...args),
          create = client.createUser.bind(client);
        client.createUser = async (username, password) => {
          if (username === blockedUsername) {
            started.resolve();
            await release.promise;
          }
          return create(username, password);
        };
        return client;
      };
      const job = await service.provisionMembership(owner, 'brigantine');
      await started.promise;
      const cancelled = cancellation(`cancel-in-flight-${blockedUsername}`);
      try {
        await Promise.resolve();
        release.resolve();
        expect((await cancelled).status).toBe('applied');
        await finish(job);
        expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
        expect(accounts().length).toBeGreaterThan(0);
        expect(accounts().every((user) => user.Policy?.IsDisabled === true)).toBe(true);
        const links = store.linksForMember(owner);
        expect(links).toHaveLength(accounts().length);
        expect(links.every((link) => link.disabled_by_jellyport === 1)).toBe(true);
        for (const delivery of bot.delivered) {
          expect(delivery.id).toBe(owner);
          expect(JSON.stringify(service.getJob(job.id))).not.toContain(delivery.password);
        }
      } finally {
        release.resolve();
        await cancelled.catch(() => {});
      }
    },
  );

  it('requires automatic disabling for role-only renewals after a saved tier allowance is reduced in Settings', async () => {
    await provision('galleon');
    const before = structuredClone(servers.users.jellyfin);
    const membership = service.memberships.get(owner, store.settings());
    store.saveSettings({
      ...store.settings(),
      auto_provision: true,
      auto_disable: false,
      membership_tiers: store
        .settings()
        .membership_tiers!.map((tier) =>
          tier.id === 'galleon' ? { ...tier, account_limit: 1 } : tier,
        ),
    });
    const event = await service.recordSubscription({
      id: 'role-renewal-after-tier-edit',
      action: 'subscribe',
      discord_user_id: owner,
      source: 'discord_role',
      detail: 'Membership role added.',
    });
    expect(event.status).toBe('pending');
    expect(event.account_limit).toBe(1);
    await expect(service.applySubscription(event.id, true)).rejects.toThrow('administrator review');
    expect(servers.users.jellyfin).toEqual(before);
    expect(service.memberships.get(owner, store.settings())).toEqual(membership);
    expect((await service.applySubscription(event.id)).status).toBe('applied');
    expect(accounts().map((user) => user.Policy?.IsDisabled)).toEqual([false, true, true]);
  });

  it('can downgrade already linked accounts while the retired Emby server is unavailable', async () => {
    await provision('galleon');
    let sourceReads = 0;
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'emby')
        client.users = async () => {
          sourceReads++;
          throw new MediaError('Emby unavailable.');
        };
      return client;
    };
    expect((await provision('sloop')).status).toBe('completed');
    expect(sourceReads).toBe(0);
    expect(accounts().map((user) => user.Policy?.IsDisabled)).toEqual([false, true, true]);
  });

  it('reports an independently disabled entitled slot for review and never re-enables it', async () => {
    await provision('brigantine');
    const second = accounts().find((user) => user.Name === 'Jim_2')!;
    second.Policy!.IsDisabled = true;
    const job = await provision('brigantine');
    expect(job.status).toBe('partial');
    const result = job.results.find((entry) => entry.username === 'Jim_2')!;
    expect(result.status).toBe('partial');
    expect(JSON.stringify(result)).toMatch(/disabled.*(administrator|outside Jellyport)|review/i);
    expect(second.Policy!.IsDisabled).toBe(true);
    expect(store.link(owner, 2)?.disabled_by_jellyport).toBe(0);
    expect(bot.delivered).toHaveLength(2);
  });

  it('accepts approved mappings to existing Jellyfin usernames containing spaces and punctuation', async () => {
    const target = servers.users.jellyfin.find((user) => user.Id === 'j-river')!;
    target.Name = 'Jim Family !';
    const before = structuredClone(target);
    service.mappings.save(
      {
        source_user_id: 'e-river',
        source_username: 'river',
        target_user_id: target.Id,
        target_username: target.Name,
        discord_user_id: owner,
        discord_username: 'Jim',
        membership_slot: 1,
      },
      store.settings(),
    );
    const job = await provision('sloop');
    expect(job.status).toBe('completed');
    expect(target).toEqual(before);
    expect(store.link(owner, 1)?.remote_id).toBe(target.Id);
    expect(servers.played[target.Id]).toEqual(new Set(['1', '2']));
    expect(bot.delivered).toEqual([]);
    expect(store.takeCredentials(job.id)).toEqual([]);
  });

  it.each([true, false])(
    'retains a cancellation hold despite an active Discord role until a fresh subscribe event (linked accounts: %s)',
    async (hasLinkedAccounts) => {
      if (hasLinkedAccounts) await provision('galleon');
      else
        service.memberships.save(
          {
            discord_user_id: owner,
            base_username: 'Jim',
            tier_id: 'galleon',
            account_limit: 3,
          },
          store.settings(),
        );
      store.saveSettings({
        ...store.settings(),
        auto_provision: true,
        auto_disable: true,
        disable_on_cancel: true,
        discord_role_events: true,
        discord_member_role_id: '987654321',
      });
      expect((await cancellation(`cancel-hold-${hasLinkedAccounts}`)).status).toBe('applied');
      const jobs = store.jobs().length,
        events = store.subscriptions().length;
      await service.reconcileMemberships();
      await service.reconcileMemberships();
      expect(store.jobs()).toHaveLength(jobs);
      expect(store.subscriptions()).toHaveLength(events);
      expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
      expect(accounts()).toHaveLength(hasLinkedAccounts ? 3 : 0);
      expect(accounts().every((user) => user.Policy?.IsDisabled === true)).toBe(true);

      const renewed = await service.recordSubscription({
        id: `renew-after-hold-${hasLinkedAccounts}`,
        action: 'subscribe',
        discord_user_id: owner,
        source: 'mee6_message',
        detail: 'Galleon Crewman Plan',
        emitted_at: '2026-10-08T12:01:00Z',
      });
      expect(renewed.status).toBe('applied');
      expect(service.memberships.get(owner, store.settings())?.active).toBe(true);
      expect(accounts()).toHaveLength(3);
      expect(accounts().every((user) => user.Policy?.IsDisabled === false)).toBe(true);
    },
  );

  it('recovers an inspected uncertain numbered account into its entitled slot and delivers only to its owner', async () => {
    const passwordResets = loseCreationResponses(['Jim_2']);
    const initial = await provision('brigantine');
    expect(initial.status).toBe('partial');
    expect(store.account('Jim_2')?.status).toBe('uncertain');
    const primary = accounts().find((user) => user.Name === 'Jim')!;
    const second = accounts().find((user) => user.Name === 'Jim_2')!;
    servers.played[primary.Id] = new Set(['1']);
    servers.played[second.Id] = new Set(['2']);
    const primaryBefore = structuredClone(primary);
    expect(store.link(owner, 2)).toBeNull();
    const inspection = await service.recoveryInfo('Jim_2');
    expect(inspection).toMatchObject({ eligible: true, target_user_id: second.Id });

    const recovered = await finish(await service.recoverAccount('Jim_2', second.Id, owner));
    expect(recovered.status).toBe('completed');
    expect(store.link(owner, 2)?.remote_id).toBe(second.Id);
    expect(store.account('Jim_2')?.status).toBe('ready');
    expect(passwordResets).toEqual([second.Id]);
    expect(primary).toEqual(primaryBefore);
    expect(servers.played[primary.Id]).toEqual(new Set(['1']));
    expect(servers.played[second.Id]).toEqual(new Set(['2']));
    expect(bot.delivered.map((entry) => ({ id: entry.id, username: entry.username }))).toEqual([
      { id: owner, username: 'Jim' },
      { id: owner, username: 'Jim_2' },
    ]);
    expect(bot.delivered[1]?.password).toHaveLength(24);
    expect(JSON.stringify(recovered)).not.toContain(bot.delivered[1]!.password);
    expect(store.takeCredentials(recovered.id)).toEqual([]);
    expect(accounts()).toHaveLength(2);
  });

  it('rejects recovery of an unentitled numbered slot or another member’s incomplete account without resetting passwords', async () => {
    const passwordResets = loseCreationResponses(['Jim_2', 'Jim_3']);
    expect((await provision('galleon')).status).toBe('partial');
    const second = accounts().find((user) => user.Name === 'Jim_2')!;
    const third = accounts().find((user) => user.Name === 'Jim_3')!;
    const previous = service.memberships.get(owner, store.settings())!;
    service.memberships.save(
      {
        discord_user_id: owner,
        base_username: previous.base_username,
        tier_id: 'brigantine',
        account_limit: 2,
      },
      store.settings(),
      previous.revision,
    );
    const otherMember = '987654321';
    service.memberships.save(
      {
        discord_user_id: otherMember,
        base_username: 'Morgan',
        tier_id: 'galleon',
        account_limit: 3,
      },
      store.settings(),
    );
    bot.recipientIdentity = async (id) => ({ id, username: id === owner ? 'Jim' : 'Morgan' });
    const before = structuredClone(servers.users.jellyfin);
    const deliveries = bot.delivered.length;
    await expect(service.recoverAccount('Jim_3', third.Id, owner)).rejects.toThrow();
    await expect(service.recoverAccount('Jim_2', second.Id, otherMember)).rejects.toThrow();
    expect(passwordResets).toEqual([]);
    expect(servers.users.jellyfin).toEqual(before);
    expect(bot.delivered).toHaveLength(deliveries);
    expect(store.link(owner, 2)).toBeNull();
    expect(store.link(owner, 3)).toBeNull();
    expect(store.linksForMember(otherMember)).toEqual([]);
    expect(store.account('Jim_2')?.status).toBe('uncertain');
    expect(store.account('Jim_3')?.status).toBe('uncertain');
  });
});
