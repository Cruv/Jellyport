import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';

const owner = '100001';
const sourceId = 'e-river';
const targetId = 'j-river';
const movieId = 'synthetic-movie';

class MigrationBot implements BotAdapter {
  sendCredentials = vi.fn(async () => {});
  status() {
    return { enabled: true, connected: true };
  }
  async recipientIdentity(id: string) {
    return { id, username: 'river' };
  }
  async validateRecipient(_id: string) {}
  async membershipActive(_id: string) {
    return true;
  }
  async activeMembers() {
    return [];
  }
}

describe('atomic migration ownership confirmation', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service, bot: MigrationBot;
  let calls: string[];
  let beforeMediaCall:
    ((kind: string, method: string, parameters: unknown[]) => Promise<void>) | undefined;
  let releaseReads: Array<() => void>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-migration-ownership-'));
    store = new Store(directory);
    servers = new DemoServers();
    servers.media = [
      { Id: movieId, Name: 'Synthetic film', Type: 'Movie', ProviderIds: { Tmdb: '900001' } },
    ];
    servers.played = { [sourceId]: new Set([movieId]), [targetId]: new Set() };
    for (const user of servers.users.emby)
      user.Policy = { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true };
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      template_user_id: 'template',
      discord_guild_id: '200001',
    });
    const pending = store.ensureAuthState();
    if (pending.kind !== 'pending') throw new Error('Expected isolated pairing');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: store.settings().jellyfin_url,
        serverId: 'demo-jellyfin',
        apiKeyName: 'synthetic',
      },
      (settings) => settings,
    );
    calls = [];
    releaseReads = [];
    beforeMediaCall = undefined;
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args),
          kind = args[2] ?? 'jellyfin';
        return new Proxy(client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return async (...parameters: unknown[]) => {
              await beforeMediaCall?.(kind, String(property), parameters);
              calls.push(String(property));
              return Reflect.apply(value, target, parameters);
            };
          },
        });
      },
    });
    bot = new MigrationBot();
    service.bot = bot;
  });

  afterEach(async () => {
    for (const release of releaseReads) release();
    await service.stop();
    vi.restoreAllMocks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  function writes() {
    return calls.filter((method) =>
      [
        'createUser',
        'setPassword',
        'setPolicy',
        'setConfiguration',
        'markPlayed',
        'updateUserData',
      ].includes(method),
    );
  }
  function pauseRead(matches: (kind: string, method: string, parameters: unknown[]) => boolean) {
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseReads.push(release);
    beforeMediaCall = async (kind, method, parameters) => {
      if (!matches(kind, method, parameters)) return;
      beforeMediaCall = undefined;
      entered = true;
      await held;
    };
    return { wait: () => vi.waitFor(() => expect(entered).toBe(true)), release };
  }
  function ownership() {
    return service.mediaOwnerships.list(store.settings());
  }

  it('rolls back both ownership records and the link if the final link write fails, then safely retries', async () => {
    const original = store.saveLink.bind(store);
    const fail = vi.spyOn(store, 'saveLink').mockImplementationOnce((...args) => {
      original(...args);
      throw new Error('Synthetic failure after the link write');
    });
    const failed = await finish(await service.migrateUsers([sourceId], { [sourceId]: owner }));
    expect(failed.status).toBe('failed');
    expect(fail).toHaveBeenCalledOnce();
    expect(ownership()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(servers.played[targetId]).toEqual(new Set());
    expect(writes()).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    fail.mockRestore();

    const retried = await finish(await service.migrateUsers([sourceId], { [sourceId]: owner }));
    expect(retried.status, JSON.stringify(retried)).toBe('completed');
    expect(ownership()).toHaveLength(2);
    expect(ownership()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'emby',
          server_id: 'demo-emby',
          account_id: sourceId,
          discord_user_id: owner,
          slot: 1,
        }),
        expect.objectContaining({
          kind: 'jellyfin',
          server_id: 'demo-jellyfin',
          account_id: targetId,
          discord_user_id: owner,
          slot: 1,
        }),
      ]),
    );
    expect(store.link(owner)).toMatchObject({ remote_id: targetId, username: 'river' });
    expect(servers.played[targetId]).toEqual(new Set([movieId]));
    expect(calls).not.toContain('setPassword');
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });

  it('preserves the approved source occupying an owner slot instead of assigning a second Emby account to it', async () => {
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
    const before = ownership();
    const result = await finish(await service.migrateUsers([sourceId], { [sourceId]: owner }));
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toMatch(/different approved account.*slot/i);
    expect(ownership()).toEqual(before);
    expect(store.links()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });

  it('retains the current lifecycle disabled flag when it changes during final source verification', async () => {
    store.saveLink(owner, 'river', targetId, false);
    let targetRead = false;
    const gate = pauseRead((kind, method, parameters) => {
      if (kind === 'jellyfin' && method === 'user' && parameters[0] === targetId) targetRead = true;
      return targetRead && kind === 'emby' && method === 'systemInfo';
    });
    const job = await service.migrateUsers([sourceId], { [sourceId]: owner });
    try {
      await gate.wait();
      store.saveLink(owner, 'river', targetId, true);
    } finally {
      gate.release();
    }
    const result = await finish(job);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(store.link(owner)).toMatchObject({
      remote_id: targetId,
      disabled_by_jellyport: 1,
      pending_disabled: null,
    });
    expect(ownership()).toHaveLength(2);
    expect(
      ownership().every((record) => record.discord_user_id === owner && record.slot === 1),
    ).toBe(true);
    expect(calls).not.toContain('setPolicy');
    expect(calls).not.toContain('setPassword');
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });

  it.each(['standalone', 'history-only'] as const)(
    'leaves ownership and lifecycle links untouched for a %s played-state migration',
    async (kind) => {
      if (kind === 'history-only')
        servers.users.jellyfin.find((user) => user.Id === targetId)!.Policy!.IsAdministrator = true;
      const preview = kind === 'history-only' ? await service.preview([sourceId]) : undefined;
      const result = await finish(
        await service.migrateUsers(
          [sourceId],
          {},
          undefined,
          'watched_only',
          undefined,
          undefined,
          preview?.history_only_targets,
        ),
      );
      expect(result.status, JSON.stringify(result)).toBe('completed');
      expect(servers.played[targetId]).toEqual(new Set([movieId]));
      expect(ownership()).toEqual([]);
      expect(store.links()).toEqual([]);
      expect(writes()).toEqual(['updateUserData']);
      expect(bot.sendCredentials).not.toHaveBeenCalled();
    },
  );

  it('does not bind under a new pairing scope if authentication changes at unchanged server URLs', async () => {
    const gate = pauseRead(
      (kind, method, parameters) =>
        kind === 'jellyfin' && method === 'user' && parameters[0] === targetId,
    );
    const job = await service.migrateUsers([sourceId], { [sourceId]: owner });
    try {
      await gate.wait();
      const pending = store.resetAuth();
      expect(
        store.completeAuth(
          pending.generation,
          {
            kind: 'configured',
            serverUrl: store.settings().jellyfin_url,
            serverId: 'different-paired-jellyfin',
            apiKeyName: 'synthetic-repaired',
          },
          (settings) => settings,
        ),
      ).toBe(true);
    } finally {
      gate.release();
    }
    const result = await finish(job);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toMatch(
      /identity server configuration changed|server.*changed/i,
    );
    expect(store.db.prepare('SELECT count(*) AS count FROM media_ownership').get()).toEqual({
      count: 0,
    });
    expect(store.links()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
  });
});
