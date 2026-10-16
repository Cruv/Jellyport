import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MediaClient,
  type CatalogProgress,
  type FetchTransport,
  type MediaClientOptions,
} from '../server/media.js';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const itemTypes =
  'Movie,Episode,Series,Season,Audio,MusicAlbum,MusicArtist,MusicVideo,Video,Book,AudioBook,Photo,PhotoAlbum,BoxSet,Trailer';
const clientFor = (transport: FetchTransport, options: MediaClientOptions = {}) =>
  new MediaClient('http://jellyfin.test', 'synthetic-token', 'jellyfin', {
    catalogIdleMs: 0,
    transport,
    ...options,
  });

afterEach(() => vi.useRealTimers());

describe('cold Jellyfin catalog preparation', () => {
  it('disables collection post-filtering and pages every supported type without totals or personal state', async () => {
    const values = itemTypes.split(',').map((Type, index) => ({
      Id: `catalog-${index}`,
      Type,
      Path: `/synthetic/${index}`,
      ProviderIds: { Synthetic: String(index) },
      UserData: { LastPlayedDate: '2026-01-01', Played: true },
    }));
    const requests: URL[] = [];
    const progress: CatalogProgress[] = [];
    const client = clientFor(async (address) => {
      const url = new URL(address);
      requests.push(url);
      expect(url.pathname).toBe('/Items');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        IncludeItemTypes: itemTypes,
        Recursive: 'true',
        CollapseBoxSetItems: 'false',
        Fields: 'ProviderIds,Path',
        EnableUserData: 'false',
        EnableImages: 'false',
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        EnableTotalRecordCount: 'false',
        Limit: '100',
      });
      const start = Number(url.searchParams.get('StartIndex'));
      // Servers may clamp a page below our requested limit. Only an empty page ends the read.
      return json({ Items: values.slice(start, start + 2), TotalRecordCount: 0 });
    });
    const catalog = await client.catalogItems({ onProgress: (value) => progress.push(value) });
    expect(catalog.map((item) => item.Type)).toEqual(itemTypes.split(','));
    expect(catalog.every((item) => item.UserData === undefined)).toBe(true);
    expect(requests.map((url) => Number(url.searchParams.get('StartIndex')))).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14, 15,
    ]);
    expect(progress.at(-1)).toMatchObject({ pages: 9, items: 15 });
    for (const event of progress) {
      expect(Object.keys(event).sort()).toEqual(['elapsed_ms', 'items', 'last_page_ms', 'pages']);
      expect(Object.values(event).every((value) => typeof value === 'number' && value >= 0)).toBe(
        true,
      );
    }
    await client.close();
  });

  it('bounds destination pages to 100 and leaves the legacy user catalog page size at 500', async () => {
    const sizes: string[] = [];
    const client = clientFor(async (address) => {
      const url = new URL(address);
      sizes.push(url.searchParams.get('Limit')!);
      if (url.pathname.startsWith('/Users/')) {
        expect(url.searchParams.has('CollapseBoxSetItems')).toBe(false);
      }
      return json({ Items: [] });
    });
    client.pageSize = 1000;
    await client.catalogItems();
    await client.migrationItems('synthetic-user');
    expect(sizes).toEqual(['100', '500']);
    await client.close();
  });

  it('allows a six-second destination page under the normal 30-second request deadline', async () => {
    vi.useFakeTimers();
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => (admitted = resolve));
    let calls = 0;
    const client = clientFor(async () => {
      calls++;
      admitted();
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return json({ Items: [] });
    });
    const checked = expect(client.catalogItems()).resolves.toEqual([]);
    await admission;
    await vi.advanceTimersByTimeAsync(6000);
    await checked;
    expect(calls).toBe(1);
    await client.close();
  });

  it('retains the five-second Emby source page deadline and source pagination', async () => {
    vi.useFakeTimers();
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => (admitted = resolve));
    let requestSignal: AbortSignal | undefined;
    const client = new MediaClient('http://emby.test', 'synthetic-key', 'emby', {
      transport: async (address, init) => {
        requestSignal = init.signal!;
        admitted();
        const url = new URL(address);
        expect(url.searchParams.get('Limit')).toBe('100');
        expect(url.searchParams.has('CollapseBoxSetItems')).toBe(false);
        return new Promise<Response>(() => {});
      },
    });
    const checked = expect(client.catalogItems()).rejects.toThrow('Emby request timed out');
    await admission;
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
    expect(requestSignal?.aborted).toBe(true);
    await client.close();
  });

  it('aborts a destination request at its own 30-second deadline without retrying', async () => {
    vi.useFakeTimers();
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => (admitted = resolve));
    let calls = 0;
    let requestSignal: AbortSignal | undefined;
    const client = clientFor(async (_address, init) => {
      calls++;
      requestSignal = init.signal!;
      admitted();
      return new Promise<Response>(() => {});
    });
    const checked = expect(client.catalogItems()).rejects.toThrow('Jellyfin request timed out');
    await admission;
    await vi.advanceTimersByTimeAsync(30_000);
    await checked;
    expect(calls).toBe(1);
    expect(requestSignal?.aborted).toBe(true);
    await client.close();
  });

  it.each([429, 503])(
    'does not automatically retry a cold catalog HTTP %s response',
    async (status) => {
      let calls = 0;
      const client = clientFor(async () => {
        calls++;
        return json({}, status);
      });
      await expect(client.catalogItems()).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toBe(1);
      await client.close();
    },
  );

  it('waits 100ms between successful catalog pages, with no idle delay before the first request', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    // Node's timers/promises implementation retains its own native timer reference.
    // Bridge it to the fake clock locally so the assertion does not depend on host scheduling.
    const pauses: number[] = [];
    vi.doMock('node:timers/promises', () => ({
      setTimeout: (milliseconds: number, value: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          pauses.push(milliseconds);
          const signal = options?.signal;
          if (signal?.aborted) return reject(signal.reason);
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve(value);
          }, milliseconds);
          signal?.addEventListener('abort', abort, { once: true });
        }),
    }));
    let client: MediaClient | undefined;
    try {
      const { MediaClient: ClockedMediaClient } = await import('../server/media.js');
      let requests = 0;
      client = new ClockedMediaClient('http://jellyfin.test', 'synthetic-token', 'jellyfin', {
        transport: async () => {
          requests++;
          return json({ Items: requests === 1 ? [{ Id: 'movie', Type: 'Movie' }] : [] });
        },
      });
      const result = client.catalogItems();
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1);
      expect(pauses).toEqual([0, 100]);
      await vi.advanceTimersByTimeAsync(99);
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(requests).toBe(2);
      await vi.runAllTimersAsync();
      expect(await result).toEqual([{ Id: 'movie', Type: 'Movie' }]);
      expect(pauses.filter((milliseconds) => milliseconds === 100)).toEqual([100]);
    } finally {
      await client?.close();
      vi.doUnmock('node:timers/promises');
      vi.resetModules();
    }
  });

  it('cancels idle time before another request without closing the media client', async () => {
    let calls = 0;
    let firstPage!: () => void;
    const prepared = new Promise<void>((resolve) => (firstPage = resolve));
    const client = clientFor(
      async () => {
        calls++;
        return json({ Items: [{ Id: 'movie', Type: 'Movie' }] });
      },
      { catalogIdleMs: 100 },
    );
    const controller = new AbortController();
    const checked = expect(
      client.catalogItems({ signal: controller.signal, onProgress: firstPage }),
    ).rejects.toThrow('catalog preparation was canceled');
    await prepared;
    expect(calls).toBe(1);
    controller.abort();
    await checked;
    await delay(110);
    expect(calls).toBe(1);
    await client.close();
  });

  it('bounds an in-flight transport that ignores cancellation and cancels its late response', async () => {
    let settle: ((response: Response) => void) | undefined;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => (admitted = resolve));
    let requestSignal: AbortSignal | undefined;
    const cancel = vi.fn();
    const client = clientFor(async (_address, init) => {
      requestSignal = init.signal!;
      admitted();
      return new Promise<Response>((resolve) => (settle = resolve));
    });
    const controller = new AbortController();
    const checked = expect(client.catalogItems({ signal: controller.signal })).rejects.toThrow(
      'catalog preparation was canceled',
    );
    await admission;
    controller.abort();
    await checked;
    expect(requestSignal?.aborted).toBe(true);
    settle!(new Response(new ReadableStream({ cancel })));
    await delay(0);
    expect(cancel).toHaveBeenCalledOnce();
    await client.close();
  });

  it('enforces one whole-build deadline, returns no partial catalog, and keeps other requests usable', async () => {
    let catalogCalls = 0;
    const progress: CatalogProgress[] = [];
    const client = clientFor(
      async (address) => {
        if (new URL(address).pathname === '/System/Info') return json({ Id: 'synthetic-server' });
        catalogCalls++;
        if (catalogCalls === 1) return json({ Items: [{ Id: 'movie', Type: 'Movie' }] });
        return new Promise<Response>(() => {});
      },
      { catalogDeadlineMs: 75, catalogIdleMs: 20 },
    );
    await expect(
      client.catalogItems({ onProgress: (value) => progress.push(value) }),
    ).rejects.toThrow('Jellyfin catalog preparation timed out');
    expect(catalogCalls).toBe(2);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ items: 1, pages: 1 });
    expect(await client.systemInfo()).toEqual({ Id: 'synthetic-server' });
    await client.close();
  });

  it('also checks cancellation during final identity enrichment', async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = clientFor(async () => {
      calls++;
      return json({
        Items:
          calls === 1
            ? [
                { Id: 'series', Type: 'Series', ProviderIds: { Tvdb: 'synthetic-provider' } },
                { Id: 'episode', Type: 'Episode', SeriesId: 'series' },
              ]
            : [],
      });
    });
    await expect(
      client.catalogItems({
        signal: controller.signal,
        onProgress: ({ pages }) => {
          if (pages === 2) queueMicrotask(() => controller.abort());
        },
      }),
    ).rejects.toThrow('catalog preparation was canceled');
    await client.close();
  });

  it('publishes progress only after validation and ignores observer errors', async () => {
    let calls = 0;
    const observe = vi.fn(() => {
      throw new Error('synthetic observer failure');
    });
    const client = clientFor(async () => {
      calls++;
      return json({ Items: calls === 1 ? [{ Id: 'movie', Type: 'Movie' }] : [] });
    });
    await expect(client.catalogItems({ onProgress: observe })).resolves.toEqual([
      { Id: 'movie', Type: 'Movie' },
    ]);
    expect(observe).toHaveBeenCalledTimes(2);
    await client.close();
    const invalidObserve = vi.fn();
    const invalid = clientFor(async () => json({ Items: [{ Id: 'invalid-type' }] }));
    await expect(invalid.catalogItems({ onProgress: invalidObserve })).rejects.toThrow(
      'without media types',
    );
    expect(invalidObserve).not.toHaveBeenCalled();
    await invalid.close();
  });

  it.each([
    { catalogIdleMs: -1 },
    { catalogIdleMs: 0.5 },
    { catalogIdleMs: 60_001 },
    { catalogDeadlineMs: 0 },
    { catalogDeadlineMs: Infinity },
    { catalogDeadlineMs: 30 * 60_000 + 1 },
  ])('rejects invalid bounded catalog options: %j', (options) => {
    expect(() => clientFor(async () => json({ Items: [] }), options)).toThrow(
      'Invalid media server client configuration',
    );
  });
});
