import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import type { MediaOwnership } from '../server/media-ownership.js';
import { MediaError } from '../server/errors.js';

const owner = '100001',
  other = '100002';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class OwnershipBot implements BotAdapter {
  readonly delivered = vi.fn(async () => {});
  readonly sendCredentials = this.delivered;
  readonly recipientIdentity = vi.fn(async (id: string) => ({
    id,
    username: id === owner ? 'discord.user' : 'other.user',
  }));
  status() {
    return { enabled: true, connected: true };
  }
  async validateRecipient(_id: string) {}
  async membershipActive(_id: string) {
    return true;
  }
  async activeMembers() {
    return [];
  }
}

describe('approved media ownership in existing migration workflows', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: OwnershipBot;
  let calls: Array<{ kind: string; method: string }>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-ownership-service-'));
    store = new Store(directory);
    servers = new DemoServers();
    servers.played['e-alex'] = new Set(['1', '2', '3']);
    for (const account of servers.users.emby)
      account.Policy = { IsAdministrator: false, IsDisabled: false };
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      template_user_id: 'template',
      discord_guild_id: '123456789012345678',
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
    calls = [];
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args),
          kind = args[2] ?? 'jellyfin';
        return new Proxy(client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return (...parameters: unknown[]) => {
              calls.push({ kind, method: String(property) });
              return Reflect.apply(value, target, parameters);
            };
          },
        });
      },
    });
    bot = new OwnershipBot();
    service.bot = bot;
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function registered(
    kind: 'emby' | 'jellyfin',
    id: string,
    discordId = owner,
    slot = 1,
    fields: Partial<MediaOwnership> = {},
  ) {
    const account = servers.users[kind].find((value) => value.Id === id)!;
    service.mediaOwnerships.save(
      [
        {
          kind,
          server_id: `demo-${kind}`,
          account_id: id,
          username: account.Name,
          discord_user_id: discordId,
          slot,
          ...fields,
        },
      ],
      store.settings(),
    );
  }
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  function mediaWrites() {
    return calls.filter((call) =>
      [
        'createUser',
        'setPassword',
        'setPolicy',
        'setConfiguration',
        'setDisplayPreferences',
        'markPlayed',
        'updateUserData',
        'markFavorite',
      ].includes(call.method),
    );
  }
  function blockTemplate() {
    const blocked = deferred(),
      released = deferred();
    const original = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = original(...args),
        read = client.user.bind(client);
      client.user = async (id) => {
        if (args[2] === 'jellyfin' && id === 'template') {
          blocked.resolve();
          await released.promise;
        }
        return read(id);
      };
      return client;
    };
    return { blocked, released };
  }

  it('prefills the verified Discord owner of an Emby-only account with a different username and no Jellyfin membership', async () => {
    servers.users.emby[0]!.Name = 'Simplified.family';
    registered('emby', 'e-alex');
    const preview = await service.preview(['e-alex']);
    expect(preview.users[0]).toMatchObject({
      source_username: 'Simplified.family',
      username: 'Simplified.family',
      target_exists: false,
      discord_user_id: owner,
      discord_username: 'discord.user',
      membership_slot: 1,
    });
    expect(bot.recipientIdentity).toHaveBeenCalledExactlyOnceWith(owner, false);
    expect(
      calls.filter((call) => call.kind === 'emby' && call.method === 'systemInfo'),
    ).toHaveLength(1);
    expect(mediaWrites()).toEqual([]);
    expect(
      calls.some((call) =>
        ['items', 'catalogItems', 'migrationItems', 'migrationState'].includes(call.method),
      ),
    ).toBe(false);
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(store.membershipRecords()).toEqual([]);
  });

  it('ignores ownership records for a different Emby server and reads server identity only once per preview', async () => {
    registered('emby', 'e-alex', owner, 1, { server_id: 'retired-emby' });
    registered('emby', 'e-sam', owner, 2);
    const preview = await service.preview(['e-alex', 'e-sam']);
    expect(preview.users[0]?.discord_user_id).toBeNull();
    expect(preview.users[1]).toMatchObject({ discord_user_id: owner, membership_slot: 2 });
    expect(
      calls.filter((call) => call.kind === 'emby' && call.method === 'systemInfo'),
    ).toHaveLength(1);
    expect(mediaWrites()).toEqual([]);
  });

  it('keeps a protected history-only migration free of Discord ownership or credential delivery', async () => {
    servers.users.emby[0]!.Name = 'Member template';
    registered('emby', 'e-alex');
    const preview = await service.preview(['e-alex']);
    expect(preview.users[0]).toMatchObject({
      history_only: true,
      target_user_id: 'template',
      discord_user_id: null,
      discord_username: null,
    });
    expect(bot.recipientIdentity).not.toHaveBeenCalled();
    expect(store.links()).toEqual([]);
    expect(mediaWrites()).toEqual([]);
  });

  it('rejects a recipient that conflicts with the approved Emby owner before creating a job or reading history', async () => {
    registered('emby', 'e-alex');
    await expect(service.migrateUsers(['e-alex'], { 'e-alex': other })).rejects.toThrow(
      'approved owner',
    );
    expect(store.jobs()).toEqual([]);
    expect(mediaWrites()).toEqual([]);
    expect(
      calls.some((call) =>
        ['items', 'catalogItems', 'migrationItems', 'migrationState'].includes(call.method),
      ),
    ).toBe(false);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it('pins the Emby server at explicit owner admission and rejects a replacement before reading history or creating an account', async () => {
    servers.users.emby.find((user) => user.Id === 'e-alex')!.Name = 'discord.user';
    const factory = service.clientFactory;
    let sourceIdentityReads = 0;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'emby') {
        const systemInfo = client.systemInfo.bind(client);
        client.systemInfo = async () => {
          const info = await systemInfo();
          return ++sourceIdentityReads === 1 ? info : { ...info, Id: 'replacement-emby' };
        };
      }
      return client;
    };
    const job = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': owner }));
    expect(job.status).toBe('failed');
    expect(sourceIdentityReads).toBe(2);
    expect(service.mediaOwnerships.list(store.settings())).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(mediaWrites()).toEqual([]);
    expect(
      calls.some((call) =>
        ['catalogItems', 'migrationState', 'migrationItems', 'items'].includes(call.method),
      ),
    ).toBe(false);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it('permits an explicitly approved migration and credential delivery for a verified source username exception', async () => {
    registered('emby', 'e-alex');
    const result = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': owner }));
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.results[0]).toMatchObject({
      username: 'alex',
      created: true,
      discord_delivery: 'sent',
    });
    expect(bot.delivered).toHaveBeenCalledOnce();
    expect(store.link(owner)?.username).toBe('alex');
    expect(store.membershipRecords()).toEqual([]);
  });

  it.each(['changed', 'added'])(
    'rejects source ownership %s while queued before account writes or history enumeration',
    async (change) => {
      if (change === 'changed') registered('emby', 'e-alex');
      const gate = blockTemplate();
      const job = await service.migrateUsers(['e-alex'], { 'e-alex': owner });
      await gate.blocked.promise;
      registered('emby', 'e-alex', other);
      gate.released.resolve();
      const result = await finish(job);
      expect(result.status).toBe('failed');
      expect(JSON.stringify(result)).toContain('ownership changed');
      expect(mediaWrites()).toEqual([]);
      expect(
        calls.some((call) =>
          ['items', 'catalogItems', 'migrationItems', 'migrationState'].includes(call.method),
        ),
      ).toBe(false);
      expect(store.links()).toEqual([]);
      expect(bot.delivered).not.toHaveBeenCalled();
    },
  );

  it('does not cancel a queued migration merely because the identical ownership decision is approved again', async () => {
    registered('emby', 'e-alex');
    const gate = blockTemplate();
    const job = await service.migrateUsers(['e-alex'], { 'e-alex': owner });
    await gate.blocked.promise;
    registered('emby', 'e-alex');
    gate.released.resolve();
    const result = await finish(job);
    expect(result.status, JSON.stringify(result)).toBe('completed');
  });

  it('prevents migration into a same-name Jellyfin account assigned to a different confirmed Discord owner', async () => {
    registered('emby', 'e-river');
    registered('jellyfin', 'j-river', other);
    const before = structuredClone(servers.played['j-river']);
    const result = await finish(await service.migrateUsers(['e-river'], { 'e-river': owner }));
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('different approved Discord owner');
    expect(mediaWrites()).toEqual([]);
    expect(servers.played['j-river']).toEqual(before);
    expect(store.links()).toEqual([]);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it('requires a mapping when the approved owner already has a differently named Jellyfin account in the slot', async () => {
    registered('emby', 'e-alex');
    registered('jellyfin', 'j-river');
    const result = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': owner }));
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('user mapping');
    expect(mediaWrites()).toEqual([]);
    expect(bot.delivered).not.toHaveBeenCalled();
    expect(store.links()).toEqual([]);
  });

  it('rechecks an existing target ownership record after an awaited provisioning read before played-state writes', async () => {
    registered('emby', 'e-river');
    registered('jellyfin', 'j-river');
    const original = service.clientFactory;
    const blocked = deferred(),
      released = deferred();
    let targetLists = 0;
    service.clientFactory = (...args) => {
      const client = original(...args),
        read = client.users.bind(client);
      client.users = async () => {
        if (args[2] === 'jellyfin' && ++targetLists === 2) {
          blocked.resolve();
          await released.promise;
        }
        return read();
      };
      return client;
    };
    const job = await service.migrateUsers(['e-river'], { 'e-river': owner });
    await blocked.promise;
    registered('jellyfin', 'j-river', other);
    released.resolve();
    const result = await finish(job);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('Jellyfin account ownership changed');
    expect(mediaWrites()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it('rechecks source ownership immediately before credential delivery and retains private recovery credentials', async () => {
    registered('emby', 'e-alex');
    let validations = 0;
    bot.validateRecipient = async () => {
      if (++validations === 2) registered('emby', 'e-alex', other);
    };
    const result = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': owner }));
    expect(result.results[0]).toMatchObject({ created: true, discord_delivery: 'failed' });
    expect(bot.delivered).not.toHaveBeenCalled();
    expect(store.takeCredentials(result.id)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('stops configuration and played writes if a newly created target is assigned another owner before configuration', async () => {
    registered('emby', 'e-alex');
    const original = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = original(...args),
        create = client.createUser.bind(client);
      client.createUser = async (username, password) => {
        const target = await create(username, password);
        registered('jellyfin', target.Id, other);
        return target;
      };
      return client;
    };
    const result = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': owner }));
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('different approved owner');
    expect(mediaWrites().length).toBeGreaterThan(0);
    expect(mediaWrites().every((call) => call.method === 'createUser')).toBe(true);
    expect(servers.users.jellyfin.filter((account) => account.Name === 'alex')).toHaveLength(1);
    expect(store.account('alex')).toMatchObject({ status: 'provisioning' });
    expect(store.links()).toEqual([]);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it.each(['owner', 'slot'])(
    'blocks a legacy billing access change when the registry has a contradictory %s',
    async (conflict) => {
      store.saveLink(owner, 'river', 'j-river', false, 1);
      registered(
        'jellyfin',
        'j-river',
        conflict === 'owner' ? other : owner,
        conflict === 'slot' ? 2 : 1,
      );
      const before = structuredClone(servers.users.jellyfin);
      await service.recordSubscription({
        id: 'legacy-expire',
        action: 'expire',
        discord_user_id: owner,
        source: 'mee6_message',
      });
      await expect(service.applySubscription('legacy-expire')).rejects.toThrow(
        'approved media owner or slot',
      );
      expect(servers.users.jellyfin).toEqual(before);
      expect(mediaWrites()).toEqual([]);
      expect(store.link(owner)).toMatchObject({ disabled_by_jellyport: 0, pending_disabled: null });
      expect(bot.delivered).not.toHaveBeenCalled();
    },
  );

  it('preserves an explicitly adopted legacy membership lifecycle when the registry agrees', async () => {
    store.saveLink(owner, 'river', 'j-river', false, 1);
    registered('jellyfin', 'j-river');
    await service.recordSubscription({
      id: 'agreed-expire',
      action: 'expire',
      discord_user_id: owner,
      source: 'mee6_message',
    });
    expect((await service.applySubscription('agreed-expire')).status).toBe('applied');
    expect(
      servers.users.jellyfin.find((account) => account.Id === 'j-river')?.Policy?.IsDisabled,
    ).toBe(true);
    expect(store.link(owner)?.disabled_by_jellyport).toBe(1);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it('keeps approved ownership and its slot through an exact-ID rename so existing billing access still works', async () => {
    store.saveLink(owner, 'river', 'j-river', false, 2);
    registered('jellyfin', 'j-river', owner, 2);
    registered('emby', 'e-river', owner, 2);
    const before = service.mediaOwnerships.get(
      'jellyfin',
      'demo-jellyfin',
      'j-river',
      store.settings(),
    )!;
    const source = service.mediaOwnerships.get('emby', 'demo-emby', 'e-river', store.settings());
    const preferences = structuredClone(
      servers.users.jellyfin.find((account) => account.Id === 'j-river')!.Configuration,
    );
    await service.renameAccount({
      user_id: 'j-river',
      expected_username: 'river',
      username: 'RiverRenamed',
    });
    expect(
      service.mediaOwnerships.get('jellyfin', 'demo-jellyfin', 'j-river', store.settings()),
    ).toEqual({ ...before, username: 'RiverRenamed' });
    expect(service.mediaOwnerships.get('emby', 'demo-emby', 'e-river', store.settings())).toEqual(
      source,
    );
    expect(store.link(owner, 2)).toMatchObject({
      username: 'RiverRenamed',
      membership_slot: 2,
      discord_user_id: owner,
      remote_id: 'j-river',
    });
    expect(
      servers.users.jellyfin.find((account) => account.Id === 'j-river')?.Configuration,
    ).toEqual(preferences);
    await service.recordSubscription({
      id: 'renamed-expire',
      action: 'expire',
      discord_user_id: owner,
      source: 'mee6_message',
    });
    expect((await service.applySubscription('renamed-expire')).status).toBe('applied');
    expect(
      servers.users.jellyfin.find((account) => account.Id === 'j-river')?.Policy?.IsDisabled,
    ).toBe(true);
    expect(store.link(owner, 2)?.disabled_by_jellyport).toBe(1);
    expect(bot.delivered).not.toHaveBeenCalled();
  });

  it('updates the existing ownership label only after uncertain rename readback is recovered without repeating the remote rename', async () => {
    store.saveLink(owner, 'river', 'j-river', false, 1);
    registered('jellyfin', 'j-river');
    const before = service.mediaOwnerships.get(
      'jellyfin',
      'demo-jellyfin',
      'j-river',
      store.settings(),
    )!;
    const original = service.clientFactory;
    let failReadback = false,
      renames = 0;
    service.clientFactory = (...args) => {
      const client = original(...args),
        rename = client.renameUser!.bind(client),
        read = client.user.bind(client);
      client.renameUser = async (...parameters) => {
        renames++;
        await rename(...parameters);
        failReadback = true;
        throw new MediaError('Synthetic lost rename response');
      };
      client.user = async (id) => {
        if (failReadback) {
          failReadback = false;
          throw new MediaError('Synthetic readback timeout');
        }
        return read(id);
      };
      return client;
    };
    const request = { user_id: 'j-river', expected_username: 'river', username: 'RiverRecovered' };
    await expect(service.renameAccount(request)).rejects.toThrow('outcome is uncertain');
    expect(renames).toBe(1);
    expect(
      service.mediaOwnerships.get('jellyfin', 'demo-jellyfin', 'j-river', store.settings()),
    ).toEqual(before);
    expect(store.link(owner)?.username).toBe('river');
    expect((await service.renameAccountRecovery('j-river')).pending?.can_confirm).toBe(true);
    await service.renameAccount(request);
    expect(renames).toBe(1);
    expect(
      service.mediaOwnerships.get('jellyfin', 'demo-jellyfin', 'j-river', store.settings()),
    ).toEqual({ ...before, username: 'RiverRecovered' });
    expect(await service.renameAccountRecovery('j-river')).toEqual({ pending: null });
    await service.recordSubscription({
      id: 'recovered-expire',
      action: 'expire',
      discord_user_id: owner,
      source: 'mee6_message',
    });
    expect((await service.applySubscription('recovered-expire')).status).toBe('applied');
    expect(store.link(owner)?.disabled_by_jellyport).toBe(1);
  });

  it('rejects an unexpected registry label before sending a rename or creating an uncertain pin', async () => {
    registered('jellyfin', 'j-river', owner, 1, { username: 'unexpected-label' });
    await expect(
      service.renameAccount({
        user_id: 'j-river',
        expected_username: 'river',
        username: 'Renamed',
      }),
    ).rejects.toThrow('approved media account label changed');
    expect(calls.filter((call) => call.method === 'renameUser')).toEqual([]);
    expect(service.renames.get('j-river', store.settings())).toBeNull();
    expect(servers.users.jellyfin.find((account) => account.Id === 'j-river')?.Name).toBe('river');
  });

  it.each(['other_server', 'other_scope'])(
    'keeps an unrelated %s ownership record unchanged during rename',
    async (scope) => {
      const settings = store.settings();
      const unrelatedSettings =
        scope === 'other_scope'
          ? { ...settings, discord_guild_id: '987654321012345678' }
          : settings;
      const serverId = scope === 'other_server' ? 'retired-jellyfin' : 'demo-jellyfin';
      service.mediaOwnerships.save(
        [
          {
            kind: 'jellyfin',
            server_id: serverId,
            account_id: 'j-river',
            username: 'UnrelatedLabel',
            discord_user_id: other,
            slot: 3,
          },
        ],
        unrelatedSettings,
      );
      const before = service.mediaOwnerships.get(
        'jellyfin',
        serverId,
        'j-river',
        unrelatedSettings,
      );
      await service.renameAccount({
        user_id: 'j-river',
        expected_username: 'river',
        username: 'UnrelatedLabel',
      });
      expect(
        service.mediaOwnerships.get('jellyfin', serverId, 'j-river', unrelatedSettings),
      ).toEqual(before);
      expect(
        service.mediaOwnerships.get('jellyfin', 'demo-jellyfin', 'j-river', settings),
      ).toBeNull();
      expect(store.links()).toEqual([]);
      expect(servers.users.jellyfin.find((account) => account.Id === 'j-river')?.Name).toBe(
        'UnrelatedLabel',
      );
    },
  );
});
