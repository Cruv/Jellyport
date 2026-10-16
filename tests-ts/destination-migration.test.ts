import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { MediaClient, type MediaItem, type CatalogReadOptions } from '../server/media.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

const snapshotId = 'b35044e6-a4ba-4af6-880f-a09368010133';
const sourceDate = '2026-10-01T12:00:00.000Z';
const destinationDate = '2026-10-02T12:00:00.000Z';

describe('destination catalog reuse and bounded user history', () => {
  let directory: string;
  let store: Store;
  let servers: DemoServers;
  let service: Service;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-destination-'));
    store = new Store(directory);
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      template_user_id: 'template',
    });
    servers = new DemoServers();
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

  function setup(userCount: number, unrelatedItems = 0) {
    const sourceIds = Array.from({ length: userCount }, (_, index) => `source-${index}`);
    const targetIds = Array.from({ length: userCount }, (_, index) => `target-${index}`);
    servers.users.emby = sourceIds.map((Id, index) => ({
      Id,
      Name: `member${index}`,
      Policy: {},
    }));
    servers.users.jellyfin = [
      servers.users.jellyfin[0]!,
      ...targetIds.map((Id, index) => ({
        Id,
        Name: `member${index}`,
        Policy: { IsAdministrator: false, IsDisabled: false },
        Configuration: {},
      })),
    ];
    servers.media.push(
      { Id: 'unrelated-history', Type: 'Audio', ProviderIds: { MusicBrainzTrack: 'untouched' } },
      ...Array.from({ length: unrelatedItems }, (_, index) => ({
        Id: `unrelated-${index}`,
        Type: 'Movie',
        ProviderIds: { Tmdb: `unrelated-${index}` },
      })),
    );
    servers.played = {};
    for (const id of sourceIds)
      servers.playlists[id] = [
        {
          Id: `playlist-${id}`,
          Name: 'Unplayed selection',
          Type: 'Playlist',
          MediaType: 'Video',
          items: ['2', '2'],
        },
      ];
    for (const id of targetIds)
      servers.userData[id] = {
        '1': {
          Played: false,
          PlayCount: 9,
          LastPlayedDate: destinationDate,
          PlaybackPositionTicks: 40_000_000,
        },
        '3': {
          Played: false,
          PlaybackPositionTicks: 90_000_000,
          LastPlayedDate: destinationDate,
        },
        'unrelated-history': {
          Played: true,
          PlayCount: 3,
          IsFavorite: true,
          LastPlayedDate: destinationDate,
        },
      };
    const sourceItems: MediaItem[] = [
      {
        ...servers.media[0]!,
        UserData: {
          Played: true,
          PlayCount: 4,
          IsFavorite: true,
          LastPlayedDate: sourceDate,
          PlaybackPositionTicks: 0,
        },
      },
      {
        ...servers.media[2]!,
        UserData: {
          Played: false,
          PlaybackPositionTicks: 10_000_000,
          LastPlayedDate: sourceDate,
        },
      },
      // Catalog metadata without state must not cause a destination user-state scan.
      ...servers.media.slice(3).map((item) => structuredClone(item)),
    ];
    const select = vi.spyOn(service.sourceSnapshots, 'select').mockImplementation(async (id) => {
      const timestamp = new Date().toISOString();
      return {
        id: snapshotId,
        metadata: {
          id: snapshotId,
          source_server_url: 'http://emby',
          source_server_id: 'synthetic-emby',
          source_server_version: '4.10.1.0',
          source_user_id: id,
          source_username: 'synthetic member',
          scope: 'complete',
          started_at: timestamp,
          finished_at: timestamp,
          expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
          items: sourceItems.length,
          playlists: 1,
          playlist_entries: 2,
          bytes: 4096,
          avatar: false,
          source_type: 'sqlite_online_backup',
          schema: 'emby-4.10.1.0',
        },
        result: {
          id: snapshotId,
          requested_at: timestamp,
          binding: { url: 'http://emby', server_id: 'synthetic-emby', version: '4.10.1.0' },
          ok: true,
          started_at: timestamp,
          finished_at: timestamp,
          identities: Object.fromEntries(sourceIds.map((sourceId) => [sourceId, 1])),
          schema: 'emby-4.10.1.0',
          bytes: 4096,
        },
      };
    });
    const items = vi
      .spyOn(service.sourceSnapshots, 'items')
      .mockImplementation(async () => structuredClone(sourceItems));
    const catalog = vi.fn(async (_options?: CatalogReadOptions) =>
      servers.media.map(({ UserData: _state, ...item }) => structuredClone(item) as MediaItem),
    );
    const destination = vi.fn(async (id: string, candidates: MediaItem[]) => {
      const ids = new Set(candidates.map((item) => item.Id));
      return (await servers.factory('http://jellyfin', 'synthetic', 'jellyfin').items(id)).filter(
        (item) => ids.has(item.Id),
      );
    });
    const fullUserCatalog = vi.fn(async () => {
      throw new Error('A destination user must never receive a full library crawl.');
    });
    const sourceCatalog = vi.fn(async () => {
      throw new Error('Saved source history must not crawl Emby.');
    });
    const sourcePlaylists = vi.fn();
    const sourcePlaylistItems = vi.fn();
    const writes = vi.fn();
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        client.systemInfo = async () => ({ Id: 'synthetic-emby', Version: '4.10.1.0' });
        client.catalogItems = sourceCatalog;
        client.migrationItems = sourceCatalog;
        const playlists = client.playlists!.bind(client);
        client.playlists = async (id) => {
          sourcePlaylists(id);
          return playlists(id);
        };
        const entries = client.playlistItems!.bind(client);
        client.playlistItems = async (id, userId) => {
          sourcePlaylistItems(id, userId);
          return entries(id, userId);
        };
      } else {
        client.catalogItems = catalog;
        client.migrationItems = fullUserCatalog;
        client.destinationItems = destination;
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (...parameters) => {
          writes(...parameters);
          return update(...parameters);
        };
      }
      return client;
    };
    const pinned = Object.fromEntries(sourceIds.map((id) => [id, snapshotId]));
    const migrate = (ids = sourceIds) =>
      service.migrateUsers(
        ids,
        {},
        undefined,
        'complete',
        Object.fromEntries(ids.map((id) => [id, snapshotId])),
      );
    return {
      sourceIds,
      sourceItems,
      targetIds,
      pinned,
      migrate,
      select,
      items,
      catalog,
      destination,
      fullUserCatalog,
      sourceCatalog,
      sourcePlaylists,
      sourcePlaylistItems,
      writes,
    };
  }

  it('pins saved history in a cold preview without reading history, playlists or catalogs', async () => {
    const fixture = setup(2, 1000);
    const preview = await service.preview(fixture.sourceIds, { use_snapshots: true });
    expect(preview.source_snapshot_ids).toEqual(fixture.pinned);
    expect(fixture.select).toHaveBeenCalledTimes(2);
    expect(preview.users).toHaveLength(2);
    for (const user of preview.users) {
      expect(user.stats).toBeNull();
      expect(user.history_deferred).toBe(true);
      expect(user.source_snapshot?.id).toBe(snapshotId);
      expect(user.unmatched).toEqual([]);
      expect(user.ambiguous).toEqual([]);
    }
    for (const read of [
      fixture.items,
      fixture.catalog,
      fixture.destination,
      fixture.fullUserCatalog,
      fixture.sourceCatalog,
      fixture.sourcePlaylists,
      fixture.sourcePlaylistItems,
    ])
      expect(read).not.toHaveBeenCalled();
    expect(store.jobs()).toEqual([]);
  });

  it('shares one catalog for 100 users and fetches only played history candidates', async () => {
    const fixture = setup(100, 1000);
    const job = await finish(await fixture.migrate());
    expect(job.status).toBe('completed');
    expect(job.results).toHaveLength(100);
    expect(fixture.catalog).toHaveBeenCalledTimes(1);
    expect(fixture.destination).toHaveBeenCalledTimes(200);
    expect(fixture.items).toHaveBeenCalledTimes(100);
    expect(fixture.fullUserCatalog).not.toHaveBeenCalled();
    expect(fixture.sourceCatalog).not.toHaveBeenCalled();
    for (const [id, candidates] of fixture.destination.mock.calls) {
      expect(fixture.targetIds).toContain(id);
      expect(candidates.map((item) => item.Id).sort()).toEqual(['1']);
      expect(candidates.every((item) => !Object.hasOwn(item, 'UserData'))).toBe(true);
    }
    for (const targetId of fixture.targetIds) {
      expect(servers.userData[targetId]?.['1']).toEqual({
        Played: true,
        PlayCount: 9,
        LastPlayedDate: destinationDate,
        PlaybackPositionTicks: 40_000_000,
      });
      expect(servers.userData[targetId]?.['3']).toEqual({
        Played: false,
        PlaybackPositionTicks: 90_000_000,
        LastPlayedDate: destinationDate,
      });
      expect(servers.userData[targetId]?.['unrelated-history']).toEqual({
        Played: true,
        PlayCount: 3,
        IsFavorite: true,
        LastPlayedDate: destinationDate,
      });
      expect(servers.playlists[targetId]).toBeUndefined();
    }
    expect(fixture.writes).toHaveBeenCalledTimes(100);
    expect(fixture.writes.mock.calls.every((call) => call[1] === '1')).toBe(true);
  });

  it('reuses metadata across jobs and rebuilds it after a destination credential change', async () => {
    const fixture = setup(1);
    expect((await finish(await fixture.migrate())).status).toBe('completed');
    expect((await finish(await fixture.migrate())).status).toBe('completed');
    expect(fixture.catalog).toHaveBeenCalledTimes(1);
    expect(fixture.destination).toHaveBeenCalledTimes(4);
    store.saveSettings({ ...store.settings(), jellyfin_api_key: 'rotated-synthetic-key' });
    expect((await finish(await fixture.migrate())).status).toBe('completed');
    expect(fixture.catalog).toHaveBeenCalledTimes(2);
    expect(fixture.destination).toHaveBeenCalledTimes(6);
    expect(servers.playlists[fixture.targetIds[0]!]).toBeUndefined();
  });

  it('checkpoints catalog progress at a bounded rate and clears it between accounts', async () => {
    const fixture = setup(2, 1000);
    const snapshots: Job[] = [];
    const save = store.saveJob.bind(store);
    vi.spyOn(store, 'saveJob').mockImplementation((job) => {
      snapshots.push(structuredClone(job));
      save(job);
    });
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    const load = fixture.catalog.getMockImplementation()!;
    fixture.catalog.mockImplementationOnce(async (options) => {
      const items = await load();
      for (let page = 1; page <= 11; page++) {
        time += 100;
        options?.onProgress?.({
          pages: page,
          items: Math.min(items.length, page * 100),
          elapsed_ms: page * 100,
          last_page_ms: 20,
        });
        expect(fixture.writes).not.toHaveBeenCalled();
      }
      return items;
    });
    try {
      const job = await finish(await fixture.migrate());
      expect(job.status).toBe('completed');
      const cold = snapshots.filter(
        (entry) => entry.progress.phase === 'indexing_target' && entry.progress.processed === 0,
      );
      expect(cold.map((entry) => entry.progress.catalog_pages)).toEqual([0, 1, 11, 11]);
      expect(cold.at(-1)?.progress).toMatchObject({
        catalog_items: servers.media.length,
        catalog_elapsed_ms: 1100,
        catalog_last_page_ms: 20,
        catalog_cache_hit: false,
      });
      expect(
        snapshots.some(
          (entry) => entry.progress.processed === 1 && entry.progress.catalog_cache_hit === true,
        ),
      ).toBe(true);
      expect(fixture.catalog).toHaveBeenCalledTimes(1);
      expect(job.progress).toEqual({ processed: 2, total: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves newer activity with an isolated played patch even when batch flags are stale', async () => {
    const fixture = setup(1);
    servers.userData['target-0']!['1']!.Played = true;
    fixture.destination.mockImplementationOnce(async (_id, candidates) =>
      candidates.map((item) => ({ ...item, UserData: { Played: false } })),
    );
    expect((await finish(await fixture.migrate())).status).toBe('completed');
    expect(fixture.writes.mock.calls).toEqual([['target-0', '1', { Played: true }]]);
    expect(servers.userData['target-0']?.['1']).toMatchObject({
      PlayCount: 9,
      LastPlayedDate: destinationDate,
      PlaybackPositionTicks: 40_000_000,
    });
    expect(servers.userData['target-0']?.['3']).toMatchObject({
      LastPlayedDate: destinationDate,
      PlaybackPositionTicks: 90_000_000,
    });
  });

  it('stops the batch after a failed catalog build and retries from a new build later', async () => {
    const fixture = setup(2);
    fixture.catalog.mockRejectedValueOnce(new MediaError('Synthetic destination unavailable.'));
    const failed = await finish(await fixture.migrate());
    expect(failed.status).toBe('failed');
    expect(fixture.catalog).toHaveBeenCalledTimes(1);
    expect(fixture.destination).not.toHaveBeenCalled();
    expect(fixture.items).toHaveBeenCalledTimes(1);
    expect(fixture.writes).not.toHaveBeenCalled();
    const retried = await finish(await fixture.migrate());
    expect(retried.status).toBe('completed');
    expect(fixture.catalog).toHaveBeenCalledTimes(2);
    expect(fixture.destination).toHaveBeenCalledTimes(4);
  });

  it('invalidates a built catalog and stops remaining users after a failed destination state read', async () => {
    const fixture = setup(2);
    fixture.destination.mockRejectedValueOnce(new MediaError('Synthetic state read unavailable.'));
    const failed = await finish(await fixture.migrate());
    expect(failed.status).toBe('failed');
    expect(fixture.catalog).toHaveBeenCalledTimes(1);
    expect(fixture.destination).toHaveBeenCalledTimes(1);
    expect(fixture.items).toHaveBeenCalledTimes(1);
    expect(fixture.writes).not.toHaveBeenCalled();
    expect((await finish(await fixture.migrate())).status).toBe('completed');
    expect(fixture.catalog).toHaveBeenCalledTimes(2);
    expect(fixture.destination).toHaveBeenCalledTimes(5);
  });

  it.each(['unavailable', 'changed'] as const)(
    'verifies parent series dependencies before writes when the series is %s',
    async (condition) => {
      servers.media[2] = {
        ...servers.media[2]!,
        SeriesId: 'series-3',
        SeriesProviderIds: { Tvdb: '42' },
      };
      servers.media.push({ Id: 'series-3', Type: 'Series', ProviderIds: { Tvdb: '42' } });
      const fixture = setup(2);
      fixture.sourceItems[1]!.UserData!.Played = true;
      const read = fixture.destination.getMockImplementation()!;
      fixture.destination.mockImplementationOnce(async (id, candidates) => {
        const returned = await read(id, candidates);
        const client = new MediaClient('http://synthetic.invalid', 'fixture-key', 'jellyfin', {
          transport: async () =>
            Response.json({
              Items: returned.flatMap((item) =>
                item.Id !== 'series-3'
                  ? [item]
                  : condition === 'unavailable'
                    ? []
                    : [{ ...item, ProviderIds: { Tvdb: 'changed' } }],
              ),
            }),
        });
        try {
          return await client.destinationItems(id, candidates);
        } finally {
          await client.close();
        }
      });
      const failed = await finish(await fixture.migrate());
      expect(failed.status).toBe('failed');
      expect(fixture.destination).toHaveBeenCalledTimes(1);
      expect(fixture.destination.mock.calls[0]?.[1].map((item) => item.Id)).toContain('series-3');
      expect(fixture.items).toHaveBeenCalledTimes(1);
      expect(fixture.writes).not.toHaveBeenCalled();
      expect(failed.results[0]?.error).toContain(
        condition === 'unavailable'
          ? 'series identity could not be verified'
          : 'catalog identities changed',
      );
      expect((await finish(await fixture.migrate())).status).toBe('completed');
      expect(fixture.catalog).toHaveBeenCalledTimes(2);
    },
  );
});
