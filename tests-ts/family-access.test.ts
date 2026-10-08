import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import type { AccountProfileKind } from '../server/account-profiles.js';

const owner = '123456789';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FamilyBot implements BotAdapter {
  active = true;
  present = true;
  deliveries: string[] = [];
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string, requireMembership = true) {
    if (!this.present || (requireMembership && !this.active)) throw new Error('Unavailable member');
    return { id, username: 'Jim' };
  }
  async validateRecipient(id: string, requireMembership = true) {
    await this.recipientIdentity(id, requireMembership);
  }
  async sendCredentials(_id: string, username: string) {
    this.deliveries.push(username);
  }
  async membershipActive() {
    return this.present && this.active;
  }
  async activeMembers() {
    return this.present && this.active ? [{ id: owner, username: 'Jim' }] : [];
  }
}

describe('manual per-account family exemptions and account access', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: FamilyBot;
  let writes: Array<{ kind: string; id: string; policy: unknown }>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-family-access-'));
    store = new Store(directory);
    servers = new DemoServers();
    for (const user of servers.users.emby)
      user.Policy = { IsAdministrator: false, IsDisabled: false };
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'https://emby.example',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'https://jellyfin.example',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      jellyfin_public_url: 'https://jellyfin.example',
      template_user_id: 'template',
    });
    writes = [];
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args),
          setPolicy = client.setPolicy.bind(client);
        client.setPolicy = async (id, policy) => {
          writes.push({ kind: args[2] ?? 'jellyfin', id, policy: structuredClone(policy) });
          await setPolicy(id, policy);
        };
        return client;
      },
    });
    bot = new FamilyBot();
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
  async function provision(tier = 'brigantine') {
    return finish(await service.provisionMembership(owner, tier));
  }
  function account(slot = 1) {
    const name = slot === 1 ? 'Jim' : `Jim_${slot}`;
    return servers.users.jellyfin.find((user) => user.Name === name)!;
  }
  async function profile(userId: string, family = true, kind: AccountProfileKind = 'jellyfin') {
    const previous = service.profiles.get(kind, userId, store.settings());
    return service.saveAccountProfile({
      kind,
      user_id: userId,
      family,
      owner_name: 'Private family owner',
      notes: 'Private household notes',
      expected_revision: previous?.revision ?? '',
    });
  }
  async function cancel(id = 'cancel-family-member') {
    await service.recordSubscription({
      id,
      action: 'cancel',
      discord_user_id: owner,
      source: 'mee6_message',
    });
    return service.applySubscription(id);
  }
  function automation() {
    store.saveSettings({
      ...store.settings(),
      auto_disable: true,
      disable_on_cancel: true,
      discord_role_events: true,
      discord_member_role_id: '555555555',
    });
  }

  it('flags only the selected account and never changes paid ownership, media data, or sibling profiles', async () => {
    await provision();
    const before = structuredClone(servers.users),
      member = service.memberships.get(owner, store.settings());
    writes.length = 0;
    const saved = await profile(account(1).Id);
    expect(saved).toMatchObject({ family: true, owner_name: 'Private family owner' });
    expect(service.profiles.get('jellyfin', account(2).Id, store.settings())).toBeNull();
    expect(service.memberships.get(owner, store.settings())).toEqual(member);
    expect(member?.access_mode).toBe('subscription');
    expect(servers.users).toEqual(before);
    expect(writes).toEqual([]);
    expect(JSON.stringify(store.jobs())).not.toMatch(
      /Private family owner|Private household notes/,
    );
  });

  it('cancels only unflagged paid slots while preserving the family account and every sibling profile', async () => {
    await provision('galleon');
    const family = account(2);
    await profile(family.Id);
    const familyLink = store.link(owner, 2);
    writes.length = 0;
    const event = await cancel();
    expect(event.status).toBe('applied');
    expect(account(1).Policy?.IsDisabled).toBe(true);
    expect(family.Policy?.IsDisabled).toBe(false);
    expect(account(3).Policy?.IsDisabled).toBe(true);
    expect(writes.map((write) => write.id)).toEqual([account(1).Id, account(3).Id]);
    expect(store.link(owner, 2)).toEqual(familyLink);
    expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
    expect(event.result).toMatch(/family/i);
  });

  it('preserves the selected family slot on a tier downgrade without exempting its paid sibling', async () => {
    await provision('galleon');
    await profile(account(3).Id);
    writes.length = 0;
    const job = await provision('sloop');
    expect(account(1).Policy?.IsDisabled).toBe(false);
    expect(account(2).Policy?.IsDisabled).toBe(true);
    expect(account(3).Policy?.IsDisabled).toBe(false);
    expect(writes.map((write) => write.id)).toEqual([account(2).Id]);
    expect(job.status).toBe('partial');
    expect(
      job.results.find((result) => result.target_user_id === account(3).Id)?.warnings?.join(' '),
    ).toMatch(/family/i);
  });

  it.each(['missing-role', 'left-discord'])(
    'does not disable a family slot after %s',
    async (reason) => {
      await provision();
      await profile(account(1).Id);
      automation();
      bot.active = false;
      if (reason === 'left-discord') bot.present = false;
      writes.length = 0;
      await service.reconcileMemberships();
      expect(account(1).Policy?.IsDisabled).toBe(false);
      expect(account(2).Policy?.IsDisabled).toBe(true);
      expect(writes.map((write) => write.id)).toEqual([account(2).Id]);
    },
  );

  it('never adopts or reconciles an old pending access write for a family account', async () => {
    await provision();
    await profile(account(1).Id);
    account(1).Policy!.IsDisabled = true;
    store.setLinkPending(owner, true, 1);
    const before = store.link(owner, 1);
    writes.length = 0;
    await provision();
    expect(account(1).Policy?.IsDisabled).toBe(true);
    expect(store.link(owner, 1)).toEqual(before);
    expect(writes.some((write) => write.id === account(1).Id)).toBe(false);
  });

  it('does not automatically restore a previously billing-disabled account merely because it is marked family', async () => {
    await provision('sloop');
    await cancel();
    await profile(account(1).Id);
    writes.length = 0;
    await provision('sloop');
    expect(account(1).Policy?.IsDisabled).toBe(true);
    expect(writes).toEqual([]);
    expect(store.link(owner)?.disabled_by_jellyport).toBe(1);
  });

  it('allows removing a family flag explicitly and then applies the next billing action to that account', async () => {
    await provision('sloop');
    await profile(account(1).Id);
    await profile(account(1).Id, false);
    expect(service.memberships.get(owner, store.settings())?.access_mode).toBe('subscription');
    await cancel();
    expect(account(1).Policy?.IsDisabled).toBe(true);
  });

  it('does not copy an Emby family flag to a migrated Jellyfin destination or grant a whole-owner exemption', async () => {
    await profile('e-sam', true, 'emby');
    service.mappings.save(
      {
        source_user_id: 'e-sam',
        source_username: 'sam',
        target_user_id: null,
        target_username: 'Jim',
        discord_user_id: owner,
        discord_username: 'Jim',
        membership_slot: 1,
      },
      store.settings(),
    );
    await provision('sloop');
    expect(service.profiles.get('jellyfin', account(1).Id, store.settings())).toBeNull();
    expect(service.memberships.get(owner, store.settings())?.access_mode).toBe('subscription');
    expect(servers.played[account(1).Id]).toEqual(new Set(['3']));
    await cancel();
    expect(account(1).Policy?.IsDisabled).toBe(true);
    expect(servers.users.emby.find((user) => user.Id === 'e-sam')?.Policy?.IsDisabled).toBe(false);
  });

  it('leaves standalone non-family users enabled without adopting them through matching Discord names', async () => {
    const job = await finish(await service.createAccount('Jim'));
    automation();
    bot.present = false;
    writes.length = 0;
    await service.reconcileMemberships();
    expect(account(1).Policy?.IsDisabled).toBe(false);
    expect(store.links()).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
    expect(writes).toEqual([]);
    expect(store.takeCredentials(job.id)).toHaveLength(1);
  });

  it('checks the family flag afresh after network reads during a queued downgrade', async () => {
    await provision();
    const target = account(2),
      started = deferred(),
      release = deferred();
    const factory = service.clientFactory;
    let blocked = false;
    service.clientFactory = (...args) => {
      const client = factory(...args),
        user = client.user.bind(client);
      client.user = async (id) => {
        const result = await user(id);
        if (args[2] === 'jellyfin' && id === target.Id && !blocked) {
          blocked = true;
          started.resolve();
          await release.promise;
        }
        return result;
      };
      return client;
    };
    writes.length = 0;
    const job = await service.provisionMembership(owner, 'sloop');
    await started.promise;
    try {
      // Simulate another administrator process persisting the profile while the read is in flight.
      service.profiles.save(
        { kind: 'jellyfin', user_id: target.Id, family: true, owner_name: '', notes: '' },
        store.settings(),
      );
      release.resolve();
      const finished = await finish(job);
      expect(target.Policy?.IsDisabled).toBe(false);
      expect(writes.some((write) => write.id === target.Id)).toBe(false);
      expect(finished.status).toBe('partial');
    } finally {
      release.resolve();
    }
  });

  it.each(['emby', 'jellyfin'] as const)(
    'lets the administrator explicitly disable and restore one %s family account while preserving other policy and activity',
    async (kind) => {
      const target = servers.users[kind].find(
        (user) => user.Id === (kind === 'emby' ? 'e-river' : 'j-river'),
      )!;
      target.Policy = {
        IsAdministrator: false,
        IsDisabled: false,
        EnableAllFolders: false,
        EnabledFolders: ['library-id'],
      };
      target.Configuration = { DisplayMissingEpisodes: true };
      const saved = await profile(target.Id, true, kind),
        before = structuredClone(target),
        played = structuredClone(servers.played);
      writes.length = 0;
      await service.setAccountAccess({
        kind,
        user_id: target.Id,
        disabled: true,
        expected_username: target.Name,
        expected_profile_revision: saved.revision,
      });
      expect(target.Policy).toEqual({ ...before.Policy, IsDisabled: true });
      expect(target.Configuration).toEqual(before.Configuration);
      expect(servers.played).toEqual(played);
      expect(service.profiles.get(kind, target.Id, store.settings())).toEqual(saved);
      await service.setAccountAccess({
        kind,
        user_id: target.Id,
        disabled: false,
        expected_username: target.Name,
        expected_profile_revision: saved.revision,
      });
      expect(target).toEqual(before);
      expect(writes).toHaveLength(2);
      expect(bot.deliveries).toEqual([]);
      expect(store.links()).toEqual([]);
    },
  );

  it('rejects manual access actions using stale profile revisions or a changed username', async () => {
    const saved = await profile('j-river');
    await profile('j-river', false);
    writes.length = 0;
    await expect(
      service.setAccountAccess({
        kind: 'jellyfin',
        user_id: 'j-river',
        disabled: true,
        expected_username: 'river',
        expected_profile_revision: saved.revision,
      }),
    ).rejects.toThrow(/changed|review/i);
    const current = service.profiles.get('jellyfin', 'j-river', store.settings())!;
    await expect(
      service.setAccountAccess({
        kind: 'jellyfin',
        user_id: 'j-river',
        disabled: true,
        expected_username: 'old username',
        expected_profile_revision: current.revision,
      }),
    ).rejects.toThrow(/changed|review/i);
    expect(writes).toEqual([]);
    expect(servers.users.jellyfin.find((user) => user.Id === 'j-river')?.Policy?.IsDisabled).toBe(
      false,
    );
  });

  it('treats an explicit administrator disable as manual even for a paid account, preserving it on renewal', async () => {
    await provision('sloop');
    const target = account(1);
    await service.setAccountAccess({
      kind: 'jellyfin',
      user_id: target.Id,
      disabled: true,
      expected_username: target.Name,
      expected_profile_revision: '',
    });
    expect(store.link(owner)?.disabled_by_jellyport).toBe(0);
    expect(store.link(owner)?.pending_disabled).toBeNull();
    writes.length = 0;
    const job = await provision('sloop');
    expect(target.Policy?.IsDisabled).toBe(true);
    expect(writes).toEqual([]);
    expect(job.status).toBe('partial');
    expect(job.results[0]?.warnings?.join(' ')).toMatch(/outside|administrator/i);
  });

  it('lets the administrator manage standalone family access when Discord is unavailable', async () => {
    bot.present = false;
    const saved = await profile('j-river');
    await service.setAccountAccess({
      kind: 'jellyfin',
      user_id: 'j-river',
      disabled: true,
      expected_username: 'river',
      expected_profile_revision: saved.revision,
    });
    expect(servers.users.jellyfin.find((user) => user.Id === 'j-river')?.Policy?.IsDisabled).toBe(
      true,
    );
    expect(bot.deliveries).toEqual([]);
    expect(store.subscriptions()).toEqual([]);
  });

  it('refuses family flags and access changes for administrator and template accounts', async () => {
    servers.users.jellyfin.push({
      Id: 'server-admin',
      Name: 'Admin',
      Policy: { IsAdministrator: true, IsDisabled: false },
    });
    for (const id of ['template', 'server-admin']) {
      await expect(profile(id)).rejects.toThrow(/protected|administrator|template/i);
      await expect(
        service.setAccountAccess({
          kind: 'jellyfin',
          user_id: id,
          disabled: true,
          expected_username: servers.users.jellyfin.find((user) => user.Id === id)!.Name,
          expected_profile_revision: '',
        }),
      ).rejects.toThrow(/protected|administrator|template/i);
    }
    expect(service.profiles.list(store.settings())).toEqual([]);
    expect(writes).toEqual([]);
  });
});
