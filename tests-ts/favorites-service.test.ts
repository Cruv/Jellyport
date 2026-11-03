import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Service, migrationScope, type Job } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import type { MediaUserDataPatch } from '../server/media.js';

let directory: string, store: Store, servers: DemoServers, service: Service;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jellyport-favorites-service-'));
  store = new Store(directory);
  store.saveSettings({
    ...DEFAULT_SETTINGS,
    emby_url: 'http://emby',
    emby_api_key: 'synthetic-source-key',
    jellyfin_url: 'http://jellyfin',
    jellyfin_api_key: 'synthetic-target-key',
    template_user_id: 'template',
  });
  servers = new DemoServers();
  servers.media.push(
    {
      Id: 'favorite-only',
      Type: 'Movie',
      Name: 'Unwatched favorite',
      ProviderIds: { Tmdb: '222222' },
    },
    { Id: 'favorite-show', Type: 'Series', Name: 'Favorite show', ProviderIds: { Tvdb: '333333' } },
  );
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

describe('played-status and favorites migration', () => {
  it('defaults new requests to favorites while retaining explicitly approved legacy scopes', () => {
    expect(migrationScope(undefined)).toBe('played_favorites');
    expect(migrationScope('played_favorites')).toBe('played_favorites');
    expect(migrationScope('watched_only')).toBe('watched_only');
    expect(migrationScope('complete')).toBe('watched_only');
    expect(migrationScope(undefined, 'watched_only')).toBe('watched_only');
    expect(() => migrationScope('everything')).toThrow();
  });

  it('adds watched and favorite flags together, including unwatched movies and shows, without replacing Jellyfin activity', async () => {
    servers.userData['e-river'] = {
      '2': {
        IsFavorite: true,
        PlaybackPositionTicks: 10,
        PlayCount: 1,
        LastPlayedDate: '2025-01-01T00:00:00.000Z',
      },
      'favorite-only': { IsFavorite: true },
      'favorite-show': { IsFavorite: true },
    };
    servers.played['j-river']!.add('3');
    servers.userData['j-river'] = {
      '1': { IsFavorite: true },
      '2': {
        PlaybackPositionTicks: 900,
        PlayCount: 20,
        LastPlayedDate: '2026-11-01T00:00:00.000Z',
        Likes: false,
        Rating: 8,
      },
    };
    const before = structuredClone(servers.userData['j-river']['2']);
    const writes: Array<{ id: string; patch: MediaUserDataPatch }> = [];
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'jellyfin') {
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (user, id, patch) => {
          writes.push({ id, patch: structuredClone(patch) });
          await update(user, id, patch);
        };
        client.markFavorite = async () => {
          throw new Error('Legacy favorite endpoint is forbidden.');
        };
      }
      return client;
    };
    const preview = await service.preview(['e-river']);
    expect(preview.migration_scope).toBe('played_favorites');
    expect(preview.users[0]?.history_deferred).toBe(true);
    expect(writes).toEqual([]);
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('completed');
    expect(job.migration_scope).toBe('played_favorites');
    expect(job.results[0]).toMatchObject({
      source_played: 2,
      source_favorites: 3,
      source_items: 4,
      data: { favorites: 3, verification: { mismatched: 0, missing: 0 } },
    });
    expect(writes).toEqual(
      expect.arrayContaining([
        { id: '2', patch: { Played: true, IsFavorite: true } },
        { id: 'favorite-only', patch: { IsFavorite: true } },
        { id: 'favorite-show', patch: { IsFavorite: true } },
      ]),
    );
    expect(writes).toHaveLength(3);
    expect(servers.userData['j-river']!['2']).toEqual({
      ...before,
      Played: true,
      IsFavorite: true,
    });
    expect(servers.userData['j-river']!['1']?.IsFavorite).toBe(true);
    expect(servers.played['j-river']!.has('3')).toBe(true);
    expect(servers.played['j-river']!.has('favorite-only')).toBe(false);
    expect(servers.played['j-river']!.has('favorite-show')).toBe(false);
    writes.length = 0;
    const again = await finish(await service.migrateUsers(['e-river']));
    expect(again.status).toBe('completed');
    expect(again.results[0]?.data?.favorites).toBe(0);
    expect(writes).toEqual([]);
  });

  it('reports a successful API response that did not actually save the favorite', async () => {
    servers.played['e-river']!.clear();
    servers.userData['e-river'] = { 'favorite-only': { IsFavorite: true } };
    const factory = service.clientFactory;
    service.clientFactory = (...args) => {
      const client = factory(...args);
      if (args[2] === 'jellyfin') client.updateUserData = vi.fn(async () => {});
      return client;
    };
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).not.toBe('completed');
    expect(job.results[0]?.data?.verification).toMatchObject({ checked: 1, mismatched: 1 });
  });

  it('keeps older queued jobs and explicit played-only requests from acquiring favorites', async () => {
    servers.userData['e-river'] = { 'favorite-only': { IsFavorite: true } };
    const legacy = await finish(
      await service.migrateUsers(['e-river'], {}, undefined, 'watched_only'),
    );
    expect(legacy.migration_scope).toBe('watched_only');
    expect(legacy.results[0]?.source_favorites).toBe(0);
    expect(servers.userData['j-river']?.['favorite-only']).toBeUndefined();
    await service.stop();
    const timestamp = new Date().toISOString();
    const queued: Job = {
      id: 'legacy-favorite-approval',
      kind: 'migrate',
      status: 'queued',
      created_at: timestamp,
      updated_at: timestamp,
      progress: { processed: 0, total: 1 },
      results: [],
    };
    store.saveQueuedJob(queued, [{ source_user_id: 'e-river' }], store.settings());
    service = new Service(store, { clientFactory: servers.factory });
    await service.start();
    const resumed = await finish(queued);
    expect(resumed.migration_scope).toBe('watched_only');
    expect(resumed.results[0]?.data?.favorites).toBe(0);
    expect(servers.userData['j-river']?.['favorite-only']).toBeUndefined();
  });
});
