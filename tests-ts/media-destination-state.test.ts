import { describe, expect, it, vi } from 'vitest';
import {
  CatalogChangedError,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ITEMS,
  MediaClient,
  type DestinationReadEvent,
  type MediaItem,
} from '../server/media.js';
import { mergeUserData } from '../server/migration.js';

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
const catalog = (length: number): MediaItem[] =>
  Array.from({ length }, (_, index) => ({
    Id: `movie-${index}`,
    Type: 'Movie',
    Path: `/media/${index}.mkv`,
    ProviderIds: { Tmdb: String(index) },
  }));

describe('targeted Jellyfin destination state reads', () => {
  it('reads a large candidate set once in bounded batches without enumerating the user library', async () => {
    const candidates = catalog(10_001);
    const byId = new Map(candidates.map((item) => [item.Id, item]));
    const calls: URL[] = [];
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        calls.push(url);
        expect(url.pathname).toBe('/Users/alice/Items');
        for (const field of ['Recursive', 'SortBy', 'SortOrder', 'StartIndex', 'IncludeItemTypes'])
          expect(url.searchParams.has(field)).toBe(false);
        expect(url.searchParams.get('EnableUserData')).toBe('true');
        expect(url.searchParams.get('EnableImages')).toBe('false');
        expect(url.searchParams.get('EnableTotalRecordCount')).toBe('false');
        expect(url.searchParams.get('Fields')).toBe('ProviderIds,Path');
        const ids = url.searchParams.get('Ids')!.split(',');
        expect(ids.length).toBeLessThanOrEqual(100);
        expect(Number(url.searchParams.get('Limit'))).toBe(ids.length);
        expect(encodeURIComponent(ids.join(',')).length).toBeLessThanOrEqual(6000);
        return json({
          Items: ids.map((id) => ({ ...byId.get(id), UserData: { Played: false } })),
          TotalRecordCount: 0,
        });
      },
    });
    try {
      const items = await client.destinationItems('alice', candidates);
      expect(items).toHaveLength(candidates.length);
      expect(calls).toHaveLength(101);
      expect(new Set(calls.flatMap((url) => url.searchParams.get('Ids')!.split(','))).size).toBe(
        candidates.length,
      );
      expect(items[0]?.UserData).toEqual({ Played: false });
    } finally {
      await client.close();
    }
  });

  it('retains unplayed and empty accessible states, omits unavailable IDs without repeated probes', async () => {
    const candidates = catalog(4);
    const transport = vi.fn(async () =>
      json({
        Items: [
          { ...candidates[2], UserData: {} },
          { ...candidates[0], UserData: { Played: false, PlayCount: 0 } },
        ],
        TotalRecordCount: 99,
      }),
    );
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport,
    });
    try {
      const items = await client.destinationItems('alice', candidates);
      expect(items.map((item) => item.Id)).toEqual(['movie-2', 'movie-0']);
      expect(items[0]?.UserData).toEqual({});
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it('preserves newer destination activity and drops personal DTO fields outside the supported state', async () => {
    const candidate = catalog(1)[0]!;
    const state = {
      Played: true,
      IsFavorite: true,
      Likes: false,
      Rating: 0,
      PlaybackPositionTicks: 99,
      PlayCount: 7,
      LastPlayedDate: '2026-10-15T12:00:00.0000000Z',
    };
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () =>
        json({
          Items: [
            {
              ...candidate,
              UserData: { ...state, Key: 'private-identity', PlayedPercentage: 12 },
              Overview: 'unused'.repeat(10_000),
              MediaSources: [{ Id: 'private-source' }],
            },
          ],
        }),
    });
    try {
      const [target] = await client.destinationItems('alice', [candidate]);
      expect(target).toEqual({
        ...candidate,
        UserData: { ...state, LastPlayedDate: '2026-10-15T12:00:00.000Z' },
      });
      expect(
        mergeUserData(
          {
            ...candidate,
            UserData: {
              Played: true,
              PlaybackPositionTicks: 50,
              PlayCount: 2,
              LastPlayedDate: '2026-10-14T12:00:00Z',
            },
          },
          target!,
        ),
      ).toEqual({});
    } finally {
      await client.close();
    }
  });

  it('does not cache personal state between users or repeat calls', async () => {
    const candidate = catalog(1)[0]!;
    let calls = 0;
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => json({ Items: [{ ...candidate, UserData: { PlayCount: ++calls } }] }),
    });
    try {
      expect((await client.destinationItems('alice', [candidate]))[0]?.UserData?.PlayCount).toBe(1);
      expect((await client.destinationItems('bob', [candidate]))[0]?.UserData?.PlayCount).toBe(2);
      expect((await client.destinationItems('alice', [candidate]))[0]?.UserData?.PlayCount).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('retains series identities only with an unchanged series link and episode numbering', async () => {
    const candidate: MediaItem = {
      Id: 'episode',
      Type: 'Episode',
      SeriesId: 'series',
      IndexNumber: 2,
      ParentIndexNumber: 1,
      SeriesProviderIds: { Tvdb: '42' },
    };
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => {
        const { SeriesProviderIds: _, ...metadata } = candidate;
        return json({ Items: [{ ...metadata, UserData: { Played: false } }] });
      },
    });
    try {
      const [target] = await client.destinationItems('alice', [candidate]);
      expect(target?.SeriesProviderIds).toEqual({ Tvdb: '42' });
      expect(target?.SeriesProviderIds).not.toBe(candidate.SeriesProviderIds);
    } finally {
      await client.close();
    }
  });

  it.each([
    { Type: 'Audio' },
    { Path: '/media/other.mkv' },
    { Path: undefined },
    { ProviderIds: { Tmdb: 'other' } },
    { ProviderIds: undefined },
    { SeriesId: 'other' },
    { IndexNumber: 2 },
    { ParentIndexNumber: 2 },
    { IndexNumberEnd: 2 },
  ])('fails closed when a cached identity changed: %j', async (changed) => {
    const candidate = catalog(1)[0]!;
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () =>
        json({ Items: [{ ...candidate, ...changed, UserData: { Played: false } }] }),
    });
    try {
      await expect(client.destinationItems('alice', [candidate])).rejects.toBeInstanceOf(
        CatalogChangedError,
      );
    } finally {
      await client.close();
    }
  });

  it.each([
    ['foreign identifier', { Id: 'foreign', UserData: {} }, false],
    ['repeated identifier', { UserData: {} }, true],
    ['missing data', {}, false],
    ['null data', { UserData: null }, false],
    ['invalid count', { UserData: { PlayCount: -1 } }, false],
    ['invalid boolean', { UserData: { Played: 'false' } }, false],
  ])('rejects %s', async (_, fields, repeat) => {
    const candidate = catalog(1)[0]!;
    const value = { ...candidate, ...(fields as Record<string, unknown>) };
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => json({ Items: repeat ? [value, value] : [value] }),
    });
    try {
      await expect(client.destinationItems('alice', catalog(2))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it('bounds encoded IDs and omits deleted/inaccessible batches with one request each', async () => {
    const candidates = catalog(40).map((item, index) => ({
      ...item,
      Id: `${'😀'.repeat(30)}-${index}`,
    }));
    const batches: string[][] = [];
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async (address) => {
        const ids = new URL(address).searchParams.get('Ids')!.split(',');
        expect(encodeURIComponent(ids.join(',')).length).toBeLessThanOrEqual(6000);
        batches.push(ids);
        return json({ Items: [] });
      },
    });
    try {
      expect(await client.destinationItems('alice', candidates)).toEqual([]);
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.flat()).toHaveLength(candidates.length);
      expect(new Set(batches.flat()).size).toBe(candidates.length);
    } finally {
      await client.close();
    }
  });

  it('bounds candidate metadata before making any API call', async () => {
    const transport = vi.fn(async () => json({ Items: [] }));
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport,
    });
    try {
      await expect(
        client.destinationItems('alice', new Array(MAX_CATALOG_ITEMS + 1)),
      ).rejects.toThrow(/catalog/);
      const tooLarge = catalog(5000).map((item) => ({ ...item, Path: 'p'.repeat(16_384) }));
      await expect(client.destinationItems('alice', tooLarge)).rejects.toThrow(/size/);
      await expect(
        client.destinationItems('alice', [catalog(1)[0]!, catalog(1)[0]!]),
      ).rejects.toThrow(/duplicate/);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('bounds retained destination state independently of the input catalog and page response ceilings', async () => {
    const candidates = catalog(4000).map((item) => ({ ...item, Path: 'p'.repeat(16_384) }));
    const byId = new Map(candidates.map((item) => [item.Id, item]));
    expect(candidates.length * 16_384).toBeLessThan(MAX_CATALOG_BYTES);
    let calls = 0;
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async (address) => {
        calls++;
        const ids = new URL(address).searchParams.get('Ids')!.split(',');
        return json({
          Items: ids.map((id) => ({
            ...byId.get(id),
            Name: 'n'.repeat(2048),
            UserData: { Played: false },
          })),
        });
      },
    });
    try {
      await expect(client.destinationItems('alice', candidates)).rejects.toThrow(
        /destination state exceeds the supported migration size/,
      );
      expect(calls).toBeLessThan(40);
    } finally {
      await client.close();
    }
  });

  it('cancels active transports even if they ignore their signal', async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => (started = resolve));
    const transport = vi.fn(async () => {
      started();
      return new Promise<Response>(() => {});
    });
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport,
    });
    const read = client.destinationItems('alice', catalog(101));
    await active;
    await client.close();
    await expect(read).rejects.toThrow(/timed out|canceled/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retries only retryable GET responses with bounded backoff and retains no partial result', async () => {
    const candidate = catalog(1)[0]!;
    const sleep = vi.fn(async () => {});
    const events: DestinationReadEvent[] = [];
    let calls = 0;
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      sleep,
      observeRead: (event) => events.push(event),
      transport: async () =>
        ++calls < 3
          ? json({}, 503, { 'Retry-After': '1' })
          : json({ Items: [{ ...candidate, UserData: { Played: true } }] }),
    });
    try {
      expect(await client.destinationItems('alice', [candidate])).toHaveLength(1);
      expect(calls).toBe(3);
      expect(sleep.mock.calls).toEqual([[1000], [1000]]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ attempts: 3, items: 1, outcome: 'completed' });
    } finally {
      await client.close();
    }
  });

  it('cancels between bounded pages before starting another API call', async () => {
    const candidates = catalog(101);
    let calls = 0;
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => {
        calls++;
        setTimeout(() => void client.close(), 0);
        return json({
          Items: candidates.slice(0, 100).map((item) => ({ ...item, UserData: {} })),
        });
      },
    });
    await expect(client.destinationItems('alice', candidates)).rejects.toThrow(/canceled/);
    expect(calls).toBe(1);
  });

  it('bounds an active candidate request with the configured read timeout', async () => {
    const transport = vi.fn(async () => new Promise<Response>(() => {}));
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      timeoutMs: 10,
      transport,
    });
    try {
      await expect(client.destinationItems('alice', catalog(1))).rejects.toThrow(/timed out/);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it('reports neutral catalog and candidate page aggregates without private request or playback fields', async () => {
    const candidate = catalog(1)[0]!;
    const events: DestinationReadEvent[] = [];
    const client = new MediaClient('http://jellyfin.test', 'fixture-secret', 'jellyfin', {
      observeRead: (event) => events.push(event),
      transport: async (address) => {
        const url = new URL(address);
        return json({
          Items:
            url.pathname === '/Items'
              ? Number(url.searchParams.get('StartIndex')) === 0
                ? [candidate]
                : []
              : [{ ...candidate, UserData: { Played: true, PlayCount: 7 } }],
        });
      },
    });
    try {
      await client.catalogItems();
      await client.destinationItems('private-user', [candidate]);
      expect(events).toHaveLength(3);
      expect(events.map(({ operation, items }) => [operation, items])).toEqual([
        ['catalog', 1],
        ['catalog', 0],
        ['user_state', 1],
      ]);
      for (const event of events) {
        expect(event).toEqual({
          event: 'destination_read',
          operation: expect.stringMatching(/catalog|user_state/),
          outcome: 'completed',
          duration_ms: expect.any(Number),
          items: expect.any(Number),
          attempts: 1,
        });
        expect(event.duration_ms).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(events)).not.toMatch(/fixture-secret|private-user|movie-0|PlayCount/);
    } finally {
      await client.close();
    }
  });

  it('reports canceled and failed reads while ignoring observer exceptions', async () => {
    const events: DestinationReadEvent[] = [];
    const failed = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => json({}, 500),
      observeRead: (event) => {
        events.push(event);
        throw new Error('An observer failed');
      },
    });
    await expect(failed.destinationItems('alice', catalog(1))).rejects.toThrow(/HTTP 500/);
    await failed.close();
    let started!: () => void;
    const active = new Promise<void>((resolve) => (started = resolve));
    const canceled = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => {
        started();
        return new Promise<Response>(() => {});
      },
      observeRead: (event) => events.push(event),
    });
    const read = canceled.destinationItems('alice', catalog(1));
    await active;
    await canceled.close();
    await expect(read).rejects.toThrow();
    expect(events.map((event) => event.outcome)).toEqual(['failed', 'canceled']);
    expect(events.every((event) => event.items === 0)).toBe(true);
    expect(events.map((event) => event.attempts)).toEqual([1, 1]);
  });

  it('counts overlapping request attempts separately for each operation', async () => {
    const candidate = catalog(1)[0]!;
    const events: DestinationReadEvent[] = [];
    const attempts = new Map<string, number>();
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      sleep: async () => {},
      observeRead: (event) => events.push(event),
      transport: async (address) => {
        const path = new URL(address).pathname;
        const count = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, count);
        if (path.includes('alice') && count === 1) return json({}, 429);
        return json({ Items: [{ ...candidate, UserData: {} }] });
      },
    });
    try {
      await Promise.all([
        client.destinationItems('alice', [candidate]),
        client.destinationItems('bob', [candidate]),
      ]);
      expect(events.map((event) => event.attempts).sort()).toEqual([1, 2]);
      expect(events.every((event) => event.items === 1 && event.outcome === 'completed')).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });
});
