import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoServers } from '../server/demo.js';
import { ServiceError } from '../server/errors.js';
import type { DestinationCatalogMetadata } from '../server/destination-catalog-files.js';
import type { MediaItem, MediaUserDataPatch } from '../server/media.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';

const sourceId = 'e-river';
const targetId = 'j-river';
const snapshotId = 'b35044e6-a4ba-4af6-880f-a09368010133';
const catalogId = 'b35044e6-a4ba-4af6-880f-a09368010134';
const laterCatalogId = 'b35044e6-a4ba-4af6-880f-a09368010135';
const sourceDate = '2026-10-01T12:00:00.000Z';
const newerDate = '2026-10-02T12:00:00.000Z';

describe('saved Jellyfin catalog service integration and independent readback', () => {
  let directory: string;
  let store: Store;
  let servers: DemoServers;
  let service: Service;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-offline-service-'));
    store = new Store(directory);
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'synthetic',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic',
      template_user_id: 'template',
    });
    servers = new DemoServers();
    servers.played = {};
    servers.playlists[sourceId] = [];
    servers.media = [
      {
        Id: '1',
        Type: 'Movie',
        ProviderIds: { Tmdb: 'synthetic-movie' },
        RunTimeTicks: 100_000_000,
      },
      {
        Id: '2',
        Type: 'Episode',
        ProviderIds: { Tvdb: 'synthetic-episode' },
        RunTimeTicks: 100_000_000,
      },
      { Id: 'unrelated', Type: 'Audio', ProviderIds: { MusicBrainzTrack: 'untouched' } },
    ];
    servers.userData[targetId] = {
      unrelated: { Played: true, IsFavorite: true, PlayCount: 9, LastPlayedDate: newerDate },
    };
    service = new Service(store, { clientFactory: servers.factory });
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  function metadata(id = catalogId): DestinationCatalogMetadata {
    const timestamp = new Date().toISOString();
    return {
      id,
      items: 194_633,
      keys: 500_000,
      bytes: 100_000_000,
      server_version: '12.2.0.0',
      backup_engine_version: '0.2.0',
      backup_created_at: timestamp,
      imported_at: timestamp,
      expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      import_elapsed_ms: 44_000,
    };
  }
  function setup(options: { realSelection?: boolean; duplicateEdition?: boolean } = {}) {
    const source: MediaItem[] = [
      {
        ...servers.media[0]!,
        Id: 'source-movie',
        UserData: {
          Played: true,
          PlayCount: 3,
          IsFavorite: true,
          LastPlayedDate: sourceDate,
          PlaybackPositionTicks: 30_000_000,
        },
      },
      {
        ...servers.media[1]!,
        Id: 'source-episode',
        UserData: { Played: false, LastPlayedDate: sourceDate, PlaybackPositionTicks: 50_000_000 },
      },
    ];
    if (options.duplicateEdition)
      source.push({
        ...source[0]!,
        Id: 'source-second-edition',
        UserData: {
          Played: true,
          PlayCount: 1,
          LastPlayedDate: newerDate,
          PlaybackPositionTicks: 50_000_000,
        },
      });
    const timestamp = new Date().toISOString();
    vi.spyOn(service.sourceSnapshots, 'select').mockResolvedValue({
      id: snapshotId,
      metadata: {
        id: snapshotId,
        source_server_url: 'http://emby',
        source_server_id: 'synthetic-emby',
        source_server_version: '4.10.1.0',
        source_user_id: sourceId,
        source_username: 'river',
        scope: 'complete',
        started_at: timestamp,
        finished_at: timestamp,
        expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
        items: source.length,
        playlists: 0,
        playlist_entries: 0,
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
        identities: { [sourceId]: 1 },
        schema: 'emby-4.10.1.0',
        bytes: 4096,
      },
    });
    vi.spyOn(service.sourceSnapshots, 'items').mockImplementation(async () =>
      structuredClone(source),
    );
    const selection = options.realSelection
      ? undefined
      : vi.spyOn(service.destinationSnapshots, 'queuedSelection').mockReturnValue(catalogId);
    const savedMetadata = vi
      .spyOn(service.destinationSnapshots, 'metadata')
      .mockImplementation(async (id) => metadata(id));
    const savedCandidates = vi
      .spyOn(service.destinationSnapshots, 'candidates')
      .mockImplementation(async () =>
        servers.media
          .filter((item) => item.Id !== 'unrelated')
          .map((item) => structuredClone(item)),
      );
    const catalog = vi.fn(async () => {
      throw new Error('A saved matching index must never crawl the live library.');
    });
    const sourceCatalog = vi.fn(async () => {
      throw new Error('Saved source history must never crawl Emby.');
    });
    const writes = vi.fn();
    const creates = vi.fn();
    const accountChanges = vi.fn();
    const freshReads = vi.fn();
    const destinationReads = vi.fn();
    const behavior = {
      ignoredFields: new Set<string>(),
      legacy: false,
      hidden: new Set<string>(),
      omitReadback: new Set<string>(),
      changedIdentity: false,
      afterWrite: undefined as undefined | ((itemId: string) => void),
      beforeFreshRead: undefined as undefined | ((itemId: string) => void),
    };
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        client.systemInfo = async () => ({ Id: 'synthetic-emby', Version: '4.10.1.0' });
        client.catalogItems = sourceCatalog;
        client.migrationItems = sourceCatalog;
      } else {
        client.systemInfo = async () => ({ Id: '1'.repeat(32), Version: '12.2.0.0' });
        client.catalogItems = catalog;
        client.migrationItems = catalog;
        const readItems = client.items.bind(client);
        client.destinationItems = async (id, candidates) => {
          destinationReads(id, structuredClone(candidates));
          const allowed = new Set(candidates.map((item) => item.Id));
          const readback = destinationReads.mock.calls.length > 1;
          const rows = (await readItems(id)).filter(
            (item) =>
              allowed.has(item.Id) &&
              !behavior.hidden.has(item.Id) &&
              !(readback && behavior.omitReadback.has(item.Id)),
          );
          if (readback && behavior.changedIdentity && rows[0])
            rows[0].ProviderIds = { Tmdb: 'changed-identity' };
          return rows;
        };
        const fresh = client.userData!.bind(client);
        client.userData = async (id, itemId) => {
          freshReads(id, itemId);
          behavior.beforeFreshRead?.(itemId);
          return fresh(id, itemId);
        };
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (id, itemId, patch) => {
          writes(id, itemId, structuredClone(patch));
          const supported = Object.fromEntries(
            Object.entries(patch).filter(([field]) => !behavior.ignoredFields.has(field)),
          );
          await update(id, itemId, supported);
          behavior.afterWrite?.(itemId);
        };
        client.migrationCapabilities = async () => ({
          userData: !behavior.legacy,
          privatePlaylists: true,
          playlistDuplicates: true,
          version: '12.2.0.0',
        });
        const markPlayed = client.markPlayed.bind(client);
        client.markPlayed = async (id, itemId, date) => {
          if (behavior.legacy)
            writes(id, itemId, { Played: true, ...(date ? { LastPlayedDate: date } : {}) });
          await markPlayed(id, itemId, date);
          (servers.userData[id] ??= {})[itemId] = {
            ...servers.userData[id]?.[itemId],
            Played: true,
          };
        };
        const create = client.createUser.bind(client);
        client.createUser = async (...parameters) => {
          creates(...parameters);
          return create(...parameters);
        };
        const setPassword = client.setPassword.bind(client);
        client.setPassword = async (...parameters) => {
          accountChanges('setPassword');
          return setPassword(...parameters);
        };
        const setPolicy = client.setPolicy.bind(client);
        client.setPolicy = async (...parameters) => {
          accountChanges('setPolicy');
          return setPolicy(...parameters);
        };
        const setConfiguration = client.setConfiguration.bind(client);
        client.setConfiguration = async (...parameters) => {
          accountChanges('setConfiguration');
          return setConfiguration(...parameters);
        };
      }
      return client;
    };
    const migrate = () =>
      service.migrateUsers([sourceId], {}, undefined, 'complete', { [sourceId]: snapshotId });
    return {
      source,
      behavior,
      selection,
      savedMetadata,
      savedCandidates,
      catalog,
      sourceCatalog,
      writes,
      freshReads,
      destinationReads,
      creates,
      accountChanges,
      migrate,
    };
  }

  it('uses the pinned offline candidate index and verifies applied watch and resume data independently', async () => {
    const fixture = setup();
    const untouched = structuredClone(servers.userData[targetId]!.unrelated);
    const job = await finish(await fixture.migrate());
    expect(job.status).toBe('completed');
    expect(job.destination_catalog_id).toBe(catalogId);
    expect(job.results[0]).toMatchObject({
      status: 'completed',
      destination_catalog: { id: catalogId },
      matched: 2,
      data: {
        verification: { checked: 2, verified: 2, mismatched: 0, missing: 0, unsupported_fields: 0 },
      },
    });
    expect(fixture.catalog).not.toHaveBeenCalled();
    expect(fixture.sourceCatalog).not.toHaveBeenCalled();
    expect(fixture.savedCandidates).toHaveBeenCalledTimes(1);
    expect(fixture.savedCandidates.mock.calls[0]![0]).toBe(catalogId);
    expect(fixture.destinationReads).toHaveBeenCalledTimes(2);
    expect(fixture.freshReads).toHaveBeenCalledTimes(2);
    expect(servers.userData[targetId]!['1']).toMatchObject({
      Played: true,
      PlayCount: 3,
      IsFavorite: true,
      LastPlayedDate: sourceDate,
      PlaybackPositionTicks: 30_000_000,
    });
    expect(
      await servers.factory('http://jellyfin', 'synthetic', 'jellyfin').userData!(targetId, '2'),
    ).toMatchObject({
      Played: false,
      LastPlayedDate: sourceDate,
      PlaybackPositionTicks: 50_000_000,
    });
    expect(servers.userData[targetId]!.unrelated).toEqual(untouched);
  });

  it('preserves activity added immediately before writing and still verifies the preserved result', async () => {
    const fixture = setup();
    fixture.behavior.beforeFreshRead = (itemId) => {
      if (itemId === '1')
        servers.userData[targetId]!['1'] = {
          Played: true,
          PlayCount: 9,
          LastPlayedDate: newerDate,
          PlaybackPositionTicks: 70_000_000,
        };
    };
    const job = await finish(await fixture.migrate());
    expect(job.results[0]?.status).toBe('completed');
    expect(servers.userData[targetId]!['1']).toMatchObject({
      Played: true,
      PlayCount: 9,
      LastPlayedDate: newerDate,
      PlaybackPositionTicks: 70_000_000,
      IsFavorite: true,
    });
    expect(fixture.writes.mock.calls.find(([, id]) => id === '1')?.[2]).toEqual({
      IsFavorite: true,
    });
  });

  it('does not treat a successful date write as proof that an ignored resume position was applied', async () => {
    const fixture = setup();
    fixture.behavior.ignoredFields.add('PlaybackPositionTicks');
    const job = await finish(await fixture.migrate());
    expect(job.results[0]).toMatchObject({
      status: 'partial',
      data: { verification: { checked: 2, mismatched: 2, verified: 0 } },
    });
    expect(servers.userData[targetId]!['1']?.LastPlayedDate).toBe(sourceDate);
    expect(servers.userData[targetId]!['1']?.PlaybackPositionTicks).toBeUndefined();
    expect(job.results[0]?.data?.warnings.join(' ')).toContain('Independent Jellyfin readback');
  });

  it('counts missing or changed readback identities as incomplete rather than reporting success', async () => {
    const fixture = setup();
    fixture.behavior.omitReadback.add('2');
    fixture.behavior.changedIdentity = true;
    const job = await finish(await fixture.migrate());
    expect(job.results[0]).toMatchObject({
      status: 'partial',
      data: { verification: { checked: 2, verified: 0, mismatched: 1, missing: 1 } },
    });
  });

  it('does not verify derived episode identities when their parent series is missing from readback', async () => {
    servers.media[1]!.SeriesId = 'series';
    servers.media[1]!.SeriesProviderIds = { Tvdb: 'synthetic-series' };
    servers.media.push({ Id: 'series', Type: 'Series', ProviderIds: { Tvdb: 'synthetic-series' } });
    const fixture = setup();
    fixture.behavior.omitReadback.add('series');
    const job = await finish(await fixture.migrate());
    expect(job.results[0]?.status).toBe('partial');
    expect(job.results[0]?.data?.verification?.missing).toBeGreaterThan(0);
    expect(job.results[0]?.data?.verification?.verified).toBeLessThan(2);
    expect(fixture.destinationReads.mock.calls[1]![1].map((item: MediaItem) => item.Id)).toContain(
      'series',
    );
  });

  it('retains every pre-write expectation when several source editions resolve to one target', async () => {
    const fixture = setup({ duplicateEdition: true });
    fixture.behavior.ignoredFields.add('PlayCount');
    fixture.behavior.afterWrite = (id) => {
      if (id === '1') fixture.behavior.ignoredFields.delete('PlayCount');
    };
    const job = await finish(await fixture.migrate());
    expect(
      (await servers.factory('http://jellyfin', 'synthetic', 'jellyfin').userData!(targetId, '1'))
        .PlayCount,
    ).toBe(1);
    expect(job.results[0]).toMatchObject({
      status: 'partial',
      matched: 3,
      data: { verification: { checked: 2, verified: 1, mismatched: 1 } },
    });
  });

  it('keeps account access authoritative even when the offline index contains a matching inaccessible item', async () => {
    const fixture = setup();
    fixture.behavior.hidden.add('2');
    const job = await finish(await fixture.migrate());
    expect(job.results[0]).toMatchObject({
      status: 'partial',
      matched: 1,
      unmatched: 1,
      data: { verification: { checked: 1, verified: 1 } },
    });
    expect(fixture.writes.mock.calls.map(([, id]) => id)).toEqual(['1']);
    expect(servers.userData[targetId]!['2']).toBeUndefined();
  });

  it('reports unsupported detailed fields on a limited client and verifies a later complete retry', async () => {
    const fixture = setup();
    fixture.behavior.legacy = true;
    const limited = await finish(await fixture.migrate());
    expect(limited.results[0]?.status).toBe('partial');
    expect(limited.results[0]?.data?.verification?.unsupported_fields).toBeGreaterThan(0);
    fixture.behavior.legacy = false;
    const retry = await finish(await fixture.migrate());
    expect(retry.results[0]).toMatchObject({
      status: 'completed',
      data: { verification: { checked: 2, verified: 2, unsupported_fields: 0 } },
    });
    expect(servers.userData[targetId]!['2']?.PlaybackPositionTicks).toBe(50_000_000);
  });

  it('verifies a repeat migration with zero repeated writes', async () => {
    const fixture = setup();
    await finish(await fixture.migrate());
    const firstWrites = fixture.writes.mock.calls.length;
    const rerun = await finish(await fixture.migrate());
    expect(rerun.results[0]).toMatchObject({
      status: 'completed',
      applied: 0,
      data: { items_updated: 0, verification: { checked: 2, verified: 2 } },
    });
    expect(fixture.writes).toHaveBeenCalledTimes(firstWrites);
    expect(fixture.destinationReads).toHaveBeenCalledTimes(4);
    expect(fixture.catalog).not.toHaveBeenCalled();
  });

  it('keeps the queued generation pinned when a newer generation becomes available', async () => {
    const fixture = setup();
    fixture.selection!.mockReturnValueOnce(catalogId).mockReturnValue(laterCatalogId);
    const job = await finish(await fixture.migrate());
    expect(job.destination_catalog_id).toBe(catalogId);
    expect(fixture.savedCandidates.mock.calls.every(([id]) => id === catalogId)).toBe(true);
    expect(fixture.savedMetadata.mock.calls.every(([id]) => id === catalogId)).toBe(true);
  });

  it('rejects a missing configured catalog before queuing any account mutation', async () => {
    const fixture = setup();
    fixture.selection!.mockImplementation(() => {
      throw new ServiceError('Import a current Jellyfin matching catalog before migrating.');
    });
    await expect(fixture.migrate()).rejects.toThrow('Import a current Jellyfin');
    expect(store.jobs()).toEqual([]);
    expect(fixture.creates).not.toHaveBeenCalled();
    expect(fixture.accountChanges).not.toHaveBeenCalled();
    expect(fixture.writes).not.toHaveBeenCalled();
  });

  it('rejects an expired pinned generation before account creation or template mutation', async () => {
    const fixture = setup();
    fixture.savedMetadata.mockRejectedValue(
      new ServiceError('The pinned Jellyfin catalog is expired.'),
    );
    const job = await finish(await fixture.migrate());
    expect(job.status).toBe('failed');
    expect(fixture.creates).not.toHaveBeenCalled();
    expect(fixture.accountChanges).not.toHaveBeenCalled();
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.catalog).not.toHaveBeenCalled();
  });

  it('rejects a job lacking a saved pin when backup mode becomes active after queueing', async () => {
    const fixture = setup();
    fixture.selection!.mockReturnValueOnce(undefined).mockReturnValue(catalogId);
    const job = await finish(await fixture.migrate());
    expect(job.status).toBe('failed');
    expect(fixture.creates).not.toHaveBeenCalled();
    expect(fixture.accountChanges).not.toHaveBeenCalled();
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.catalog).not.toHaveBeenCalled();
  });

  it('cancels an indexed candidate read without starting a live fallback or history write', async () => {
    const fixture = setup();
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.savedCandidates.mockImplementation(
      async (_id, _settings, _serverId, _version, _source, _mappings, signal) => {
        entered();
        return new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => reject(new ServiceError('Indexed read canceled.')),
            { once: true },
          );
        });
      },
    );
    const queued = await fixture.migrate();
    await pending;
    service.cancelJob(queued.id);
    const job = await finish(queued);
    expect(job.status).toBe('canceled');
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.catalog).not.toHaveBeenCalled();
  });

  it('fails closed before the first helper heartbeat when backup mode is explicitly configured', async () => {
    await service.stop();
    vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', 'backup');
    service = new Service(store, { clientFactory: servers.factory });
    const fixture = setup({ realSelection: true });
    await expect(fixture.migrate()).rejects.toThrow('Import a current Jellyfin');
    expect(fixture.creates).not.toHaveBeenCalled();
    expect(fixture.accountChanges).not.toHaveBeenCalled();
    expect(fixture.catalog).not.toHaveBeenCalled();
  });
});
