import { setTimeout as delay } from 'node:timers/promises';
import { MediaError } from './errors.js';

export type MediaKind = 'emby' | 'jellyfin';
export type JsonObject = Record<string, unknown>;
/** Writable, non-derived fields accepted by Jellyfin's item user-data endpoint. */
export interface MediaUserDataPatch extends JsonObject {
  Played?: boolean;
  IsFavorite?: boolean;
  Likes?: boolean;
  PlaybackPositionTicks?: number;
  PlayCount?: number;
  LastPlayedDate?: string;
  Rating?: number;
}
export interface MigrationCapabilities {
  userData: boolean;
  privatePlaylists: boolean;
  playlistDuplicates: boolean;
  version?: string;
}
export interface MediaItem extends JsonObject {
  Id: string;
  Name?: string;
  Type?: string;
  ProviderIds?: JsonObject;
  SeriesProviderIds?: JsonObject;
  SeriesId?: string;
  Path?: string;
  UserData?: { Played?: boolean; [key: string]: unknown };
}
export interface MediaPlaylist extends MediaItem {
  Name: string;
  MediaType?: string;
}
export interface MediaUserImage {
  contentType: 'image/png' | 'image/jpeg';
  data: Uint8Array;
}
export interface MediaUser extends JsonObject {
  Id: string;
  Name: string;
  Policy?: JsonObject;
  Configuration?: JsonObject;
}
export interface MediaAPI {
  close(): Promise<void>;
  systemInfo(): Promise<JsonObject>;
  users(): Promise<MediaUser[]>;
  user(id: string): Promise<MediaUser>;
  items(userId?: string): Promise<MediaItem[]>;
  createUser(name: string, password: string): Promise<MediaUser>;
  setPassword(id: string, password: string): Promise<void>;
  setPolicy(id: string, policy: JsonObject): Promise<void>;
  setConfiguration(id: string, configuration: JsonObject): Promise<void>;
  markPlayed(userId: string, itemId: string, datePlayed?: string): Promise<void>;
  migrationItems?(userId?: string): Promise<MediaItem[]>;
  migrationCapabilities?(): Promise<MigrationCapabilities>;
  updateUserData?(userId: string, itemId: string, patch: MediaUserDataPatch): Promise<void>;
  userData?(userId: string, itemId: string): Promise<MediaUserDataPatch>;
  markFavorite?(userId: string, itemId: string): Promise<void>;
  playlists?(userId: string): Promise<MediaPlaylist[]>;
  playlistItems?(playlistId: string, userId: string): Promise<MediaItem[]>;
  createPlaylist?(
    userId: string,
    name: string,
    mediaType?: string,
    ids?: string[],
  ): Promise<MediaPlaylist>;
  addPlaylistItems?(playlistId: string, userId: string, ids: string[]): Promise<void>;
  userImage?(userId: string): Promise<MediaUserImage | null>;
  setUserImage?(userId: string, image: MediaUserImage): Promise<void>;
}
export type ClientFactory = (url: string, apiKey: string, kind?: MediaKind) => MediaAPI;
export type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface MediaClientOptions {
  transport?: FetchTransport;
  sleep?: (milliseconds: number) => Promise<unknown>;
  timeoutMs?: number;
  /** Can lower the 8 MiB response ceiling for constrained deployments and tests. */
  maxResponseBytes?: number;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MIGRATION_ITEM_TYPES =
  'Movie,Episode,Series,Season,Audio,MusicAlbum,MusicArtist,MusicVideo,Video,Book,AudioBook,Photo,PhotoAlbum,BoxSet,Trailer';
const PLAYLIST_MEDIA_TYPES = new Set(['Audio', 'Video', 'Photo', 'Book']);

function versionAtLeast(version: string | undefined, major: number, minor = 0): boolean {
  // Unknown and prerelease versions fail closed for privacy-sensitive writes.
  const match = version?.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)?$/);
  return (
    !!match &&
    (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor))
  );
}

function dateValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value)))
    throw new MediaError('A valid playback date is required.');
  const normalized = new Date(value).toISOString();
  if (!/^\d{4}-/.test(normalized) || normalized.startsWith('0000-'))
    throw new MediaError('A valid playback date is required.');
  return normalized;
}

