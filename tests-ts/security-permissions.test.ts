import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { ServiceError } from '../server/errors.js';
import { matchItems } from '../server/matching.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { validateSettings } from '../server/settings.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

/** Security regression fixtures only: never connect to Discord or a media server. */
class MemberFixture implements BotAdapter {
  readonly members = new Map<string, { username: string; active: boolean }>();
  readonly deliveries: string[][] = [];
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string) {
    const member = this.members.get(id);
    if (!member?.active) throw new ServiceError('Membership unavailable.');
    return { id, username: member.username };
  }
  async validateRecipient(id: string) {
    await this.recipientIdentity(id);
  }
  async sendCredentials(...args: string[]) {
    this.deliveries.push(args);
  }
  async membershipActive(id: string) {
    return this.members.get(id)?.active ?? false;
  }
  async activeMembers() {
    return [...this.members].flatMap(([id, member]) =>
      member.active ? [{ id, username: member.username }] : [],
    );
  }
}

describe('adversarial account ownership and secret storage', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  let bot: MemberFixture;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-pentest-permissions-'));
    store = new Store(directory);
    servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby.test',
      emby_api_key: 'EMBY-KEY-MUST-NOT-BE-PLAINTEXT-9072',
      jellyfin_url: 'http://jellyfin.test',
      jellyfin_api_key: 'JF-KEY-MUST-NOT-BE-PLAINTEXT-9072',
      discord_bot_token: 'DISCORD-TOKEN-MUST-NOT-BE-PLAINTEXT-9072',
      template_user_id: 'template',
    });
    service = new Service(store, { clientFactory: servers.factory });
    bot = new MemberFixture();
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

  it('does not let a new member take over a renamed member’s account by reusing the old username', async () => {
    bot.members.set('10001', { username: 'river-renamed', active: true });
    bot.members.set('10002', { username: 'river', active: true });
    store.saveLink('10001', 'river', 'j-river');
    const before = structuredClone(servers.users.jellyfin);
    const beforePlayed = new Set(servers.played['j-river']);
    const attack = await finish(await service.migrateUsers(['e-river'], { 'e-river': '10002' }));
    expect(attack.status).toBe('failed');
    expect(store.link('10002')).toBeNull();
    expect(store.link('10001')?.remote_id).toBe('j-river');
    expect(servers.users.jellyfin).toEqual(before);
    expect(servers.played['j-river']).toEqual(beforePlayed);
    expect(store.takeCredentials(attack.id)).toEqual([]);
    expect(bot.deliveries).toEqual([]);
  });

  it('serializes concurrent identity claims and delivers credentials to only the winning member', async () => {
    bot.members.set('10001', { username: 'alex', active: true });
    bot.members.set('10002', { username: 'alex', active: true });
    const requests = await Promise.all([
      service.migrateUsers(['e-alex'], { 'e-alex': '10001' }),
      service.migrateUsers(['e-alex'], { 'e-alex': '10002' }),
    ]);
    const jobs = await Promise.all(requests.map(finish));
    expect(jobs.filter((job) => job.status === 'failed')).toHaveLength(1);
    expect(servers.users.jellyfin.filter((user) => user.Name === 'alex')).toHaveLength(1);
    const links = store.links();
    expect(links).toHaveLength(1);
    expect(bot.deliveries).toHaveLength(1);
    expect(bot.deliveries[0]?.[0]).toBe(links[0]?.discord_user_id);
    expect(jobs.flatMap((job) => store.takeCredentials(job.id))).toEqual([]);
  });

  it('rechecks membership after a job has waited in the mutation queue', async () => {
    bot.members.set('10001', { username: 'alex', active: true });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      const original = client.createUser.bind(client);
      client.createUser = async (username, password) => {
        if (username === 'blocker') {
          enter();
          await gate;
        }
        return original(username, password);
      };
      return client;
    };
    const blocker = await service.createAccount('blocker');
    await entered;
    const attack = await service.createAccount('alex', '10001');
    bot.members.get('10001')!.active = false;
    release();
    await finish(blocker);
    expect((await finish(attack)).status).toBe('failed');
    expect(servers.users.jellyfin.some((user) => user.Name === 'alex')).toBe(false);
    expect(store.link('10001')).toBeNull();
    expect(bot.deliveries).toEqual([]);
  });

  it('does not use a recycled username to reenable an account disabled manually by its administrator', async () => {
    store.saveLink('10001', 'river', 'j-river', false);
    servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
    bot.members.set('10001', { username: 'new-discord-name', active: true });
    await service.recordSubscription({
      id: 'renewal',
      action: 'subscribe',
      discord_user_id: '10001',
    });
    await service.applySubscription('renewal');
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(true);
    expect(store.link('10001')?.username).toBe('river');
    expect(bot.deliveries).toEqual([]);
  });

  it('does not persist API keys, bot tokens, generated passwords or credential plaintext in SQLite or its journals', async () => {
    const job = await finish(await service.createAccount('casey'));
    const credential = store.takeCredentials(job.id)[0]!;
    expect(credential.password).toHaveLength(24);
    store.saveCredentials(job.id, credential.username, credential.password, credential.server_url);
    store.saveAccount('partial', 'partial-id', 'provisioning', credential.password);
    const secrets = [
      ...['emby_api_key', 'jellyfin_api_key', 'discord_bot_token'].map(
        (field) => store.settings()[field as 'emby_api_key'],
      ),
      credential.password,
    ];
    for (const name of readdirSync(directory).filter((name) => name !== 'secret.key')) {
      const bytes = readFileSync(join(directory, name));
      for (const secret of secrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(statSync(join(directory, name)).mode & 0o077).toBe(0);
    }
    expect(statSync(join(directory, 'secret.key')).mode & 0o077).toBe(0);
    expect(JSON.stringify(store.jobs())).not.toContain(credential.password);
  });

  it('uses literal parameterized keys for SQL injection strings without exposing another job’s credentials', () => {
    const password = 'REAL-ACCOUNT-PASSWORD-9072';
    store.saveCredentials('real-job', 'real-user', password, 'https://jellyfin.test');
    const payload = "x' OR 1=1; DROP TABLE credentials;--";
    expect(store.takeCredentials(payload)).toEqual([]);
    expect(store.job(payload)).toBeNull();
    expect(store.account(payload)).toBeNull();
    expect(store.link(payload)).toBeNull();
    expect(store.subscription(payload)).toBeNull();
    expect(store.takeCredentials('real-job')).toEqual([
      { username: 'real-user', password, server_url: 'https://jellyfin.test' },
    ]);
  });

  it('rejects settings prototype injection without changing default or object prototypes', () => {
    const payload = JSON.parse('{"__proto__":{"auto_provision":true,"polluted":true}}');
    expect(() => validateSettings({ ...store.settings(), ...payload })).toThrow('Unknown setting');
    expect(Object.getPrototypeOf(DEFAULT_SETTINGS)).toBe(Object.prototype);
    expect(DEFAULT_SETTINGS.auto_provision).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('does not interpret prototype names as trusted media providers or permit them to change matching behavior', () => {
    const providers = JSON.parse(
      '{"__proto__":{"imdb":"fake"},"constructor":"fake","toString":"fake"}',
    );
    expect(
      matchItems(
        [{ Id: 'source', Type: 'Movie', ProviderIds: providers }],
        [{ Id: 'target', Type: 'Movie', ProviderIds: { Imdb: 'fake' } }],
      ).matches,
    ).toEqual([]);
    expect(Object.hasOwn(Object.prototype, 'imdb')).toBe(false);
  });
});
