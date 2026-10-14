import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('queued and running job cancellation', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  const releases: Array<() => void> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-cancellation-'));
    store = new Store(directory);
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'fixture-source',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'fixture-target',
      template_user_id: 'template',
    });
    servers = new DemoServers();
    service = new Service(store, { clientFactory: servers.factory, observeMedia: () => {} });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }

  it.each(['migrate', 'create', 'recover', 'role_update', 'membership'])(
    'cancels an unstarted durable %s job without opening a server client',
    async (kind) => {
      const timestamp = new Date().toISOString();
      const job: Job = {
        id: `queued-${kind}`,
        kind,
        status: 'queued',
        created_at: timestamp,
        updated_at: timestamp,
        progress: { processed: 0, total: 1 },
        results: [],
      };
      store.saveQueuedJob(job, [{ username: 'casey' }], store.settings());
      const factory = vi.fn(servers.factory);
      service.clientFactory = factory;
      const canceled = service.cancelJob(job.id);
      expect(canceled).toMatchObject({
        status: 'canceled',
        cancel_requested: true,
        results: [],
        progress: { processed: 0 },
      });
      expect(canceled.finished_at).toBeTruthy();
      expect(service.cancelJob(job.id)).toEqual(canceled);
      expect(store.queuedJobs()).toEqual([]);
      await service.stop();
      store.close();
      store = new Store(directory);
      expect(store.queuedJobs()).toEqual([]);
      service = new Service(store, { clientFactory: factory, observeMedia: () => {} });
      await service.start();
      await finish(job);
      expect(factory).not.toHaveBeenCalled();
      expect(service.getJob(job.id).status).toBe('canceled');
      expect(servers.users.jellyfin.map((user) => user.Name)).toEqual(['Member template', 'river']);
    },
  );

  it('rejects unknown job IDs and leaves a completed job unchanged', async () => {
    expect(() => service.cancelJob('missing')).toThrow('Job not found');
    const completed = await finish(await service.createAccount('casey'));
    expect(completed.status).toBe('completed');
    expect(service.cancelJob(completed.id)).toEqual(completed);
    expect(service.getJob(completed.id).cancel_requested).toBeUndefined();
  });

  it('aborts a running source catalog read and closes only that job’s owned clients', async () => {
    const entered = deferred();
    const closed = new Set<string>();
    const mutations = vi.fn();
    let rejectRead: ((reason: Error) => void) | undefined;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      const kind = args[2]!;
      if (kind === 'emby')
        client.catalogItems = async () =>
          new Promise((_, reject) => {
            rejectRead = reject;
            entered.resolve();
          });
      else
        client.updateUserData = async () => {
          mutations();
        };
      client.close = async () => {
        closed.add(kind);
        if (kind === 'emby') rejectRead?.(new MediaError('private upstream request details'));
      };
      return client;
    };
    const job = await service.migrateUsers(['e-river', 'e-sam']);
    await entered.promise;
    const requested = service.cancelJob(job.id);
    expect(requested).toMatchObject({ status: 'running', cancel_requested: true });
    const final = await finish(job);
    expect(final.status).toBe('canceled');
    expect(final.progress.processed).toBe(0);
    expect(closed).toEqual(new Set(['emby', 'jellyfin']));
    expect(mutations).not.toHaveBeenCalled();
    expect(servers.users.jellyfin).toHaveLength(2);
    expect(JSON.stringify(final)).not.toContain('private upstream request details');
  });

  it('drains in-flight Jellyfin writes before finishing and preserves applied changes without starting another user', async () => {
    for (let index = 0; index < 20; index++) {
      const id = `extra-${index}`;
      servers.media.push({
        Id: id,
        Name: 'Synthetic item',
        Type: 'Movie',
        ProviderIds: { Tmdb: `extra-${index}` },
      });
      servers.played['e-river']!.add(id);
    }
    const entered = deferred(),
      release = deferred();
    releases.push(release.resolve);
    const started: string[] = [],
      completed: string[] = [],
      sourceUsers: string[] = [];
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        const read = client.migrationState!.bind(client);
        client.migrationState = async (id, catalog, scope) => {
          sourceUsers.push(id);
          return read(id, catalog, scope);
        };
      } else {
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (id, itemId, patch) => {
          started.push(itemId);
          entered.resolve();
          await release.promise;
          await update(id, itemId, patch);
          completed.push(itemId);
        };
      }
      return client;
    };
    const job = await service.migrateUsers(['e-river', 'e-sam']);
    await entered.promise;
    const requested = service.cancelJob(job.id);
    expect(requested).toMatchObject({ status: 'running', cancel_requested: true });
    let drained = false;
    const pending = service.jobTasks.get(job.id)!.then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(service.getJob(job.id).status).toBe('running');
    expect(started.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThanOrEqual(4);
    const inFlight = [...started];
    release.resolve();
    await pending;
    const final = service.getJob(job.id);
    expect(final.status).toBe('canceled');
    expect(completed).toEqual(inFlight);
    expect(started).toEqual(inFlight);
    expect(sourceUsers).toEqual(['e-river']);
    expect(servers.users.jellyfin).toHaveLength(2);
    for (const id of completed) expect(servers.played['j-river']!.has(id)).toBe(true);
    expect(final.results[0]?.data?.items_updated).toBe(completed.length);
    expect(final.error).toMatch(/Already-applied changes.*preserved/);
  });
});