function writableUserData(value: unknown, requireFields = false): MediaUserDataPatch {
  if (!isObject(value)) throw new MediaError('A valid user-data object is required.');
  const body: MediaUserDataPatch = {};
  for (const field of ['Played', 'IsFavorite', 'Likes'] as const) {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'boolean') throw new MediaError('Invalid user-data boolean value.');
    body[field] = candidate;
  }
  for (const field of ['PlaybackPositionTicks', 'PlayCount'] as const) {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) continue;
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      (field === 'PlayCount' && candidate > 2_147_483_647)
    )
      throw new MediaError('Invalid user-data playback value.');
    body[field] = candidate;
  }
  if (value.LastPlayedDate !== undefined && value.LastPlayedDate !== null)
    body.LastPlayedDate = dateValue(value.LastPlayedDate);
  if (value.Rating !== undefined && value.Rating !== null) {
    if (
      typeof value.Rating !== 'number' ||
      !Number.isFinite(value.Rating) ||
      value.Rating < 0 ||
      value.Rating > 10
    )
      throw new MediaError('Invalid user-data rating value.');
    body.Rating = value.Rating;
  }
  if (requireFields && !Object.keys(body).length)
    throw new MediaError('A writable user-data field is required.');
  return body;
}

/** Accept small raster avatars only; PNG/JPEG dimensions also bound decompression work. */
function validateImage(image: MediaUserImage): MediaUserImage {
  const invalid = () => new MediaError('The profile image is not a supported small PNG or JPEG.');
  if (!image || !(image.data instanceof Uint8Array) || image.data.length > MAX_IMAGE_BYTES)
    throw invalid();
  const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  let width = 0;
  let height = 0;
  if (image.contentType === 'image/png') {
    if (
      data.length < 24 ||
      !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.readUInt32BE(8) !== 13 ||
      data.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw invalid();
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (image.contentType === 'image/jpeg') {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw invalid();
    let offset = 2;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) throw invalid();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) throw invalid();
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) throw invalid();
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 8) throw invalid();
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else throw invalid();
  if (!width || !height || width > 256 || height > 256) throw invalid();
  return image;
}

/** Bounds custom transports and streams even when they ignore the fetch signal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function cancelBody(response: Response | undefined): void {
  // Cancellation must not be awaited: a malicious or custom stream may never settle it.
  if (response?.body) void response.body.cancel().catch(() => {});
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Conservative API-key client. Mutations are never retried after uncertain outcomes. */
export class MediaClient implements MediaAPI {
  pageSize = 500;
  readonly kind: MediaKind;
  private readonly label: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly transport: FetchTransport;
  private readonly sleep: (milliseconds: number) => Promise<unknown>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly controller = new AbortController();
  private capabilities?: Promise<MigrationCapabilities>;

