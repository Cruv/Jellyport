import { randomUUID } from 'node:crypto';
import { MediaError } from './errors.js';
import { caseFold } from './matching.js';
import type {
  ClientFactory,
  JsonObject,
  MediaAPI,
  MediaItem,
  MediaKind,
  MediaUser,
  MediaUserDataPatch,
  MediaPlaylist,
  MediaUserImage,
} from './media.js';

/** Isolated simulated servers for local preview; never contacts real services. */
export class DemoServers {
  userData: Record<string, Record<string, MediaUserDataPatch>> = {};
  playlists: Record<string, Array<MediaPlaylist & { items: string[] }>> = {};
  images: Record<string, MediaUserImage> = {};
  display: Record<string, JsonObject> = {
    template: {
      ShowBackdrop: true,
      ShowSidebar: false,
      CustomPrefs: {
        homesection0: 'smalllibrarytiles',
        homesection1: 'resume',
        homesection2: 'nextup',
        homesection3: 'latestmedia',
        useEpisodeImagesInNextUpAndResume: 'true',
        skipBackLength: '10000',
        skipForwardLength: '30000',
      },
    },
  };
  users: Record<MediaKind, MediaUser[]> = {
    emby: [
      { Id: 'e-alex', Name: 'alex', Policy: {} },
      { Id: 'e-river', Name: 'river', Policy: {} },
      { Id: 'e-sam', Name: 'sam', Policy: {} },
    ],
    jellyfin: [
      {
        Id: 'template',
        Name: 'Member template',
        Policy: { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true },
        Configuration: { DisplayMissingEpisodes: false },
      },
      {
        Id: 'j-river',
        Name: 'river',
        Policy: { IsAdministrator: false, IsDisabled: false },
        Configuration: {},
      },
    ],
  };
  media: MediaItem[] = [
    { Id: '1', Name: 'Arrival', Type: 'Movie', ProviderIds: { Tmdb: '329865' } },
    { Id: '2', Name: 'The Grand Budapest Hotel', Type: 'Movie', ProviderIds: { Tmdb: '120467' } },
    {
      Id: '3',
      Name: 'The Last of Us — Pilot',
      Type: 'Episode',
      ProviderIds: { Tvdb: '9149826' },
      ParentIndexNumber: 1,
      IndexNumber: 1,
    },
  ];
  played: Record<string, Set<string>> = {
    'e-alex': new Set(['1', '2', '3', 'missing']),
    'e-river': new Set(['1', '2']),
    'e-sam': new Set(['3']),
    'j-river': new Set(['1']),
  };
  factory: ClientFactory = (_url, _apiKey, kind = 'jellyfin') => new DemoClient(this, kind);
}

