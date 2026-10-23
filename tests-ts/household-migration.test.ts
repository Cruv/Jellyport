import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import type { IdentityRoster } from '../server/identity-review-types.js';

const owner = '123456789012345678';
const other = '223456789012345678';
const sources = ['e-base', 'e-second', 'e-third'];

class HouseholdBot implements BotAdapter {
  roster: IdentityRoster = {
    members: [{ id: owner, username: 'Jim', roles: [] }],
    complete: true,
    fetched_at: new Date().toISOString(),
  };
  readonly sendCredentials = vi.fn(async (_id: string, _username: string, _password: string) => {});
  readonly listIdentityMembers = vi.fn(async () => structuredClone(this.roster));
  status() {
    return { enabled: true, connected: true };
  }
  async validateRecipient(_id: string) {}
  async recipientIdentity(id: string) {
    const member = this.roster.members.find((entry) => entry.id === id);
    if (!member) throw new Error('Synthetic member missing');
    return { id, username: member.username };
  }
  async membershipActive(_id: string) {
    return true;
  }
  async activeMembers() {
    return this.roster.members;
  }
}

describe('reviewed household source accounts', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: HouseholdBot;
  let create: Mock<(username: string, password: string) => void>;
  let reset: Mock<(id: string, password: string) => void>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-synthetic-household-'));
    store = new Store(directory);
    servers = new DemoServers();
    servers.users.emby = sources.map((Id, index) => ({
      Id,
      Name: index ? `Jim_${index + 1}` : 'Jim',
      Policy: { IsAdministrator: false, IsDisabled: false },
    }));
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id === 'template');
    servers.media = [1, 2, 3].map((number) => ({
      Id: String(number),
      Name: `Synthetic household movie ${number}`,
      Type: 'Movie',
      ProviderIds: { Tmdb: `synthetic-${number}` },
    }));
    servers.played = Object.fromEntries(
      sources.map((id, index) => [id, new Set([String(index + 1)])]),
    );
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      jellyfin_public_url: 'https://jellyfin.example.test',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '323456789012345678',
    });
    const pending = store.ensureAuthState();
    if (pending.kind !== 'pending') throw new Error('Expected synthetic setup');
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
    create = vi.fn();
    reset = vi.fn();
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        const createUser = client.createUser.bind(client);
        const setPassword = client.setPassword.bind(client);
        client.createUser = async (username, password) => {
          create(username, password);
          return createUser(username, password);
        };
        client.setPassword = async (id, password) => {
          reset(id, password);
          return setPassword(id, password);
        };
        return client;
      },
    });
    bot = new HouseholdBot();
    service.bot = bot;
    service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'Jim',
        tier_id: 'galleon',
        account_limit: 3,
        active: true,
        provision_jellyfin: true,
      },
      store.settings(),
    );
    register('e-base', owner, 1);
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function register(id: string, discordId: string, slot: number) {
    const account = servers.users.emby.find((user) => user.Id === id)!;
    service.mediaOwnerships.save(
      [
        {
          kind: 'emby',
          server_id: 'demo-emby',
          account_id: id,
          username: account.Name,
          discord_user_id: discordId,
          slot,
        },
      ],
      store.settings(),
    );
  }
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  type Preview = Awaited<ReturnType<Service['preview']>>;
  function accept(preview: Preview) {
    return service.migrateUsers(
      preview.users.map((user) => user.source_user_id),
      Object.fromEntries(
        preview.users
          .filter((user) => user.discord_user_id)
          .map((user) => [user.source_user_id, user.discord_user_id!]),
      ),
      Object.fromEntries(
        preview.users.map((user) => [user.source_user_id, user.mapping_revision ?? null]),
      ),
      preview.migration_scope,
      preview.source_snapshot_ids,
      undefined,
      preview.history_only_targets,
      preview.household_targets,
    );
  }

  it('suggests numbered accounts from a complete roster without approving ownership or reading history', async () => {
    const preview = await service.preview(sources);
    expect(
      preview.users.map((user) => [
        user.source_username,
        user.discord_user_id,
        user.membership_slot,
        user.owner_basis,
      ]),
    ).toEqual([
      ['Jim', owner, 1, 'approved'],
      ['Jim_2', owner, 2, 'numbered_suggestion'],
      ['Jim_3', owner, 3, 'numbered_suggestion'],
    ]);
    expect(preview.household_targets).toEqual({
      'e-second': {
        source_username: 'Jim_2',
        discord_user_id: owner,
        discord_username: 'Jim',
        slot: 2,
        server_id: 'demo-emby',
      },
      'e-third': {
        source_username: 'Jim_3',
        discord_user_id: owner,
        discord_username: 'Jim',
        slot: 3,
        server_id: 'demo-emby',
      },
    });
    expect(service.mediaOwnerships.list(store.settings())).toHaveLength(1);
    expect(store.jobs()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });

  it('never strips a real Discord username suffix to give that account to another member', async () => {
    bot.roster.members.push({ id: other, username: 'Jim_2', roles: [] });
    const preview = await service.preview(['e-second', 'e-third']);
    expect(preview.users[0]?.discord_user_id).toBeNull();
    expect(preview.household_targets?.['e-second']).toBeUndefined();
    expect(preview.household_targets?.['e-third']).toMatchObject({
      discord_user_id: owner,
      slot: 3,
    });
  });

  it('does not suggest household ownership from an incomplete roster', async () => {
    bot.roster.complete = false;
    const preview = await service.preview(['e-second', 'e-third']);
    expect(preview.users.every((user) => user.discord_user_id === null)).toBe(true);
    expect(preview.household_targets).toBeUndefined();
  });

  it('honors a reviewed legacy naming alias without renaming its existing source account', async () => {
    store.saveSettings({
      ...store.settings(),
      account_name_additional: '{username}-slot-{slot}',
      account_name_aliases: ['{username}_{slot}'],
    });
    const preview = await service.preview(['e-second']);
    expect(preview.household_targets?.['e-second']).toMatchObject({
      source_username: 'Jim_2',
      discord_user_id: owner,
      slot: 2,
    });
    const job = await finish(await accept(preview));
    expect(job.status).toBe('completed');
    expect(store.link(owner, 2)?.username).toBe('Jim_2');
    expect(bot.sendCredentials.mock.calls[0]?.slice(0, 2)).toEqual([owner, 'Jim_2']);
    expect(servers.users.emby[1]?.Name).toBe('Jim_2');
    expect(servers.users.jellyfin.some((account) => account.Name === 'Jim-slot-2')).toBe(false);
  });

  it('keeps three independent histories and sends every new account password only to the household owner', async () => {
    const preview = await service.preview(sources);
    const job = await finish(await accept(preview));
    expect(job.status).toBe('completed');
    expect(
      job.results.map((result) => [result.username, result.created, result.discord_delivery]),
    ).toEqual([
      ['Jim', true, 'sent'],
      ['Jim_2', true, 'sent'],
      ['Jim_3', true, 'sent'],
    ]);
    expect(
      store.linksForMember(owner).map((link) => [link.username, link.membership_slot]),
    ).toEqual([
      ['Jim', 1],
      ['Jim_2', 2],
      ['Jim_3', 3],
    ]);
    for (let index = 0; index < 3; index++) {
      const link = store.link(owner, index + 1)!;
      expect([...servers.played[link.remote_id]!]).toEqual([String(index + 1)]);
      expect(
        service.mediaOwnerships.get('emby', 'demo-emby', sources[index]!, store.settings()),
      ).toMatchObject({ discord_user_id: owner, slot: index + 1 });
      expect(
        service.mediaOwnerships.get('jellyfin', 'demo-jellyfin', link.remote_id, store.settings()),
      ).toMatchObject({
        username: link.username,
        discord_user_id: owner,
        slot: index + 1,
      });
      expect(bot.sendCredentials.mock.calls[index]?.slice(0, 2)).toEqual([owner, link.username]);
    }
    expect(create).toHaveBeenCalledTimes(3);
    expect(new Set(bot.sendCredentials.mock.calls.map((call) => call[2])).size).toBe(3);
    expect(reset).not.toHaveBeenCalled();
  });

  it('preserves an existing secondary account password and does not send a replacement DM', async () => {
    servers.users.jellyfin.push({
      Id: 'existing-secondary',
      Name: 'Jim_2',
      Policy: { IsAdministrator: false, IsDisabled: false },
      Configuration: {},
    });
    const job = await finish(await accept(await service.preview(['e-second'])));
    expect(job.status).toBe('completed');
    expect(job.results[0]).toMatchObject({
      username: 'Jim_2',
      target_user_id: 'existing-secondary',
      created: false,
      discord_delivery: 'skipped_existing_account',
    });
    expect([...servers.played['existing-secondary']!]).toEqual(['2']);
    expect(create).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(
      service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings()),
    ).toMatchObject({ discord_user_id: owner, slot: 2 });
    expect(
      service.mediaOwnerships.get(
        'jellyfin',
        'demo-jellyfin',
        'existing-secondary',
        store.settings(),
      ),
    ).toMatchObject({ discord_user_id: owner, slot: 2, username: 'Jim_2' });
  });

  it.each(['quota', 'source-name', 'owner', 'mapping', 'occupied-slot'])(
    'rejects changed %s authority before accepting ownership, creating accounts or sending credentials',
    async (change) => {
      const preview = await service.preview(['e-second']);
      if (change === 'quota') {
        const member = service.memberships.get(owner, store.settings())!;
        service.memberships.save(
          { ...member, tier_id: 'sloop', account_limit: 1 },
          store.settings(),
          member.revision,
        );
      } else if (change === 'source-name') servers.users.emby[1]!.Name = 'Renamed_2';
      else if (change === 'owner') register('e-second', other, 2);
      else if (change === 'mapping')
        service.mappings.save(
          {
            source_user_id: 'e-second',
            source_username: 'Jim_2',
            target_user_id: null,
            target_username: 'Jim_2',
            discord_user_id: owner,
            discord_username: 'Jim',
            membership_slot: 2,
          },
          store.settings(),
        );
      else {
        servers.users.emby.push({
          Id: 'occupied',
          Name: 'Other source',
          Policy: { IsAdministrator: false, IsDisabled: false },
        });
        register('occupied', owner, 2);
      }
      await expect(accept(preview)).rejects.toThrow(/slot|changed|mapping|owner/i);
      expect(store.jobs()).toEqual([]);
      expect(create).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      expect(bot.sendCredentials).not.toHaveBeenCalled();
      if (!['owner'].includes(change))
        expect(
          service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings()),
        ).toBeNull();
    },
  );

  it('invalidates a suggested household recipient when the Discord roster identity changes before acceptance', async () => {
    const preview = await service.preview(['e-second']);
    bot.roster.members[0]!.username = 'RenamedDiscord';
    await expect(accept(preview)).rejects.toThrow('suggested household owner changed');
    expect(create).not.toHaveBeenCalled();
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });
});
