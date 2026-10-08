import { setTimeout as delay } from 'node:timers/promises';
import { MediaError } from './errors.js';

export type MediaKind = 'emby' | 'jellyfin';
export type JsonObject = Record<string, unknown>;
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
  markPlayed(userId: string, itemId: string): Promise<void>;
}
export type ClientFactory = (url: string, apiKey: string, kind?: MediaKind) => MediaAPI;
export type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface MediaClientOptions {
  transport?: FetchTransport;
  sleep?: (milliseconds: number) => Promise<unknown>;
  timeoutMs?: number;
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
  private readonly controller = new AbortController();

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
    decode = true,
  ): Promise<unknown> {
    const attempts = method === 'GET' ? 3 : 1;
    const url = new URL(this.baseUrl + path.replace(/^\/+/, ''));
    for (const [key, value] of Object.entries(params ?? {}))
      url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await this.transport(url.toString(), {
          method,
          redirect: 'manual',
          headers: {
            ...(this.kind === 'jellyfin'
              ? {
                  Authorization: `MediaBrowser Client="Jellyport", Device="Jellyport", DeviceId="jellyport-service", Version="0.3.0", Token="${this.apiKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
                }
              : { 'X-Emby-Token': this.apiKey }),
            Accept: 'application/json',
            'User-Agent': 'Jellyport/0.3',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)]),
        });
      } catch (error) {
        const timedOut =
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
        const suffix =
          method !== 'GET' ? ' The operation may have been applied; check before retrying.' : '';
        throw new MediaError(
          (timedOut ? `${this.label} request timed out.` : `Unable to connect to ${this.label}.`) +
            suffix,
        );
      }
      if ([429, 503].includes(response.status) && attempt + 1 < attempts) {
        const parsed = Number(response.headers.get('Retry-After') ?? '0.2');
        await response.body?.cancel();
        await this.sleep(Number.isFinite(parsed) ? Math.min(2, Math.max(0, parsed)) * 1000 : 200);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MediaError(
          `${this.label} rejected the request (HTTP ${response.status}).`,
          response.status,
        );
      }
      if (!decode || response.status === 204) {
        await response.body?.cancel();
        return null;
      }
      try {
        return await response.json();
      } catch {
        throw new MediaError(`${this.label} returned an invalid API response.`);
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

  private async itemsByType(userId: string | undefined, itemTypes: string): Promise<MediaItem[]> {
    const path = userId !== undefined ? `Users/${this.id(userId)}/Items` : 'Items';
    const items: MediaItem[] = [];
    const seenIds = new Set<string>();
    let start = 0;
    while (true) {
      const data = this.object(
        await this.request('GET', path, {
          IncludeItemTypes: itemTypes,
          Recursive: 'true',
          Fields: 'ProviderIds,Path',
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
  async markPlayed(userId: string, itemId: string): Promise<void> {
    await this.request(
      'POST',
      `Users/${this.id(userId)}/PlayedItems/${this.id(itemId)}`,
      undefined,
      undefined,
      false,
    );
  }
}
