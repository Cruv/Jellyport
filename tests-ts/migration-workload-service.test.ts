import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import type { MediaItem, MediaUserDataPatch } from '../server/media.js';
import type { MediaWorkloadEvent } from '../server/media-workload.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

describe('playback-conscious migration orchestration', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  let events: MediaWorkloadEvent[];
  const releases: Array<() => void> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-workload-service-'));
    store = new Store(directory);
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'private-fixture-source-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'private-fixture-target-key',
      template_user_id: 'template',
    });
    servers = new DemoServers();
    events = [];
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        if (args[2] === 'emby')
          client.systemInfo = async () => ({ Id: 'fixture-source', Version: '4.10.1.0' });
        return client;
      },
      observeMedia: (event) => events.push(event),
    });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  function snapshots(
    read: () => Promise<MediaItem[]> = async () => [
      { Id: '2', Type: 'Movie', ProviderIds: { Tmdb: '120467' }, UserData: { Played: true } },
    ],
  ) {
    const id = '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80';
    const select = vi
      .spyOn(service.sourceSnapshots, 'select')
      .mockImplementation(async (userId) => {
        const timestamp = new Date().toISOString();
        return {
          id,
          metadata: {
            id,
            source_server_url: 'http://emby',
            source_server_id: 'fixture-source',
            source_server_version: '4.10.1.0',
            source_user_id: userId,
            source_username: 'river',
            scope: 'complete',
            started_at: timestamp,
            finished_at: timestamp,
            expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
            items: 1,
            playlists: 0,
            playlist_entries: 0,
            bytes: 4096,
            avatar: false,
            source_type: 'sqlite_online_backup',
            schema: 'emby-4.10.1.0',
          },
          result: {
            id,
            requested_at: timestamp,
            binding: { url: 'http://emby', server_id: 'fixture-source', version: '4.10.1.0' },
            ok: true,
            started_at: timestamp,
            finished_at: timestamp,
            identities: { [userId]: 1 },
            schema: 'emby-4.10.1.0',
            bytes: 4096,
          },
        };
      });
    const items = vi.spyOn(service.sourceSnapshots, 'items').mockImplementation(read);
    return { select, items };
  }

  it('does no catalog work in live previews and pins one 100,000-item metadata array across users even after TTL expiry', async () => {
    let clock = Date.UTC(2026, 9, 8, 12),
      advanceDuringFirstUser = true;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let catalog: MediaItem[] | undefined;
    const catalogReads = vi.fn(
      async () =>
        (catalog ??= Array.from({ length: 100_000 }, (_, index) => ({
          Id: `source-${index}`,
          Type: 'Movie',
          ProviderIds: {
            Tmdb: index === 0 ? '329865' : index === 1 ? '120467' : `catalog-${index}`,
          },
        }))),
    );
    const sourceState: Record<string, MediaUserDataPatch> = {
      'e-river': {
        Played: false,
        IsFavorite: true,
        PlaybackPositionTicks: 300,
        PlayCount: 8,
        LastPlayedDate: '2026-10-06T12:00:00.000Z',
      },
      'e-sam': {
        Played: true,
        IsFavorite: true,
        PlayCount: 3,
        LastPlayedDate: '2026-10-05T12:00:00.000Z',
      },
    };
    servers.userData['j-river'] = {
      '1': {
        PlaybackPositionTicks: 900,
        PlayCount: 10,
        LastPlayedDate: '2026-10-07T12:00:00.000Z',
      },
    };
    const stateReads: Array<{ id: string; catalog: MediaItem[]; scope: string }> = [];
    const forbidden = vi.fn(async () => {
      throw new Error('Legacy catalog enumeration is forbidden.');
    });
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'emby') {
        client.catalogItems = catalogReads;
        client.migrationState = async (id, metadata, scope) => {
          stateReads.push({ id, catalog: metadata, scope: scope ?? 'complete' });
          if (advanceDuringFirstUser) {
            clock += 600_001;
            advanceDuringFirstUser = false;
          }
          return [
            { ...metadata[id === 'e-river' ? 0 : 1]!, UserData: structuredClone(sourceState[id]) },
          ];
        };
        client.items = forbidden;
        client.migrationItems = forbidden;
        client.watchedItems = forbidden;
      }
      return client;
    };
    const preview = await service.preview(['e-river', 'e-sam']);
    expect(preview.users.map((user) => user.stats)).toEqual([null, null]);
    expect(preview.users.every((user) => user.history_deferred)).toBe(true);
    expect(catalog).toBeUndefined();
    expect(catalogReads).not.toHaveBeenCalled();
    expect(stateReads).toEqual([]);
    const initial = await finish(await service.migrateUsers(['e-river', 'e-sam']));
    expect(initial.status).toBe('completed');
    expect(catalogReads).toHaveBeenCalledTimes(1);
    expect(stateReads.map((call) => call.id)).toEqual(['e-river', 'e-sam']);
    expect(stateReads.every((call) => call.scope === 'complete' && call.catalog === catalog)).toBe(
      true,
    );
    expect(catalog!.every((item) => !Object.hasOwn(item, 'UserData'))).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(initial.results.map((result) => result.source_catalog?.items)).toEqual([
      100_000, 100_000,
    ]);
    expect(initial.results[0]?.source_catalog?.captured_at).toBe(
      new Date(Date.UTC(2026, 9, 8, 12)).toISOString(),
    );
    expect(JSON.stringify(initial).length).toBeLessThan(30_000);
    expect(servers.userData['j-river']?.['1']).toMatchObject({
      IsFavorite: true,
      PlaybackPositionTicks: 900,
      PlayCount: 10,
      LastPlayedDate: '2026-10-07T12:00:00.000Z',
    });
    expect(servers.played['j-river']!.has('1')).toBe(true);
    const sam = servers.users.jellyfin.find((user) => user.Name === 'sam')!;
    expect(servers.userData[sam.Id]?.['2']).toMatchObject({
      Played: true,
      IsFavorite: true,
      PlayCount: 3,
      LastPlayedDate: '2026-10-05T12:00:00.000Z',
    });

    // A separate job refreshes the expired metadata once, then the next job shares it.
    expect((await finish(await service.migrateUsers(['e-river']))).status).toBe('completed');
    expect(catalogReads).toHaveBeenCalledTimes(2);
    sourceState['e-river'] = {
      Played: true,
      IsFavorite: true,
      PlaybackPositionTicks: 1100,
      LastPlayedDate: '2026-10-09T12:00:00.000Z',
    };
    servers.userData['j-river']!['1'] = {
      PlaybackPositionTicks: 1200,
      PlayCount: 10,
      LastPlayedDate: '2026-10-10T12:00:00.000Z',
    };
    const refreshedState = await finish(await service.migrateUsers(['e-river']));
    expect(refreshedState.status).toBe('completed');
    expect(catalogReads).toHaveBeenCalledTimes(2);
    expect(stateReads.map((call) => call.id)).toEqual(['e-river', 'e-sam', 'e-river', 'e-river']);
    expect(servers.userData['j-river']?.['1']).toMatchObject({
      PlaybackPositionTicks: 1200,
      PlayCount: 10,
      LastPlayedDate: '2026-10-10T12:00:00.000Z',
    });
    expect(
      events.some((event) => event.event === 'cache_hit' && event.cache_items === 100_000),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(
      /private-fixture|e-river|e-sam|LastPlayedDate|PlaybackPositionTicks/,
    );
    expect(forbidden).not.toHaveBeenCalled();
  }, 15_000);

  it('stops the entire batch after a late catalog failure and never reuses partial data or immediately repeats the crawl', async () => {
    let fail = true;
    const pages: number[] = [],
      states = vi.fn();
    const factory = service.clientFactory;
    const catalogReads = vi.fn(async () => {
      const partial: MediaItem[] = [];
      for (let page = 0; page < 3; page++) {
        pages.push(page);
        partial.push({ Id: `partial-${page}`, Type: 'Movie' });
        await Promise.resolve();
      }
      if (fail) throw new MediaError('The source catalog page was rejected.');
      return servers.factory('http://emby', 'fixture', 'emby').catalogItems!();
    });
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'emby') {
        client.catalogItems = catalogReads;
        const state = client.migrationState!.bind(client);
        client.migrationState = async (...parameters) => {
          states(parameters[0]);
          return state(...parameters);
        };
      }
      return client;
    };
    const failed = await finish(await service.migrateUsers(['e-river', 'e-sam']));
    expect(failed.status).toBe('failed');
    expect(catalogReads).toHaveBeenCalledTimes(1);
    expect(pages).toEqual([0, 1, 2]);
    expect(states).not.toHaveBeenCalled();
    expect(failed.progress.processed).toBe(0);
    expect(failed.results).toHaveLength(1);
    expect(servers.played['j-river']).toEqual(new Set(['1']));
    expect(servers.users.jellyfin).toHaveLength(2);
    fail = false;
    const retry = await finish(await service.migrateUsers(['e-river']));
    expect(retry.status).toBe('completed');
    expect(catalogReads).toHaveBeenCalledTimes(2);
    expect(states.mock.calls).toEqual([['e-river']]);
    expect(servers.played['j-river']).toEqual(new Set(['1', '2']));
  });

  it('waits to read snapshot history and destination details until active migration writes finish', async () => {
    const entered = deferred(),
      release = deferred();
    releases.push(release.resolve);
    let writesFinished = false;
    const factory = service.clientFactory,
      factoryCalls = vi.fn();
    service.clientFactory = (...args) => {
      factoryCalls(args[2]);
      const client = factory(...args);
      if (args[2] === 'emby') {
        const catalog = client.catalogItems!.bind(client);
        client.catalogItems = async () => {
          entered.resolve();
          await release.promise;
          return catalog();
        };
      } else {
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (...parameters) => {
          await update(...parameters);
          writesFinished = true;
        };
      }
      return client;
    };
    const { select, items } = snapshots(async () => {
      expect(writesFinished).toBe(true);
      return [
        { Id: '2', Type: 'Movie', ProviderIds: { Tmdb: '120467' }, UserData: { Played: true } },
      ];
    });
    const job = await service.migrateUsers(['e-river']);
    await entered.promise;
    const opened = factoryCalls.mock.calls.length;
    const pending = service.preview(['e-river'], { use_snapshots: true });
    await flush();
    expect(factoryCalls).toHaveBeenCalledTimes(opened);
    expect(select).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    release.resolve();
    const [final, preview] = await Promise.all([finish(job), pending]);
    expect(final.status).toBe('completed');
    expect(preview.users[0]?.stats).toMatchObject({
      source_played: 1,
      matched: 1,
      already_played: 1,
    });
    expect(items).toHaveBeenCalledTimes(1);
  });

  it('does not start migration source reads while a snapshot preview owns history admission', async () => {
    const entered = deferred(),
      release = deferred();
    releases.push(release.resolve);
    const catalogReads = vi.fn();
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'emby') {
        const catalog = client.catalogItems!.bind(client);
        client.catalogItems = async () => {
          catalogReads();
          return catalog();
        };
      }
      return client;
    };
    snapshots(async () => {
      entered.resolve();
      await release.promise;
      return [
        { Id: '2', Type: 'Movie', ProviderIds: { Tmdb: '120467' }, UserData: { Played: true } },
      ];
    });
    const pending = service.preview(['e-river'], { use_snapshots: true });
    await entered.promise;
    const job = await service.migrateUsers(['e-river']);
    await flush();
    expect(catalogReads).not.toHaveBeenCalled();
    release.resolve();
    const [preview, final] = await Promise.all([pending, finish(job)]);
    expect(preview.users[0]?.stats?.matched).toBe(1);
    expect(final.status).toBe('completed');
    expect(catalogReads).toHaveBeenCalledTimes(1);
  });

  it('cancels a snapshot preview waiting behind a migration without opening clients or disrupting active work', async () => {
    const entered = deferred(),
      release = deferred();
    releases.push(release.resolve);
    const factory = service.clientFactory,
      opened = vi.fn();
    service.clientFactory = (...args) => {
      opened(args[2]);
      const client = factory(...args);
      if (args[2] === 'emby') {
        const catalog = client.catalogItems!.bind(client);
        client.catalogItems = async () => {
          entered.resolve();
          await release.promise;
          return catalog();
        };
      }
      return client;
    };
    const saved = snapshots();
    const job = await service.migrateUsers(['e-river']);
    await entered.promise;
    const calls = opened.mock.calls.length;
    const controller = new AbortController();
    const pending = service.preview(['e-river'], {
      use_snapshots: true,
      signal: controller.signal,
    });
    const canceled = expect(pending).rejects.toThrow(/abort|cancel/i);
    controller.abort();
    await canceled;
    expect(opened).toHaveBeenCalledTimes(calls);
    expect(saved.select).not.toHaveBeenCalled();
    expect(saved.items).not.toHaveBeenCalled();
    expect(service.getJob(job.id).cancel_requested).toBeUndefined();
    release.resolve();
    expect((await finish(job)).status).toBe('completed');
    // An aborted waiter must release its place without poisoning subsequent admission.
    expect(
      (await service.preview(['e-river'], { use_snapshots: true })).users[0]?.stats?.matched,
    ).toBe(1);
  });
});
