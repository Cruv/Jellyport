import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter, type SubscriptionInput } from '../server/service.js';
import { Store } from '../server/store.js';

const owner = '100001',
  other = '100002';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class SourceBot implements BotAdapter {
  membershipActive = vi.fn(async (_id: string) => true);
  sendCredentials = vi.fn(async () => {});
  recipientIdentity = vi.fn(async (id: string) => ({ id, username: 'river' }));
  status() {
    return { enabled: true, connected: true };
  }
  async validateRecipient(_id: string) {}
  async activeMembers() {
    return [];
  }
}
describe('automatic subscription source changes', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: SourceBot;
  let writes: string[];
  let beforeMediaCall: ((method: string, parameters: unknown[]) => Promise<void>) | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-subscription-source-'));
    store = new Store(directory);
    servers = new DemoServers();
    writes = [];
    beforeMediaCall = undefined;
    store.saveSettings({
      ...store.settings(),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic',
      jellyfin_public_url: 'https://jellyfin.example.test',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '200001',
      new_subscriber_source: 'trusted_messages',
      auto_provision: true,
      auto_disable: false,
      disable_on_cancel: true,
    });
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Name !== 'river');
    servers.users.jellyfin.push({
      Id: 'linked-river',
      Name: 'river',
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    store.saveLink(owner, 'river', 'linked-river', false, 1);
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        return new Proxy(client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return async (...parameters: unknown[]) => {
              await beforeMediaCall?.(String(property), parameters);
              if (
                ['createUser', 'setPolicy', 'setPassword', 'updateUserData', 'markPlayed'].includes(
                  String(property),
                )
              )
                writes.push(String(property));
              return Reflect.apply(value, target, parameters);
            };
          },
        });
      },
    });
    bot = new SourceBot();
    service.bot = bot;
    service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'river',
        tier_id: 'sloop',
        access_mode: 'subscription',
        provision_jellyfin: true,
        account_limit: 1,
        active: true,
      },
      store.settings(),
    );
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it.each([
    ['mee6_message', 'cancel'],
    ['mee6_message', 'expire'],
    ['mee6_message', 'subscribe'],
    ['discord_role', 'expire'],
    ['role_reconciliation', 'expire'],
  ] satisfies Array<[string, SubscriptionInput['action']]>)(
    'keeps automatic %s %s pending when Stripe becomes authoritative while it waits for the event lock',
    async (source, action) => {
      await service.recordSubscription({
        id: 'blocker',
        action: 'expire',
        source: 'discord_role',
        discord_user_id: other,
      });
      const entered = deferred(),
        release = deferred();
      bot.membershipActive.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return true;
      });
      const blocker = service.applySubscription('blocker');
      await entered.promise;
      store.saveSettings({ ...store.settings(), auto_disable: true });
      const cancellation = service.recordSubscription({
        id: 'queued-cancel',
        action,
        source,
        discord_user_id: owner,
        detail: action === 'subscribe' ? 'Sloop Crewman Plan' : undefined,
      });
      expect(store.subscription('queued-cancel')?.status).toBe('pending');
      store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
      release.resolve();
      await blocker;
      expect((await cancellation).status).toBe('pending');
      expect(service.memberships.get(owner, store.settings())?.active).toBe(true);
      expect(
        servers.users.jellyfin.find((user) => user.Id === 'linked-river')?.Policy?.IsDisabled,
      ).toBe(false);
      expect(writes).toEqual([]);
      expect(store.jobs()).toEqual([]);
      expect(bot.sendCredentials).not.toHaveBeenCalled();
    },
  );
  it('preserves explicit administrator approval of a pending non-Stripe cancellation', async () => {
    store.saveSettings({
      ...store.settings(),
      new_subscriber_source: 'stripe',
      auto_disable: true,
    });
    const pending = await service.recordSubscription({
      id: 'admin-cancel',
      action: 'cancel',
      source: 'mee6_message',
      discord_user_id: owner,
    });
    expect(pending.status).toBe('pending');
    expect(writes).toEqual([]);
    expect((await service.applySubscription(pending.id)).status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.active).toBe(false);
    expect(
      servers.users.jellyfin.find((user) => user.Id === 'linked-river')?.Policy?.IsDisabled,
    ).toBe(true);
    expect(writes).toEqual(['setPolicy']);
  });
  it('rechecks the source after waiting for linked account validation before disabling', async () => {
    store.saveSettings({ ...store.settings(), auto_disable: true });
    const entered = deferred(),
      release = deferred();
    beforeMediaCall = async (method, parameters) => {
      if (method !== 'user' || parameters[0] !== 'linked-river') return;
      beforeMediaCall = undefined;
      entered.resolve();
      await release.promise;
    };
    const cancellation = service.recordSubscription({
      id: 'awaited-cancel',
      action: 'cancel',
      source: 'mee6_message',
      discord_user_id: owner,
    });
    await entered.promise;
    store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
    release.resolve();
    expect((await cancellation).status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())?.active).toBe(true);
    expect(writes).toEqual([]);
  });
  it('preserves an already disabled slot but stops the remaining slots when authority changes', async () => {
    servers.users.jellyfin.push({
      Id: 'linked-river-2',
      Name: 'river_2',
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    store.saveLink(owner, 'river_2', 'linked-river-2', false, 2);
    const member = service.memberships.get(owner, store.settings())!;
    service.memberships.save(
      { ...member, tier_id: 'brigantine', account_limit: 2 },
      store.settings(),
      member.revision,
    );
    store.saveSettings({ ...store.settings(), auto_disable: true });
    const entered = deferred(),
      release = deferred();
    let secondSlotReads = 0;
    beforeMediaCall = async (method, parameters) => {
      if (method !== 'user' || parameters[0] !== 'linked-river-2' || ++secondSlotReads !== 2)
        return;
      beforeMediaCall = undefined;
      entered.resolve();
      await release.promise;
    };
    const cancellation = service.recordSubscription({
      id: 'partial-cancel',
      action: 'cancel',
      source: 'mee6_message',
      discord_user_id: owner,
    });
    await entered.promise;
    store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
    release.resolve();
    expect((await cancellation).status).toBe('pending');
    expect(writes).toEqual(['setPolicy']);
    expect(
      servers.users.jellyfin.find((user) => user.Id === 'linked-river')?.Policy?.IsDisabled,
    ).toBe(true);
    expect(
      servers.users.jellyfin.find((user) => user.Id === 'linked-river-2')?.Policy?.IsDisabled,
    ).toBe(false);
    expect(store.link(owner, 1)?.disabled_by_jellyport).toBe(1);
    expect(store.link(owner, 2)?.disabled_by_jellyport).toBe(0);
  });
  it('rechecks the source after a renewal waits for Discord identity validation', async () => {
    const entered = deferred(),
      release = deferred();
    bot.recipientIdentity.mockImplementationOnce(async (id) => {
      entered.resolve();
      await release.promise;
      return { id, username: 'river' };
    });
    const renewal = service.recordSubscription({
      id: 'awaited-renewal',
      action: 'subscribe',
      source: 'mee6_message',
      detail: 'Brigantine Crewman Plan',
      discord_user_id: owner,
    });
    await entered.promise;
    store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
    release.resolve();
    expect((await renewal).status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())?.account_limit).toBe(1);
    expect(store.jobs()).toEqual([]);
    expect(writes).toEqual([]);
  });
  it('pins the automatic source into a queued renewal job and stops later writes after the switch', async () => {
    const entered = deferred(),
      release = deferred();
    beforeMediaCall = async (method, parameters) => {
      if (
        method !== 'user' ||
        parameters[0] !== 'linked-river' ||
        !store.jobs().some((job) => job.status === 'running')
      )
        return;
      beforeMediaCall = undefined;
      entered.resolve();
      await release.promise;
    };
    const renewal = service.recordSubscription({
      id: 'queued-renewal',
      action: 'subscribe',
      source: 'mee6_message',
      detail: 'Brigantine Crewman Plan',
      discord_user_id: owner,
    });
    await entered.promise;
    store.saveSettings({ ...store.settings(), new_subscriber_source: 'stripe' });
    release.resolve();
    const event = await renewal;
    expect(event.status).toBe('pending');
    expect(event.job_id).toBeTruthy();
    expect(service.getJob(event.job_id!).results.some((result) => result.status === 'failed')).toBe(
      true,
    );
    expect(writes).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(servers.users.jellyfin.filter((user) => user.Name.startsWith('river'))).toHaveLength(1);
  });
});
