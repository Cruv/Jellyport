import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaError, ServiceError } from '../server/errors.js';
import {
  Service,
  generatePassword,
  templatePolicy,
  validateUsername,
  type BotAdapter,
  type Job,
} from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import type { MediaItem } from '../server/media.js';

class FakeBot implements BotAdapter {
  delivered: string[][] = [];
  username = 'alex';
  active: boolean | null = false;
  members: Array<{ id: string; username: string }> | null = [];
  status() {
    return { enabled: true, connected: true };
  }
  async validateRecipient(_id: string) {}
  async recipientIdentity(id: string) {
    return { id, username: this.username };
  }
  async sendCredentials(
    id: string,
    username: string,
    password: string,
    url: string,
    _requireMembership = true,
  ) {
    this.delivered.push([id, username, password, url]);
  }
  async membershipActive(_id: string) {
    return this.active;
  }
  async activeMembers() {
    return this.members;
  }
}
describe('account migration and subscription safety', () => {
  let directory: string, store: Store, servers: DemoServers, service: Service;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-service-'));
    store = new Store(directory);
    servers = new DemoServers();
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'secret-emby',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'secret-jellyfin',
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

  it.each(['template', 'administrator', 'disabled'])(
    'rejects a %s destination before scanning catalogs or playlists',
    async (protection) => {
      if (protection === 'template') servers.users.emby[0]!.Name = 'Member template';
      else {
        servers.users.emby[0]!.Name = 'river';
        servers.users.jellyfin[1]!.Policy![
          protection === 'administrator' ? 'IsAdministrator' : 'IsDisabled'
        ] = true;
      }
      const reads = vi.fn(async () => {
        throw new Error('Catalog reads must not start for a protected destination.');
      });
      service.clientFactory = (...args) => {
        const client = servers.factory(...args);
        client.items = reads;
        client.migrationItems = reads;
        client.playlists = reads;
        return client;
      };
      await expect(service.preview(['e-alex'])).rejects.toThrow(protection);
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(['different account', 'renamed mapping'])(
    'rejects a source with %s before scanning catalogs or playlists',
    async (mismatch) => {
      if (mismatch === 'renamed mapping') {
        approveMapping('e-alex', 'alex');
        servers.users.emby[0]!.Name = 'changed-source-name';
      }
      const reads = vi.fn(async () => {
        throw new Error('Catalog reads must not start before source identity is checked.');
      });
      service.clientFactory = (...args) => {
        const client = servers.factory(...args);
        if (args[2] === 'emby' && mismatch === 'different account') {
          const original = client.user.bind(client);
          client.user = async (id) => ({ ...(await original(id)), Id: 'different-source-id' });
        }
        client.items = reads;
        client.migrationItems = reads;
        client.playlists = reads;
        return client;
      };
      await expect(service.preview(['e-alex'])).rejects.toThrow(
        mismatch === 'different account' ? 'different source account' : 'renamed',
      );
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it('counts source playlists without reading entries in preview, while migration reads their contents', async () => {
    servers.playlists['e-river'] = [
      {
        Id: 'source-list',
        Name: 'Favorites',
        Type: 'Playlist',
        MediaType: 'Video',
        items: ['2', '1'],
      },
    ];
    const entries = vi.fn();
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        const original = client.playlistItems!.bind(client);
        client.playlistItems = async (...parameters) => {
          entries(...parameters);
          return original(...parameters);
        };
      }
      return client;
    };
    const preview = await service.preview(['e-river']);
    expect(preview.users[0]?.stats.source_playlists).toBe(1);
    expect(entries).not.toHaveBeenCalled();
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(entries).toHaveBeenCalledWith('source-list', 'e-river');
    expect(job.results[0]?.data?.playlists_created).toBe(1);
    expect(servers.playlists['j-river']?.[0]?.items).toEqual(['2', '1']);
  });

  it.each(['unavailable', 'unsupported', 'over limit'])(
    'reports safe playlist metadata warnings when source playlists are %s',
    async (condition) => {
      const entries = vi.fn(async () => []);
      service.clientFactory = (...args) => {
        const client = servers.factory(...args);
        if (args[2] === 'emby') {
          client.playlistItems = entries;
          if (condition === 'unsupported') client.playlists = undefined;
          else
            client.playlists = async () => {
              if (condition === 'unavailable') throw new Error('private upstream credential');
              return Array.from({ length: 501 }, (_, index) => ({
                Id: `playlist-${index}`,
                Name: 'Playlist',
                Type: 'Playlist',
              }));
            };
        }
        return client;
      };
      const preview = await service.preview(['e-river']);
      expect(preview.users[0]?.stats.source_playlists).toBe(condition === 'over limit' ? 500 : 0);
      expect(preview.users[0]?.warnings).toEqual([
        condition === 'unsupported'
          ? 'This source client cannot read playlists.'
          : condition === 'over limit'
            ? 'Only the first 500 source playlists were read. Remaining playlists were skipped.'
            : 'Source playlists could not be read; library data can still migrate.',
      ]);
      expect(JSON.stringify(preview)).not.toContain('private upstream credential');
      expect(entries).not.toHaveBeenCalled();
    },
  );

  it('overlaps independent catalog scans and reports progress after each completed user', async () => {
    let sourceStarted!: () => void;
    let targetStarted!: () => void;
    const sourceReady = new Promise<void>((resolve) => {
      sourceStarted = resolve;
    });
    const targetReady = new Promise<void>((resolve) => {
      targetStarted = resolve;
    });
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      const original = client.migrationItems!.bind(client);
      client.migrationItems = async (...parameters) => {
        if (args[2] === 'emby') {
          sourceStarted();
          await targetReady;
        } else {
          targetStarted();
          await sourceReady;
        }
        return original(...parameters);
      };
      return client;
    };
    const progress = vi.fn();
    const preview = await service.preview(['e-river', 'e-sam'], { progress });
    expect(preview.users.map((user) => user.source_user_id)).toEqual(['e-river', 'e-sam']);
    expect(progress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  }, 1000);

  it('reuses only sanitized new-destination catalogs within a preview and never across previews', async () => {
    const targetReads = vi.fn();
    servers.userData.template = {
      '1': { Played: true, IsFavorite: true, PlaybackPositionTicks: 5000 },
    };
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'jellyfin') {
        const original = client.migrationItems!.bind(client);
        client.migrationItems = async (id) => {
          targetReads(id);
          return original(id);
        };
      }
      return client;
    };
    const preview = await service.preview(['e-alex', 'e-sam', 'e-river']);
    expect(targetReads.mock.calls).toEqual([['template'], ['j-river']]);
    expect(preview.users.map((user) => user.stats.already_played)).toEqual([0, 0, 1]);
    expect(JSON.stringify(preview)).not.toContain('PlaybackPositionTicks');
    await service.preview(['e-alex', 'e-sam']);
    expect(targetReads.mock.calls).toEqual([['template'], ['j-river'], ['template']]);
  });

  it('bounds preview detail arrays while retaining full unmatched and ambiguous counts', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.migrationItems = async () =>
        args[2] === 'emby'
          ? [
              ...Array.from({ length: 201 }, (_, index) => ({
                Id: `unmatched-${index}`,
                Name: 'Unmatched movie',
                Type: 'Movie',
                ProviderIds: { Tmdb: `missing-${index}` },
                UserData: { Played: true },
              })),
              ...Array.from({ length: 201 }, (_, index) => ({
                Id: `ambiguous-${index}`,
                Name: 'Ambiguous movie',
                Type: 'Movie',
                ProviderIds: { Tmdb: 'multiple-editions' },
                UserData: { Played: true },
              })),
            ]
          : Array.from({ length: 21 }, (_, index) => ({
              Id: `candidate-${index}`,
              Name: 'Candidate movie',
              Type: 'Movie',
              ProviderIds: { Tmdb: 'multiple-editions' },
            }));
      return client;
    };
    const preview = await service.preview(['e-river']);
    expect(preview.users[0]?.stats).toMatchObject({
      source_items: 402,
      unmatched: 201,
      ambiguous: 201,
    });
    expect(preview.users[0]?.unmatched).toHaveLength(200);
    expect(preview.users[0]?.ambiguous).toHaveLength(200);
    expect(preview.users[0]?.ambiguous.every((entry) => entry.candidates.length === 20)).toBe(true);
    expect(preview.users[0]?.warnings).toContain(
      'Preview details are limited to 200 unmatched items, 200 ambiguous items, and 20 candidates per item. Full counts are shown; migration checks every item.',
    );
  });

  it('projects preview details to bounded primitive strings without retaining nested upstream data', async () => {
    const privateObject = { private_plugin_token: 'private-plugin-value' };
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.migrationItems = async () =>
        args[2] === 'emby'
          ? [
              {
                Id: 'nested-source',
                Name: privateObject,
                Type: 'Movie',
                UserData: { Played: true },
              } as unknown as MediaItem,
              {
                Id: 'oversize-id'.repeat(100),
                Name: 'oversize-name'.repeat(100),
                Type: 'Movie',
                UserData: { Played: true },
              },
              {
                Id: 'ambiguous-source',
                Name: privateObject,
                Type: 'Movie',
                ProviderIds: { Tmdb: 'multiple-editions' },
                UserData: { Played: true },
              } as unknown as MediaItem,
              {
                Id: 'nested-type',
                Name: 'Nested type',
                Type: privateObject,
                UserData: { IsFavorite: true },
              } as unknown as MediaItem,
              {
                Id: 'oversize-type',
                Name: 'Oversize type',
                Type: 'unsupported-type'.repeat(100),
                UserData: { IsFavorite: true },
              },
            ]
          : [
              {
                Id: 'nested-candidate',
                Name: privateObject,
                Type: 'Movie',
                ProviderIds: { Tmdb: 'multiple-editions' },
              } as unknown as MediaItem,
              {
                Id: 'oversize-candidate-id'.repeat(100),
                Name: 'oversize-candidate-name'.repeat(100),
                Type: 'Movie',
                ProviderIds: { Tmdb: 'multiple-editions' },
              },
            ];
      return client;
    };
    const preview = await service.preview(['e-river']);
    const details = preview.users[0]!;
    expect(details.unmatched[0]).toEqual({ Id: 'nested-source', Type: 'Movie' });
    expect(details.unmatched[1]?.Id).toHaveLength(128);
    expect(details.unmatched[1]?.Name).toHaveLength(512);
    expect(details.unmatched[2]).toEqual({ Id: 'nested-type', Name: 'Nested type' });
    expect(details.unmatched[3]?.Type).toHaveLength(64);
    expect(details.ambiguous[0]?.source).toEqual({ Id: 'ambiguous-source', Type: 'Movie' });
    expect(details.ambiguous[0]?.candidates[0]).toEqual({ Id: 'nested-candidate', Type: 'Movie' });
    expect(details.ambiguous[0]?.candidates[1]?.Id).toHaveLength(128);
    expect(details.ambiguous[0]?.candidates[1]?.Name).toHaveLength(512);
    expect(JSON.stringify(preview)).not.toContain('private-plugin-value');
    expect(JSON.stringify(preview)).not.toContain('private_plugin_token');
    expect(details.stats).toMatchObject({ source_items: 5, unmatched: 4, ambiguous: 1 });
  });

  it('rejects an already canceled preview without opening media clients', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private cancellation reason'));
    const factory = vi.fn(servers.factory);
    service.clientFactory = factory;
    await expect(service.preview(['e-river'], { signal: controller.signal })).rejects.toThrow(
      'History matching was canceled.',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('stops before the next user when canceled after a progress update', async () => {
    const controller = new AbortController();
    const sourceUsers = vi.fn();
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        const original = client.user.bind(client);
        client.user = async (id) => {
          sourceUsers(id);
          return original(id);
        };
      }
      return client;
    };
    const progress = vi.fn(() => controller.abort());
    await expect(
      service.preview(['e-river', 'e-sam'], { signal: controller.signal, progress }),
    ).rejects.toThrow('History matching was canceled.');
    expect(progress.mock.calls).toEqual([[1, 2]]);
    expect(sourceUsers.mock.calls).toEqual([['e-river']]);
  });

  it('closes both preview clients when canceled during catalog reads and returns a safe error', async () => {
    const controller = new AbortController();
    const started = new Set<string>();
    const closed = new Set<string>();
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      const kind = args[2]!;
      let reject!: (reason: Error) => void;
      client.migrationItems = async () =>
        new Promise((_, fail) => {
          reject = fail;
          started.add(kind);
          if (started.size === 2) ready();
        });
      client.close = async () => {
        closed.add(kind);
        reject?.(new MediaError('private upstream cancellation details'));
      };
      return client;
    };
    const progress = vi.fn();
    const pending = service.preview(['e-river'], { signal: controller.signal, progress });
    const rejected = expect(pending).rejects.toThrow('History matching was canceled.');
    await reading;
    controller.abort(new Error('private cancellation reason'));
    await rejected;
    expect(closed).toEqual(new Set(['emby', 'jellyfin']));
    expect(progress).not.toHaveBeenCalled();
    expect(store.jobs()).toEqual([]);
  });

  it('removes its cancellation listener after preview clients are closed normally', async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.close = close;
      return client;
    };
    await service.preview(['e-river'], { signal: controller.signal });
    expect(close).toHaveBeenCalledTimes(2);
    controller.abort();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('migrates played items, reveals new credentials once and preserves them on repeated merging', async () => {
    const preview = await service.preview(['e-alex']);
    expect(preview.users[0]?.stats).toEqual({
      source_played: 4,
      matched: 3,
      unmatched: 1,
      ambiguous: 0,
      already_played: 0,
      source_items: 4,
      source_favorites: 0,
      source_resume: 0,
      source_playlists: 0,
    });
    const job = await finish(await service.migrateUsers(['e-alex']));
    expect(job.status).toBe('partial');
    expect(job.results[0]?.applied).toBe(3);
    const alex = servers.users.jellyfin.find((user) => user.Name === 'alex')!;
    expect(alex.Policy).toEqual(servers.users.jellyfin[0]?.Policy);
    const credentials = store.takeCredentials(job.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.password).toHaveLength(24);
    expect(store.takeCredentials(job.id)).toEqual([]);
    const repeat = await finish(await service.migrateUsers(['e-alex']));
    expect(repeat.results[0]?.created).toBe(false);
    expect(repeat.results[0]?.applied).toBe(0);
    expect(store.takeCredentials(repeat.id)).toEqual([]);
    expect(servers.users.jellyfin.filter((user) => user.Name === 'alex')).toHaveLength(1);
  });
  it('preserves an existing account password, permissions and Jellyfin-only played items', async () => {
    const river = servers.users.jellyfin[1]!;
    river.Policy!.EnableAllFolders = false;
    const before = structuredClone(river);
    servers.played['j-river']!.add('3');
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('completed');
    expect(river).toEqual(before);
    expect(servers.played['j-river']).toEqual(new Set(['1', '2', '3']));
    expect(store.takeCredentials(job.id)).toEqual([]);
  });
  it('quick migration reads only watched source items and preserves all unrelated destination data', async () => {
    servers.userData['e-river'] = {
      '2': {
        IsFavorite: true,
        PlayCount: 8,
        PlaybackPositionTicks: 700,
        Rating: 9,
        Likes: false,
        LastPlayedDate: '2026-10-06T12:00:00.000Z',
      },
      '3': { IsFavorite: true, PlaybackPositionTicks: 1000 },
    };
    servers.userData['j-river'] = {
      '2': {
        PlaybackPositionTicks: 800,
        PlayCount: 2,
        Rating: 4,
        LastPlayedDate: '2026-10-07T12:00:00.000Z',
      },
    };
    const watchedReads = vi.fn();
    const excluded = vi.fn(async () => {
      throw new Error('Quick migration must not import this data.');
    });
    const patches: unknown[] = [];
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        const original = client.migrationItems!.bind(client);
        client.watchedItems = async (id) => {
          watchedReads(id);
          return (await original(id)).filter((item) => item.UserData?.Played === true);
        };
        client.migrationItems = excluded;
        client.playlists = excluded;
        client.playlistItems = excluded;
        client.userImage = excluded;
      } else {
        const update = client.updateUserData!.bind(client);
        client.updateUserData = async (...parameters) => {
          patches.push(parameters[2]);
          await update(...parameters);
        };
        client.createPlaylist = excluded;
        client.setConfiguration = excluded;
        client.setUserImage = excluded;
      }
      return client;
    };
    const preview = await service.preview(['e-river'], { migration_scope: 'watched_only' });
    expect(preview.migration_scope).toBe('watched_only');
    expect(preview.users[0]?.stats).toMatchObject({
      source_items: 2,
      matched: 2,
      source_favorites: 0,
      source_resume: 0,
      source_playlists: 0,
    });
    const job = await finish(
      await service.migrateUsers(['e-river'], {}, undefined, 'watched_only'),
    );
    expect(job.status).toBe('completed');
    expect(job.migration_scope).toBe('watched_only');
    expect(job.results[0]?.applied).toBe(1);
    expect(watchedReads.mock.calls).toEqual([['e-river'], ['e-river']]);
    expect(excluded).not.toHaveBeenCalled();
    expect(patches).toEqual([{ Played: true }]);
    expect(servers.userData['j-river']?.['2']).toEqual({
      Played: true,
      PlaybackPositionTicks: 800,
      PlayCount: 2,
      Rating: 4,
      LastPlayedDate: '2026-10-07T12:00:00.000Z',
    });
    expect(servers.userData['j-river']?.['3']).toBeUndefined();
  });

  it('quick new accounts keep normal defaults and can import the remaining data in a later complete migration', async () => {
    servers.users.emby[2]!.Configuration = { AudioLanguagePreference: 'spa' };
    servers.images['e-sam'] = { contentType: 'image/png', data: new Uint8Array([137, 80]) };
    servers.userData['e-sam'] = { '1': { IsFavorite: true, PlaybackPositionTicks: 500 } };
    const quick = await finish(
      await service.migrateUsers(['e-sam'], {}, undefined, 'watched_only'),
    );
    expect(quick.status).toBe('completed');
    const target = servers.users.jellyfin.find((user) => user.Name === 'sam')!;
    expect(target.Configuration).toEqual(servers.users.jellyfin[0]!.Configuration);
    expect(target.Policy).toEqual(servers.users.jellyfin[0]!.Policy);
    expect(servers.images[target.Id]).toBeUndefined();
    expect(servers.userData[target.Id]?.['1']).toBeUndefined();
    expect(store.takeCredentials(quick.id)).toHaveLength(1);
    const complete = await finish(await service.migrateUsers(['e-sam']));
    expect(complete.migration_scope).toBe('complete');
    expect(complete.results[0]?.created).toBe(false);
    expect(servers.userData[target.Id]?.['1']).toMatchObject({
      IsFavorite: true,
      PlaybackPositionTicks: 500,
    });
    expect(store.takeCredentials(complete.id)).toEqual([]);
  });

  it('retains watched-only scope in a durable unstarted job across a store restart', async () => {
    await service.stop();
    const timestamp = new Date().toISOString();
    const queued: Job = {
      id: 'durable-quick-job',
      kind: 'migrate',
      status: 'queued',
      created_at: timestamp,
      updated_at: timestamp,
      migration_scope: 'watched_only',
      progress: { processed: 0, total: 1 },
      results: [],
    };
    servers.userData['e-river'] = { '3': { IsFavorite: true } };
    store.saveQueuedJob(
      queued,
      [{ source_user_id: 'e-river', migration_scope: 'watched_only' }],
      store.settings(),
    );
    store.close();
    store = new Store(directory);
    service = new Service(store, { clientFactory: servers.factory });
    await service.start();
    const job = await finish(queued);
    expect(job.status).toBe('completed');
    expect(job.migration_scope).toBe('watched_only');
    expect(job.results[0]?.data?.favorites).toBe(0);
    expect(servers.userData['j-river']?.['3']).toBeUndefined();
  });

  it('rejects unknown migration scopes before any reads or queued mutations', async () => {
    const reads = vi.fn();
    service.clientFactory = (...args) => {
      reads();
      return servers.factory(...args);
    };
    await expect(
      service.preview(['e-river'], { migration_scope: 'unknown' as never }),
    ).rejects.toThrow('Choose complete or watched-only');
    await expect(
      service.migrateUsers(['e-river'], {}, undefined, 'unknown' as never),
    ).rejects.toThrow('Choose complete or watched-only');
    expect(reads).not.toHaveBeenCalled();
    expect(store.jobs()).toEqual([]);
  });

  it.each(['complete', 'watched_only'] as const)(
    'uses approved database history for %s preview and execution without live source catalogs',
    async (scope) => {
      const approved = '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80';
      let latest = approved;
      const sourceItems = await servers.factory('http://emby', 'fixture', 'emby').items('e-river');
      const captured = (id: string, userId: string) => {
        const timestamp = new Date().toISOString();
        return {
          id,
          metadata: {
            id,
            source_server_url: 'http://emby',
            source_server_id: 'fixture-source-server',
            source_server_version: '4.10.1.0',
            source_user_id: userId,
            source_username: 'river',
            scope: 'complete' as const,
            started_at: timestamp,
            finished_at: timestamp,
            expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
            items: sourceItems.length,
            playlists: 0,
            playlist_entries: 0,
            bytes: 4096,
            avatar: false,
            source_type: 'sqlite_online_backup' as const,
            schema: 'emby-4.10.1.0',
          },
          result: {
            id,
            requested_at: timestamp,
            binding: {
              url: 'http://emby',
              server_id: 'fixture-source-server',
              version: '4.10.1.0',
            },
            ok: true,
            started_at: timestamp,
            finished_at: timestamp,
            identities: { 'e-river': 1 },
            schema: 'emby-4.10.1.0',
            bytes: 4096,
          },
        };
      };
      const select = vi
        .spyOn(service.sourceSnapshots, 'select')
        .mockImplementation(async (userId, _settings, serverId, id) => {
          expect(serverId).toBe('fixture-source-server');
          return captured(id ?? latest, userId);
        });
      const items = vi
        .spyOn(service.sourceSnapshots, 'items')
        .mockImplementation(async (selected, userId, selectedScope) => {
          expect(selected.id).toBe(approved);
          expect(userId).toBe('e-river');
          expect(selectedScope).toBe(scope);
          return structuredClone(sourceItems);
        });
      const forbiddenSourceReads = vi.fn(async () => {
        throw new Error('Saved history must not scan the live source library.');
      });
      const freshTargetReads = vi.fn();
      const sourcePlaylists = vi.fn();
      service.clientFactory = (...args) => {
        const client = servers.factory(...args);
        if (args[2] === 'emby') {
          client.systemInfo = async () => ({ Version: '4.10.1.0', Id: 'fixture-source-server' });
          client.items = forbiddenSourceReads;
          client.migrationItems = forbiddenSourceReads;
          client.watchedItems = forbiddenSourceReads;
          const playlists = client.playlists!.bind(client);
          client.playlists = async (id) => {
            sourcePlaylists(id);
            return playlists(id);
          };
        } else {
          const userData = client.userData!.bind(client);
          client.userData = async (userId, itemId) => {
            freshTargetReads(userId, itemId);
            return userData(userId, itemId);
          };
        }
        return client;
      };
      const preview = await service.preview(['e-river'], {
        migration_scope: scope,
        use_snapshots: true,
      });
      expect(preview.source_snapshot_ids).toEqual({ 'e-river': approved });
      expect(preview.users[0]?.source_snapshot).toMatchObject({
        id: approved,
        source_username: 'river',
      });
      latest = '99b59955-98ea-453d-9d25-a2b3f3cbac0b';
      const job = await finish(
        await service.migrateUsers(['e-river'], {}, undefined, scope, preview.source_snapshot_ids),
      );
      expect(job.status).toBe('completed');
      expect(job.source_snapshot_ids).toEqual({ 'e-river': approved });
      expect(job.results[0]?.source_snapshot).toMatchObject({ id: approved });
      expect(items).toHaveBeenCalledTimes(2);
      expect(select.mock.calls.map((call) => call[3])).toEqual([undefined, approved, approved]);
      expect(forbiddenSourceReads).not.toHaveBeenCalled();
      expect(freshTargetReads).toHaveBeenCalledWith('j-river', '2');
      expect(servers.played['j-river']).toEqual(new Set(['1', '2']));
      expect(store.takeCredentials(job.id)).toEqual([]);
      if (scope === 'complete') expect(sourcePlaylists).toHaveBeenCalled();
      else expect(sourcePlaylists).not.toHaveBeenCalled();
    },
  );

  it.each(['expired', 'unsupported', 'missing'])(
    'refuses %s database captures before creating a job or writing to Jellyfin',
    async (reason) => {
      const before = structuredClone(servers.users.jellyfin);
      const played = structuredClone(servers.played);
      const snapshot = '7d1a6301-8c1c-4c1c-a1b1-b2139d712b80';
      const sourceReads = vi.fn();
      const targetWrites = vi.fn(async () => {});
      service.clientFactory = (...args) => {
        const client = servers.factory(...args);
        if (args[2] === 'emby') {
          client.systemInfo = async () => ({ Version: '4.10.1.0', Id: 'fixture-source-server' });
          client.items = async () => {
            sourceReads();
            return [];
          };
          client.migrationItems = client.items;
          client.watchedItems = client.items;
        } else {
          client.setPolicy = targetWrites;
          client.setConfiguration = targetWrites;
          client.updateUserData = targetWrites;
          client.markPlayed = targetWrites;
        }
        return client;
      };
      vi.spyOn(service.sourceSnapshots, 'select').mockRejectedValue(
        new ServiceError(`The saved capture is ${reason}. Capture it again.`),
      );
      await expect(service.preview(['e-river'], { use_snapshots: true })).rejects.toThrow(reason);
      await expect(
        service.migrateUsers(['e-river'], {}, undefined, 'complete', { 'e-river': snapshot }),
      ).rejects.toThrow(reason);
      expect(store.jobs()).toEqual([]);
      expect(sourceReads).not.toHaveBeenCalled();
      expect(targetWrites).not.toHaveBeenCalled();
      expect(servers.users.jellyfin).toEqual(before);
      expect(servers.played).toEqual(played);
    },
  );
  it('does not reset a duplicate fresh account', async () => {
    const before = structuredClone(servers.users.jellyfin[1]);
    const job = await finish(await service.createAccount('river'));
    expect(job.status).toBe('failed');
    expect(servers.users.jellyfin[1]).toEqual(before);
  });
  it('resumes only a tracked incomplete creation and applies the template once successful', async () => {
    let failing = true;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args),
        original = client.setPolicy.bind(client);
      client.setPolicy = async (...policyArgs) => {
        if (failing) throw new MediaError('Jellyfin rejected the request (HTTP 503).', 503);
        await original(...policyArgs);
      };
      return client;
    };
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect(store.account('casey')?.status).toBe('provisioning');
    failing = false;
    const retry = await finish(await service.createAccount('casey'));
    expect(retry.status).toBe('completed');
    expect(servers.users.jellyfin.filter((user) => user.Name === 'casey')).toHaveLength(1);
    expect(store.takeCredentials(retry.id)).toHaveLength(1);
  });
  it('never retries an uncertain creation or resets its password automatically', async () => {
    const calls: string[] = [];
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.createUser = async (username) => {
        calls.push(username);
        throw new MediaError('Jellyfin request timed out.');
      };
      return client;
    };
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect((await finish(await service.createAccount('casey'))).status).toBe('failed');
    expect(calls).toEqual(['casey']);
    expect(store.account('casey')?.status).toBe('uncertain');
  });
  it('journals uncertain account creation before sending the request, then confirms its identity', async () => {
    const sent = vi.fn();
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      const original = client.createUser.bind(client);
      client.createUser = async (username, password) => {
        const pending = store.account(username)!;
        expect(pending.status).toBe('uncertain');
        expect(pending.remote_id).toBeNull();
        expect(store.accountPassword(pending)).toBe(password);
        sent();
        return original(username, password);
      };
      return client;
    };
    const job = await finish(await service.createAccount('casey'));
    expect(job.status).toBe('completed');
    expect(sent).toHaveBeenCalledOnce();
    expect(store.account('casey')?.status).toBe('ready');
    expect(store.account('casey')?.remote_id).toBe(job.results[0]?.target_user_id);
  });

  it('checkpoints live history counts in batches and flushes them before completing a user', async () => {
    const catalog = Array.from({ length: 64 }, (_, index) => ({
      Id: `bulk-${index}`,
      Name: `Movie ${index}`,
      Type: 'Movie',
      ProviderIds: { Tmdb: `bulk-${index}` },
    }));
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.migrationItems = async () =>
        catalog.map((item) => ({ ...item, UserData: { Played: args[2] === 'emby' } }));
      return client;
    };
    const snapshots: Job[] = [];
    const originalSave = store.saveJob.bind(store);
    vi.spyOn(store, 'saveJob').mockImplementation((job) => {
      snapshots.push(structuredClone(job));
      originalSave(job);
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const job = await finish(await service.migrateUsers(['e-river']));
      expect(job.status).toBe('completed');
      expect(job.results[0]?.applied).toBe(64);
      const history = snapshots.filter((entry) => entry.progress.phase === 'transferring_history');
      expect(history.length).toBeGreaterThanOrEqual(4);
      expect(history.length).toBeLessThan(10);
      expect(history.at(-1)?.progress).toMatchObject({
        processed: 0,
        total: 1,
        current_user: 'river',
        items_processed: 64,
        items_total: 64,
        items_updated: 64,
      });
      expect(snapshots.map((entry) => entry.progress.phase)).toEqual(
        expect.arrayContaining([
          'reading_source',
          'preparing_account',
          'reading_target',
          'transferring_history',
          'transferring_playlists',
        ]),
      );
      expect(job.progress).toEqual({ processed: 1, total: 1 });
      expect(Date.parse(job.started_at!)).toBeGreaterThan(0);
      expect(Date.parse(job.finished_at!)).toBeGreaterThanOrEqual(Date.parse(job.started_at!));
    } finally {
      clock.mockRestore();
    }
  });

  it('bounds persisted migration diagnostics and never serializes arbitrary upstream name objects', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      client.migrationItems = async () =>
        args[2] === 'emby'
          ? ([
              ...Array.from({ length: 201 }, (_, index) => ({
                Id: `unmatched-${index}`,
                Name: { credential: 'upstream-private-diagnostic' },
                Type: 'Movie',
                ProviderIds: { Tmdb: `missing-${index}` },
                UserData: { Played: true },
              })),
              ...Array.from({ length: 201 }, (_, index) => ({
                Id: `ambiguous-${index}`,
                Name: 'A'.repeat(700),
                Type: 'Movie',
                ProviderIds: { Tmdb: 'duplicate' },
                UserData: { Played: true },
              })),
            ] as unknown as MediaItem[])
          : Array.from({ length: 21 }, (_, index) => ({
              Id: `candidate-${index}`,
              Type: 'Movie',
              ProviderIds: { Tmdb: 'duplicate' },
            }));
      return client;
    };
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('partial');
    expect(job.results[0]).toMatchObject({ unmatched: 201, ambiguous: 201 });
    expect(job.results[0]?.unmatched_items).toHaveLength(200);
    expect(job.results[0]?.unmatched_items?.[0]?.name).toBe('');
    expect(job.results[0]?.ambiguous_items).toHaveLength(200);
    expect(job.results[0]?.ambiguous_items?.[0]?.name).toHaveLength(512);
    expect(job.results[0]?.ambiguous_items?.[0]?.candidate_ids).toHaveLength(20);
    expect(JSON.stringify(job)).not.toContain('upstream-private-diagnostic');
    expect(job.results[0]?.data?.warnings).toContain(
      'Result details are limited to 200 unmatched items, 200 ambiguous items, and 20 candidates per item. Full counts are shown; migration checks every item.',
    );
  });
  it('reads source history successfully before creating any target account', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby')
        client.items = async () => {
          throw new MediaError('Emby unavailable.');
        };
      return client;
    };
    const before = structuredClone(servers.users.jellyfin);
    const job = await finish(await service.migrateUsers(['e-alex']));
    expect(job.status).toBe('failed');
    expect(servers.users.jellyfin).toEqual(before);
  });
  it('removes delivered credentials and excludes passwords from audit records', async () => {
    const bot = new FakeBot();
    service.bot = bot;
    const job = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': '123456789' }));
    expect(bot.delivered).toHaveLength(1);
    expect(JSON.stringify(job)).not.toContain(bot.delivered[0]![2]);
    expect(store.takeCredentials(job.id)).toEqual([]);
    expect(store.link('123456789')?.username).toBe('alex');
  });
  it('retains one-time credentials after failed Discord delivery without exposing library exceptions', async () => {
    const bot = new FakeBot();
    bot.sendCredentials = async () => {
      throw new Error('library-secret-error');
    };
    service.bot = bot;
    const job = await finish(await service.createAccount('alex', '123456789'));
    expect(job.status).toBe('partial');
    expect(job.results[0]?.discord_delivery).toBe('failed');
    expect(JSON.stringify(job)).not.toContain('library-secret-error');
    expect(store.takeCredentials(job.id)).toHaveLength(1);
  });
  it('checks recipient membership again immediately before sending credentials', async () => {
    const bot = new FakeBot();
    let validations = 0;
    bot.validateRecipient = async () => {
      if (++validations > 1) throw new Error('Membership expired');
    };
    service.bot = bot;
    const job = await finish(await service.createAccount('alex', '123456789'));
    expect(job.results[0]?.discord_delivery).toBe('failed');
    expect(bot.delivered).toEqual([]);
    expect(store.takeCredentials(job.id)).toHaveLength(1);
  });
  it('suspends and reenables only a linked account while preserving policy details and watch history', async () => {
    const bot = new FakeBot();
    service.bot = bot;
    expect((await finish(await service.createAccount('alex', '123456789'))).status).toBe(
      'completed',
    );
    const alex = servers.users.jellyfin.find((user) => user.Name === 'alex')!,
      before = structuredClone(alex.Policy);
    servers.played[alex.Id] = new Set(['1']);
    await service.recordSubscription({
      id: 'expire',
      action: 'expire',
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    await service.applySubscription('expire');
    expect(alex.Policy?.IsDisabled).toBe(true);
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(1);
    await service.recordSubscription({
      id: 'subscribe',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    await service.applySubscription('subscribe');
    expect(alex.Policy).toEqual(before);
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(0);
    expect(servers.played[alex.Id]).toEqual(new Set(['1']));
  });
  it('keeps cancellation in review by default and deduplicates events', async () => {
    const event = {
      id: 'cancel',
      action: 'cancel' as const,
      username: 'alex',
      discord_user_id: '123456789',
      source: 'mee6_message',
    };
    await service.recordSubscription(event);
    await service.recordSubscription(event);
    expect(store.subscriptions()).toHaveLength(1);
    expect(store.subscription('cancel')?.status).toBe('pending');
  });
  it('cannot disable an unlinked account based on a username', async () => {
    service.bot = new FakeBot();
    const before = structuredClone(servers.users.jellyfin);
    await service.recordSubscription({
      id: 'unlinked',
      action: 'expire',
      username: 'river',
      discord_user_id: '123456789',
      source: 'discord_role',
    });
    await expect(service.applySubscription('unlinked')).rejects.toThrow(
      'no Jellyport identity link',
    );
    expect(servers.users.jellyfin).toEqual(before);
  });
  it('does not claim an existing account during automated subscription provisioning', async () => {
    const bot = new FakeBot();
    bot.username = 'river';
    service.bot = bot;
    const before = structuredClone(servers.users.jellyfin);
    await service.recordSubscription({
      id: 'unlinked',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    await expect(service.applySubscription('unlinked')).rejects.toThrow('admin-approved migration');
    expect(servers.users.jellyfin).toEqual(before);
    expect(store.link('123456789')).toBeNull();
  });
  it('protects template and administrator destinations in preview and migration', async () => {
    servers.users.emby[0]!.Name = 'Member template';
    await expect(service.preview(['e-alex'])).rejects.toThrow('template');
    expect((await finish(await service.migrateUsers(['e-alex']))).status).toBe('failed');
    servers.users.emby[0]!.Name = 'river';
    servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
    await expect(service.preview(['e-alex'])).rejects.toThrow('administrator');
    expect((await finish(await service.migrateUsers(['e-alex']))).status).toBe('failed');
  });
  it('never uses template watch history as a new account baseline', async () => {
    servers.played.template = new Set(['1', '2', '3']);
    expect((await service.preview(['e-alex'])).users[0]?.stats.already_played).toBe(0);
  });
  it('keeps Jellyfin template users visible when Emby is unavailable', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby')
        client.users = async () => {
          throw new MediaError('Unable to connect to Emby.');
        };
      return client;
    };
    const users = await service.users();
    expect(users.emby).toEqual([]);
    expect(users.jellyfin[0]?.Id).toBe('template');
    expect(users.errors).toEqual({ emby: 'Unable to connect to Emby.' });
  });
  it('does not reenable a manually disabled account on renewal', async () => {
    service.bot = new FakeBot();
    const river = servers.users.jellyfin[1]!;
    river.Policy!.IsDisabled = true;
    store.saveLink('123456789', 'river', 'j-river', false);
    await service.recordSubscription({
      id: 'renewal',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    await service.applySubscription('renewal');
    expect(river.Policy?.IsDisabled).toBe(true);
  });
  it('provisions offline role joins once and reconciles later expiration only when opted in', async () => {
    const bot = new FakeBot();
    bot.active = true;
    bot.members = [{ id: '123456789', username: 'alex' }];
    service.bot = bot;
    store.saveSettings({
      ...store.settings(),
      discord_role_events: true,
      discord_member_role_id: '12345678',
      auto_provision: true,
      auto_disable: true,
    });
    await service.reconcileMemberships();
    expect(store.link('123456789')?.username).toBe('alex');
    expect(store.subscriptions()).toHaveLength(1);
    await service.reconcileMemberships();
    expect(store.subscriptions()).toHaveLength(1);
    bot.active = false;
    bot.members = [];
    await service.reconcileMemberships();
    expect(store.link('123456789')?.disabled_by_jellyport).toBe(1);
    expect(servers.users.jellyfin.find((user) => user.Name === 'alex')?.Policy?.IsDisabled).toBe(
      true,
    );
  });
  it('does not auto-disable cancellation unless that separate option is enabled', async () => {
    service.bot = new FakeBot();
    store.saveLink('123456789', 'river', 'j-river');
    store.saveSettings({ ...store.settings(), auto_disable: true });
    await service.recordSubscription({
      id: 'cancel',
      action: 'cancel',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    expect(store.subscription('cancel')?.status).toBe('pending');
    expect(servers.users.jellyfin[1]?.Policy?.IsDisabled).toBe(false);
  });
  it('cannot link different Discord members to one destination', async () => {
    const bot = new FakeBot();
    bot.username = 'river';
    service.bot = bot;
    store.saveLink('owner', 'river', 'j-river');
    const job = await finish(await service.migrateUsers(['e-river'], { 'e-river': '123456789' }));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('another Discord user');
    expect(store.link('owner')?.remote_id).toBe('j-river');
    expect(store.link('123456789')).toBeNull();
  });
  it('requires the current Discord username for first linking and fresh creation', async () => {
    service.bot = new FakeBot();
    await expect(service.createAccount('Server Nickname', '123456789')).rejects.toThrow(
      'Discord username',
    );
    const job = await finish(await service.migrateUsers(['e-river'], { 'e-river': '123456789' }));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('must match');
  });
  it('preserves a durable identity link when a Discord username changes', async () => {
    const bot = new FakeBot();
    bot.username = 'newname';
    service.bot = bot;
    store.saveLink('123456789', 'river', 'j-river');
    const job = await finish(await service.migrateUsers(['e-river'], { 'e-river': '123456789' }));
    expect(job.status).toBe('completed');
    expect(store.link('123456789')?.username).toBe('river');
    expect(job.results[0]?.discord_delivery).toBe('skipped_existing_account');
  });
  it('rejects duplicate or out-of-scope batch recipients and users', async () => {
    await expect(service.migrateUsers(['e-alex', 'e-alex'])).rejects.toBeInstanceOf(ServiceError);
    await expect(service.migrateUsers(['e-alex'], { 'e-river': '123456789' })).rejects.toThrow(
      'selected',
    );
    await expect(
      service.migrateUsers(['e-alex', 'e-river'], { 'e-alex': 'same', 'e-river': 'same' }),
    ).rejects.toThrow('different');
  });
  function approveMapping(
    sourceId: string,
    targetName: string,
    targetId: string | null = null,
    discordId: string | null = null,
  ) {
    const source = servers.users.emby.find((user) => user.Id === sourceId)!;
    return service.mappings.save(
      {
        source_user_id: sourceId,
        source_username: source.Name,
        target_user_id: targetId,
        target_username: targetName,
        discord_user_id: discordId,
        discord_username: discordId ? 'verified.original' : null,
      },
      store.settings(),
    );
  }
  it('migrates favorites, resume position, counts, ratings and original dates across playable and container types', async () => {
    servers.media.push(
      { Id: 'series', Type: 'Series', Name: 'Continuing show', ProviderIds: { Tvdb: '100' } },
      {
        Id: 'season',
        Type: 'Season',
        Name: 'Season one',
        SeriesProviderIds: { Tvdb: '100' },
        IndexNumber: 1,
      },
    );
    servers.userData['e-sam'] = {
      '1': {
        IsFavorite: true,
        PlaybackPositionTicks: 300_000_000,
        PlayCount: 5,
        LastPlayedDate: '2026-10-07T01:00:00.000Z',
        Likes: false,
        Rating: 7.5,
      },
      '3': { LastPlayedDate: '2023-03-14T18:00:00.000Z' },
      series: { IsFavorite: true },
      season: { IsFavorite: true },
    };
    const preview = await service.preview(['e-sam']);
    expect(preview.users[0]?.stats).toMatchObject({
      source_items: 4,
      source_played: 1,
      source_favorites: 3,
      source_resume: 1,
    });
    const job = await finish(await service.migrateUsers(['e-sam']));
    expect(job.status).toBe('completed');
    const target = servers.users.jellyfin.find((user) => user.Name === 'sam')!;
    expect(servers.userData[target.Id]?.['1']).toMatchObject({
      IsFavorite: true,
      PlaybackPositionTicks: 300_000_000,
      PlayCount: 5,
      LastPlayedDate: '2026-10-07T01:00:00.000Z',
      Likes: false,
      Rating: 7.5,
    });
    expect(servers.userData[target.Id]?.['3']?.LastPlayedDate).toBe('2023-03-14T18:00:00.000Z');
    expect(servers.userData[target.Id]?.series?.IsFavorite).toBe(true);
    expect(servers.userData[target.Id]?.season?.IsFavorite).toBe(true);
    expect(job.results[0]?.data).toMatchObject({
      favorites: 3,
      resume_positions: 1,
      play_counts: 2,
      last_played_dates: 2,
      ratings: 1,
      failed_items: 0,
    });
    const repeat = await finish(await service.migrateUsers(['e-sam']));
    expect(repeat.results[0]?.applied).toBe(0);
    expect(repeat.results[0]?.data?.items_updated).toBe(0);
  });
  it('copies only portable preferences and the avatar for newly created accounts', async () => {
    servers.users.emby[2]!.Policy = { IsAdministrator: true, EnableAllFolders: false };
    servers.users.emby[2]!.Configuration = {
      AudioLanguagePreference: 'spa',
      SubtitleMode: 'Always',
      EnableNextEpisodeAutoPlay: true,
      OrderedViews: ['emby-library-id'],
      private_token: 'private-source-config-secret',
    };
    const picture = {
      contentType: 'image/png' as const,
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    };
    servers.images['e-sam'] = picture;
    const job = await finish(await service.migrateUsers(['e-sam']));
    const target = servers.users.jellyfin.find((user) => user.Name === 'sam')!;
    expect(target.Policy).toEqual(servers.users.jellyfin[0]!.Policy);
    expect(target.Configuration).toMatchObject({
      AudioLanguagePreference: 'spa',
      SubtitleMode: 'Always',
      EnableNextEpisodeAutoPlay: true,
      DisplayMissingEpisodes: false,
    });
    expect(target.Configuration).not.toHaveProperty('OrderedViews');
    expect(target.Configuration).not.toHaveProperty('private_token');
    expect(servers.images[target.Id]).toEqual(picture);
    expect(job.results[0]?.data?.avatar).toBe(true);
    expect(job.results[0]?.data?.preferences).toEqual(
      expect.arrayContaining([
        'AudioLanguagePreference',
        'SubtitleMode',
        'EnableNextEpisodeAutoPlay',
      ]),
    );
    expect(JSON.stringify(job)).not.toContain('private-source-config-secret');
  });
  it('preserves existing preferences, avatar, favorites, ratings and newer Jellyfin playback progress', async () => {
    const river = servers.users.jellyfin[1]!;
    river.Configuration = { AudioLanguagePreference: 'fra' };
    servers.users.emby[1]!.Configuration = { AudioLanguagePreference: 'spa' };
    servers.images['e-river'] = { contentType: 'image/png', data: new Uint8Array([1, 2]) };
    servers.images['j-river'] = { contentType: 'image/png', data: new Uint8Array([3, 4]) };
    servers.userData['e-river'] = {
      '2': {
        IsFavorite: false,
        PlaybackPositionTicks: 100,
        LastPlayedDate: '2025-01-01T00:00:00.000Z',
        PlayCount: 2,
        Likes: true,
        Rating: 7,
      },
    };
    servers.userData['j-river'] = {
      '2': {
        IsFavorite: true,
        PlaybackPositionTicks: 200,
        LastPlayedDate: '2026-01-01T00:00:00.000Z',
        PlayCount: 10,
        Likes: false,
        Rating: 9,
      },
    };
    const before = structuredClone(river);
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(river).toEqual(before);
    expect(servers.images['j-river']?.data).toEqual(new Uint8Array([3, 4]));
    expect(servers.userData['j-river']?.['2']).toMatchObject({
      IsFavorite: true,
      PlaybackPositionTicks: 200,
      PlayCount: 10,
      Likes: false,
      Rating: 9,
      LastPlayedDate: '2026-01-01T00:00:00.000Z',
    });
    expect(job.results[0]?.data).toMatchObject({ avatar: false, preferences: [] });
  });
  it('imports private playlists with order and duplicates while preserving existing playlists and preventing repeated imports', async () => {
    servers.playlists['e-river'] = [
      {
        Id: 'source-playlist',
        Name: 'Favorites',
        Type: 'Playlist',
        MediaType: 'Video',
        items: ['2', '1', '2', 'not-present'],
      },
    ];
    servers.playlists['j-river'] = [
      { Id: 'existing', Name: 'Favorites', Type: 'Playlist', MediaType: 'Video', items: ['3'] },
    ];
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('partial');
    const lists = servers.playlists['j-river']!;
    expect(lists).toHaveLength(2);
    expect(lists[0]?.items).toEqual(['3']);
    expect(lists[1]).toMatchObject({
      IsPublic: false,
      OwnerUserId: 'j-river',
      items: ['2', '1', '2'],
    });
    expect(job.results[0]?.data).toMatchObject({
      playlists_created: 1,
      playlist_items_added: 3,
      playlist_items_skipped: 1,
    });
    const repeat = await finish(await service.migrateUsers(['e-river']));
    expect(servers.playlists['j-river']).toHaveLength(2);
    expect(repeat.results[0]?.data?.playlists_created).toBe(0);
  });
  it('uses explicit mappings for unusual source names, pins created target IDs and does not DM a label', async () => {
    servers.users.emby[2]!.Name = '<Source / Account>';
    const mapping = approveMapping('e-sam', 'simple.alias');
    const bot = new FakeBot();
    service.bot = bot;
    const preview = await service.preview(['e-sam']);
    expect(preview.users[0]).toMatchObject({
      source_username: '<Source / Account>',
      username: 'simple.alias',
      mapping_id: mapping.id,
      mapping_revision: mapping.revision,
      target_exists: false,
      discord_user_id: null,
    });
    const job = await finish(
      await service.migrateUsers(['e-sam'], {}, { 'e-sam': mapping.revision }),
    );
    expect(job.status).toBe('completed');
    const target = servers.users.jellyfin.find((user) => user.Name === 'simple.alias')!;
    const bound = service.mappings.getForSource('e-sam', store.settings())!;
    expect(bound.target_user_id).toBe(target.Id);
    expect(bound.revision).not.toBe(mapping.revision);
    expect(store.takeCredentials(job.id)[0]?.username).toBe('simple.alias');
    expect(bot.delivered).toEqual([]);
    const repeat = await finish(await service.migrateUsers(['e-sam']));
    expect(repeat.status).toBe('completed');
    expect(repeat.results[0]?.created).toBe(false);
    expect(servers.users.jellyfin.filter((user) => user.Name === 'simple.alias')).toHaveLength(1);
  });
  it('permits different usernames only through a mapping with the verified stable Discord ID', async () => {
    const bot = new FakeBot();
    bot.username = 'current.discord';
    service.bot = bot;
    approveMapping('e-sam', 'friendly.alias', null, '123456789');
    const job = await finish(await service.migrateUsers(['e-sam'], { 'e-sam': '123456789' }));
    expect(job.status).toBe('completed');
    expect(bot.delivered[0]?.[1]).toBe('friendly.alias');
    expect(store.link('123456789')?.username).toBe('friendly.alias');
    await expect(service.createAccount('current.discord', '123456789')).rejects.toThrow(
      'approved Emby mapping',
    );
  });
  it('does not use username-only Discord labels to claim an identity', async () => {
    const bot = new FakeBot();
    bot.username = 'current.discord';
    service.bot = bot;
    const mapping = approveMapping('e-sam', 'friendly.alias');
    service.mappings.save({ ...mapping, discord_username: 'current.discord' }, store.settings());
    const before = structuredClone(servers.users.jellyfin);
    const job = await finish(await service.migrateUsers(['e-sam'], { 'e-sam': '123456789' }));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('verified user ID');
    expect(servers.users.jellyfin).toEqual(before);
    expect(store.link('123456789')).toBeNull();
    expect(bot.delivered).toEqual([]);
  });
  it('rejects changed mapping revisions between preview, queueing and execution', async () => {
    const mapping = approveMapping('e-sam', 'first.alias');
    const changed = service.mappings.save(
      { ...mapping, target_username: 'second.alias' },
      store.settings(),
    );
    await expect(
      service.migrateUsers(['e-sam'], {}, { 'e-sam': mapping.revision }),
    ).rejects.toThrow('after preview');
    await expect(service.migrateUsers(['e-sam'], {}, {})).rejects.toThrow('exactly');
    await expect(
      service.migrateUsers(['e-sam'], {}, { 'e-sam': changed.revision, extra: null }),
    ).rejects.toThrow('exactly');
    const job = await service.migrateUsers(['e-sam'], {}, { 'e-sam': changed.revision });
    service.mappings.save({ ...changed, target_username: 'third.alias' }, store.settings());
    const finished = await finish(job);
    expect(finished.status).toBe('failed');
    expect(finished.results[0]?.error).toContain('queued');
    expect(servers.users.jellyfin).toHaveLength(2);
  });
  it('rejects a newly added mapping when the preview explicitly showed no mapping', async () => {
    const preview = await service.preview(['e-sam']);
    expect(preview.users[0]?.mapping_revision).toBeNull();
    approveMapping('e-sam', 'new.alias');
    await expect(service.migrateUsers(['e-sam'], {}, { 'e-sam': null })).rejects.toThrow(
      'after preview',
    );
  });
  it('revalidates mapped source names, target IDs, and protection before mutations', async () => {
    const mapping = approveMapping('e-sam', 'river', 'j-river');
    const before = structuredClone(servers.played['j-river']);
    servers.users.emby[2]!.Name = 'renamed-source';
    expect((await finish(await service.migrateUsers(['e-sam']))).results[0]?.error).toContain(
      'Emby account was renamed',
    );
    servers.users.emby[2]!.Name = mapping.source_username;
    servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
    expect((await finish(await service.migrateUsers(['e-sam']))).results[0]?.error).toContain(
      'permissions changed',
    );
    servers.users.jellyfin[1]!.Policy!.IsAdministrator = false;
    servers.users.jellyfin[1]!.Name = 'renamed-target';
    expect((await finish(await service.migrateUsers(['e-sam']))).results[0]?.error).toContain(
      'removed or renamed',
    );
    expect(servers.played['j-river']).toEqual(before);
  });
  it('does not claim a new mapped name that appeared after approval', async () => {
    approveMapping('e-sam', 'reserved.alias');
    servers.users.jellyfin.push({
      Id: 'external-account',
      Name: 'reserved.alias',
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    const before = structuredClone(servers.users.jellyfin);
    const job = await finish(await service.migrateUsers(['e-sam']));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('now exists');
    expect(servers.users.jellyfin).toEqual(before);
  });
  it('honors verified mappings during subscription provisioning and later lifecycle actions', async () => {
    const bot = new FakeBot();
    bot.username = 'different.discord';
    service.bot = bot;
    approveMapping('e-sam', 'river', 'j-river', '123456789');
    await service.recordSubscription({
      id: 'mapped-subscribe',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    expect((await service.applySubscription('mapped-subscribe')).status).toBe('applied');
    expect(store.link('123456789')?.remote_id).toBe('j-river');
    expect(bot.delivered).toEqual([]);
    await service.recordSubscription({
      id: 'mapped-expire',
      action: 'expire',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    await service.applySubscription('mapped-expire');
    expect(servers.users.jellyfin[1]!.Policy?.IsDisabled).toBe(true);
    await service.recordSubscription({
      id: 'mapped-renew',
      action: 'subscribe',
      discord_user_id: '123456789',
      source: 'mee6_message',
    });
    await service.applySubscription('mapped-renew');
    expect(servers.users.jellyfin[1]!.Policy?.IsDisabled).toBe(false);
  });
  it('protects disabled accounts in ordinary preview and migration', async () => {
    servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
    await expect(service.preview(['e-river'])).rejects.toThrow('disabled');
    const before = structuredClone(servers.users.jellyfin[1]);
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('disabled');
    expect(servers.users.jellyfin[1]).toEqual(before);
  });
  it('projects preview issues to safe summaries instead of exposing upstream plugin data', async () => {
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'emby') {
        const original = client.migrationItems!.bind(client);
        client.migrationItems = async (...parameters) =>
          (await original(...parameters)).map((item) => ({
            ...item,
            private_plugin_token: 'private-library-token',
          }));
      }
      return client;
    };
    const preview = await service.preview(['e-alex']);
    expect(JSON.stringify(preview)).not.toContain('private-library-token');
    expect(preview.users[0]?.unmatched[0]).toEqual({
      Id: 'missing',
      Name: 'An unmatched library item',
      Type: 'Movie',
    });
  });
  it('prevents an unmapped source or fresh create from claiming a reserved destination ID or name', async () => {
    approveMapping('e-sam', 'river', 'j-river');
    const before = structuredClone(servers.played['j-river']);
    await expect(service.preview(['e-river'])).rejects.toThrow('reserved');
    await expect(service.createAccount('river')).rejects.toThrow('reserved');
    const first = await finish(await service.migrateUsers(['e-river']));
    expect(first.status).toBe('failed');
    expect(first.results[0]?.error).toContain('reserved');
    // Renaming the upstream account cannot escape its stable-ID reservation.
    servers.users.jellyfin[1]!.Name = 'renamed';
    servers.users.emby[1]!.Name = 'renamed';
    const renamed = await finish(await service.migrateUsers(['e-river']));
    expect(renamed.status).toBe('failed');
    expect(renamed.results[0]?.error).toContain('reserved');
    expect(servers.played['j-river']).toEqual(before);
  });
  it('reserves a mapped new alias before its Jellyfin account is created', async () => {
    approveMapping('e-sam', 'reserved.new');
    servers.users.emby[1]!.Name = 'reserved.new';
    await expect(service.createAccount('reserved.new')).rejects.toThrow('reserved');
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('reserved');
    expect(servers.users.jellyfin.some((user) => user.Name === 'reserved.new')).toBe(false);
  });
  it('rechecks destination ownership after asynchronous item reads before writing state', async () => {
    const before = structuredClone(servers.played['j-river']);
    let changed = false;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'jellyfin') {
        const original = client.userData!.bind(client);
        client.userData = async (...parameters) => {
          const data = await original(...parameters);
          if (!changed) {
            changed = true;
            approveMapping('e-sam', 'river', 'j-river');
          }
          return data;
        };
      }
      return client;
    };
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toContain('reserved');
    expect(servers.played['j-river']).toEqual(before);
  });
  it('preserves generated credentials if the mapping changes during the final Discord membership check', async () => {
    const bot = new FakeBot();
    service.bot = bot;
    approveMapping('e-sam', 'mapped.alias', null, '123456789');
    let validations = 0;
    bot.validateRecipient = async () => {
      if (++validations === 2) {
        const mapping = service.mappings.getForSource('e-sam', store.settings())!;
        service.mappings.save({ ...mapping, discord_username: bot.username }, store.settings());
      }
    };
    const job = await finish(await service.migrateUsers(['e-sam'], { 'e-sam': '123456789' }));
    expect(job.status).toBe('partial');
    expect(job.results[0]?.discord_delivery).toBe('failed');
    expect(bot.delivered).toEqual([]);
    expect(store.takeCredentials(job.id)[0]?.username).toBe('mapped.alias');
  });
  it('recovers an explicitly inspected uncertain mapped creation and then pins its target ID', async () => {
    approveMapping('e-sam', 'recover.alias');
    let first = true;
    service.clientFactory = (...args) => {
      const client = servers.factory(...args);
      if (args[2] === 'jellyfin') {
        const original = client.createUser.bind(client);
        client.createUser = async (...parameters) => {
          const created = await original(...parameters);
          if (first) {
            first = false;
            throw new MediaError('Creation response timed out.');
          }
          return created;
        };
      }
      return client;
    };
    expect((await finish(await service.migrateUsers(['e-sam']))).status).toBe('failed');
    expect(store.account('recover.alias')?.status).toBe('uncertain');
    const target = servers.users.jellyfin.find((user) => user.Name === 'recover.alias')!;
    const info = await service.recoveryInfo('recover.alias');
    expect(info.eligible).toBe(true);
    const recovered = await finish(await service.recoverAccount('recover.alias', target.Id));
    expect(recovered.status).toBe('completed');
    expect(service.mappings.getForSource('e-sam', store.settings())?.target_user_id).toBe(
      target.Id,
    );
    expect(servers.users.jellyfin.filter((user) => user.Name === 'recover.alias')).toHaveLength(1);
    expect(store.takeCredentials(recovered.id)).toHaveLength(1);
  });
  it('retains printable existing target names through explicit ID mappings', async () => {
    servers.users.jellyfin[1]!.Name = 'Existing / Family Account';
    approveMapping('e-sam', 'Existing / Family Account', 'j-river');
    const before = structuredClone(servers.users.jellyfin[1]);
    const job = await finish(await service.migrateUsers(['e-sam']));
    expect(job.status).toBe('completed');
    expect(job.results[0]?.username).toBe('Existing / Family Account');
    expect(servers.users.jellyfin[1]).toEqual(before);
    expect(store.takeCredentials(job.id)).toEqual([]);
  });
});

describe('password and template validation', () => {
  it('generates 24-character cryptographic passwords containing all required categories', () => {
    const values = new Set(Array.from({ length: 100 }, generatePassword));
    expect(values.size).toBe(100);
    for (const value of values) {
      expect(value).toHaveLength(24);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[0-9]/);
      expect(value).toMatch(/[!@#%+_-]/);
    }
  });
  it('rejects disabled, administrator and empty templates while preserving lockout settings', () => {
    for (const Policy of [{}, { IsAdministrator: true }, { IsDisabled: true }])
      expect(() => templatePolicy({ Policy })).toThrow(ServiceError);
    const Policy = {
      IsAdministrator: false,
      LoginAttemptsBeforeLockout: 3,
      InvalidLoginAttemptCount: 9,
      FailedLoginAttempts: 9,
    };
    expect(templatePolicy({ Policy })).toEqual({
      IsAdministrator: false,
      LoginAttemptsBeforeLockout: 3,
    });
    expect(Policy.InvalidLoginAttemptCount).toBe(9);
  });
  it.each(['', ' leading', 'trailing ', 'a/b', 'a\\b', '<name>', 'a\n', 'x'.repeat(65)])(
    'rejects an invalid username: %j',
    (username) => {
      expect(() => validateUsername(username)).toThrow(ServiceError);
    },
  );
});
