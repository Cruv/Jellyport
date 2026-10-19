import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Service, type Job, type ReviewedHistoryTarget } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

describe('reviewed protected-account history migration', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-protected-history-'));
    store = new Store(directory);
    servers = new DemoServers();
    servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://fixture-emby',
      emby_api_key: 'fixture-emby-key',
      jellyfin_url: 'http://fixture-jellyfin',
      jellyfin_api_key: 'fixture-jellyfin-key',
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
  async function reviewed(sourceId = 'e-river') {
    const preview = await service.preview([sourceId]);
    expect(preview.users[0]?.history_only).toBe(true);
    return preview.history_only_targets!;
  }
  async function migrate(pins: Record<string, ReviewedHistoryTarget>, sourceId = 'e-river') {
    return finish(
      await service.migrateUsers(
        [sourceId],
        {},
        undefined,
        'watched_only',
        undefined,
        undefined,
        pins,
      ),
    );
  }
  function forbidManagement() {
    const mutation = vi.fn(async () => {
      throw new Error('Protected-account management must not run.');
    });
    const original = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = original(...args);
      client.createUser = mutation;
      client.setPassword = mutation;
      client.setPolicy = mutation;
      client.setConfiguration = mutation;
      client.setDisplayPreferences = mutation;
      client.setUserImage = mutation;
      return client;
    };
    const localMutations = [
      vi.spyOn(store, 'saveAccount'),
      vi.spyOn(store, 'saveCredentials'),
      vi.spyOn(store, 'saveLink'),
      vi.spyOn(service.mappings, 'bindTarget'),
      vi.spyOn(service.roles, 'assign'),
      vi.spyOn(service.roles, 'markApplied'),
    ];
    return () => {
      expect(mutation).not.toHaveBeenCalled();
      localMutations.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    };
  }

  it.each(['administrator', 'template'] as const)(
    'migrates additive played flags into the reviewed %s without account management',
    async (kind) => {
      const targetId = kind === 'template' ? 'template' : 'j-river';
      if (kind === 'template') servers.users.emby[1]!.Name = 'Member template';
      servers.played[targetId] = new Set(['1', '3']);
      servers.userData[targetId] = {
        '2': { PlayCount: 7, PlaybackPositionTicks: 12345, LastPlayedDate: '2026-10-01T10:00:00Z' },
      };
      // A half-finished provisioning journal must never resume or reset a password here.
      store.saveAccount(servers.users.emby[1]!.Name, targetId, 'provisioning', 'fixture-private');
      const beforeUsers = structuredClone(servers.users.jellyfin);
      const assertNoManagement = forbidManagement();
      const job = await migrate(await reviewed());
      expect(job.status).toBe('completed');
      expect(job.results[0]).toMatchObject({
        history_only: true,
        created: false,
        target_user_id: targetId,
        applied: 1,
        discord_delivery: 'not_requested',
        migration_outcome: { version: 1, execution: 'verified', unresolved_source_history: 0 },
      });
      expect(servers.played[targetId]).toEqual(new Set(['1', '2', '3']));
      expect(servers.userData[targetId]!['2']).toEqual({
        PlayCount: 7,
        PlaybackPositionTicks: 12345,
        LastPlayedDate: '2026-10-01T10:00:00Z',
        Played: true,
      });
      expect(servers.users.jellyfin).toEqual(beforeUsers);
      expect(
        store.db.prepare('SELECT count(*) AS count FROM credentials WHERE job_id=?').get(job.id),
      ).toEqual({ count: 0 });
      assertNoManagement();
    },
  );

  it('does not broaden unreviewed migrations, creation, recovery or Discord management', async () => {
    const assertNoManagement = forbidManagement();
    expect((await finish(await service.migrateUsers(['e-river']))).status).toBe('failed');
    const pins = await reviewed();
    await expect(
      service.migrateUsers(
        ['e-river'],
        { 'e-river': '123456789' },
        undefined,
        undefined,
        undefined,
        undefined,
        pins,
      ),
    ).rejects.toThrow('cannot send credentials');
    expect((await finish(await service.createAccount('river'))).status).toBe('failed');
    expect(servers.played['j-river']).toEqual(new Set(['1']));
    assertNoManagement();
  });

  it.each(['renamed', 'replaced', 'demoted', 'disabled', 'template changed', 'server changed'])(
    'rejects a reviewed destination that is %s before any write',
    async (change) => {
      const pins = await reviewed();
      const target = servers.users.jellyfin[1]!;
      if (change === 'renamed') target.Name = 'changed';
      if (change === 'replaced') target.Id = 'replacement';
      if (change === 'demoted') target.Policy!.IsAdministrator = false;
      if (change === 'disabled') target.Policy!.IsDisabled = true;
      if (change === 'template changed')
        store.saveSettings({ ...store.settings(), template_user_id: '' });
      if (change === 'server changed') {
        const original = service.clientFactory;
        service.clientFactory = (...args) => {
          const client = original(...args);
          if (args[2] === 'jellyfin') client.systemInfo = async () => ({ Id: 'changed-server' });
          return client;
        };
      }
      const assertNoManagement = forbidManagement();
      const update = vi.fn();
      const factory = service.clientFactory;
      service.clientFactory = (...args) => {
        const client = factory(...args);
        client.updateUserData = update;
        return client;
      };
      expect((await migrate(pins)).status).toBe('failed');
      expect(update).not.toHaveBeenCalled();
      assertNoManagement();
    },
  );

  it('rechecks protection after target preparation and before the first played update', async () => {
    const pins = await reviewed();
    const original = service.clientFactory;
    const update = vi.fn();
    service.clientFactory = (...args) => {
      const client = original(...args);
      if (args[2] === 'jellyfin') {
        const destinationItems = client.destinationItems!.bind(client);
        client.destinationItems = async (...values) => {
          const items = await destinationItems(...values);
          servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
          return items;
        };
        client.updateUserData = update;
      }
      return client;
    };
    const job = await migrate(pins);
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('history-only destination changed');
    expect(update).not.toHaveBeenCalled();
  });

  it('bounds guard requests to mutation batches and stops after a protection change', async () => {
    servers.media = Array.from({ length: 350 }, (_, index) => ({
      Id: String(index),
      Name: `Fixture movie ${index}`,
      Type: 'Movie',
      ProviderIds: { Tmdb: String(index + 10) },
    }));
    servers.played['e-river'] = new Set(servers.media.map((item) => item.Id));
    servers.played['j-river'] = new Set();
    const pins = await reviewed();
    let writes = 0,
      userReads = 0;
    const original = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = original(...args);
      if (args[2] === 'jellyfin') {
        const user = client.user.bind(client);
        client.user = async (id) => {
          userReads++;
          return user(id);
        };
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (...values) => {
          writes++;
          await update(...values);
          if (writes >= 50) servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
        };
      }
      return client;
    };
    const job = await migrate(pins);
    expect(job.status).toBe('failed');
    expect(writes).toBeGreaterThanOrEqual(50);
    expect(writes).toBeLessThanOrEqual(105);
    expect(userReads).toBeLessThan(10);
    expect(job.results[0]?.data?.write_metrics?.succeeded).toBe(writes);
    expect(servers.played['j-river']?.size).toBe(writes);
  });

  it('does not add guard API work per already-played item and checks final readback', async () => {
    servers.media = Array.from({ length: 1200 }, (_, index) => ({
      Id: String(index),
      Name: `Fixture movie ${index}`,
      Type: 'Movie',
      ProviderIds: { Tmdb: String(index + 10) },
    }));
    servers.played['e-river'] = new Set(servers.media.map((item) => item.Id));
    servers.played['j-river'] = new Set(servers.played['e-river']);
    const pins = await reviewed();
    let userReads = 0,
      reads = 0;
    const original = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = original(...args);
      if (args[2] === 'jellyfin') {
        const user = client.user.bind(client);
        client.user = async (id) => {
          userReads++;
          return user(id);
        };
        const destinationItems = client.destinationItems!.bind(client);
        client.destinationItems = async (...values) => {
          const items = await destinationItems(...values);
          if (++reads === 2) servers.users.jellyfin[1]!.Policy!.IsAdministrator = false;
          return items;
        };
      }
      return client;
    };
    const job = await migrate(pins);
    expect(job.status).toBe('partial');
    expect(job.results[0]).toMatchObject({
      applied: 0,
      migration_outcome: { execution: 'needs_review' },
      data: { verification: { missing: 1200, verified: 0 } },
    });
    expect(userReads).toBeLessThan(8);
  });
});
