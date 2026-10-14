import { describe, expect, it, vi } from 'vitest';
import {
  MediaClient,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ITEMS,
  MAX_MIGRATION_STATE_BYTES,
  MAX_MIGRATION_STATE_ITEMS,
  projectCatalogItem,
  type MediaItem,
} from '../server/media.js';
import { MediaWorkload } from '../server/media-workload.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const catalog = (length: number): MediaItem[] =>
  Array.from({ length }, (_, i) => ({
    Id: `id-${i}`,
    Type: 'Movie',
    Name: `Movie ${i}`,
    ProviderIds: { Tmdb: String(i) },
    Path: `/media/${i}.mkv`,
  }));

describe('playback-safe catalog and explicit-ID state reads', () => {
  it('projects a neutral catalog, never retaining state, arbitrary fields, or image data', async () => {
    const calls: URL[] = [];
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        calls.push(url);
        const start = Number(url.searchParams.get('StartIndex'));
        expect(url.pathname).toBe('/Items');
        expect(url.searchParams.get('EnableUserData')).toBe('false');
        expect(url.searchParams.get('EnableTotalRecordCount')).toBe('false');
        expect(url.searchParams.get('Fields')).toBe('ProviderIds,Path');
        expect(url.searchParams.get('SortBy')).toBe('SortName');
        expect(url.searchParams.get('Limit')).toBe('100');
        return json({
          Items: start
            ? []
            : [
                {
                  Id: 's',
                  Name: 'Show',
                  Type: 'Series',
                  ProviderIds: { Tvdb: '42' },
                  UserData: { Played: true },
                  Overview: 'not needed',
                },
                {
                  Id: 'e',
                  Name: 'Episode',
                  Type: 'Episode',
                  SeriesId: 's',
                  IndexNumber: 2,
                  ParentIndexNumber: 1,
                  RunTimeTicks: 1000,
                  UserData: { IsFavorite: true },
                  ImageTags: { Primary: 'private' },
                },
              ],
          TotalRecordCount: 0,
        });
      },
    });
    try {
      expect(await client.catalogItems()).toEqual([
        { Id: 's', Name: 'Show', Type: 'Series', ProviderIds: { Tvdb: '42' } },
        {
          Id: 'e',
          Name: 'Episode',
          Type: 'Episode',
          SeriesId: 's',
          IndexNumber: 2,
          ParentIndexNumber: 1,
          RunTimeTicks: 1000,
          SeriesProviderIds: { Tvdb: '42' },
        },
      ]);
      expect(calls).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it('ignores every total-count field in a neutral no-count crawl', async () => {
    const values = catalog(5);
    const starts: number[] = [];
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        const start = Number(new URL(address).searchParams.get('StartIndex'));
        starts.push(start);
        const page = values.slice(start, start + 2);
        return json({ Items: page, TotalRecordCount: page.length });
      },
    });
    try {
      expect(await client.catalogItems()).toEqual(values);
      expect(starts).toEqual([0, 2, 4, 5]);
    } finally {
      await client.close();
    }
  });

  it('reads a large catalog once per bounded ID batch without a sorted per-user scan', async () => {
    const values = catalog(100_001);
    const calls: URL[] = [];
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        calls.push(url);
        expect(url.pathname).toBe('/Users/alice/Items');
        for (const field of [
          'SortBy',
          'SortOrder',
          'Recursive',
          'IncludeItemTypes',
          'Filters',
          'IsPlayed',
        ])
          expect(url.searchParams.has(field)).toBe(false);
        expect(url.searchParams.get('EnableTotalRecordCount')).toBe('false');
        expect(url.searchParams.get('Fields')).toBe('UserDataPlayCount,UserDataLastPlayedDate');
        const ids = url.searchParams.get('Ids')!.split(',');
        expect(ids.length).toBeLessThanOrEqual(100);
        expect(encodeURIComponent(ids.join(',')).length).toBeLessThanOrEqual(6000);
        return json({
          Items: ids.map((Id) => ({ Id, Type: 'Movie', UserData: { Played: Id === 'id-100000' } })),
          TotalRecordCount: 0,
        });
      },
    });
    try {
      expect((await client.migrationState('alice', values)).map((item) => item.Id)).toEqual([
        'id-100000',
      ]);
      expect(calls).toHaveLength(1001);
      expect(new Set(calls.flatMap((url) => url.searchParams.get('Ids')!.split(','))).size).toBe(
        values.length,
      );
    } finally {
      await client.close();
    }
  });

  it('continues short/clamped ID pages, omits inaccessible IDs, and ignores unusable totals', async () => {
    const values = catalog(8);
    const starts: number[] = [];
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        const start = Number(url.searchParams.get('StartIndex'));
        starts.push(start);
        return json({
          Items: values
            .slice(0, 7)
            .slice(start, start + 2)
            .map((item) => ({ Id: item.Id, UserData: { Played: true } })),
          TotalRecordCount: start ? 2 : 0,
        });
      },
    });
    try {
      expect((await client.migrationState('alice', values)).map((item) => item.Id)).toEqual(
        values.slice(0, 7).map((item) => item.Id),
      );
      expect(starts).toEqual([0, 2, 4, 6, 7]);
    } finally {
      await client.close();
    }
  });

  it('bounds percent-encoded IDs as well as their count', async () => {
    const values = catalog(40).map((item, i) => ({ ...item, Id: `${'😀'.repeat(30)}-${i}` }));
    const lengths: number[] = [];
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        const ids = url.searchParams.get('Ids')!.split(',');
        lengths.push(ids.length);
        expect(encodeURIComponent(ids.join(',')).length).toBeLessThanOrEqual(6000);
        return json({ Items: ids.map((Id) => ({ Id, UserData: { Played: true } })) });
      },
    });
    try {
      expect(await client.migrationState('alice', values)).toHaveLength(40);
      expect(lengths.length).toBeGreaterThan(1);
      expect(lengths.reduce((a, b) => a + b)).toBe(40);
    } finally {
      await client.close();
    }
  });

  it('preserves count/date-only, dislikes, zero ratings, container favorites, and resume state', async () => {
    const states = [
      { Played: false, PlayCount: 11, LastPlayedDate: '2026-10-04T10:00:00.0000000Z' },
      { Played: false, PlayCount: 0, LastPlayedDate: '2026-10-05T10:00:00Z' },
      { Likes: false },
      { Rating: 0 },
      { IsFavorite: true },
      { PlaybackPositionTicks: 9999 },
      { Played: false, PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false },
    ];
    const values = catalog(states.length);
    values[4]!.Type = 'MusicAlbum';
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async () =>
        json({
          Items: values.map((item, i) => ({
            Id: item.Id,
            Type: item.Type,
            UserData: { ...states[i], Key: 'drop-private-identity', Unsupported: 'drop' },
          })),
        }),
    });
    try {
      const items = await client.migrationState('alice', values);
      expect(items).toHaveLength(6);
      expect(items[0]!.UserData).toEqual({
        Played: false,
        PlayCount: 11,
        LastPlayedDate: '2026-10-04T10:00:00.000Z',
      });
      expect(items[1]!.UserData?.LastPlayedDate).toBe('2026-10-05T10:00:00.000Z');
      expect(items[2]!.UserData).toEqual({ Likes: false });
      expect(items[3]!.UserData).toEqual({ Rating: 0 });
      expect(items[4]!.Type).toBe('MusicAlbum');
      expect(items[5]!.UserData).toEqual({ PlaybackPositionTicks: 9999 });
    } finally {
      await client.close();
    }
  });

  it('filters watched-only locally while preserving the complete read contract', async () => {
    const values = catalog(3);
    values[1]!.Type = 'Series';
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        expect(new URL(address).searchParams.has('IsPlayed')).toBe(false);
        return json({
          Items: values.map((item) => ({
            Id: item.Id,
            UserData: { Played: item.Id !== 'id-2', IsFavorite: true },
          })),
        });
      },
    });
    try {
      expect(
        (await client.migrationState('alice', values, 'watched_only')).map((item) => item.Id),
      ).toEqual(['id-0']);
    } finally {
      await client.close();
    }
  });

  it.each([
    { Id: 'outside', UserData: { Played: true } },
    { Id: 'id-0' },
    { Id: 'id-0', UserData: [] },
    { Id: 'id-0', UserData: {} },
    { Id: 'id-0', UserData: { Played: 'true' } },
    { Id: 'id-0', UserData: { LastPlayedDate: 'broken' } },
    { Id: 'id-0', UserData: { PlayCount: -1 } },
    { Id: 'id-0', Type: 'Episode', UserData: { Played: true } },
  ])('fails closed on invalid or unexpected state (%j)', async (bad) => {
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async () => json({ Items: [bad] }),
    });
    try {
      await expect(client.migrationState('alice', catalog(1))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it('rejects oversized and repeated ID pages rather than duplicate work or silently losing state', async () => {
    for (const mode of ['oversized', 'repeated']) {
      let calls = 0;
      const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
        transport: async () => {
          calls++;
          return json({
            Items: Array.from({ length: mode === 'oversized' ? 3 : 1 }, () => ({
              Id: 'id-0',
              UserData: { Played: true },
            })),
          });
        },
      });
      try {
        await expect(client.migrationState('alice', catalog(2))).rejects.toThrow(
          /oversized|invalid|repeated/,
        );
        expect(calls).toBeLessThanOrEqual(2);
      } finally {
        await client.close();
      }
    }
  });

  it('rejects a repeated neutral catalog ID even if the same page also contains new IDs', async () => {
    let calls = 0;
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async () => json({ Items: calls++ ? catalog(2) : catalog(1) }),
    });
    try {
      await expect(client.catalogItems()).rejects.toThrow(/repeated catalog/);
      expect(calls).toBe(2);
    } finally {
      await client.close();
    }
  });

  it('retains explicit item/encoded-byte bounds and rejects an oversized caller catalog before any request', async () => {
    expect(MAX_CATALOG_ITEMS).toBe(200_000);
    expect(MAX_CATALOG_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_MIGRATION_STATE_ITEMS).toBe(100_000);
    expect(MAX_MIGRATION_STATE_BYTES).toBe(32 * 1024 * 1024);
    const transport = vi.fn(async () => json({ Items: [] }));
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', { transport });
    try {
      await expect(
        client.migrationState('alice', Array(MAX_CATALOG_ITEMS + 1).fill(catalog(1)[0])),
      ).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect(() =>
        projectCatalogItem({ Id: 'a', Type: 'Movie', Path: 'x'.repeat(16_385) }),
      ).toThrow();
    } finally {
      await client.close();
    }
  });

  it('stops retaining personal state at its byte ceiling rather than reading the remaining pages', async () => {
    const values = catalog(4000).map((item) => ({ ...item, Path: `/${'a'.repeat(9000)}` }));
    let calls = 0;
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport: async (address) => {
        calls++;
        const ids = new URL(address).searchParams.get('Ids')!.split(',');
        return json({ Items: ids.map((Id) => ({ Id, UserData: { Played: true } })) });
      },
    });
    try {
      await expect(client.migrationState('alice', values)).rejects.toThrow(
        /personal state exceeds/,
      );
      expect(calls).toBeLessThan(40);
    } finally {
      await client.close();
    }
  });

  it('cancels promptly in-flight and while waiting, without beginning another page', async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const transport = vi.fn(async (_address: string, init: RequestInit) => {
      signal = init.signal!;
      started();
      return new Promise<Response>(() => {});
    });
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      transport,
      workload: new MediaWorkload(),
    });
    const read = client.migrationState('alice', catalog(200));
    await begun;
    await client.close();
    await expect(read).rejects.toThrow(/canceled/);
    expect(signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])(
    'does not automatically retry expensive reads on HTTP %s and opens source cooldown',
    async (status) => {
      const workload = new MediaWorkload();
      const transport = vi.fn(async () => json({}, status));
      const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
        transport,
        workload,
      });
      try {
        await expect(client.catalogItems()).rejects.toThrow(`HTTP ${status}`);
        await expect(client.migrationState('alice', catalog(1))).rejects.toThrow(/paused/);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(workload.snapshot().cooldown_remaining_ms).toBeGreaterThan(0);
      } finally {
        await client.close();
        workload.close();
      }
    },
  );

  it.each([
    [429, '600', 600_000],
    [503, 'Thu, 08 Oct 2026 12:15:00 GMT', 900_000],
    [429, '9999999999999', 86_400_000],
    [503, 'Wed, 07 Oct 2026 12:00:00 GMT', 0],
    [503, 'Thursday, 08-Oct-26 12:15:00 GMT', 900_000],
    [503, 'Thu Oct  8 12:15:00 2026', 900_000],
    [429, '-3', undefined],
    [503, 'private-playback-detail', undefined],
    [429, '2026-10-08T12:15:00Z', undefined],
    [503, 'Thu, 99 Oct 2026 12:15:00 GMT', undefined],
  ] as const)('honors a sanitized Retry-After on HTTP %s (%s)', async (status, header, hint) => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let time = 0;
    let calls = 0;
    const workload = new MediaWorkload({
      clock: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    const client = new MediaClient('http://emby.test', 'fixture-key', 'emby', {
      workload,
      transport: async () =>
        ++calls === 1
          ? new Response('{}', { status, headers: { 'Retry-After': header } })
          : json({ Items: [] }),
    });
    try {
      await expect(client.catalogItems()).rejects.toMatchObject({
        statusCode: status,
        retryAfterMs: hint,
      });
      const hold = Math.max(300_000, hint ?? 0);
      expect(workload.snapshot().cooldown_remaining_ms).toBe(hold);
      time += hold - 1;
      await expect(client.catalogItems()).rejects.toThrow(/paused/);
      expect(calls).toBe(1);
      time++;
      expect(await client.catalogItems()).toEqual([]);
      expect(calls).toBe(2);
    } finally {
      await client.close();
      workload.close();
      clock.mockRestore();
    }
  });

  it('fails closed for unverified destination state reads without making requests', async () => {
    const transport = vi.fn(async () => json({ Items: [] }));
    const client = new MediaClient('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport,
    });
    try {
      await expect(client.migrationState('alice', catalog(1))).rejects.toThrow(
        /verified only for Emby/,
      );
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
