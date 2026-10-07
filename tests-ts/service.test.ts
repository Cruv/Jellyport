import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError, ServiceError } from '../server/errors.js';
import {
  Service,
  generatePassword,
  templatePolicy,
  validateUsername,
  type BotAdapter,
  type Job,
} from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

class FakeBot implements BotAdapter {
  delivered: string[][] = [];
  username = 'alex';
  active: boolean | null = false;
  members: Array<{ id: string; username: string }> | null = [];
  status() {
    return { enabled: true, connected: true };
  }
  async validateRecipient(_id: string) {}
  async recipientIdentity(id: string) {
    return { id, username: this.username };
  }
  async sendCredentials(...args: string[]) {
    this.delivered.push(args);
  }
  async membershipActive(_id: string) {
    return this.active;
  }
  async activeMembers() {
    return this.members;
  }
}
describe('account migration and subscription safety', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-service-'));
    store = new Store(directory);
    servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'secret-emby',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'secret-jellyfin',
      template_user_id: 'template',
    });
    service = new Service(store, { clientFactory: servers.factory });
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

  it('migrates played items, reveals new credentials once and preserves them on repeated merging', async () => {
    const preview = await service.preview(['e-alex']);
    expect(preview.users[0]?.stats).toEqual({
      source_played: 4,
      matched: 3,
      unmatched: 1,
      ambiguous: 0,
      already_played: 0,
    });
    const job = await finish(await service.migrateUsers(['e-alex']));
    expect(job.status).toBe('partial');
    expect(job.results[0]?.applied).toBe(3);
    const alex = servers.users.jellyfin.find((user) => user.Name === 'alex')!;
    expect(alex.Policy).toEqual(servers.users.jellyfin[0]?.Policy);
    const credentials = store.takeCredentials(job.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.password).toHaveLength(24);
    expect(store.takeCredentials(job.id)).toEqual([]);
    const repeat = await finish(await service.migrateUsers(['e-alex']));
    expect(repeat.results[0]?.created).toBe(false);
    expect(repeat.results[0]?.applied).toBe(0);
    expect(store.takeCredentials(repeat.id)).toEqual([]);
    expect(servers.users.jellyfin.filter((user) => user.Name === 'alex')).toHaveLength(1);
  });
  it('preserves an existing account password, permissions and Jellyfin-only played items', async () => {
    const river = servers.users.jellyfin[1]!;
    river.Policy!.EnableAllFolders = false;
    const before = structuredClone(river);
    servers.played['j-river']!.add('3');
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('completed');
    expect(river).toEqual(before);
    expect(servers.played['j-river']).toEqual(new Set(['1', '2', '3']));
    expect(store.takeCredentials(job.id)).toEqual([]);
  });
  it('does not reset a duplicate fresh account', async () => {
    const before = structuredClone(servers.users.jellyfin[1]);
    const job = await finish(await service.createAccount('river'));
    expect(job.status).toBe('failed');
    expect(servers.users.jellyfin[1]).toEqual(before);
  });
  it('resumes only a tracked incomplete creation and applies the template once successful', async () => {
    let failing = true;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        original = client.setPolicy.bind(client);
      client.setPolicy = async (...policyArgs) => {
        if (failing) throw new MediaError('Jellyfin rejected the request (HTTP 503).', 503);
        await original(...policyArgs);
      };
      return client;
    };
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect(store.account('casey')?.status).toBe('provisioning');
    failing = false;
    const retry = await finish(await service.createAccount('casey'));
    expect(retry.status).toBe('completed');
    expect(servers.users.jellyfin.filter((user) => user.Name === 'casey')).toHaveLength(1);
    expect(store.takeCredentials(retry.id)).toHaveLength(1);
  });
  it('never retries an uncertain creation or resets its password automatically', async () => {
    const calls: string[] = [];
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.createUser = async (username) => {
        calls.push(username);
        throw new MediaError('Jellyfin request timed out.');
      };
      return client;
    };
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect(calls).toEqual(['casey']);
    expect(store.account('casey')?.status).toBe('uncertain');
  });
  it('reads source history successfully before creating any target account', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby')
        client.items = async () => {
          throw new MediaError('Emby unavailable.');
        };
      return client;
    };
    const before = structuredClone(servers.users.jellyfin);
    const job = await finish(await service.migrateUsers(['e-alex']));
    expect(job.status).toBe('failed');
    expect(servers.users.jellyfin).toEqual(before);
  });
  it('removes delivered credentials and excludes passwords from audit records', async () => {
    const bot = new FakeBot();
    service.bot = bot;
    const job = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': '123456789' }));
    expect(bot.delivered).toHaveLength(1);
    expect(JSON.stringify(job)).not.toContain(bot.delivered[0]![2]);
    expect(store.takeCredentials(job.id)).toEqual([]);
    expect(store.link('123456789')?.username).toBe('alex');
  });
  it('retains one-time credentials after failed Discord delivery without exposing library exceptions', async () => {
    const bot = new FakeBot();
    bot.sendCredentials = async () => {
      throw new Error('library-secret-error');
    };
    service.bot = bot;
    const job = await finish(await service.createAccount('alex', '123456789'));
    expect(job.status).toBe('partial');
    expect(job.results[0]?.discord_delivery).toBe('failed');
    expect(JSON.stringify(job)).not.toContain('library-secret-error');
    expect(store.takeCredentials(job.id)).toHaveLength(1);
  });
  it('checks recipient membership again immediately before sending credentials', async () => {
    const bot = new FakeBot();
    let validations = 0;
    bot.validateRecipient = async () => {
      if (++validations > 1) throw new Error('Membership expired');
    };
    service.bot = bot;
    const job = await finish(await service.createAccount('alex', '123456789'));
    expect(job.results[0]?.discord_delivery).toBe('failed');
    expect(bot.delivered).toEqual([]);
    expect(store.takeCredentials(job.id)).toHaveLength(1);
  });
  it('suspends and reenables only a linked account while preserving policy details and watch history', async () => {
    const bot = new FakeBot();
    service.bot = bot;
    expect((await finish(await service.createAccount('alex', '123456789'))).status).toBe(
      'completed',
    );
    const alex = servers.users.jellyfin.find((user) => user.Name === 'alex')!,
      before = structuredClone(alex.Policy);
    servers.played[alex.Id] = new Set(['1']);
    await service.recordSubscription({
      id: 'expire',
      action: 'expire',
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    await service.applySubscription('expire');
    expect(alex.Policy?.IsDisabled).toBe(true);
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(1);
    await service.recordSubscription({
      id: 'subscribe',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    await service.applySubscription('subscribe');
    expect(alex.Policy).toEqual(before);
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(0);
    expect(servers.played[alex.Id]).toEqual(new Set(['1']));
  });
  it('keeps cancellation in review by default and deduplicates events', async () => {
    const event = {
      id: 'cancel',
      action: 'cancel' as const,
      username: 'alex',
      discord_user_id: '123456789',
      source: 'mee6_message',
    };
    await service.recordSubscription(event);
    await service.recordSubscription(event);
    expect(store.subscriptions()).toHaveLength(1);
    expect(store.subscription('cancel')?.status).toBe('pending');
  });
  it('cannot disable an unlinked account based on a username', async () => {
    service.bot = new FakeBot();
    const before = structuredClone(servers.users.jellyfin);
    await service.recordSubscription({
      id: 'unlinked',
      action: 'expire',
      username: 'river',
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    await expect(service.applySubscription('unlinked')).rejects.toThrow(
      'no Jellyport identity link',
    );
    expect(servers.users.jellyfin).toEqual(before);
  });
  it('does not claim an existing account during automated subscription provisioning', async () => {
    const bot = new FakeBot();
    bot.username = 'river';
    service.bot = bot;
    const before = structuredClone(servers.users.jellyfin);
    await service.recordSubscription({
      id: 'unlinked',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    await expect(service.applySubscription('unlinked')).rejects.toThrow('admin-approved migration');
    expect(servers.users.jellyfin).toEqual(before);
    expect(store.link('123456789')).toBeNull();
  });
  it('protects template and administrator destinations in preview and migration', async () => {
    servers.users.emby[0]!.Name = 'Member template';
    await expect(service.preview(['e-alex'])).rejects.toThrow('template');
    expect((await finish(await service.migrateUsers(['e-alex']))).status).toBe('failed');
    servers.users.emby[0]!.Name = 'river';
    servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
    await expect(service.preview(['e-alex'])).rejects.toThrow('administrator');
    expect((await finish(await service.migrateUsers(['e-alex']))).status).toBe('failed');
  });
  it('never uses template watch history as a new account baseline', async () => {
    servers.played.template = new Set(['1', '2', '3']);
    expect((await service.preview(['e-alex'])).users[0]?.stats.already_played).toBe(0);
  });
  it('keeps Jellyfin template users visible when Emby is unavailable', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby')
        client.users = async () => {
          throw new MediaError('Unable to connect to Emby.');
        };
      return client;
    };
    const users = await service.users();
    expect(users.emby).toEqual([]);
    expect(users.jellyfin[0]?.Id).toBe('template');
    expect(users.errors).toEqual({ emby: 'Unable to connect to Emby.' });
  });
  it('does not reenable a manually disabled account on renewal', async () => {
    service.bot = new FakeBot();
    const river = servers.users.jellyfin[1]!;
    river.Policy!.IsDisabled = true;
    store.saveLink('123456789', 'river', 'j-river', false);
    await service.recordSubscription({
      id: 'renewal',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    await service.applySubscription('renewal');
    expect(river.Policy?.IsDisabled).toBe(true);
  });
  it('provisions offline role joins once and reconciles later expiration only when opted in', async () => {
    const bot = new FakeBot();
    bot.active = true;
    bot.members = [{ id: '123456789', username: 'alex' }];
    service.bot = bot;
    store.saveSettings({
      ...store.settings(),
      discord_role_events: true,
      discord_member_role_id: '12345678',
      auto_provision: true,
      auto_disable: true,
    });
    await service.reconcileMemberships();
    expect(store.link('123456789')?.username).toBe('alex');
    expect(store.subscriptions()).toHaveLength(1);
    await service.reconcileMemberships();
    expect(store.subscriptions()).toHaveLength(1);
    bot.active = false;
    bot.members = [];
    await service.reconcileMemberships();
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(1);
    expect(servers.users.jellyfin.find((user) => user.Name === 'alex')?.Policy?.IsDisabled).toBe(
      true,
    );
  });
  it('does not auto-disable cancellation unless that separate option is enabled', async () => {
    service.bot = new FakeBot();
    store.saveLink('123456789', 'river', 'j-river');
    store.saveSettings({ ...store.settings(), auto_disable: true });
    await service.recordSubscription({
      id: 'cancel',
      action: 'cancel',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    expect(store.subscription('cancel')?.status).toBe('pending');
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(false);
  });
  it('cannot link different Discord members to one destination', async () => {
    const bot = new FakeBot();
    bot.username = 'river';
    service.bot = bot;
    store.saveLink('owner', 'river', 'j-river');
    const job = await finish(await service.migrateUsers(['e-river'], { 'e-river': '123456789' }));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('another Discord user');
    expect(store.link('owner')?.remote_id).toBe('j-river');
    expect(store.link('123456789')).toBeNull();
  });
  it('requires the current Discord username for first linking and fresh creation', async () => {
    service.bot = new FakeBot();
    await expect(service.createAccount('Server Nickname', '123456789')).rejects.toThrow(
      'Discord username',
    );
    const job = await finish(await service.migrateUsers(['e-river'], { 'e-river': '123456789' }));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('must match');
  });
  it('preserves a durable identity link when a Discord username changes', async () => {
    const bot = new FakeBot();
    bot.username = 'newname';
    service.bot = bot;
    store.saveLink('123456789', 'river', 'j-river');
    const job = await finish(await service.migrateUsers(['e-river'], { 'e-river': '123456789' }));
    expect(job.status).toBe('completed');
    expect(store.link('123456789')?.username).toBe('river');
    expect(job.results[0]?.discord_delivery).toBe('skipped_existing_account');
  });
  it('rejects duplicate or out-of-scope batch recipients and users', async () => {
    await expect(service.migrateUsers(['e-alex', 'e-alex'])).rejects.toBeInstanceOf(ServiceError);
    await expect(service.migrateUsers(['e-alex'], { 'e-river': '123456789' })).rejects.toThrow(
      'selected',
    );
    await expect(
      service.migrateUsers(['e-alex', 'e-river'], { 'e-alex': 'same', 'e-river': 'same' }),
    ).rejects.toThrow('different');
  });
});

describe('password and template validation', () => {
  it('generates 24-character cryptographic passwords containing all required categories', () => {
    const values = new Set(Array.from({ length: 100 }, generatePassword));
    expect(values.size).toBe(100);
    for (const value of values) {
      expect(value).toHaveLength(24);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[0-9]/);
      expect(value).toMatch(/[!@#%+_-]/);
    }
  });
  it('rejects disabled, administrator and empty templates while preserving lockout settings', () => {
    for (const Policy of [{}, { IsAdministrator: true }, { IsDisabled: true }])
      expect(() => templatePolicy({ Policy })).toThrow(ServiceError);
    const Policy = {
      IsAdministrator: false,
      LoginAttemptsBeforeLockout: 3,
      InvalidLoginAttemptCount: 9,
      FailedLoginAttempts: 9,
    };
    expect(templatePolicy({ Policy })).toEqual({
      IsAdministrator: false,
      LoginAttemptsBeforeLockout: 3,
    });
    expect(Policy.InvalidLoginAttemptCount).toBe(9);
  });
  it.each(['', ' leading', 'trailing ', 'a/b', 'a\\b', '<name>', 'a\n', 'x'.repeat(65)])(
    'rejects an invalid username: %j',
    (username) => {
      expect(() => validateUsername(username)).toThrow(ServiceError);
    },
  );
});
