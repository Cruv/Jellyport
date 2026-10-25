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
  function acceptManual(
    preview: Preview,
    slots: Record<string, number>,
    admissionGuard?: () => void,
  ) {
    return service.migrateUsers(
      preview.users.map((user) => user.source_user_id),
      Object.fromEntries(preview.users.map((user) => [user.source_user_id, owner])),
      Object.fromEntries(
        preview.users.map((user) => [user.source_user_id, user.mapping_revision ?? null]),
      ),
      preview.migration_scope,
      preview.source_snapshot_ids,
      undefined,
      preview.history_only_targets,
      preview.household_targets,
      Object.fromEntries(
        Object.entries(slots).map(([id, slot]) => [
          id,
          { ...preview.owner_assignment_sources![id]!, discord_user_id: owner, slot },
        ]),
      ),
      admissionGuard,
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
    expect(preview.owner_assignment_sources?.['e-second']).toEqual({
      source_username: 'Jim_2',
      server_id: 'demo-emby',
    });
  });

  it('migrates differently named accounts into explicitly reviewed slots for one Discord owner', async () => {
    store.db.exec('DELETE FROM media_ownership');
    servers.users.emby[0]!.Name = 'Cinema-Profile';
    servers.users.emby[1]!.Name = 'Cartoon-Profile';
    bot.roster.complete = false;
    const preview = await service.preview(['e-base', 'e-second']);
    expect(preview.users.every((user) => user.discord_user_id === null)).toBe(true);
    expect(service.mediaOwnerships.list(store.settings())).toHaveLength(0);
    const job = await finish(await acceptManual(preview, { 'e-base': 1, 'e-second': 2 }));
    expect(job.status).toBe('completed');
    expect(job.results.map((result) => result.username)).toEqual([
      'Cinema-Profile',
      'Cartoon-Profile',
    ]);
    expect(
      store.linksForMember(owner).map((link) => [link.username, link.membership_slot]),
    ).toEqual([
      ['Cinema-Profile', 1],
      ['Cartoon-Profile', 2],
    ]);
    for (const [id, slot] of [
      ['e-base', 1],
      ['e-second', 2],
    ] as const)
      expect(service.mediaOwnerships.get('emby', 'demo-emby', id, store.settings())).toMatchObject({
        discord_user_id: owner,
        slot,
      });
    expect(bot.sendCredentials.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [owner, 'Cinema-Profile'],
      [owner, 'Cartoon-Profile'],
    ]);
    expect(reset).not.toHaveBeenCalled();
  });

  it('preserves an ownerless destination mapping while confirming a custom second slot', async () => {
    servers.users.emby[1]!.Name = 'Legacy-Child';
    service.mappings.save(
      {
        source_user_id: 'e-second',
        source_username: 'Legacy-Child',
        target_user_id: null,
        target_username: 'Child-Profile',
        discord_user_id: null,
        discord_username: null,
      },
      store.settings(),
    );
    const mapping = service.mappings.getForSource('e-second', store.settings())!;
    const job = await finish(
      await acceptManual(await service.preview(['e-second']), { 'e-second': 2 }),
    );
    expect(job.results.map((result) => result.error)).toEqual([undefined]);
    expect(job.status).toBe('completed');
    expect(store.link(owner, 2)?.username).toBe('Child-Profile');
    expect(service.mappings.getForSource('e-second', store.settings())).toMatchObject({
      id: mapping.id,
      source_user_id: mapping.source_user_id,
      source_username: mapping.source_username,
      target_username: mapping.target_username,
      target_user_id: store.link(owner, 2)?.remote_id,
      discord_user_id: owner,
      discord_username: 'Jim',
      membership_slot: 2,
    });
    const next = await service.preview(['e-second']);
    expect(next.users[0]).toMatchObject({
      discord_user_id: owner,
      membership_slot: 2,
      owner_basis: 'mapping',
    });
  });

  it('keeps duplicate slot protection when two names are assigned to the same owner slot', async () => {
    servers.users.emby[1]!.Name = 'Separate-Profile';
    const preview = await service.preview(['e-base', 'e-second']);
    await expect(acceptManual(preview, { 'e-base': 1, 'e-second': 1 })).rejects.toThrow(
      'different Discord recipient or approved membership slot',
    );
    expect(store.jobs()).toHaveLength(0);
    expect(service.mediaOwnerships.list(store.settings())).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('adopts an ownerless new-target mapping for its already approved exact source owner and slot', async () => {
    servers.users.emby[1]!.Name = 'Approved-Legacy';
    service.mappings.save(
      {
        source_user_id: 'e-second',
        source_username: 'Approved-Legacy',
        target_user_id: null,
        target_username: 'Approved-Child',
        discord_user_id: null,
        discord_username: null,
      },
      store.settings(),
    );
    register('e-second', owner, 2);
    const sourceOwner = service.mediaOwnerships.get(
      'emby',
      'demo-emby',
      'e-second',
      store.settings(),
    );
    const preview = await service.preview(['e-second']);
    expect(preview.users[0]).toMatchObject({
      discord_user_id: owner,
      membership_slot: 2,
      owner_basis: 'approved',
    });
    const job = await finish(await accept(preview));
    expect(job.results.map((result) => result.error)).toEqual([undefined]);
    expect(job.status).toBe('completed');
    expect(service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings())).toEqual(
      sourceOwner,
    );
    expect(service.mappings.getForSource('e-second', store.settings())).toMatchObject({
      source_user_id: 'e-second',
      source_username: 'Approved-Legacy',
      target_username: 'Approved-Child',
      discord_user_id: owner,
      discord_username: 'Jim',
      membership_slot: 2,
    });
    expect(store.link(owner, 2)?.username).toBe('Approved-Child');
  });

  it.each(['source-owner', 'mapping-owner', 'tier', 'target-slot', 'target-owner', 'source-name'])(
    'rejects a conflicting %s before saving a manual ownership approval',
    async (conflict) => {
      servers.users.emby[1]!.Name = 'Separate-Profile';
      const preview = await service.preview(['e-second']);
      if (conflict === 'source-owner') register('e-second', other, 2);
      else if (conflict === 'mapping-owner') {
        store.db.exec('DELETE FROM media_ownership');
        service.mappings.save(
          {
            source_user_id: 'e-second',
            source_username: 'Separate-Profile',
            target_user_id: null,
            target_username: 'Separate-Profile',
            discord_user_id: owner,
            discord_username: 'Jim',
            membership_slot: 1,
          },
          store.settings(),
        );
      } else if (conflict === 'tier') {
        const member = service.memberships.get(owner, store.settings())!;
        service.memberships.save(
          { ...member, account_limit: 1, tier_id: 'sloop' },
          store.settings(),
          member.revision,
        );
      } else if (conflict === 'target-slot')
        store.saveLink(owner, 'Existing-Profile', 'different-existing', false, 2);
      else if (conflict === 'target-owner') {
        servers.users.jellyfin.push({
          Id: 'owned-target',
          Name: 'Separate-Profile',
          Policy: { IsAdministrator: false, IsDisabled: false },
        });
        service.mediaOwnerships.save(
          [
            {
              kind: 'jellyfin',
              server_id: 'demo-jellyfin',
              account_id: 'owned-target',
              username: 'Separate-Profile',
              discord_user_id: other,
              slot: 2,
            },
          ],
          store.settings(),
        );
      } else servers.users.emby[1]!.Name = 'Renamed-Profile';
      await expect(acceptManual(preview, { 'e-second': 2 })).rejects.toThrow();
      expect(store.jobs()).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
      if (conflict !== 'source-owner')
        expect(
          service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings()),
        ).toBeNull();
    },
  );

  it('rolls back source approvals if queued work cannot be persisted', async () => {
    servers.users.emby[1]!.Name = 'Separate-Profile';
    const preview = await service.preview(['e-second']);
    const save = vi.spyOn(store, 'saveJob').mockImplementationOnce(() => {
      throw new Error('Synthetic queue write failure');
    });
    await expect(acceptManual(preview, { 'e-second': 2 })).rejects.toThrow(
      'Synthetic queue write failure',
    );
    save.mockRestore();
    expect(store.jobs()).toHaveLength(0);
    expect(
      service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings()),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('restores an ownerless mapping and its cached revision after queue persistence rolls back', async () => {
    servers.users.emby[1]!.Name = 'Separate-Profile';
    service.mappings.save(
      {
        source_user_id: 'e-second',
        source_username: 'Separate-Profile',
        target_user_id: null,
        target_username: 'Separate-Profile',
        discord_user_id: null,
        discord_username: null,
      },
      store.settings(),
    );
    const mapping = service.mappings.getForSource('e-second', store.settings())!;
    const preview = await service.preview(['e-second']);
    const save = vi.spyOn(store, 'saveJob').mockImplementationOnce(() => {
      // Populate the cache while the newly approved mapping is still visible.
      expect(service.mappings.get(mapping.id, store.settings())?.discord_user_id).toBe(owner);
      throw new Error('Synthetic persistence failure after mapping approval');
    });
    await expect(acceptManual(preview, { 'e-second': 2 })).rejects.toThrow(
      'Synthetic persistence failure after mapping approval',
    );
    save.mockRestore();
    expect(service.mappings.getForSource('e-second', store.settings())).toEqual(mapping);
    expect(
      service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings()),
    ).toBeNull();
    expect(store.jobs()).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not save approval when a reviewed session expires during Discord verification', async () => {
    servers.users.emby[1]!.Name = 'Separate-Profile';
    const preview = await service.preview(['e-second']);
    let active = true;
    vi.spyOn(bot, 'validateRecipient').mockImplementation(async () => {
      active = false;
    });
    await expect(
      acceptManual(preview, { 'e-second': 2 }, () => {
        if (!active) throw new Error('Synthetic review expired');
      }),
    ).rejects.toThrow('Synthetic review expired');
    expect(store.jobs()).toHaveLength(0);
    expect(
      service.mediaOwnerships.get('emby', 'demo-emby', 'e-second', store.settings()),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
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