  constructor(
    url: string,
    apiKey: string,
    kind: MediaKind = 'jellyfin',
    options: MediaClientOptions = {},
  ) {
    if (kind !== 'emby' && kind !== 'jellyfin')
      throw new MediaError('Unsupported media server type.');
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        url.includes('?') ||
        url.includes('#')
      )
        throw new Error();
    } catch {
      throw new MediaError(
        'Server URL must be an HTTP(S) address without credentials or query parameters.',
      );
    }
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey))
      throw new MediaError('A valid media server API key is required.');
    this.kind = kind;
    this.label = kind === 'jellyfin' ? 'Jellyfin' : 'Emby';
    this.baseUrl = parsed.toString().replace(/\/+$/, '') + '/';
    this.apiKey = apiKey;
    this.transport = options.transport ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 60_000 ||
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_RESPONSE_BYTES
    )
      throw new MediaError('Invalid media server client configuration.');
  }

  async close(): Promise<void> {
    this.controller.abort();
  }

  private id(value: string): string {
    if (typeof value !== 'string' || !value || value === '.' || value === '..')
      throw new MediaError('A valid media server identifier is required.');
    return encodeURIComponent(value);
  }

  private async request(
    method: string,
    path: string,
    params?: Record<string, string | number>,
    body?: unknown,
    decode: boolean | 'image' = true,
    bodyContentType?: MediaUserImage['contentType'],
  ): Promise<unknown> {
    const attempts = method === 'GET' ? 3 : 1;
    const url = new URL(this.baseUrl + path.replace(/^\/+/, ''));
    for (const [key, value] of Object.entries(params ?? {}))
      url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const timeout = new AbortController();
      const deadline = Date.now() + this.timeoutMs;
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
      timer.unref();
      const signal = AbortSignal.any([this.controller.signal, timeout.signal]);
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (signal.aborted) throw signal.reason;
        const pending = this.transport(url.toString(), {
          method,
          redirect: 'manual',
          headers: {
            ...(this.kind === 'jellyfin'
              ? {
                  Authorization: `MediaBrowser Client="Jellyport", Device="Jellyport", DeviceId="jellyport-service", Version="0.3.0", Token="${this.apiKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
                }
              : { 'X-Emby-Token': this.apiKey }),
            Accept: decode === 'image' ? 'image/png, image/jpeg' : 'application/json',
            'User-Agent': 'Jellyport/0.3',
            ...(body !== undefined
              ? { 'Content-Type': bodyContentType ?? 'application/json' }
              : {}),
          },
          ...(body !== undefined
            ? { body: bodyContentType ? String(body) : JSON.stringify(body) }
            : {}),
          signal,
        });
        // A transport that resolves after the deadline must not leave an unread body open.
        void pending.then(
          (late) => {
            if (signal.aborted) cancelBody(late);
          },
          () => {},
        );
        response = await abortable(pending, signal);
        if ([429, 503].includes(response.status) && attempt + 1 < attempts) {
          const parsed = Number(response.headers.get('Retry-After') ?? '0.2');
          cancelBody(response);
          response = undefined;
          await abortable(
            this.sleep(Number.isFinite(parsed) ? Math.min(2, Math.max(0, parsed)) * 1000 : 200),
            signal,
          );
          continue;
        }
        if (decode === 'image' && response.status === 404) return null;
        if (!response.ok)
          throw new MediaError(
            `${this.label} rejected the request (HTTP ${response.status}).`,
            response.status,
          );
        if (!decode || response.status === 204) return null;
        const maxBytes =
          decode === 'image'
            ? Math.min(this.maxResponseBytes, MAX_IMAGE_BYTES)
            : this.maxResponseBytes;
        const declaredLength = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
          throw new MediaError(`${this.label} API response exceeds the supported size.`);
        if (!response.body) throw new MediaError(`${this.label} returned an invalid API response.`);
        reader = response.body.getReader();
        let buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
        let bytes = 0;
        while (true) {
          // Immediate stream chunks must not starve the deadline's timer callback.
          if (Date.now() >= deadline) {
            timeout.abort();
            throw signal.reason;
          }
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) break;
          const nextSize = bytes + chunk.value.byteLength;
          if (nextSize > maxBytes)
            throw new MediaError(`${this.label} API response exceeds the supported size.`);
          if (nextSize > buffer.length) {
            const expanded = Buffer.allocUnsafe(
              Math.min(maxBytes, Math.max(nextSize, buffer.length * 2)),
            );
            buffer.copy(expanded, 0, 0, bytes);
            buffer = expanded;
          }
          buffer.set(chunk.value, bytes);
          bytes = nextSize;
        }
        if (decode === 'image') {
          if (Date.now() >= deadline) {
            timeout.abort();
            throw signal.reason;
          }
          const contentType = response.headers
            .get('Content-Type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase();
          if (contentType !== 'image/png' && contentType !== 'image/jpeg')
            throw new MediaError('The profile image is not a supported small PNG or JPEG.');
          const image = validateImage({
            contentType,
            data: new Uint8Array(buffer.subarray(0, bytes)),
          });
          if (Date.now() >= deadline) {
            timeout.abort();
            throw signal.reason;
          }
          return image;
        }
        let result: unknown;
        try {
          result = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
        } catch {
          throw new MediaError(`${this.label} returned an invalid API response.`);
        }
        if (Date.now() >= deadline) {
          timeout.abort();
          throw signal.reason;
        }
        return result;
      } catch (error) {
        if (error instanceof MediaError) throw error;
        const timedOut =
          signal.aborted ||
          (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
        const suffix =
          method !== 'GET' ? ' The operation may have been applied; check before retrying.' : '';
        throw new MediaError(
          (timedOut ? `${this.label} request timed out.` : `Unable to connect to ${this.label}.`) +
            suffix,
        );
      } finally {
        clearTimeout(timer);
        if (reader) {
          void reader.cancel().catch(() => {});
          try {
            reader.releaseLock();
          } catch {
            /* The canceled read may still be settling. */
          }
        } else cancelBody(response);
      }
    }
    throw new MediaError(`${this.label} request failed.`);
  }

  private object(value: unknown): JsonObject {
    if (!isObject(value)) throw new MediaError(`${this.label} returned an invalid API response.`);
    return value;
  }

  private validUser(value: unknown): MediaUser {
    if (
      !isObject(value) ||
      typeof value.Id !== 'string' ||
      !value.Id ||
      typeof value.Name !== 'string' ||
      !value.Name
    )
      throw new MediaError(`${this.label} returned an invalid user list.`);
    return value as MediaUser;
  }

  async systemInfo(): Promise<JsonObject> {
    return this.object(await this.request('GET', 'System/Info'));
  }
  async users(): Promise<MediaUser[]> {
    const value = await this.request('GET', 'Users');
    if (!Array.isArray(value)) throw new MediaError(`${this.label} returned an invalid user list.`);
    return value.map((item) => this.validUser(item));
  }
  async user(id: string): Promise<MediaUser> {
    return this.validUser(await this.request('GET', `Users/${this.id(id)}`));
  }

  private async itemsByType(
    userId: string | undefined,
    itemTypes: string,
    expanded = false,
  ): Promise<MediaItem[]> {
    const path = userId !== undefined ? `Users/${this.id(userId)}/Items` : 'Items';
    const items: MediaItem[] = [];
    const seenIds = new Set<string>();
    let start = 0;
    while (true) {
      const data = this.object(
        await this.request('GET', path, {
          IncludeItemTypes: itemTypes,
          Recursive: 'true',
          Fields:
            expanded && this.kind === 'emby'
              ? 'ProviderIds,Path,UserDataPlayCount,UserDataLastPlayedDate'
              : 'ProviderIds,Path',
          EnableUserData: userId !== undefined ? 'true' : 'false',
          EnableImages: 'false',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          StartIndex: start,
          Limit: this.pageSize,
          EnableTotalRecordCount: 'true',
        }),
      );
      if (!Array.isArray(data.Items) || data.Items.some((item) => !isObject(item)))
        throw new MediaError(`${this.label} returned an invalid library page.`);
      if (!data.Items.length) break;
      if (data.Items.some((item) => typeof item.Id !== 'string' || !item.Id))
        throw new MediaError(`${this.label} returned library items without identifiers.`);
      const page = data.Items as MediaItem[];
      if (page.every((item) => seenIds.has(item.Id)))
        throw new MediaError(
          `${this.label} repeated a library page; refresh the library and retry.`,
        );
      for (const item of page) {
        if (!seenIds.has(item.Id)) items.push(item);
        seenIds.add(item.Id);
      }
      start += page.length;
      if (
        typeof data.TotalRecordCount === 'number' &&
        Number.isInteger(data.TotalRecordCount) &&
        data.TotalRecordCount >= 0
      ) {
        if (start >= data.TotalRecordCount) break;
      } else if (page.length < this.pageSize) break;
      if (start > 2_000_000)
        throw new MediaError(`${this.label} library exceeds the supported migration size.`);
    }
    return items;
  }

  async items(userId?: string): Promise<MediaItem[]> {
    const items = await this.itemsByType(userId, 'Movie,Episode');
    const needsSeries = new Set(
      items
        .filter((item) => item.Type === 'Episode' && item.SeriesId && !item.SeriesProviderIds)
        .map((item) => item.SeriesId),
    );
    if (needsSeries.size) {
      const series = await this.itemsByType(userId, 'Series');
      const providers = new Map(
        series
          .filter((item) => needsSeries.has(item.Id) && isObject(item.ProviderIds))
          .map((item) => [item.Id, item.ProviderIds!]),
      );
      for (const item of items) {
        const values = item.SeriesId ? providers.get(item.SeriesId) : undefined;
        if (values && !item.SeriesProviderIds) item.SeriesProviderIds = structuredClone(values);
      }
    }
    return items;
  }

  /** Reads per-user state beyond movies/episodes without requesting image or media streams. */
  async migrationItems(userId?: string): Promise<MediaItem[]> {
    const items = await this.itemsByType(userId, MIGRATION_ITEM_TYPES, true);
    const providers = new Map(
      items
        .filter((item) => item.Type === 'Series' && isObject(item.ProviderIds))
        .map((item) => [item.Id, item.ProviderIds!]),
    );
    for (const item of items) {
      const values = item.SeriesId ? providers.get(item.SeriesId) : undefined;
      if (values && !item.SeriesProviderIds) item.SeriesProviderIds = structuredClone(values);
    }
    return items;
  }

  async migrationCapabilities(): Promise<MigrationCapabilities> {
    if (!this.capabilities) {
      this.capabilities = this.systemInfo().then((info) => {
        const version = typeof info.Version === 'string' ? info.Version : undefined;
        const supported = this.kind === 'jellyfin' && versionAtLeast(version, 10, 9);
        return {
          userData: supported,
          privatePlaylists: supported,
          playlistDuplicates: supported && versionAtLeast(version, 12),
          ...(version ? { version } : {}),
        };
      });
      // A temporary read failure must not permanently disable retries for this client.
      void this.capabilities.catch(() => {
        this.capabilities = undefined;
      });
    }
    return this.capabilities;
  }

  async updateUserData(userId: string, itemId: string, patch: MediaUserDataPatch): Promise<void> {
    const body = writableUserData(patch, true);
    this.id(userId);
    const id = this.id(itemId);
    if (!(await this.migrationCapabilities()).userData)
      throw new MediaError('Detailed user-data migration requires Jellyfin 10.9 or newer.');
    await this.request('POST', `UserItems/${id}/UserData`, { userId }, body, false);
  }

  async userData(userId: string, itemId: string): Promise<MediaUserDataPatch> {
    this.id(userId);
    if (!(await this.migrationCapabilities()).userData)
      throw new MediaError('Detailed user-data migration requires Jellyfin 10.9 or newer.');
    return writableUserData(
      await this.request('GET', `UserItems/${this.id(itemId)}/UserData`, { userId }),
    );
  }

  async playlists(userId: string): Promise<MediaPlaylist[]> {
    const items = await this.itemsByType(userId, 'Playlist');
    if (items.some((item) => typeof item.Name !== 'string' || !item.Name.trim()))
      throw new MediaError(`${this.label} returned playlists without names.`);
    return items as MediaPlaylist[];
  }

  /** Playlist entry IDs are occurrence IDs; ordinary media IDs must never be deduplicated here. */
  async playlistItems(playlistId: string, userId: string): Promise<MediaItem[]> {
    this.id(userId);
    const path = `Playlists/${this.id(playlistId)}/Items`;
    const items: MediaItem[] = [];
    const seenPages = new Set<string>();
    let start = 0;
    while (true) {
      const data = this.object(
        await this.request('GET', path, {
          userId,
          Fields: 'ProviderIds,Path',
          EnableUserData: 'true',
          EnableImages: 'false',
          StartIndex: start,
          Limit: this.pageSize,
        }),
      );
      if (
        !Array.isArray(data.Items) ||
        data.Items.some((item) => !isObject(item) || typeof item.Id !== 'string' || !item.Id)
      )
        throw new MediaError(`${this.label} returned an invalid playlist page.`);
      const page = data.Items as MediaItem[];
      if (!page.length) break;
      // Jellyfin's PlaylistItemId can equal the media ID, including repeated occurrences.
      // Keep every entry and bound pagination using the server's total count instead.
      const total = data.TotalRecordCount;
      const hasTotal = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0;
      if (hasTotal && total > 100_000)
        throw new MediaError(`${this.label} playlist exceeds the supported migration size.`);
      if (!hasTotal) {
        const signature = JSON.stringify(page.map((item) => item.Id));
        if (seenPages.has(signature))
          throw new MediaError(`${this.label} repeated a playlist page; refresh and retry.`);
        seenPages.add(signature);
      }
      items.push(...page);
      start += page.length;
      if (start > 100_000)
        throw new MediaError(`${this.label} playlist exceeds the supported migration size.`);
      if ((hasTotal && start >= total) || (!hasTotal && page.length < this.pageSize)) break;
    }
    return items;
  }

  async createPlaylist(
    userId: string,
    name: string,
    mediaType?: string,
    ids: string[] = [],
  ): Promise<MediaPlaylist> {
    this.id(userId);
    if (typeof name !== 'string' || !name.trim() || name.length > 512)
      throw new MediaError('A playlist name of at most 512 characters is required.');
    if (mediaType !== undefined && !PLAYLIST_MEDIA_TYPES.has(mediaType))
      throw new MediaError('Unsupported playlist media type.');
    if (
      !Array.isArray(ids) ||
      ids.length > 100_000 ||
      ids.some((id) => typeof id !== 'string' || !id || id.length > 128 || /[,\r\n\u0000]/.test(id))
    )
      throw new MediaError('Create playlists with at most 100,000 valid item identifiers.');
    const body = {
      Name: name,
      UserId: userId,
      Ids: ids,
      Users: [],
      IsPublic: false,
      ...(mediaType ? { MediaType: mediaType } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 4 * 1024 * 1024)
      throw new MediaError('The private playlist creation request exceeds the supported size.');
    if (!(await this.migrationCapabilities()).privatePlaylists)
      throw new MediaError('Private playlist migration requires Jellyfin 10.9 or newer.');
    const result = this.object(await this.request('POST', 'Playlists', undefined, body));
    if (typeof result.Id !== 'string' || !result.Id)
      throw new MediaError(
        'Jellyfin returned an invalid playlist creation response. Check before retrying.',
      );
    return {
      Id: result.Id,
      Name: name,
      Type: 'Playlist',
      ...(mediaType ? { MediaType: mediaType } : {}),
    };
  }

  async addPlaylistItems(playlistId: string, userId: string, ids: string[]): Promise<void> {
    this.id(userId);
    const id = this.id(playlistId);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some(
        (item) =>
          typeof item !== 'string' || !item || item.length > 128 || /[,\r\n\u0000]/.test(item),
      )
    )
      throw new MediaError('Add between 1 and 100 valid playlist item identifiers at a time.');
    if (!(await this.migrationCapabilities()).privatePlaylists)
      throw new MediaError('Private playlist migration requires Jellyfin 10.9 or newer.');
    await this.request(
      'POST',
      `Playlists/${id}/Items`,
      { userId, ids: ids.join(',') },
      undefined,
      false,
    );
  }

  async userImage(userId: string): Promise<MediaUserImage | null> {
    return (await this.request(
      'GET',
      `Users/${this.id(userId)}/Images/Primary`,
      { Format: 'Png', MaxWidth: 256, MaxHeight: 256 },
      undefined,
      'image',
    )) as MediaUserImage | null;
  }

  async setUserImage(userId: string, image: MediaUserImage): Promise<void> {
    if (this.kind !== 'jellyfin')
      throw new MediaError('Profile image migration is supported only on Jellyfin.');
    const valid = validateImage(image);
    await this.request(
      'POST',
      `Users/${this.id(userId)}/Images/Primary`,
      undefined,
      Buffer.from(valid.data).toString('base64'),
      false,
      valid.contentType,
    );
  }
  async createUser(name: string, password: string): Promise<MediaUser> {
    if (this.kind !== 'jellyfin')
      throw new MediaError('Account creation is supported only on Jellyfin.');
    if (!name.trim() || !password)
      throw new MediaError('A username and nonempty password are required.');
    return this.validUser(
      await this.request('POST', 'Users/New', undefined, { Name: name, Password: password }),
    );
  }
  async setPassword(id: string, password: string): Promise<void> {
    if (this.kind !== 'jellyfin' || !password)
      throw new MediaError('A nonempty Jellyfin password is required.');
    await this.request(
      'POST',
      `Users/${this.id(id)}/Password`,
      undefined,
      { CurrentPw: '', NewPw: password, ResetPassword: false },
      false,
    );
  }
  async setPolicy(id: string, policy: JsonObject): Promise<void> {
    await this.request('POST', `Users/${this.id(id)}/Policy`, undefined, policy, false);
  }
  async setConfiguration(id: string, configuration: JsonObject): Promise<void> {
    await this.request(
      'POST',
      `Users/${this.id(id)}/Configuration`,
      undefined,
      configuration,
      false,
    );
  }
  async markPlayed(userId: string, itemId: string, datePlayed?: string): Promise<void> {
    const date = datePlayed === undefined ? undefined : dateValue(datePlayed);
    await this.request(
      'POST',
      `Users/${this.id(userId)}/PlayedItems/${this.id(itemId)}`,
      date ? { DatePlayed: date.replace(/[-:TZ.]/g, '').slice(0, 14) } : undefined,
      undefined,
      false,
    );
  }
  async markFavorite(userId: string, itemId: string): Promise<void> {
    await this.request(
      'POST',
      `Users/${this.id(userId)}/FavoriteItems/${this.id(itemId)}`,
      undefined,
      undefined,
      false,
    );
  }
}
