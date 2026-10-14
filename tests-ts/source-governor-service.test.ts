import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import type { MediaWorkload } from '../server/media-workload.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

describe('source cooldown and destination job isolation', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-source-governor-'));
    store = new Store(directory);
    const settings = {
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'synthetic-source-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-target-key',
      template_user_id: 'template',
    };
    const pending = store.resetAuth(settings.jellyfin_url);
    expect(
      store.completeAuth(
        pending.generation,
        {
          kind: 'configured',
          serverUrl: settings.jellyfin_url,
          serverId: 'demo-jellyfin',
          apiKeyName: 'Synthetic fixture',
        },
        () => settings,
      ),
    ).toBe(true);
    servers = new DemoServers();
    service = new Service(store, { clientFactory: servers.factory, observeMedia: () => {} });
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const governor = () => (service as unknown as { sourceWorkload: MediaWorkload }).sourceWorkload;
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  async function rejectSourceRead() {
    await expect(
      governor().read('catalog', async () => {
        throw new MediaError('Synthetic source rejected the request.', 503);
      }),
    ).rejects.toThrow('Synthetic source rejected');
    expect(governor().snapshot().cooldown_remaining_ms).toBeGreaterThan(0);
  }

  it('finishes unrelated fresh account creation while source reads are in cooldown', async () => {
    await rejectSourceRead();
    const originalSourceUsers = structuredClone(servers.users.emby);
    const job = await finish(await service.createAccount('casey'));
    expect(job.status).toBe('completed');
    expect(job.results[0]).toMatchObject({ username: 'casey', created: true, status: 'completed' });
    expect(servers.users.jellyfin.some((user) => user.Name === 'casey')).toBe(true);
    expect(servers.users.emby).toEqual(originalSourceUsers);
    expect(governor().snapshot().calls).toBe(1);
    expect(governor().snapshot().cooldown_remaining_ms).toBeGreaterThan(0);
  });

  it('finishes an unrelated role update without changing history during source cooldown', async () => {
    const role = service.roles.save(
      {
        name: 'Synthetic account preferences',
        parameters: {
          policy: { IsAdministrator: false, EnableAllFolders: true },
          configuration: { AudioLanguagePreference: 'en', EnableNextEpisodeAutoPlay: true },
          display: null,
        },
      },
      store.settings(),
    );
    const target = servers.users.jellyfin.find((user) => user.Id === 'j-river')!;
    service.roles.assign(role.id, role.revision, [target], store.settings());
    const previousHistory = structuredClone(servers.played);
    await rejectSourceRead();
    const job = await finish(
      await service.applyRole(role.id, role.revision, [target.Id], ['configuration']),
    );
    expect(job.status).toBe('completed');
    expect(job.results[0]).toMatchObject({ status: 'completed', role_sections: ['configuration'] });
    expect(target.Configuration).toMatchObject({
      AudioLanguagePreference: 'en',
      EnableNextEpisodeAutoPlay: true,
    });
    expect(servers.played).toEqual(previousHistory);
    expect(governor().snapshot().calls).toBe(1);
  });

  it('stops before provisioning when a source playlist rejection opens the circuit', async () => {
    const originalUsers = structuredClone(servers.users.jellyfin);
    const originalHistory = structuredClone(servers.played);
    const states = vi.fn(),
      playlists = vi.fn(),
      mutations = vi.fn();
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'emby') {
        const state = client.migrationState!.bind(client);
        client.migrationState = async (...parameters) => {
          states(parameters[0]);
          return state(...parameters);
        };
        client.playlists = async () => {
          playlists();
          return governor().read('playlists', async () => {
            throw new MediaError('Synthetic source rejected playlists.', 503);
          });
        };
      } else {
        const create = client.createUser.bind(client);
        client.createUser = async (name, password) => {
          mutations('createUser');
          return create(name, password);
        };
        for (const method of ['setPolicy', 'setConfiguration'] as const) {
          const original = client[method].bind(client);
          client[method] = async (id, value) => {
            mutations(method);
            return original(id, value);
          };
        }
      }
      return client;
    };
    const job = await finish(await service.migrateUsers(['e-sam', 'e-alex']));
    expect(job.status).toBe('failed');
    expect(job.error).toContain('No destination changes were started');
    expect(job.progress.processed).toBe(0);
    expect(job.results).toHaveLength(1);
    expect(states.mock.calls).toEqual([['e-sam']]);
    expect(playlists).toHaveBeenCalledTimes(1);
    expect(mutations).not.toHaveBeenCalled();
    expect(servers.users.jellyfin).toEqual(originalUsers);
    expect(servers.played).toEqual(originalHistory);
    expect(governor().snapshot()).toMatchObject({ calls: 1, failures: 1 });
  });
});
