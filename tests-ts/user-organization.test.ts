import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { Service, type BotAdapter } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import { UserOrganization } from '../server/user-organization.js';
import type { MembershipAccessMode } from '../server/memberships.js';
import type { Settings } from '../server/types.js';

const owner = '123456789';
const other = '987654321';
const embyRole = '666666';
const jellyfinRole = '777777';

class OrganizationBot implements BotAdapter {
  readonly members = new Map<string, { username: string; roles: string[] }>();
  readonly listTagRoles = vi.fn(async () => ({
    can_manage_roles: true,
    roles: [
      { id: embyRole, name: 'Emby only', manageable: true },
      { id: jellyfinRole, name: 'Jellyfin', manageable: true },
    ],
  }));
  readonly memberTagState = vi.fn(async (id: string) => {
    const member = this.members.get(id);
    if (!member) return null;
    return { id, username: member.username, roles: [...member.roles] };
  });
  readonly updateTagRoles = vi.fn(async (id: string, add: string[], remove: string[]) => {
    const member = this.members.get(id);
    if (!member) throw new Error('Missing guild member');
    member.roles = [...new Set([...member.roles.filter((role) => !remove.includes(role)), ...add])];
  });
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string) {
    return { id, username: this.members.get(id)?.username ?? 'unknown' };
  }
  async validateRecipient(_id: string) {}
  readonly sendCredentials = vi.fn(
    async (
      _id: string,
      _username: string,
      _password: string,
      _url: string,
      _requireMembership = true,
    ) => {},
  );
  async membershipActive(_id: string) {
    return false;
  }
  async activeMembers() {
    return [];
  }
}

