import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { Service, type BotAdapter, type SubscriptionInput } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';

const owner = '100001';
class SignupBot implements BotAdapter {
  username = 'new.member';
  active: boolean | null = true;
  joined_at: string | undefined = new Date().toISOString();
  sendCredentials = vi.fn(
    async (_id: string, _username: string, _password: string, _url: string) => {},
  );
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string) {
    return { id, username: this.username, joined_at: this.joined_at };
  }
  async validateRecipient(_id: string) {}
  async membershipActive(_id: string) {
    return this.active;
  }
  async activeMembers() {
    return [{ id: owner, username: this.username }];
  }
}

describe('future new-subscriber automatic Jellyfin onboarding', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: SignupBot;
  let calls: Array<{ kind: string; method: string }>;
  let embyRead: (() => Promise<void>) | undefined;
  let jellyfinRead: (() => Promise<void>) | undefined;
  let creates: string[];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
    directory = mkdtempSync(join(tmpdir(), 'jellyport-new-signup-'));
    store = new Store(directory);
    servers = new DemoServers();
    calls = [];
    creates = [];
    embyRead = undefined;
    jellyfinRead = undefined;
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      discord_enabled: true,
      discord_message_events: true,
      discord_guild_id: '200001',
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      jellyfin_public_url: 'https://jellyfin.example.test',
      template_user_id: 'template',
      auto_provision: true,
      auto_create_new_subscribers: true,
    });
    vi.setSystemTime(new Date('2026-10-22T12:00:01.000Z'));
    bot = new SignupBot();
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args),
          kind = args[2] ?? 'jellyfin';
        return new Proxy(client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return async (...parameters: unknown[]) => {
              calls.push({ kind, method: String(property) });
              if (kind === 'emby' && property === 'users') await embyRead?.();
              if (kind === 'jellyfin' && property === 'users') await jellyfinRead?.();
              if (property === 'createUser') creates.push(String(parameters[0]));
              if (kind === 'emby' && !['users', 'close'].includes(String(property)))
                throw new Error('Automatic onboarding must not read source history or catalogs');
              return Reflect.apply(value, target, parameters);
            };
          },
        });
      },
    });
    service.bot = bot;
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });
  async function signup(overrides: Partial<SubscriptionInput> = {}) {
    return service.recordSubscription({
      id: `signup-${store.subscriptions().length + 1}`,
      action: 'subscribe',
      discord_user_id: owner,
      username: bot.username,
      source: 'mee6_message',
      detail: 'Sloop Crewman Plan',
      emitted_at: new Date().toISOString(),
      ...overrides,
    });
  }
  function noAccounts() {
    expect(creates).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(
      calls
        .filter((call) => call.kind === 'emby')
        .every((call) => ['users', 'close'].includes(call.method)),
    ).toBe(true);
  }

  it.each([
    ['Sloop Crewman Plan', 1],
    ['Brigantine Crewman Plan', 2],
    ['Galleon Crewman Plan', 3],
  ])('creates and privately delivers all %s slots without history reads', async (detail, limit) => {
    const event = await signup({ detail });
    expect(event.status).toBe('applied');
    expect(event.job_id).toBeTruthy();
    expect(creates).toEqual(
      Array.from({ length: Number(limit) }, (_, index) =>
        index ? `${bot.username}_${index + 1}` : bot.username,
      ),
    );
    expect(store.links()).toHaveLength(Number(limit));
    expect(bot.sendCredentials).toHaveBeenCalledTimes(Number(limit));
    for (const [id, username, password, url] of bot.sendCredentials.mock.calls) {
      expect(id).toBe(owner);
      expect(creates).toContain(username);
      expect(password).toMatch(/^[A-Za-z0-9]{12}$/);
      expect(url).toBe('https://jellyfin.example.test');
    }
    expect(new Set(bot.sendCredentials.mock.calls.map((call) => call[2])).size).toBe(Number(limit));
    expect(service.memberships.get(owner, store.settings())).toMatchObject({
      provision_jellyfin: true,
      account_limit: Number(limit),
    });
    expect(
      calls
        .filter((call) => call.kind === 'emby')
        .every((call) => ['users', 'close'].includes(call.method)),
    ).toBe(true);
    expect(JSON.stringify(service.getJob(event.job_id!))).not.toContain('source_user_id');
    expect(calls.filter((call) => call.kind === 'emby' && call.method === 'users').length).toBe(
      Number(limit) + 2,
    );
    const repeated = await service.recordSubscription({ id: event.id, action: 'subscribe' });
    expect(repeated.job_id).toBe(event.job_id);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(Number(limit));
  });

  it('keeps the new-subscriber policy disabled by default and preserves existing opt-in behavior', async () => {
    store.saveSettings({ ...store.settings(), auto_create_new_subscribers: false });
    const event = await signup();
    expect(event.status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    expect(store.jobs()).toEqual([]);
    noAccounts();
  });

  it('does not opt in an existing explicitly opted-out membership', async () => {
    await service.setMembershipAccess({
      discord_user_id: owner,
      access_mode: 'subscription',
      tier_id: 'sloop',
      provision_jellyfin: false,
    });
    expect((await signup()).status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    noAccounts();
  });

  it('requires automatic provisioning as well as the new-subscriber switch', async () => {
    store.saveSettings({ ...store.settings(), auto_provision: false });
    const event = await signup();
    expect(event.status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    await service.applySubscription(event.id);
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    noAccounts();
  });

  it.each(['new.member', 'NEW.MEMBER_2', 'new.member_3'])(
    'holds an existing Emby account %s for explicit opt-in',
    async (name) => {
      servers.users.emby.push({ Id: 'existing', Name: name, Policy: {} });
      const event = await signup();
      expect(event.status).toBe('applied');
      expect(event.result).toContain('remains opt-in');
      expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
      noAccounts();
    },
  );

  it('holds an existing Emby identity with a simplified alias', async () => {
    service.mediaOwnerships.save(
      [
        {
          kind: 'emby',
          server_id: 'demo-emby',
          account_id: 'e-alex',
          username: 'alex',
          discord_user_id: owner,
          slot: 1,
        },
      ],
      store.settings(),
    );
    expect((await signup()).status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    noAccounts();
  });

  it('does not adopt an existing Jellyfin account or change its password', async () => {
    servers.users.jellyfin.push({
      Id: 'existing-jellyfin',
      Name: bot.username,
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    expect((await signup()).status).toBe('applied');
    expect(calls.some((call) => call.method === 'setPassword')).toBe(false);
    noAccounts();
  });

  it('does not reuse an incomplete local account', async () => {
    store.saveAccount(bot.username, null, 'provisioning');
    expect((await signup()).status).toBe('applied');
    noAccounts();
  });

  it.each([
    '2026-10-21T12:00:00.000Z',
    undefined,
    'invalid',
    '2026-10-22T12:00:01.001Z',
    '2026-10-22T13:00:00.000Z',
  ])('holds older or unverifiable Discord joins (%s)', async (joined) => {
    bot.joined_at = joined;
    expect((await signup()).status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    noAccounts();
  });

  it.each(['2026-10-21T12:00:00.000Z', undefined, 'invalid', '2026-10-22T13:00:00.000Z'])(
    'does not automatically provision a stale or invalid announcement (%s)',
    async (emitted_at) => {
      expect((await signup({ emitted_at })).status).toBe('applied');
      noAccounts();
    },
  );

  it('does not drain a recorded pre-cutover backlog after enabling the switch', async () => {
    store.saveSettings({
      ...store.settings(),
      auto_create_new_subscribers: false,
      auto_provision: false,
    });
    const event = await signup();
    vi.setSystemTime(new Date('2026-10-22T12:00:02.000Z'));
    store.saveSettings({
      ...store.settings(),
      auto_create_new_subscribers: true,
      auto_provision: true,
    });
    await service.applySubscription(event.id, true);
    noAccounts();
  });

  it('holds returning subscribers with a known prior MEE6 event', async () => {
    store.saveSubscription({
      id: 'older-subscription',
      action: 'cancel',
      discord_user_id: owner,
      source: 'mee6_message',
      status: 'ignored',
      created_at: '2026-10-21T12:00:00.000Z',
    });
    expect((await signup()).status).toBe('applied');
    noAccounts();
  });

  it('keeps a generic role event pending until a fresh known-plan announcement arrives', async () => {
    const role = await signup({ source: 'discord_role', detail: undefined });
    expect(role.status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect((await signup({ detail: 'Brigantine Crewman Plan' })).status).toBe('applied');
    expect(creates).toHaveLength(2);
  });

  it.each(['discord_role', 'role_reconciliation'])(
    'waits for the active role and continues the known-plan MEE6 event on %s',
    async (source) => {
      store.saveSettings({ ...store.settings(), discord_member_role_id: '300001' });
      bot.active = false;
      const announcement = await signup({ detail: 'Galleon Crewman Plan' });
      expect(announcement.status).toBe('pending');
      expect(announcement.result).toContain('Waiting for the active subscriber role');
      expect(service.memberships.get(owner, store.settings())).toBeNull();
      noAccounts();
      bot.active = true;
      const role = await signup({ source, detail: undefined });
      expect(role.status).toBe('ignored');
      expect(store.subscription(announcement.id)?.status).toBe('applied');
      expect(service.memberships.get(owner, store.settings())?.account_limit).toBe(3);
      expect(creates).toHaveLength(3);
      await signup({ source, detail: undefined });
      expect(creates).toHaveLength(3);
      expect(bot.sendCredentials).toHaveBeenCalledTimes(3);
    },
  );

  it('leaves an unverifiable active role pending without saving an opt-out decision', async () => {
    store.saveSettings({ ...store.settings(), discord_member_role_id: '300001' });
    bot.active = null;
    expect((await signup()).status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    noAccounts();
  });

  it('does not let a later role event revive an expired announcement', async () => {
    store.saveSettings({ ...store.settings(), discord_member_role_id: '300001' });
    bot.active = false;
    const announcement = await signup();
    vi.setSystemTime(new Date('2026-10-22T12:11:01.000Z'));
    bot.active = true;
    expect((await signup({ source: 'discord_role', detail: undefined })).status).toBe('pending');
    expect(store.subscription(announcement.id)?.status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    noAccounts();
  });

  it('does not infer a tier from a role event when the pending MEE6 plan is unknown', async () => {
    await signup({ detail: 'Unknown Plan' });
    expect((await signup({ source: 'discord_role', detail: undefined })).status).toBe('pending');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    noAccounts();
  });

  it('keeps an unknown MEE6 plan in review without guessing an allowance', async () => {
    expect((await signup({ detail: 'Unknown Plan' })).status).toBe('pending');
    noAccounts();
  });

  it('does not create an account from an announcement with no plan', async () => {
    expect((await signup({ detail: undefined })).status).toBe('applied');
    noAccounts();
  });

  it('fails closed when the Emby account list cannot be verified', async () => {
    embyRead = async () => {
      throw new MediaError('Synthetic unavailable source');
    };
    const event = await signup();
    expect(event.status).toBe('failed');
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    noAccounts();
  });

  it('rechecks for an Emby account that appears while preparing the target', async () => {
    jellyfinRead = async () => {
      servers.users.emby.push({ Id: 'appeared', Name: bot.username, Policy: {} });
    };
    expect((await signup()).status).toBe('applied');
    noAccounts();
  });

  it('rejects a policy switch changed during the upstream account check', async () => {
    embyRead = async () => {
      embyRead = undefined;
      store.saveSettings({ ...store.settings(), auto_create_new_subscribers: false });
    };
    expect((await signup()).status).toBe('failed');
    noAccounts();
  });

  it.each(['source', 'policy', 'opt-out', 'ownership', 'expired'])(
    'checks queued %s changes immediately before creating the account',
    async (change) => {
      let reads = 0;
      embyRead = async () => {
        if (++reads !== 3) return;
        if (change === 'source')
          servers.users.emby.push({ Id: 'appeared-before-create', Name: bot.username, Policy: {} });
        if (change === 'policy')
          store.saveSettings({ ...store.settings(), auto_create_new_subscribers: false });
        if (change === 'opt-out') {
          const member = service.memberships.get(owner, store.settings())!;
          service.memberships.save(
            { ...member, provision_jellyfin: false },
            store.settings(),
            member.revision,
          );
        }
        if (change === 'ownership')
          service.mediaOwnerships.save(
            [
              {
                kind: 'emby',
                server_id: 'demo-emby',
                account_id: 'e-alex',
                username: 'alex',
                discord_user_id: owner,
                slot: 1,
              },
            ],
            store.settings(),
          );
        if (change === 'expired') vi.setSystemTime(new Date('2026-10-22T12:11:01.000Z'));
      };
      const event = await signup();
      expect(event.status).toBe('failed');
      expect(event.job_id).toBeTruthy();
      expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
      noAccounts();
    },
  );

  it('never resets or adopts a Jellyfin account that appears during the final target read', async () => {
    let reads = 0;
    jellyfinRead = async () => {
      if (++reads === 3)
        servers.users.jellyfin.push({
          Id: 'appeared-before-create',
          Name: bot.username,
          Policy: { IsAdministrator: false, IsDisabled: false },
        });
    };
    expect((await signup()).status).toBe('failed');
    expect(calls.some((call) => call.method === 'setPassword')).toBe(false);
    noAccounts();
  });

  it('preserves an administrator opt-out saved while the upstream account check awaits', async () => {
    embyRead = async () => {
      embyRead = undefined;
      service.memberships.save(
        {
          discord_user_id: owner,
          base_username: bot.username,
          tier_id: 'sloop',
          access_mode: 'subscription',
          provision_jellyfin: false,
          account_limit: 1,
          active: true,
        },
        store.settings(),
      );
    };
    const event = await signup();
    expect(event.status).toBe('failed');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    noAccounts();
  });

  it('reports blocked credential delivery without retrying account creation or exposing the password', async () => {
    bot.sendCredentials.mockRejectedValue(new Error('Synthetic DM blocked'));
    const event = await signup();
    expect(event.status).toBe('applied');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(true);
    expect(event.result).toContain('credential delivery failed');
    const password = bot.sendCredentials.mock.calls[0]![2];
    expect(JSON.stringify(event)).not.toContain(password);
    expect(service.getJob(event.job_id!).results[0]).toMatchObject({
      discord_delivery: 'failed',
      created: true,
    });
    await service.recordSubscription({ id: event.id, action: 'subscribe' });
    expect(creates).toHaveLength(1);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(1);
    expect(store.takeCredentials(event.job_id!)).toHaveLength(1);
  });

  it('holds a canceled signup so a second announcement cannot resume account creation', async () => {
    let reads = 0;
    embyRead = async () => {
      if (++reads === 3) service.cancelJob(store.jobs()[0]!.id);
    };
    const event = await signup();
    expect(event.status).toBe('failed');
    expect(service.getJob(event.job_id!).status).toBe('canceled');
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    embyRead = undefined;
    expect((await signup()).status).toBe('applied');
    noAccounts();
  });

  it('preserves successful slots but holds further creation after a partial signup failure', async () => {
    let reads = 0;
    embyRead = async () => {
      if (++reads === 4)
        servers.users.emby.push({ Id: 'appeared-slot-2', Name: `${bot.username}_2`, Policy: {} });
    };
    const event = await signup({ detail: 'Brigantine Crewman Plan' });
    expect(event.status).toBe('failed');
    expect(creates).toEqual([bot.username]);
    expect(store.links()).toHaveLength(1);
    expect(service.memberships.get(owner, store.settings())?.provision_jellyfin).toBe(false);
    embyRead = undefined;
    servers.users.emby = [];
    expect((await signup({ detail: 'Brigantine Crewman Plan' })).status).toBe('applied');
    expect(creates).toEqual([bot.username]);
    expect(bot.sendCredentials).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer explicit administrator decision when automatic onboarding fails', async () => {
    let reads = 0;
    let manualRevision: string | undefined;
    embyRead = async () => {
      if (++reads !== 3) return;
      const member = service.memberships.get(owner, store.settings())!;
      manualRevision = service.memberships.save(
        { ...member, provision_jellyfin: true, account_limit: 2 },
        store.settings(),
        member.revision,
      ).revision;
    };
    expect((await signup()).status).toBe('failed');
    expect(service.memberships.get(owner, store.settings())).toMatchObject({
      revision: manualRevision,
      provision_jellyfin: true,
      account_limit: 2,
    });
    noAccounts();
  });

  it('does not rewrite an old scope after the configured guild changes', async () => {
    let reads = 0;
    let originalRevision: string | undefined;
    const original = store.settings();
    embyRead = async () => {
      if (++reads === 3) {
        originalRevision = service.memberships.get(owner, original)?.revision;
        store.saveSettings({ ...store.settings(), discord_guild_id: '200002' });
      }
    };
    expect((await signup()).status).toBe('failed');
    expect(service.memberships.get(owner, original)).toMatchObject({
      revision: originalRevision,
      provision_jellyfin: true,
    });
    noAccounts();
  });
});
