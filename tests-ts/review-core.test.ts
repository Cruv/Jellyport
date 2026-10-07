import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError, ServiceError } from '../server/errors.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

class MembershipBot implements BotAdapter {
  active: boolean | null = false;
  departed = false;
  status() {
    return { enabled: true };
  }
  async validateRecipient(_id: string) {}
  async recipientIdentity(id: string) {
    if (this.departed) throw new Error('Member departed');
    return { id, username: 'river' };
  }
  async sendCredentials(..._args: string[]) {}
  async membershipActive(_id: string) {
    return this.active;
  }
  async activeMembers() {
    return [];
  }
}
describe('review regressions and durable job recovery', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: MembershipBot;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-review-'));
    store = new Store(directory);
    servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'key',
      template_user_id: 'template',
    });
    service = new Service(store, { clientFactory: servers.factory });
    bot = new MembershipBot();
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
  async function event(id: string, action: 'expire' | 'subscribe') {
    await service.recordSubscription({
      id,
      action,
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    return service.applySubscription(id);
  }

  it('can suspend a linked member who left Discord without looking up a recipient', async () => {
    bot.departed = true;
    store.saveLink('123456789', 'river', 'j-river');
    expect((await event('departed', 'expire')).status).toBe('applied');
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(true);
  });
  it('ignores obsolete expiration when the current role is active', async () => {
    bot.active = true;
    store.saveLink('123456789', 'river', 'j-river');
    const before = structuredClone(servers.users.jellyfin[1]);
    expect((await event('old', 'expire')).status).toBe('ignored');
    expect(servers.users.jellyfin[1]).toEqual(before);
  });
  it('fails safely when membership cannot be determined', async () => {
    bot.active = null;
    store.saveLink('123456789', 'river', 'j-river');
    const before = structuredClone(servers.users.jellyfin[1]);
    await expect(event('unknown', 'expire')).rejects.toThrow('could not be verified');
    expect(servers.users.jellyfin[1]).toEqual(before);
  });
  it('reconciles a successful remote disable that timed out and later reenables safely', async () => {
    store.saveLink('123456789', 'river', 'j-river');
    let injected = false;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        original = client.setPolicy.bind(client);
      client.setPolicy = async (id, policy) => {
        await original(id, policy);
        if (policy.IsDisabled && !injected) {
          injected = true;
          throw new MediaError('Jellyfin request timed out.');
        }
      };
      return client;
    };
    await expect(event('disable', 'expire')).rejects.toThrow(ServiceError);
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(true);
    expect(store.link('123456789')?.pending_disabled).toBe(1);
    await service.applySubscription('disable');
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(1);
    expect(store.link('123456789')?.pending_disabled).toBeNull();
    bot.active = true;
    await event('renew', 'subscribe');
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(false);
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(0);
  });
  it('reconciles a successful remote reenable that timed out and clears ownership', async () => {
    bot.active = true;
    servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
    store.saveLink('123456789', 'river', 'j-river', true);
    let injected = false;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        original = client.setPolicy.bind(client);
      client.setPolicy = async (id, policy) => {
        await original(id, policy);
        if (!policy.IsDisabled && !injected) {
          injected = true;
          throw new MediaError('Jellyfin request timed out.');
        }
      };
      return client;
    };
    await expect(event('renew', 'subscribe')).rejects.toThrow(ServiceError);
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(false);
    expect(store.link('123456789')?.pending_disabled).toBe(0);
    await service.applySubscription('renew');
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(0);
    expect(store.link('123456789')?.pending_disabled).toBeNull();
  });
  it('clears pending disable ownership following definite HTTP rejection', async () => {
    store.saveLink('123456789', 'river', 'j-river');
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.setPolicy = async () => {
        throw new MediaError('Jellyfin rejected the request (HTTP 403).', 403);
      };
      return client;
    };
    await expect(event('rejected', 'expire')).rejects.toThrow(ServiceError);
    expect(store.link('123456789')?.pending_disabled).toBeNull();
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(0);
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(false);
  });
  it('requires inspected recovery after remote creation succeeded but the response timed out', async () => {
    const updates: Array<[string, string]> = [];
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        originalCreate = client.createUser.bind(client),
        originalPassword = client.setPassword.bind(client);
      client.createUser = async (username, password) => {
        await originalCreate(username, password);
        throw new MediaError('Jellyfin request timed out.');
      };
      client.setPassword = async (id, password) => {
        updates.push([id, password]);
        await originalPassword(id, password);
      };
      return client;
    };
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    const target = servers.users.jellyfin.find((user) => user.Name === 'casey')!;
    servers.played[target.Id] = new Set(['1']);
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect(updates).toEqual([]);
    const info = await service.recoveryInfo('casey');
    expect(info.eligible).toBe(true);
    await expect(service.recoverAccount('casey', 'wrong-target')).rejects.toThrow(ServiceError);
    const recovered = await finish(await service.recoverAccount('casey', info.target_user_id!));
    expect(recovered.status).toBe('completed');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toBe(target.Id);
    expect(target.Policy).toEqual(servers.users.jellyfin[0]?.Policy);
    expect(servers.played[target.Id]).toEqual(new Set(['1']));
    expect(store.takeCredentials(recovered.id)[0]?.password).toBe(updates[0]?.[1]);
  });
  it('allows an authenticated retry after creation was definitely rejected by API authentication', async () => {
    let rejected = true;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        original = client.createUser.bind(client);
      client.createUser = async (...values) => {
        if (rejected) throw new MediaError('Jellyfin rejected the request (HTTP 401).', 401);
        return original(...values);
      };
      return client;
    };
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect(store.account('casey')?.status).toBe('rejected');
    expect(servers.users.jellyfin.some((user) => user.Name === 'casey')).toBe(false);
    rejected = false;
    const retry = await finish(await service.createAccount('casey'));
    expect(retry.status).toBe('completed');
    expect(store.takeCredentials(retry.id)).toHaveLength(1);
  });
  it('rejects an account whose identity changed before applying an access event', async () => {
    store.saveLink('123456789', 'river', 'j-river');
    servers.users.jellyfin[1]!.Name = 'renamed';
    await expect(event('changed', 'expire')).rejects.toThrow('changed or is protected');
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(false);
  });
  it('never applies subscription policy mutations to administrator or template links', async () => {
    store.saveLink('123456789', 'river', 'j-river');
    servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
    await expect(event('admin', 'expire')).rejects.toThrow('protected');
    store.saveLink('123456789', 'Member template', 'template');
    await expect(event('template', 'expire')).rejects.toThrow('protected');
    expect(servers.users.jellyfin[0]?.Policy?.IsDisabled).toBe(false);
  });
  it('preserves full Unicode casefold conflict behavior', async () => {
    servers.users.jellyfin.push({
      Id: 'unicode',
      Name: 'straße',
      Policy: { IsAdministrator: false },
    });
    const result = await finish(await service.createAccount('STRASSE'));
    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('letter case');
    expect(store.account('STRASSE')).toBeNull();
  });
  it('serializes concurrent creation requests for the same account', async () => {
    const jobs = await Promise.all([
      service.createAccount('casey'),
      service.createAccount('casey'),
    ]);
    const results = await Promise.all(jobs.map(finish));
    expect(results.map((job) => job.status).sort()).toEqual(['completed', 'failed']);
    expect(servers.users.jellyfin.filter((user) => user.Name === 'casey')).toHaveLength(1);
    expect(results.flatMap((job) => store.takeCredentials(job.id))).toHaveLength(1);
  });
  it('releases the mutation lock between batch users so expiration can run promptly', async () => {
    store.saveLink('123456789', 'river', 'j-river');
    const order: string[] = [];
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        originalCreate = client.createUser.bind(client),
        originalPolicy = client.setPolicy.bind(client);
      client.createUser = async (username, password) => {
        order.push(`create:${username}`);
        if (username === 'alex') {
          entered();
          await gate;
        }
        return originalCreate(username, password);
      };
      client.setPolicy = async (id, policy) => {
        if (id === 'j-river') order.push('expire:river');
        await originalPolicy(id, policy);
      };
      return client;
    };
    const migration = await service.migrateUsers(['e-alex', 'e-sam']);
    await enteredPromise;
    const expiration = event('expire', 'expire');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([finish(migration), expiration]);
    expect(order).toEqual(['create:alex', 'expire:river', 'create:sam']);
  });
  it('replays a persisted queued job with its encrypted settings snapshot after restart', async () => {
    await service.stop();
    const timestamp = new Date().toISOString(),
      queued: Job = {
        id: 'durable',
        kind: 'create',
        status: 'queued',
        created_at: timestamp,
        updated_at: timestamp,
        progress: { processed: 0, total: 1 },
        results: [],
      };
    const settings = store.settings();
    store.saveQueuedJob(queued, [{ username: 'casey' }], settings);
    store.saveSettings({ ...settings, template_user_id: '' });
    store.close();
    store = new Store(directory);
    service = new Service(store, { clientFactory: servers.factory });
    await service.start();
    await service.jobTasks.get('durable');
    expect(service.getJob('durable').status).toBe('completed');
    expect(store.queuedJobs()).toEqual([]);
    expect(servers.users.jellyfin.filter((user) => user.Name === 'casey')).toHaveLength(1);
  });
  it('does not replay a running job or an old queued job lacking a durable payload', async () => {
    await service.stop();
    const timestamp = new Date().toISOString();
    for (const status of ['running', 'queued'])
      store.saveJob({
        id: status,
        kind: 'create',
        status,
        created_at: timestamp,
        updated_at: timestamp,
        progress: { processed: 0, total: 1 },
        results: [],
      });
    store.close();
    store = new Store(directory);
    service = new Service(store, { clientFactory: servers.factory });
    await service.start();
    expect(service.jobTasks.size).toBe(0);
    expect(service.getJob('running').status).toBe('interrupted');
    expect(service.getJob('queued').status).toBe('interrupted');
    expect(servers.users.jellyfin).toHaveLength(2);
  });
});