describe('user directory and informational Discord organization', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  let bot: OrganizationBot, organization: UserOrganization;
  let mediaWrites: string[];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-organization-'));
    store = new Store(directory);
    servers = new DemoServers();
    // The directory must treat known non-admin accounts as ordinary users.
    for (const user of servers.users.emby)
      user.Policy = { IsAdministrator: false, IsDisabled: false };
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'PRIVATE-EMBY-KEY',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'PRIVATE-JELLYFIN-KEY',
      discord_bot_token: 'PRIVATE-DISCORD-TOKEN',
      discord_emby_role_id: embyRole,
      discord_jellyfin_role_id: jellyfinRole,
      // These removal/stale-review fixtures explicitly exercise the optional exclusive mode.
      discord_emby_only_role: true,
      template_user_id: 'template',
    });
    mediaWrites = [];
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        const methods = [
          'createUser',
          'setPassword',
          'setPolicy',
          'setConfiguration',
          'setDisplayPreferences',
          'markPlayed',
          'markFavorite',
          'updateUserData',
          'createPlaylist',
          'addPlaylistItems',
          'setUserImage',
        ] as const;
        const dynamic = client as unknown as Record<string, unknown>;
        for (const method of methods)
          if (typeof dynamic[method] === 'function') {
            dynamic[method] = async () => {
              mediaWrites.push(method);
              throw new Error('Organization must never write a media server');
            };
          }
        return client;
      },
    });
    bot = new OrganizationBot();
    service.bot = bot;
    organization = new UserOrganization(service);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function updateSettings(patch: Partial<Settings>) {
    store.saveSettings({ ...store.settings(), ...patch });
  }
  function membership(id = owner, mode: MembershipAccessMode = 'subscription', name = 'river') {
    bot.members.set(id, { username: name, roles: ['unrelated', 'subscriber'] });
    return service.memberships.save(
      {
        discord_user_id: id,
        base_username: name,
        tier_id: mode === 'complimentary' ? 'complimentary' : 'sloop',
        account_limit: 1,
        access_mode: mode,
      },
      store.settings(),
    );
  }
  function mapping(
    source = 'e-river',
    target: string | null = 'j-river',
    discordId: string | null = owner,
  ) {
    const sourceUser = servers.users.emby.find((user) => user.Id === source)!;
    const targetUser = servers.users.jellyfin.find((user) => user.Id === target);
    return service.mappings.save(
      {
        source_user_id: source,
        source_username: sourceUser.Name,
        target_user_id: target,
        target_username: targetUser?.Name ?? sourceUser.Name,
        discord_user_id: discordId,
        discord_username: discordId
          ? (bot.members.get(discordId)?.username ?? sourceUser.Name)
          : null,
      },
      store.settings(),
    );
  }
  function linked(mode: MembershipAccessMode = 'subscription') {
    membership(owner, mode);
    store.saveLink(owner, 'river', 'j-river');
    return mapping();
  }
  it('skips confirmed Discord departures without revoking family access or blocking other tags', async () => {
    linked('complimentary');
    membership(other, 'subscription', 'alex');
    mapping('e-alex', null, other);
    bot.members.delete(owner);
    const before = structuredClone(servers.users);
    const review = await organization.preview();
    expect(review.unavailable).toBe(1);
    expect(review.changes).toEqual([
      { discord_user_id: other, username: 'alex', add: [embyRole], remove: [] },
    ]);
    expect(await organization.apply(review.token)).toEqual({ updated: 1, failed: 0 });
    expect(bot.updateTagRoles).toHaveBeenCalledExactlyOnceWith(other, [embyRole], []);
    expect(service.memberships.get(owner, store.settings())?.access_mode).toBe('complimentary');
    expect(servers.users).toEqual(before);
    expect(mediaWrites).toEqual([]);
  });
  function bindServer(id = 'demo-jellyfin') {
    const pending = store.resetAuth();
    expect(
      store.completeAuth(
        pending.generation,
        {
          kind: 'configured',
          serverUrl: store.settings().jellyfin_url,
          serverId: id,
          apiKeyName: 'Jellyport',
        },
        (settings) => settings,
      ),
    ).toBe(true);
  }

  it('includes standalone kids and groups unique exact names only as a display aid', async () => {
    servers.users.jellyfin.push({
      Id: 'j-kid',
      Name: 'kid',
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    const result = await organization.directory();
    const river = result.users.find((row) => row.emby.some((account) => account.id === 'e-river'))!;
    expect(river.jellyfin.map((account) => account.id)).toEqual(['j-river']);
    expect(river).toMatchObject({
      discord_user_id: null,
      discord_username: null,
      access_mode: 'standalone',
      account_limit: null,
    });
    expect(
      result.users.find((row) => row.jellyfin.some((account) => account.id === 'j-kid')),
    ).toMatchObject({ access_mode: 'standalone', discord_user_id: null });
    expect(bot.memberTagState).not.toHaveBeenCalled();
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
  });

  it('never derives Discord ownership from a matching current Discord or media username', async () => {
    membership(owner);
    const rows = (await organization.directory()).users;
    const ownerRow = rows.find((row) => row.discord_user_id === owner)!;
    expect(ownerRow.emby).toEqual([]);
    expect(ownerRow.jellyfin).toEqual([]);
    expect(
      rows.find((row) => row.jellyfin.some((account) => account.id === 'j-river'))?.discord_user_id,
    ).toBeNull();
    const preview = await organization.preview();
    expect(preview.changes).toEqual([]);
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
  });

  it('uses confirmed IDs, exposes complimentary and paid modes, and keeps private fields out of DTOs', async () => {
    linked('complimentary');
    membership(other, 'subscription', 'alex');
    mapping('e-alex', null, other);
    servers.users.jellyfin[1]!.Configuration = { Secret: 'PRIVATE-USER-CONFIG' };
    const rows = (await organization.directory()).users;
    expect(rows.find((row) => row.discord_user_id === owner)).toMatchObject({
      access_mode: 'complimentary',
      emby: [{ id: 'e-river', name: 'river', disabled: false }],
      jellyfin: [{ id: 'j-river', name: 'river', disabled: false }],
    });
    expect(rows.find((row) => row.discord_user_id === other)).toMatchObject({
      access_mode: 'subscription',
      account_limit: 1,
      jellyfin: [],
    });
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE-|api_key|bot_token|server_url|Configuration/);
  });

  it('handles approved standalone name differences without inventing a Discord identity', async () => {
    servers.users.jellyfin[1]!.Name = 'simple.family';
    mapping('e-river', 'j-river', null);
    const row = (await organization.directory()).users.find((row) =>
      row.emby.some((account) => account.id === 'e-river'),
    )!;
    expect(row).toMatchObject({ access_mode: 'standalone', discord_user_id: null });
    expect(row.jellyfin[0]?.name).toBe('simple.family');
  });

  it('does not pair duplicate usernames and marks admin, unknown-policy and template accounts protected', async () => {
    servers.users.jellyfin.push({
      Id: 'j-river-duplicate',
      Name: 'river',
      Policy: { IsAdministrator: false },
    });
    servers.users.emby[0]!.Policy = { IsAdministrator: true };
    servers.users.emby[2]!.Policy = {};
    const rows = (await organization.directory()).users;
    expect(
      rows.find((row) => row.emby.some((account) => account.id === 'e-river'))?.jellyfin,
    ).toEqual([]);
    expect(rows.find((row) => row.emby.some((account) => account.id === 'e-alex'))?.protected).toBe(
      true,
    );
    expect(rows.find((row) => row.emby.some((account) => account.id === 'e-sam'))?.protected).toBe(
      true,
    );
    expect(
      rows.find((row) => row.jellyfin.some((account) => account.id === 'template'))?.protected,
    ).toBe(true);
  });

  it('ignores saved ownership when a user ID has been renamed or replaced', async () => {
    linked();
    servers.users.emby[1]!.Name = 'renamed-source';
    servers.users.jellyfin[1]!.Name = 'renamed-target';
    const row = (await organization.directory()).users.find(
      (row) => row.discord_user_id === owner,
    )!;
    expect(row.emby).toEqual([]);
    expect(row.jellyfin).toEqual([]);
  });

  it('does not carry mappings, memberships or legacy links into another configured server scope', async () => {
    linked('complimentary');
    updateSettings({ jellyfin_url: 'http://replacement.example.test' });
    const rows = (await organization.directory()).users;
    expect(rows.some((row) => row.discord_user_id === owner)).toBe(false);
    expect(
      rows.find((row) => row.jellyfin.some((account) => account.id === 'j-river'))?.access_mode,
    ).toBe('standalone');
  });

  it('rejects an authenticated server ID mismatch before any Discord or media writes', async () => {
    linked();
    bindServer('different-server');
    await expect(organization.preview()).rejects.toThrow('paired Jellyfin server changed');
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
    expect(mediaWrites).toEqual([]);
  });

  it('requires a reviewed operation and preserves all account state and unrelated Discord roles', async () => {
    linked('complimentary');
    bot.members.get(owner)!.roles.push(embyRole);
    const serverBefore = structuredClone(servers.users);
    const settingsBefore = store.settings(),
      membershipsBefore = service.memberships.list(settingsBefore),
      linksBefore = store.links();
    const preview = await organization.preview();
    expect(preview.changes).toEqual([
      { discord_user_id: owner, username: 'river', add: [jellyfinRole], remove: [embyRole] },
    ]);
    expect(preview).not.toHaveProperty('fingerprint');
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
    expect(await organization.apply(preview.token)).toEqual({ updated: 1, failed: 0 });
    expect(bot.updateTagRoles).toHaveBeenCalledExactlyOnceWith(owner, [jellyfinRole], [embyRole]);
    expect(bot.members.get(owner)!.roles).toEqual(['unrelated', 'subscriber', jellyfinRole]);
    expect(servers.users).toEqual(serverBefore);
    expect(store.settings()).toEqual(settingsBefore);
    expect(service.memberships.list(settingsBefore)).toEqual(membershipsBefore);
    expect(store.links()).toEqual(linksBefore);
    expect(mediaWrites).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });

  it.each(['emby', 'jellyfin', 'both'] as const)(
    'uses a tag for every confirmed server account by default: %s',
    async (presence) => {
      expect(DEFAULT_SETTINGS.discord_emby_only_role).toBe(false);
      updateSettings({ discord_emby_only_role: DEFAULT_SETTINGS.discord_emby_only_role });
      if (presence === 'both') linked();
      else {
        membership();
        if (presence === 'emby') mapping('e-alex', null);
        else store.saveLink(owner, 'river', 'j-river');
      }
      const preview = await organization.preview();
      expect(preview.changes).toEqual([
        {
          discord_user_id: owner,
          username: 'river',
          add:
            presence === 'both'
              ? [embyRole, jellyfinRole]
              : [presence === 'emby' ? embyRole : jellyfinRole],
          remove: [],
        },
      ]);
      await organization.apply(preview.token);
      expect(bot.members.get(owner)!.roles).toEqual([
        'unrelated',
        'subscriber',
        ...preview.changes[0]!.add,
      ]);
      expect(mediaWrites).toEqual([]);
    },
  );

  it('tags disabled accounts as existing accounts and supports keeping both server tags', async () => {
    linked();
    servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
    updateSettings({ discord_emby_only_role: false });
    const preview = await organization.preview();
    expect(preview.changes[0]).toMatchObject({ add: [embyRole, jellyfinRole], remove: [] });
    expect(
      (await organization.directory()).users.find((row) => row.discord_user_id === owner)
        ?.jellyfin[0]?.disabled,
    ).toBe(true);
  });

  it('tags an explicitly mapped Emby-only member and does not tag unlinked media users', async () => {
    membership(owner, 'complimentary', 'alex');
    mapping('e-alex', null);
    const preview = await organization.preview();
    expect(preview.changes).toEqual([
      { discord_user_id: owner, username: 'alex', add: [embyRole], remove: [] },
    ]);
    expect(preview.unlinked).toBeGreaterThan(0);
    expect(bot.memberTagState).toHaveBeenCalledExactlyOnceWith(owner);
  });

  it('updates only the selected organizational role if one role is not configured', async () => {
    linked();
    updateSettings({ discord_emby_role_id: '' });
    bot.members.get(owner)!.roles.push(embyRole);
    const review = await organization.preview();
    expect(review.changes[0]).toMatchObject({ add: [jellyfinRole], remove: [] });
    await organization.apply(review.token);
    expect(bot.members.get(owner)!.roles).toContain(embyRole);
  });

  it.each(['missing', 'duplicate', 'unsafe', 'permission'])(
    'refuses %s organizational role configuration without writing anything',
    async (kind) => {
      linked();
      if (kind === 'missing')
        updateSettings({ discord_emby_role_id: '', discord_jellyfin_role_id: '' });
      if (kind === 'duplicate') updateSettings({ discord_emby_role_id: jellyfinRole });
      if (kind === 'unsafe')
        bot.listTagRoles.mockResolvedValue({
          can_manage_roles: true,
          roles: [
            { id: embyRole, name: 'Unsafe', manageable: false },
            { id: jellyfinRole, name: 'Jellyfin', manageable: true },
          ],
        });
      if (kind === 'permission')
        bot.listTagRoles.mockResolvedValue({ can_manage_roles: false, roles: [] });
      await expect(organization.preview()).rejects.toThrow();
      expect(bot.updateTagRoles).not.toHaveBeenCalled();
    },
  );

  it('expires reviews after five minutes, consumes used reviews and rejects unknown tokens', async () => {
    linked();
    vi.useFakeTimers();
    const expired = await organization.preview();
    vi.advanceTimersByTime(300_000);
    await expect(organization.apply(expired.token)).rejects.toThrow('expired');
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
    const usable = await organization.preview();
    await organization.apply(usable.token);
    await expect(organization.apply(usable.token)).rejects.toThrow('expired');
    await expect(organization.apply('unknown-token')).rejects.toThrow('expired');
    expect(bot.updateTagRoles).toHaveBeenCalledOnce();
  });

  it.each(['settings', 'mapping', 'account', 'role'])(
    'invalidates a reviewed removal when %s state changes',
    async (kind) => {
      const savedMapping = linked();
      bot.members.get(owner)!.roles.push(embyRole);
      const review = await organization.preview();
      if (kind === 'settings') updateSettings({ discord_emby_only_role: false });
      if (kind === 'mapping')
        service.mappings.save(
          { ...savedMapping, discord_username: 'different-label' },
          store.settings(),
        );
      if (kind === 'account') servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
      if (kind === 'role') bot.members.get(owner)!.roles.push(jellyfinRole);
      await expect(organization.apply(review.token)).rejects.toThrow('changed');
      expect(bot.updateTagRoles).not.toHaveBeenCalled();
      expect(bot.members.get(owner)!.roles).toContain(embyRole);
    },
  );

  it.each(['emby', 'jellyfin'] as const)(
    'preserves roles on a %s catalog failure',
    async (kind) => {
      linked();
      bot.members.get(owner)!.roles.push(embyRole);
      const review = await organization.preview();
      const original = service.clientFactory;
      service.clientFactory = (...args) => {
        const client = original(...args);
        if (args[2] === kind)
          client.users = async () => {
            throw new MediaError('Catalog unavailable');
          };
        return client;
      };
      await expect(organization.apply(review.token)).rejects.toThrow('roles were preserved');
      expect(bot.updateTagRoles).not.toHaveBeenCalled();
      expect(bot.members.get(owner)!.roles).toContain(embyRole);
    },
  );

  it('rejects identity mismatch and unavailable guild members before applying any removal', async () => {
    linked();
    bot.members.get(owner)!.roles.push(embyRole);
    bot.memberTagState.mockResolvedValue({
      id: other,
      username: 'wrong-person',
      roles: [embyRole],
    });
    await expect(organization.preview()).rejects.toThrow('different member');
    bot.memberTagState.mockRejectedValue(new Error('Guild unavailable'));
    await expect(organization.preview()).rejects.toThrow('Guild unavailable');
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
  });

  it('keeps automatic role sync off by default and applies fresh changes only when explicitly enabled', async () => {
    linked();
    expect(DEFAULT_SETTINGS.discord_auto_role_sync).toBe(false);
    await organization.reconcile();
    expect(bot.listTagRoles).not.toHaveBeenCalled();
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
    updateSettings({ discord_auto_role_sync: true });
    await organization.reconcile();
    expect(bot.updateTagRoles).toHaveBeenCalledExactlyOnceWith(owner, [jellyfinRole], []);
    expect(mediaWrites).toEqual([]);
  });

  it('reports role update failures without changing media accounts or sending credentials', async () => {
    linked('complimentary');
    bot.updateTagRoles.mockRejectedValue(new Error('PRIVATE-DISCORD-TOKEN'));
    const review = await organization.preview();
    expect(await organization.apply(review.token)).toEqual({ updated: 0, failed: 1 });
    expect(mediaWrites).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });

  it('refuses writes in demo mode and requires a connected role-capable bot', async () => {
    const demoService = new Service(store, { demo: true, clientFactory: servers.factory });
    demoService.bot = bot;
    const demoOrganization = new UserOrganization(demoService);
    await expect(demoOrganization.preview()).rejects.toThrow('read-only');
    await expect(demoOrganization.apply('unused')).rejects.toThrow('read-only');
    updateSettings({ discord_auto_role_sync: true });
    await demoOrganization.reconcile();
    expect(bot.updateTagRoles).not.toHaveBeenCalled();
    service.bot = null;
    await expect(organization.listTagRoles()).rejects.toThrow('Connect the Discord bot');
    await demoService.stop();
  });

  it.each(['emby', 'jellyfin'] as const)(
    'preserves tags when the selected %s server is not fully configured',
    async (kind) => {
      linked();
      bot.members.get(owner)!.roles.push(embyRole, jellyfinRole);
      updateSettings({ [`${kind}_api_key`]: '' });
      await expect(organization.preview()).rejects.toThrow();
      updateSettings({ discord_auto_role_sync: true });
      await expect(organization.reconcile()).rejects.toThrow();
      expect(bot.updateTagRoles).not.toHaveBeenCalled();
      expect(bot.members.get(owner)!.roles).toContain(embyRole);
      expect(bot.members.get(owner)!.roles).toContain(jellyfinRole);
    },
  );

  it.each(['mapping', 'configuration', 'media failure'])(
    'stops remaining removals if %s changes while an earlier Discord update is pending',
    async (kind) => {
      linked();
      membership(other, 'complimentary', 'sam');
      const secondMapping = mapping('e-sam', null, other);
      bot.members.get(owner)!.roles.push(embyRole);
      bot.members.get(other)!.roles.push(jellyfinRole);
      const review = await organization.preview();
      expect(review.changes).toHaveLength(2);
      let finish!: () => void;
      bot.updateTagRoles.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = organization.apply(review.token);
      const assertion = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(bot.updateTagRoles).toHaveBeenCalledOnce());
      if (kind === 'mapping')
        service.mappings.save(
          { ...secondMapping, discord_username: 'new-confirmed-name' },
          store.settings(),
        );
      if (kind === 'configuration') updateSettings({ discord_emby_only_role: false });
      if (kind === 'media failure') {
        const original = service.clientFactory;
        service.clientFactory = (...args) => {
          const client = original(...args);
          client.users = async () => {
            throw new MediaError('Server disconnected during role update');
          };
          return client;
        };
      }
      finish();
      await assertion;
      expect(bot.updateTagRoles).toHaveBeenCalledOnce();
      expect(bot.members.get(other)!.roles).toContain(jellyfinRole);
      expect(mediaWrites).toEqual([]);
    },
  );
});
