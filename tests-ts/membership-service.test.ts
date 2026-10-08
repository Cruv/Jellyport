import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { Service, type BotAdapter, type Job, type SubscriptionInput } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

const owner = '123456789';
class MemberBot implements BotAdapter {
  username = 'Jim';
  active: boolean | null = true;
  delivered: Array<{ recipient: string; username: string; password: string; url: string }> = [];
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string) {
    return { id, username: this.username };
  }
  async validateRecipient(_id: string) {}
  async membershipActive(_id: string) {
    return this.active;
  }
  async activeMembers() {
    return this.active ? [{ id: owner, username: this.username }] : [];
  }
  async sendCredentials(recipient: string, username: string, password: string, url: string) {
    this.delivered.push({ recipient, username, password, url });
  }
}

describe('multi-account Discord membership provisioning', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: MemberBot;
  let passwords: Map<string, string>, passwordResets: Array<{ id: string; password: string }>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-membership-service-'));
    store = new Store(directory);
    servers = new DemoServers();
    bot = new MemberBot();
    passwords = new Map();
    passwordResets = [];
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby',
      emby_api_key: 'private-emby-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'private-jellyfin-key',
      jellyfin_public_url: 'https://jellyfin.example',
      template_user_id: 'template',
    });
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        const create = client.createUser.bind(client),
          reset = client.setPassword.bind(client);
        client.createUser = async (username, password) => {
          passwords.set(username, password);
          return create(username, password);
        };
        client.setPassword = async (id, password) => {
          passwordResets.push({ id, password });
          await reset(id, password);
        };
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
  async function finish(job: Job): Promise<Job> {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  async function provision(tier = 'sloop') {
    return finish(await service.provisionMembership(owner, tier));
  }
  function linked(slot: number) {
    const link = store.link(owner, slot)!;
    expect(link).toBeDefined();
    return servers.users.jellyfin.find((user) => user.Id === link.remote_id)!;
  }
  async function event(fields: Partial<SubscriptionInput>) {
    const value = await service.recordSubscription({
      id: `event-${store.subscriptions().length + 1}`,
      action: 'subscribe',
      discord_user_id: owner,
      source: 'mee6_message',
      ...fields,
    });
    return service.applySubscription(value.id);
  }

  it.each([
    ['sloop', 1],
    ['brigantine', 2],
    ['galleon', 3],
  ] as const)(
    'creates %s allowance with separate credentials delivered only to the membership owner',
    async (tier, limit) => {
      const job = await provision(tier);
      expect(job.status).toBe('completed');
      const names = ['Jim', 'Jim_2', 'Jim_3'].slice(0, limit);
      expect(store.linksForMember(owner).map((link) => link.username)).toEqual(names);
      expect(bot.delivered.map((delivery) => delivery.username)).toEqual(names);
      expect(
        bot.delivered.every(
          (delivery) => delivery.recipient === owner && delivery.url === 'https://jellyfin.example',
        ),
      ).toBe(true);
      expect(new Set(bot.delivered.map((delivery) => delivery.password)).size).toBe(limit);
      for (let slot = 1; slot <= limit; slot++) {
        const target = linked(slot);
        expect(target.Policy).toEqual(servers.users.jellyfin[0]?.Policy);
        expect(target.Configuration).toEqual(servers.users.jellyfin[0]?.Configuration);
        const delivery = bot.delivered[slot - 1]!;
        expect(delivery.password).toHaveLength(24);
        expect(JSON.stringify(job)).not.toContain(delivery.password);
        expect(servers.played[target.Id] ?? new Set()).toEqual(new Set());
      }
      if (limit > 1) {
        servers.played[linked(1).Id] = new Set(['1']);
        expect(servers.played[linked(2).Id] ?? new Set()).toEqual(new Set());
      }
      expect(store.takeCredentials(job.id)).toEqual([]);
      const repeated = await provision(tier);
      expect(repeated.status).toBe('completed');
      expect(bot.delivered).toHaveLength(limit);
      expect(passwordResets).toEqual([]);
    },
  );

  it('upgrades and downgrades without losing data or overriding manually disabled secondary accounts', async () => {
    await provision('brigantine');
    const primary = linked(1),
      second = linked(2);
    servers.played[primary.Id] = new Set(['1']);
    servers.played[second.Id] = new Set(['2']);
    servers.userData[second.Id] = { '2': { IsFavorite: true, PlaybackPositionTicks: 500_000 } };
    second.Policy!.IsDisabled = true;
    const originalPasswords = new Map(passwords);
    const upgrade = await provision('galleon');
    expect(upgrade.status).toBe('partial');
    expect(upgrade.results.find((result) => result.username === 'Jim_2')?.warnings?.[0]).toContain(
      'remains disabled',
    );
    const third = linked(3);
    servers.played[third.Id] = new Set(['3']);
    expect(second.Policy?.IsDisabled).toBe(true);
    expect(store.link(owner, 2)?.disabled_by_jellyport).toBe(0);
    expect((await provision('sloop')).status).toBe('completed');
    expect([primary, second, third].map((user) => user.Policy?.IsDisabled)).toEqual([
      false,
      true,
      true,
    ]);
    expect(store.link(owner, 3)?.disabled_by_jellyport).toBe(1);
    expect((await provision('galleon')).status).toBe('partial');
    expect([primary, second, third].map((user) => user.Policy?.IsDisabled)).toEqual([
      false,
      true,
      false,
    ]);
    expect(servers.played[primary.Id]).toEqual(new Set(['1']));
    expect(servers.played[second.Id]).toEqual(new Set(['2']));
    expect(servers.played[third.Id]).toEqual(new Set(['3']));
    expect(servers.userData[second.Id]).toEqual({
      '2': { IsFavorite: true, PlaybackPositionTicks: 500_000 },
    });
    for (const [username, password] of originalPasswords)
      expect(passwords.get(username)).toBe(password);
    expect(passwordResets).toEqual([]);
    expect(bot.delivered).toHaveLength(3);
  });

  it('initializes every membership slot from the saved default role including shared Home preferences', async () => {
    const pending = store.ensureAuthState();
    if (pending.kind !== 'pending') throw new Error('Expected isolated pending setup');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: 'http://jellyfin',
        serverId: 'demo-jellyfin',
        apiKeyName: 'fixture',
      },
      (settings) => settings,
    );
    const parameters = {
      policy: {
        IsAdministrator: false,
        EnableAllFolders: false,
        EnabledFolders: ['family-library'],
        EnableMediaPlayback: true,
      },
      configuration: {
        AudioLanguagePreference: 'en',
        EnableNextEpisodeAutoPlay: true,
        OrderedViews: ['family-library'],
      },
      display: {
        ShowBackdrop: true,
        CustomPrefs: {
          tvhome: 'vertical',
          homesection0: 'smalllibrarytiles',
          homesection1: 'resume',
          homesection2: 'nextup',
          homesection3: 'none',
        },
      },
    };
    const role = service.roles.save({ name: 'Member experience', parameters }, store.settings());
    store.saveSettings({ ...store.settings(), template_user_id: '', default_role_id: role.id });
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id !== 'template');
    expect((await provision('galleon')).status).toBe('completed');
    for (let slot = 1; slot <= 3; slot++) {
      const target = linked(slot);
      expect(target.Policy).toMatchObject(parameters.policy);
      expect(target.Configuration).toMatchObject(parameters.configuration);
      expect(servers.display[target.Id]).toMatchObject(parameters.display);
      expect(service.roles.getAssignment(target.Id, store.settings())).toMatchObject({
        role_id: role.id,
        applied_sections: {
          policy: role.revision,
          configuration: role.revision,
          display: role.revision,
        },
      });
    }
    expect(bot.delivered).toHaveLength(3);
  });

  it('expires every linked account and renews only the current allowance', async () => {
    await provision('galleon');
    const all = [linked(1), linked(2), linked(3)];
    for (let index = 0; index < all.length; index++)
      servers.played[all[index]!.Id] = new Set([String(index + 1)]);
    await provision('sloop');
    bot.active = false;
    expect((await event({ action: 'expire', source: 'discord_role' })).status).toBe('applied');
    expect(all.map((user) => user.Policy?.IsDisabled)).toEqual([true, true, true]);
    expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
    bot.active = true;
    expect((await event({ detail: 'Sloop Crewman Plan' })).status).toBe('applied');
    expect(all.map((user) => user.Policy?.IsDisabled)).toEqual([false, true, true]);
    expect((await event({ detail: 'Brigantine Crewman Plan' })).status).toBe('applied');
    expect(all.map((user) => user.Policy?.IsDisabled)).toEqual([false, false, true]);
    expect(all.map((user) => [...servers.played[user.Id]!])).toEqual([['1'], ['2'], ['3']]);
    expect(passwordResets).toEqual([]);
    expect(bot.delivered).toHaveLength(3);
  });

  it('keeps unknown plans and automatic downgrades requiring permission from changing account access', async () => {
    await provision('galleon');
    store.saveSettings({ ...store.settings(), auto_provision: true, auto_disable: false });
    const before = structuredClone(servers.users.jellyfin),
      member = service.memberships.get(owner, store.settings());
    const unknown = await service.recordSubscription({
      id: 'unknown-plan',
      action: 'subscribe',
      discord_user_id: owner,
      source: 'mee6_message',
      detail: 'Future Galleon Promotion',
    });
    expect(unknown.status).toBe('pending');
    expect(unknown.error).toContain('not configured');
    const downgrade = await service.recordSubscription({
      id: 'downgrade',
      action: 'subscribe',
      discord_user_id: owner,
      source: 'mee6_message',
      detail: 'Sloop Crewman Plan',
    });
    expect(downgrade.status).toBe('pending');
    await expect(service.applySubscription('downgrade', true)).rejects.toThrow(
      'administrator review',
    );
    expect(servers.users.jellyfin).toEqual(before);
    expect(service.memberships.get(owner, store.settings())).toEqual(member);
    expect((await service.applySubscription('downgrade')).status).toBe('applied');
    expect([linked(1), linked(2), linked(3)].map((user) => user.Policy?.IsDisabled)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('preserves pinned base usernames after the owner changes their Discord username', async () => {
    await provision('sloop');
    bot.username = 'New.discord.username';
    const job = await provision('galleon');
    expect(job.status).toBe('completed');
    expect(store.linksForMember(owner).map((link) => link.username)).toEqual([
      'Jim',
      'Jim_2',
      'Jim_3',
    ]);
    expect(service.memberships.get(owner, store.settings())?.base_username).toBe('Jim');
    expect(
      servers.users.jellyfin.some((user) => user.Name.startsWith('New.discord.username')),
    ).toBe(false);
  });

  it.each(['Jim_2', 'JIM_2'])(
    'checks all generated usernames before creating any accounts and never claims an existing secondary account %s',
    async (name) => {
      servers.users.jellyfin.push({
        Id: 'someone-elses-account',
        Name: name,
        Policy: { IsAdministrator: false, IsDisabled: false },
        Configuration: { AudioLanguagePreference: 'fr' },
      });
      const before = structuredClone(servers.users.jellyfin);
      await expect(service.provisionMembership(owner, 'brigantine')).rejects.toThrow();
      expect(servers.users.jellyfin).toEqual(before);
      expect(store.linksForMember(owner)).toEqual([]);
      expect(service.memberships.get(owner, store.settings())).toBeNull();
      expect(bot.delivered).toEqual([]);
    },
  );

  it('migrates separate approved sources into membership slots without mixing their histories', async () => {
    for (const [sourceId, username, slot] of [
      ['e-river', 'Jim', 1],
      ['e-sam', 'Simplified.secondary', 2],
    ] as const) {
      const source = servers.users.emby.find((user) => user.Id === sourceId)!;
      service.mappings.save(
        {
          source_user_id: sourceId,
          source_username: source.Name,
          target_user_id: null,
          target_username: username,
          discord_user_id: owner,
          discord_username: bot.username,
          membership_slot: slot,
        },
        store.settings(),
      );
    }
    const job = await provision('brigantine');
    expect(job.status).toBe('completed');
    expect(store.linksForMember(owner).map((link) => link.username)).toEqual([
      'Jim',
      'Simplified.secondary',
    ]);
    expect(servers.played[linked(1).Id]).toEqual(new Set(['1', '2']));
    expect(servers.played[linked(2).Id]).toEqual(new Set(['3']));
    expect(bot.delivered.map((delivery) => delivery.username)).toEqual([
      'Jim',
      'Simplified.secondary',
    ]);
    expect(service.mappings.getForDiscord(owner, store.settings(), 2)?.target_user_id).toBe(
      linked(2).Id,
    );
  });

  it('retries an incomplete secondary creation without duplicating accounts or resending completed slots', async () => {
    const originalFactory = service.clientFactory;
    let failSecondary = true;
    service.clientFactory = (...args) => {
      const client = originalFactory(...args),
        setPolicy = client.setPolicy.bind(client);
      client.setPolicy = async (id, policy) => {
        if (
          failSecondary &&
          servers.users.jellyfin.find((user) => user.Id === id)?.Name === 'Jim_2'
        )
          throw new MediaError('Temporary policy failure.', 503);
        await setPolicy(id, policy);
      };
      return client;
    };
    const partial = await provision('galleon');
    expect(partial.status).toBe('partial');
    expect(partial.results.filter((result) => result.status === 'failed')).toHaveLength(1);
    const initialPassword = passwords.get('Jim_2');
    const secondId = servers.users.jellyfin.find((user) => user.Name === 'Jim_2')!.Id;
    expect(bot.delivered.map((delivery) => delivery.username)).toEqual(['Jim', 'Jim_3']);
    failSecondary = false;
    const retry = await provision('galleon');
    expect(retry.status).toBe('completed');
    expect(servers.users.jellyfin.filter((user) => user.Name.startsWith('Jim'))).toHaveLength(3);
    expect(linked(2).Id).toBe(secondId);
    expect(passwordResets).toEqual([{ id: secondId, password: initialPassword }]);
    expect(bot.delivered.filter((delivery) => delivery.username === 'Jim_2')).toEqual([
      {
        recipient: owner,
        username: 'Jim_2',
        password: initialPassword,
        url: 'https://jellyfin.example',
      },
    ]);
    expect(bot.delivered).toHaveLength(3);
  });

  it('recovers per-account pending suspension after an uncertain remote response and completes the remaining accounts', async () => {
    await provision('galleon');
    const second = linked(2),
      third = linked(3);
    const originalFactory = service.clientFactory;
    let failOnce = true;
    service.clientFactory = (...args) => {
      const client = originalFactory(...args),
        write = client.setPolicy.bind(client);
      client.setPolicy = async (id, policy) => {
        await write(id, policy);
        if (failOnce && id === second.Id && policy.IsDisabled === true) {
          failOnce = false;
          throw new MediaError('Response lost after suspension.', 503);
        }
      };
      return client;
    };
    bot.active = false;
    await service.recordSubscription({
      id: 'expire-partial',
      action: 'expire',
      discord_user_id: owner,
      source: 'discord_role',
    });
    await expect(service.applySubscription('expire-partial')).rejects.toThrow('Response lost');
    expect(store.link(owner, 1)?.disabled_by_jellyport).toBe(1);
    expect(store.link(owner, 2)?.pending_disabled).toBe(1);
    expect(store.link(owner, 3)?.pending_disabled).toBeNull();
    expect(third.Policy?.IsDisabled).toBe(false);
    expect((await service.applySubscription('expire-partial')).status).toBe('applied');
    expect(
      store
        .linksForMember(owner)
        .map((link) => [link.disabled_by_jellyport, link.pending_disabled]),
    ).toEqual([
      [1, null],
      [1, null],
      [1, null],
    ]);
    expect(passwordResets).toEqual([]);
  });

  it('blocks stale membership jobs before their first remote account write', async () => {
    const originalFactory = service.clientFactory;
    let templateReads = 0;
    let notifyBlocked!: () => void, release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve;
    });
    const continueJob = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.clientFactory = (...args) => {
      const client = originalFactory(...args),
        user = client.user.bind(client);
      client.user = async (id) => {
        if (args[2] === 'jellyfin' && id === 'template' && ++templateReads === 2) {
          notifyBlocked();
          await continueJob;
        }
        return user(id);
      };
      return client;
    };
    const job = await service.provisionMembership(owner, 'galleon');
    await blocked;
    const member = service.memberships.get(owner, store.settings())!;
    service.memberships.save({ ...member, active: false }, store.settings(), member.revision);
    release();
    const result = await finish(job);
    expect(result.status).toBe('failed');
    expect(servers.users.jellyfin.filter((user) => user.Name.startsWith('Jim'))).toEqual([]);
    expect(passwords.size).toBe(0);
    expect(bot.delivered).toEqual([]);
  });

  it('preflights every linked target before an expiration can change any account', async () => {
    await provision('galleon');
    linked(2).Policy!.IsAdministrator = true;
    const before = structuredClone(servers.users.jellyfin);
    bot.active = false;
    await service.recordSubscription({
      id: 'protected-expiration',
      action: 'expire',
      discord_user_id: owner,
      source: 'discord_role',
    });
    await expect(service.applySubscription('protected-expiration')).rejects.toThrow('protected');
    expect(servers.users.jellyfin).toEqual(before);
    expect(store.linksForMember(owner).every((link) => link.disabled_by_jellyport === 0)).toBe(
      true,
    );
  });

  it('ignores an older tier announcement after a newer subscription was applied', async () => {
    expect(
      (
        await event({
          id: 'newer',
          detail: 'Galleon Crewman Plan',
          emitted_at: '2026-10-08T12:00:00.000Z',
        })
      ).status,
    ).toBe('applied');
    expect(
      (
        await event({
          id: 'older',
          detail: 'Sloop Crewman Plan',
          emitted_at: '2026-10-07T12:00:00.000Z',
        })
      ).status,
    ).toBe('ignored');
    expect(service.memberships.get(owner, store.settings())?.account_limit).toBe(3);
    expect(
      [linked(1), linked(2), linked(3)].every((user) => user.Policy?.IsDisabled === false),
    ).toBe(true);
  });

  it('does not reconcile retained higher slots back into an active lower membership allowance', async () => {
    await provision('galleon');
    await provision('sloop');
    store.saveSettings({
      ...store.settings(),
      discord_role_events: true,
      discord_member_role_id: '7654321',
      auto_provision: true,
      auto_disable: true,
    });
    const jobsBefore = store.jobs().length;
    await service.reconcileMemberships();
    await service.reconcileMemberships();
    expect(store.subscriptions()).toEqual([]);
    expect(store.jobs()).toHaveLength(jobsBefore);
    expect([linked(1), linked(2), linked(3)].map((user) => user.Policy?.IsDisabled)).toEqual([
      false,
      true,
      true,
    ]);
  });
});
