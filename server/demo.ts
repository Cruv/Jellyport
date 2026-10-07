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
} from './media.js';

/** Isolated simulated servers for local preview; never contacts real services. */
export class DemoServers {
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
      };
    return values;
  }
  async createUser(name: string, _password: string): Promise<MediaUser> {
    if (this.servers.users[this.kind].some((user) => caseFold(user.Name) === caseFold(name)))
      throw new MediaError('Demo username already exists.');
    const user = {
      Id: randomUUID().replaceAll('-', ''),
      Name: name,
      Policy: {},
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
  async markPlayed(userId: string, itemId: string): Promise<void> {
    (this.servers.played[userId] ??= new Set()).add(itemId);
  }
}