export class DemoClient implements MediaAPI {
  constructor(
    readonly servers: DemoServers,
    readonly kind: MediaKind,
  ) {}
  async close(): Promise<void> {}
  async systemInfo(): Promise<JsonObject> {
    return {
      Id: `demo-${this.kind}`,
      ServerName: `Demo ${this.kind === 'emby' ? 'Emby' : 'Jellyfin'}`,
      Version: 'simulation',
    };
  }
  async users(): Promise<MediaUser[]> {
    return structuredClone(this.servers.users[this.kind]);
  }
  private findUser(id: string): MediaUser {
    const user = this.servers.users[this.kind].find((value) => value.Id === id);
    if (!user) throw new MediaError('Demo user not found.');
    return user;
  }
  async user(id: string): Promise<MediaUser> {
    return structuredClone(this.findUser(id));
  }
  async items(userId?: string): Promise<MediaItem[]> {
    const values = structuredClone(this.servers.media);
    if (this.kind === 'emby')
      values.push({
        Id: 'missing',
        Name: 'An unmatched library item',
        Type: 'Movie',
        ProviderIds: { Tmdb: '999999999' },
      });
    for (const value of values)
      value.UserData = {
        Played: userId ? (this.servers.played[userId]?.has(value.Id) ?? false) : false,
        ...(userId && this.servers.played[userId]?.has(value.Id)
          ? { PlayCount: 1, LastPlayedDate: '2026-10-01T12:00:00.000Z' }
          : {}),
        ...(userId ? this.servers.userData[userId]?.[value.Id] : {}),
      };
    return values;
  }
  async createUser(name: string, _password: string): Promise<MediaUser> {
    if (this.servers.users[this.kind].some((user) => caseFold(user.Name) === caseFold(name)))
      throw new MediaError('Demo username already exists.');
    const user = {
      Id: randomUUID().replaceAll('-', ''),
      Name: name,
      Policy: { IsAdministrator: false, IsDisabled: false },
      Configuration: {},
    };
    this.servers.users[this.kind].push(user);
    return structuredClone(user);
  }
  async setPassword(id: string, _password: string): Promise<void> {
    this.findUser(id);
  }
  async setPolicy(id: string, policy: JsonObject): Promise<void> {
    this.findUser(id).Policy = structuredClone(policy);
  }
  async setConfiguration(id: string, configuration: JsonObject): Promise<void> {
    this.findUser(id).Configuration = structuredClone(configuration);
  }
  async displayPreferences(userId: string): Promise<JsonObject> {
    this.findUser(userId);
    return structuredClone(this.servers.display[userId] ?? { CustomPrefs: {} });
  }
  async setDisplayPreferences(userId: string, preferences: JsonObject): Promise<void> {
    if (this.kind !== 'jellyfin')
      throw new MediaError('Display preference updates are supported only on Jellyfin.');
    this.findUser(userId);
    this.servers.display[userId] = structuredClone(preferences);
  }
  async markPlayed(userId: string, itemId: string, datePlayed?: string): Promise<void> {
    (this.servers.played[userId] ??= new Set()).add(itemId);
    if (datePlayed)
      (this.servers.userData[userId] ??= {})[itemId] = {
        ...this.servers.userData[userId]?.[itemId],
        LastPlayedDate: datePlayed,
      };
  }
  async migrationItems(userId?: string): Promise<MediaItem[]> {
    return this.items(userId);
  }
  async migrationCapabilities() {
    return { userData: true, privatePlaylists: true, playlistDuplicates: true, version: '12.2.0' };
  }
  async userData(userId: string, itemId: string): Promise<MediaUserDataPatch> {
    return (await this.items(userId)).find((item) => item.Id === itemId)?.UserData ?? {};
  }
  async updateUserData(userId: string, itemId: string, patch: MediaUserDataPatch): Promise<void> {
    if (patch.Played) await this.markPlayed(userId, itemId, patch.LastPlayedDate ?? undefined);
    (this.servers.userData[userId] ??= {})[itemId] = {
      ...this.servers.userData[userId]?.[itemId],
      ...patch,
    };
  }
  async markFavorite(userId: string, itemId: string): Promise<void> {
    await this.updateUserData(userId, itemId, { IsFavorite: true });
  }
  async playlists(userId: string): Promise<MediaPlaylist[]> {
    return structuredClone(this.servers.playlists[userId] ?? []);
  }
  async playlistItems(id: string, userId: string): Promise<MediaItem[]> {
    const playlist = this.servers.playlists[userId]?.find((entry) => entry.Id === id);
    if (!playlist) throw new MediaError('Playlist not found.', 404);
    const library = await this.items(userId);
    return playlist.items.map((itemId, index) => ({
      ...(library.find((item) => item.Id === itemId) ?? { Id: itemId }),
      PlaylistItemId: String(index),
    }));
  }
  async createPlaylist(
    userId: string,
    name: string,
    mediaType?: string,
    ids: string[] = [],
  ): Promise<MediaPlaylist> {
    const playlist = {
      Id: randomUUID().replaceAll('-', ''),
      Name: name,
      MediaType: mediaType,
      items: [...ids],
      IsPublic: false,
      OwnerUserId: userId,
    };
    (this.servers.playlists[userId] ??= []).push(playlist);
    return structuredClone(playlist);
  }
  async addPlaylistItems(id: string, userId: string, ids: string[]): Promise<void> {
    const playlist = this.servers.playlists[userId]?.find((entry) => entry.Id === id);
    if (!playlist) throw new MediaError('Playlist not found.', 404);
    playlist.items.push(...ids);
  }
  async userImage(userId: string): Promise<MediaUserImage | null> {
    return this.servers.images[userId] ?? null;
  }
  async setUserImage(userId: string, image: MediaUserImage): Promise<void> {
    this.servers.images[userId] = structuredClone(image);
  }
}
