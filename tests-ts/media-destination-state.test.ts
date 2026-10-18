import { describe, expect, it, vi } from 'vitest';
import {
  CatalogChangedError,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ITEMS,
  MAX_DESTINATION_ACCESS_CHECKS,
  MAX_DESTINATION_BATCH_IDS,
  MediaClient,
  type DestinationReadEvent,
  type MediaItem,
  type MediaClientOptions,
  type MediaKind,
} from '../server/media.js';
import { mergeUserData } from '../server/migration.js';
import { jellyfinLibraryConfigHash } from '../server/jellyfin-library-membership.js';

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
const fixtureLibraries = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', locations: ['/media/allowed'] },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', locations: ['/media/forbidden'] },
  { id: 'cccccccccccccccccccccccccccccccc', locations: ['/media/other'] },
];
const fixtureConfigHash = jellyfinLibraryConfigHash(fixtureLibraries);
const fixtureVirtualFolders = fixtureLibraries.map(({ id, locations }) => ({
  ItemId: id,
  Locations: locations,
}));
const clientWithLibraries = (
  url: string,
  key: string,
  kind: MediaKind,
  options: MediaClientOptions,
): MediaClient =>
  new MediaClient(url, key, kind, {
    ...options,
    transport: async (address, init) =>
      new URL(address).pathname === '/Library/VirtualFolders'
        ? json(fixtureVirtualFolders)
        : options.transport!(address, init),
  });

// Existing state-boundary fixtures have trusted membership in one allowed library.
// Access tests below exercise fresh policies and exact target-scoped exceptions.
const clientWithPolicy = (
  url: string,
  key: string,
  kind: MediaKind,
  options: MediaClientOptions,
): MediaClient =>
  clientWithLibraries(url, key, kind, {
    ...options,
    transport: async (address, init) => {
      const parsed = new URL(address);
      return /^\/Users\/[^/]+$/.test(parsed.pathname)
        ? json({
            Id: decodeURIComponent(parsed.pathname.split('/').at(-1)!),
            Name: 'Fixture',
            Policy: {
              EnableAllFolders: false,
              EnabledFolders: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
              BlockedMediaFolders: [],
            },
          })
        : /^\/UserItems\/[^/]+\/UserData$/.test(parsed.pathname)
          ? json({}, 404)
          : options.transport!(address, init);
    },
  });

const catalog = (length: number): MediaItem[] =>
  Array.from({ length }, (_, index) => ({
    Id: `movie-${index}`,
    Type: 'Movie',
    Path: `/media/${index}.mkv`,
    ProviderIds: { Tmdb: String(index) },
    JellyportLibraryIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    JellyportLibraryConfigHash: fixtureConfigHash,
  }));

describe('targeted Jellyfin destination state reads', () => {
  const user = (policy: Record<string, unknown> = {}) => ({
    Id: 'alice',
    Name: 'Fixture',
    Policy: {
      EnableAllFolders: false,
      EnabledFolders: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      BlockedMediaFolders: [],
      ...policy,
    },
  });

  it('refreshes the library configuration binding before verifying an already-played positive hint', async () => {
    const candidate = catalog(1)[0]!;
    let folders = structuredClone(fixtureVirtualFolders);
    let configurationReads = 0;
    let candidateReads = 0;
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const path = new URL(address).pathname;
        if (path === '/Users/alice') return json(user());
        if (path === '/Library/VirtualFolders') {
          configurationReads++;
          return json(folders);
        }
        candidateReads++;
        return json({ Items: [{ ...candidate, UserData: { Played: true } }] });
      },
    });
    try {
      expect((await client.destinationItems('alice', [candidate]))[0]?.UserData?.Played).toBe(true);
      folders[0]!.Locations = ['/media/reconfigured-root'];
      await expect(client.destinationItems('alice', [candidate])).rejects.toBeInstanceOf(
        CatalogChangedError,
      );
      expect(configurationReads).toBe(2);
      expect(candidateReads).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('uses one canonical binding across response order and GUID spelling without normalizing paths', async () => {
    const candidate = catalog(1)[0]!;
    const folders = [...fixtureVirtualFolders].reverse().map((folder) => ({
      ...folder,
      ItemId: folder.ItemId.replace(
        /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
        '$1-$2-$3-$4-$5',
      ).toUpperCase(),
    }));
    const calls: string[] = [];
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const path = new URL(address).pathname;
        calls.push(path);
        if (path === '/Users/alice') return json(user());
        if (path === '/Library/VirtualFolders') return json(folders);
        return json({ Items: [{ ...candidate, UserData: { Played: false } }] });
      },
    });
    try {
      expect(
        (await client.destinationItems('alice', [candidate]))[0]?.JellyportLibraryConfigHash,
      ).toBe(fixtureConfigHash);
      expect(calls).toEqual(['/Users/alice', '/Library/VirtualFolders', '/Users/alice/Items']);
      folders[0]!.Locations = folders[0]!.Locations.map((path) => path.toUpperCase());
      await expect(client.destinationItems('alice', [candidate])).rejects.toThrow(
        /configuration changed/,
      );
    } finally {
      await client.close();
    }
  });

  it.each([undefined, null])(
    'does not trust a membership hint without its configuration binding (%j)',
    async (hash) => {
      const candidate = { ...catalog(1)[0]!, JellyportLibraryConfigHash: hash } as MediaItem;
      const calls: string[] = [];
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async (address) => {
          const path = new URL(address).pathname;
          calls.push(path);
          return path === '/Users/alice' ? json(user()) : json({}, 404);
        },
      });
      try {
        expect(await client.destinationItems('alice', [candidate])).toEqual([]);
        expect(calls).toEqual(['/Users/alice', '/UserItems/movie-0/UserData']);
      } finally {
        await client.close();
      }
    },
  );

  it.each(['invalid', 'a'.repeat(63), 123])(
    'rejects malformed trusted configuration bindings before requests (%j)',
    async (hash) => {
      const transport = vi.fn(async () => json(user()));
      const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
      try {
        await expect(
          client.destinationItems('alice', [
            { ...catalog(1)[0]!, JellyportLibraryConfigHash: hash } as MediaItem,
          ]),
        ).rejects.toThrow(/configuration metadata/);
        expect(transport).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );

  it.each([
    ['object response', {}],
    ['missing logical ID', [{ Locations: ['/media'] }]],
    ['malformed logical ID', [{ ItemId: 'bad', Locations: ['/media'] }]],
    ['missing locations', [{ ItemId: 'a'.repeat(32) }]],
    ['duplicate logical ID', [fixtureVirtualFolders[0], fixtureVirtualFolders[0]]],
    [
      'excessive libraries',
      Array.from({ length: 1001 }, (_, index) => ({
        ItemId: index.toString(16).padStart(32, '0'),
        Locations: [],
      })),
    ],
    [
      'excessive locations',
      [
        {
          ItemId: 'a'.repeat(32),
          Locations: Array.from({ length: 1001 }, (_, index) => '/media/' + index),
        },
      ],
    ],
    ['oversized location', [{ ItemId: 'a'.repeat(32), Locations: ['x'.repeat(16_385)] }]],
    ['control characters', [{ ItemId: 'a'.repeat(32), Locations: ['/media\nprivate'] }]],
  ])('fails closed on invalid fresh library configuration: %s', async (_label, folders) => {
    const calls: string[] = [];
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const path = new URL(address).pathname;
        calls.push(path);
        return path === '/Users/alice' ? json(user()) : json(folders);
      },
    });
    try {
      await expect(client.destinationItems('alice', catalog(1))).rejects.toThrow(
        /library configuration/,
      );
      expect(calls).toEqual(['/Users/alice', '/Library/VirtualFolders']);
    } finally {
      await client.close();
    }
  });

  it('excludes confirmed unavailable libraries before the permissive explicit-ID batch', async () => {
    const candidates = catalog(3);
    candidates[1]!.JellyportLibraryIds = ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
    delete candidates[2]!.JellyportLibraryIds;
    const calls: URL[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        calls.push(url);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname === '/UserItems/movie-1/UserData') return json({}, 404);
        if (url.pathname === '/UserItems/movie-2/UserData') return json({ Played: false });
        expect(url.pathname).toBe('/Users/alice/Items');
        expect(url.searchParams.has('ParentId')).toBe(false);
        expect(url.searchParams.has('Recursive')).toBe(false);
        // Model actual Jellyfin: explicit IDs ignore parent/view scoping. Every
        // requested ID is returned, including forbidden ones if the caller errs.
        const ids = url.searchParams.get('Ids')!.split(',');
        expect(ids).toEqual(['movie-0', 'movie-2']);
        return json({
          Items: ids.map((id) => ({
            ...candidates.find((item) => item.Id === id),
            UserData: { Played: true },
          })),
        });
      },
    });
    try {
      expect((await client.destinationItems('alice', candidates)).map((item) => item.Id)).toEqual([
        'movie-0',
        'movie-2',
      ]);
      expect(calls).toHaveLength(4);
      expect(calls.filter((url) => url.pathname === '/Users/alice/Items')).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('confirms predicted denials instead of excluding valid items using stale backup membership', async () => {
    const candidate = {
      ...catalog(1)[0]!,
      JellyportLibraryIds: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    };
    const calls: string[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const path = new URL(address).pathname;
        calls.push(path);
        if (path === '/Users/alice') return json(user());
        if (path.endsWith('/UserData')) return json({ Played: false });
        return json({ Items: [{ ...candidate, UserData: { Played: true } }] });
      },
    });
    try {
      expect((await client.destinationItems('alice', [candidate]))[0]?.UserData?.Played).toBe(true);
      expect(calls).toEqual(['/Users/alice', '/UserItems/movie-0/UserData', '/Users/alice/Items']);
    } finally {
      await client.close();
    }
  });

  it.each([
    [{ EnableAllFolders: true }, ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']],
    [
      { EnableAllFolders: false, EnabledFolders: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
      ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ],
    // A nonempty blocked list overrides both EnableAllFolders and EnabledFolders.
    [
      {
        EnableAllFolders: false,
        EnabledFolders: [],
        BlockedMediaFolders: ['cccccccccccccccccccccccccccccccc'],
      },
      ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ],
    [{ EnableAllFolders: false, EnabledFolders: [] }, []],
  ])('uses exact folder policy and permits any allowed association (%j)', async (policy, ids) => {
    const candidate = { ...catalog(1)[0]!, JellyportLibraryIds: ids };
    const calls: string[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const path = new URL(address).pathname;
        calls.push(path);
        return path === '/Users/alice'
          ? json(user(policy))
          : json({ Items: [{ ...candidate, UserData: {} }] });
      },
    });
    try {
      expect(await client.destinationItems('alice', [candidate])).toHaveLength(1);
      expect(calls).toEqual(['/Users/alice', '/Users/alice/Items']);
    } finally {
      await client.close();
    }
  });

  it('refreshes policy during independent readback and does not trust membership from remote DTOs', async () => {
    const candidate = catalog(1)[0]!;
    let checks = 0,
      policyReads = 0;
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const path = new URL(address).pathname;
        if (path === '/Users/alice')
          return json(user(++policyReads === 1 ? {} : { EnabledFolders: [] }));
        if (path.endsWith('/UserData')) {
          checks++;
          return json({}, 404);
        }
        return json({
          Items: [{ ...candidate, JellyportLibraryIds: ['forged-library'], UserData: {} }],
        });
      },
    });
    try {
      const first = await client.destinationItems('alice', [candidate]);
      expect(first[0]?.JellyportLibraryIds).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
      expect(await client.destinationItems('alice', [candidate])).toEqual([]);
      expect(policyReads).toBe(2);
      expect(checks).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('rejects excessive unresolved membership before any per-item checks or batch reads', async () => {
    const candidates = catalog(MAX_DESTINATION_ACCESS_CHECKS + 1).map(
      ({ JellyportLibraryIds: _, ...item }) => item,
    );
    const transport = vi.fn(async () => json(user()));
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', { transport });
    try {
      await expect(client.destinationItems('alice', candidates)).rejects.toThrow(
        /fresh Jellyfin matching backup/,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it.each([null, 'wrong', ['invalid,id'], ['same', 'same']])(
    'rejects invalid trusted membership before calling Jellyfin (%j)',
    async (ids) => {
      const transport = vi.fn(async () => json(user()));
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', { transport });
      try {
        await expect(
          client.destinationItems('alice', [
            { ...catalog(1)[0]!, JellyportLibraryIds: ids } as MediaItem,
          ]),
        ).rejects.toThrow(/membership/);
        expect(transport).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );

  it.each([
    {},
    { EnableAllFolders: 'true' },
    { EnableAllFolders: true, BlockedMediaFolders: 'invalid' },
  ])('rejects malformed fresh access policy (%j)', async (policy) => {
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async () => json({ ...user(), Policy: policy }),
    });
    try {
      await expect(client.destinationItems('alice', catalog(1))).rejects.toThrow(/access policy/);
    } finally {
      await client.close();
    }
  });

  it('bounds exact access checks to four workers and observes requests without IDs or personal state', async () => {
    const candidates = catalog(12).map(({ JellyportLibraryIds: _, ...item }) => item);
    let active = 0,
      maximum = 0,
      checks = 0;
    const events: DestinationReadEvent[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'fixture-secret', 'jellyfin', {
      observeRead: (event) => events.push(event),
      transport: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname.endsWith('/UserData')) {
          active++;
          checks++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
          return json({ Played: false });
        }
        return json({ Items: candidates.map((item) => ({ ...item, UserData: {} })) });
      },
    });
    try {
      expect(await client.destinationItems('alice', candidates)).toHaveLength(12);
      expect(checks).toBe(12);
      expect(maximum).toBe(4);
      expect(active).toBe(0);
      expect(events.filter((event) => event.operation === 'user_access')).toHaveLength(14);
      expect(JSON.stringify(events)).not.toMatch(/fixture-secret|alice|movie-|Played/);
    } finally {
      await client.close();
    }
  });

  it('aborts and drains every exception worker on a non-404 failure', async () => {
    const candidates = catalog(4).map(({ JellyportLibraryIds: _, ...item }) => item);
    const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
    const calls: string[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address, init) => {
        const path = new URL(address).pathname;
        calls.push(path);
        if (path === '/Users/alice') return json(user());
        return new Promise<Response>((resolve) => pending.push({ resolve, signal: init.signal! }));
      },
    });
    const read = client.destinationItems('alice', candidates);
    const rejected = expect(read).rejects.toThrow(/HTTP 500/);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[0]!.resolve(json({}, 500));
    await rejected;
    expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
    expect(calls).not.toContain('/Users/alice/Items');
    for (const entry of pending.slice(1)) entry.resolve(json({ Played: false }));
    await client.close();
  });

  it('cancels exact access checks promptly without starting candidate reads', async () => {
    const candidates = catalog(4).map(({ JellyportLibraryIds: _, ...item }) => item);
    let started!: () => void;
    const active = new Promise<void>((resolve) => (started = resolve));
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        if (new URL(address).pathname === '/Users/alice') return json(user());
        started();
        return new Promise<Response>(() => {});
      },
    });
    const read = client.destinationItems('alice', candidates);
    await active;
    await client.close();
    await expect(read).rejects.toThrow(/canceled/);
  });

  it('enforces one 60-second deadline across the exception phase and drains active reads', async () => {
    const realTimer = setTimeout;
    const clearRealTimer = clearTimeout;
    vi.useFakeTimers();
    const candidates = catalog(1).map(({ JellyportLibraryIds: _, ...item }) => item);
    let started = false;
    let adapterStarted!: () => void;
    const active = new Promise<void>((resolve) => {
      adapterStarted = resolve;
    });
    let startDeadline: ReturnType<typeof setTimeout> | undefined;
    let candidateReads = 0;
    let signal: AbortSignal | undefined;
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      timeoutMs: 60_000,
      transport: async (address, init) => {
        const path = new URL(address).pathname;
        if (path === '/Users/alice') return json(user());
        if (path === '/Users/alice/Items') candidateReads++;
        started = true;
        signal = init.signal!;
        adapterStarted();
        return new Promise<Response>(() => {});
      },
    });
    const outcome = client.destinationItems('alice', candidates).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      // Real node:timers/promises yields must reach the adapter before the mocked
      // phase clock advances. Synchronize with that event, not a scheduling delay.
      await Promise.race([
        active,
        new Promise<never>((_resolve, reject) => {
          startDeadline = realTimer(
            () => reject(new Error('The synthetic access adapter did not start.')),
            2000,
          );
        }),
      ]);
      clearRealTimer(startDeadline);
      expect(started).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toMatchObject({
        message: expect.stringMatching(/60-second safety limit/),
      });
      expect(signal?.aborted).toBe(true);
      expect(candidateReads).toBe(0);
    } finally {
      clearRealTimer(startDeadline);
      await client.close();
      await outcome;
      vi.useRealTimers();
    }
  });

  it('retains bounded GET backoff within exact access checks and accounts for every attempt', async () => {
    const candidate = { ...catalog(1)[0]!, JellyportLibraryIds: undefined };
    const sleep = vi.fn(async () => {});
    const events: DestinationReadEvent[] = [];
    let checks = 0;
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      sleep,
      observeRead: (event) => events.push(event),
      transport: async (address) => {
        const path = new URL(address).pathname;
        if (path === '/Users/alice') return json(user());
        if (path.endsWith('/UserData'))
          return ++checks === 1 ? json({}, 503, { 'Retry-After': '0.2' }) : json({ Played: false });
        return json({ Items: [{ ...candidate, UserData: { Played: true } }] });
      },
    });
    try {
      expect(await client.destinationItems('alice', [candidate])).toHaveLength(1);
      expect(checks).toBe(2);
      expect(sleep.mock.calls).toEqual([[200]]);
      expect(events.map(({ operation, attempts }) => [operation, attempts])).toEqual([
        ['user_access', 1],
        ['user_access', 1],
        ['user_access', 2],
        ['user_state', 1],
      ]);
    } finally {
      await client.close();
    }
  });

  it.each([{}, { Played: 'false' }, { Played: false, ItemId: 'different-item' }])(
    'fails closed on invalid exact access state before any batch read (%j)',
    async (data) => {
      const candidate = { ...catalog(1)[0]!, JellyportLibraryIds: undefined };
      const calls: string[] = [];
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async (address) => {
          const path = new URL(address).pathname;
          calls.push(path);
          return path === '/Users/alice' ? json(user()) : json(data);
        },
      });
      try {
        await expect(client.destinationItems('alice', [candidate])).rejects.toThrow(/access-check/);
        expect(calls).not.toContain('/Users/alice/Items');
      } finally {
        await client.close();
      }
    },
  );

  it('uses destination-only 170-GUID batches within the encoded request bound', async () => {
    const candidates = catalog(171).map((item, index) => ({
      ...item,
      Id: index.toString(16).padStart(32, '0'),
    }));
    const byId = new Map(candidates.map((item) => [item.Id, item]));
    const batches: string[][] = [];
    const client = clientWithPolicy('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        const ids = url.searchParams.get('Ids')!.split(',');
        batches.push(ids);
        expect(Number(url.searchParams.get('Limit'))).toBe(ids.length);
        expect(url.searchParams.has('StartIndex')).toBe(false);
        expect(url.searchParams.has('SortBy')).toBe(false);
        return json({ Items: ids.map((id) => ({ ...byId.get(id), UserData: { Played: false } })) });
      },
    });
    try {
      expect(await client.destinationItems('alice', candidates)).toHaveLength(171);
      expect(batches.map((batch) => batch.length)).toEqual([170, 1]);
      expect(encodeURIComponent(batches[0]!.join(',')).length).toBe(5947);
      expect(new Set(batches.flat()).size).toBe(171);
    } finally {
      await client.close();
    }
  });

  it('recovers a grouped accessible version at the 170-item bound with one exact check and singleton', async () => {
    const candidates = catalog(171);
    // Two physical versions share presentation/provider identity. Like the pinned
    // API, this fixture ignores ParentId for explicit IDs and groups only a batch.
    candidates[169]!.ProviderIds = { ...candidates[0]!.ProviderIds };
    const byId = new Map(candidates.map((item) => [item.Id, item]));
    const batches: string[][] = [];
    const access: string[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname.startsWith('/UserItems/')) {
          access.push(url.pathname);
          expect(url.searchParams.get('userId')).toBe('alice');
          return json({ ItemId: candidates[169]!.Id, Played: true });
        }
        const ids = url.searchParams.get('Ids')!.split(',');
        batches.push(ids);
        return json({
          Items: ids
            .filter((id) => ids.length === 1 || id !== candidates[169]!.Id)
            .map((id) => ({
              ...byId.get(id),
              UserData: {
                Played: id === candidates[169]!.Id,
                PlayCount: 7,
                PlaybackPositionTicks: 91,
              },
            })),
        });
      },
    });
    try {
      const result = await client.destinationItems('alice', candidates);
      expect(result).toHaveLength(171);
      expect(new Set(result.map((item) => item.Id)).size).toBe(171);
      expect(batches.map((batch) => batch.length)).toEqual([170, 1, 1]);
      expect(access).toEqual(['/UserItems/movie-169/UserData']);
      expect(result.find((item) => item.Id === candidates[169]!.Id)).toEqual({
        ...candidates[169],
        UserData: { Played: true, PlayCount: 7, PlaybackPositionTicks: 91 },
      });
    } finally {
      await client.close();
    }
  });

  it('excludes an omitted item only after its exact access check returns 404', async () => {
    const candidates = catalog(2);
    const calls: string[] = [];
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        calls.push(url.pathname);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname.startsWith('/UserItems/')) return json({}, 404);
        return json({ Items: [{ ...candidates[0], UserData: { Played: false } }] });
      },
    });
    try {
      expect((await client.destinationItems('alice', candidates)).map((item) => item.Id)).toEqual([
        candidates[0]!.Id,
      ]);
      expect(calls).toEqual(['/Users/alice', '/Users/alice/Items', '/UserItems/movie-1/UserData']);
    } finally {
      await client.close();
    }
  });

  it.each([
    ['still omitted', { Items: [] }, 200, /confirmed item access but omitted/],
    [
      'foreign identifier',
      { Items: [{ ...catalog(1)[0], Id: 'foreign', UserData: {} }] },
      200,
      /unexpected/,
    ],
    [
      'changed identity',
      { Items: [{ ...catalog(1)[0], Path: '/changed', UserData: {} }] },
      200,
      /identities changed/,
    ],
    ['missing state', { Items: [catalog(1)[0]] }, 200, /valid data object/],
    ['singleton 404', {}, 404, /HTTP 404/],
  ])(
    'fails closed after confirmed access when the singleton is %s',
    async (_label, response, status, message) => {
      let batches = 0;
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async (address) => {
          const url = new URL(address);
          if (url.pathname === '/Users/alice') return json(user());
          if (url.pathname.startsWith('/UserItems/')) return json({ Played: false });
          return ++batches === 1 ? json({ Items: [] }) : json(response, status);
        },
      });
      try {
        await expect(client.destinationItems('alice', catalog(1))).rejects.toThrow(message);
        expect(batches).toBe(_label === 'still omitted' ? 4 : 2);
      } finally {
        await client.close();
      }
    },
  );

  it.each([
    ['Movie', false],
    ['Episode', true],
    ['Series', false],
    ['Season', true],
    ['Audio', false],
    ['MusicAlbum', true],
    ['MusicArtist', false],
    ['MusicVideo', true],
    ['Video', false],
    ['Book', true],
    ['AudioBook', false],
    ['Photo', true],
    ['PhotoAlbum', false],
    ['BoxSet', true],
    ['Trailer', false],
  ])('recovers a hidden owned/alternate %s with HasSubtitles=%s', async (type, subtitles) => {
    const candidate = { ...catalog(1)[0]!, Type: type };
    const filters: (string | null)[] = [];
    let accessChecks = 0;
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname.startsWith('/UserItems/')) {
          accessChecks++;
          return json({ Played: true });
        }
        const filter = url.searchParams.get('HasSubtitles');
        filters.push(filter);
        expect(url.searchParams.get('Ids')).toBe(candidate.Id);
        expect(url.searchParams.get('Limit')).toBe('1');
        expect(url.pathname).toBe('/Users/alice/Items');
        // The actual API hides this version in both ordinary explicit-ID calls;
        // a complementary stream filter enables owned versions without refreshing.
        return json({
          Items:
            filter === String(subtitles)
              ? [{ ...candidate, UserData: { Played: true, PlayCount: 9 } }]
              : [],
        });
      },
    });
    try {
      expect(await client.destinationItems('alice', [candidate])).toEqual([
        { ...candidate, UserData: { Played: true, PlayCount: 9 } },
      ]);
      expect(accessChecks).toBe(1);
      expect(filters).toEqual(subtitles ? [null, null, 'false', 'true'] : [null, null, 'false']);
    } finally {
      await client.close();
    }
  });

  it.each([
    ['invalid page', {}, /invalid destination candidate page/],
    [
      'duplicate page',
      {
        Items: [
          { ...catalog(1)[0], UserData: {} },
          { ...catalog(1)[0], UserData: {} },
        ],
      },
      /invalid destination candidate page/,
    ],
    ['foreign ID', { Items: [{ ...catalog(1)[0], Id: 'foreign', UserData: {} }] }, /unexpected/],
    [
      'changed identity',
      { Items: [{ ...catalog(1)[0], Path: '/changed', UserData: {} }] },
      /identities changed/,
    ],
    ['missing state', { Items: [catalog(1)[0]] }, /valid data object/],
    ['invalid state', { Items: [{ ...catalog(1)[0], UserData: { Played: 'yes' } }] }, /boolean/],
  ])(
    'rejects a filtered singleton with %s instead of trying the other partition',
    async (_label, response, message) => {
      const filters: (string | null)[] = [];
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async (address) => {
          const url = new URL(address);
          if (url.pathname === '/Users/alice') return json(user());
          if (url.pathname.startsWith('/UserItems/')) return json({ Played: false });
          const filter = url.searchParams.get('HasSubtitles');
          filters.push(filter);
          return filter === 'false' ? json(response) : json({ Items: [] });
        },
      });
      try {
        await expect(client.destinationItems('alice', catalog(1))).rejects.toThrow(message);
        expect(filters).toEqual([null, null, 'false']);
      } finally {
        await client.close();
      }
    },
  );

  it.each([false, true])(
    'bounds transient filtered-singleton retries (eventual success=%s)',
    async (success) => {
      const candidate = catalog(1)[0]!;
      let attempts = 0;
      const sleep = vi.fn(async () => {});
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
        sleep,
        transport: async (address) => {
          const url = new URL(address);
          if (url.pathname === '/Users/alice') return json(user());
          if (url.pathname.startsWith('/UserItems/')) return json({ Played: false });
          const filter = url.searchParams.get('HasSubtitles');
          if (filter === null) return json({ Items: [] });
          expect(filter).toBe('false');
          if (++attempts < 3 || !success) return json({}, 503);
          return json({ Items: [{ ...candidate, UserData: { Played: false } }] });
        },
      });
      try {
        if (success) expect(await client.destinationItems('alice', [candidate])).toHaveLength(1);
        else
          await expect(client.destinationItems('alice', [candidate])).rejects.toThrow(/HTTP 503/);
        expect(attempts).toBe(3);
        expect(sleep).toHaveBeenCalledTimes(2);
      } finally {
        await client.close();
      }
    },
  );

  it('stops oversized omission recovery before any exact item checks', async () => {
    let checks = 0;
    let batches = 0;
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname.startsWith('/UserItems/')) {
          checks++;
          return json({ Played: false });
        }
        batches++;
        return json({ Items: [] });
      },
    });
    try {
      await expect(
        client.destinationItems('alice', catalog(MAX_DESTINATION_ACCESS_CHECKS + 1)),
      ).rejects.toThrow(/omitted too many/);
      expect(checks).toBe(0);
      expect(batches).toBe(13);
    } finally {
      await client.close();
    }
  });

  it('shares the 2048-item budget between unknown memberships and later batch omissions', async () => {
    const unknown = catalog(MAX_DESTINATION_ACCESS_CHECKS).map((item) => ({
      ...item,
      JellyportLibraryIds: undefined,
    }));
    const known = { ...catalog(1)[0]!, Id: 'known-but-omitted' };
    let checks = 0;
    let batches = 0;
    const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/Users/alice') return json(user());
        if (url.pathname.startsWith('/UserItems/')) {
          checks++;
          return json({}, 404);
        }
        batches++;
        return json({ Items: [] });
      },
    });
    try {
      await expect(client.destinationItems('alice', [...unknown, known])).rejects.toThrow(
        /omitted too many/,
      );
      expect(checks).toBe(MAX_DESTINATION_ACCESS_CHECKS);
      expect(batches).toBe(1);
    } finally {
      await client.close();
    }
  });

  it.each(['access', 'singleton', 'without-subtitles', 'with-subtitles'])(
    'cancels and drains an active omitted-item %s read',
    async (phase) => {
      let signal: AbortSignal | undefined;
      let batches = 0;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const client = clientWithLibraries('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async (address, init) => {
          const url = new URL(address);
          if (url.pathname === '/Users/alice') return json(user());
          if (url.pathname.startsWith('/UserItems/')) {
            if (phase !== 'access') return json({ Played: false });
          } else {
            batches++;
            if (
              batches === 1 ||
              (batches === 2 && phase !== 'singleton') ||
              (batches === 3 && phase === 'with-subtitles')
            )
              return json({ Items: [] });
          }
          signal = init?.signal as AbortSignal;
          started();
          return new Promise<Response>(() => {});
        },
      });
      const outcome = client.destinationItems('alice', catalog(1)).then(
        () => undefined,
        (error: unknown) => error,
      );
      await pending;
      await client.close();
      expect(await outcome).toBeInstanceOf(Error);
      expect(String(await outcome)).toMatch(/canceled/);
      expect(signal?.aborted).toBe(true);
      expect(batches).toBe(
        { access: 1, singleton: 2, 'without-subtitles': 3, 'with-subtitles': 4 }[phase],
      );
    },
  );

  it('reads a large candidate set once in bounded batches without enumerating the user library', async () => {
    const candidates = catalog(10_001);
    const byId = new Map(candidates.map((item) => [item.Id, item]));
    const calls: URL[] = [];
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async (address) => {
        const url = new URL(address);
        calls.push(url);
        expect(url.pathname).toBe('/Users/alice/Items');
        for (const field of [
          'Recursive',
          'ParentId',
          'SortBy',
          'SortOrder',
          'StartIndex',
          'IncludeItemTypes',
        ])
          expect(url.searchParams.has(field)).toBe(false);
        expect(url.searchParams.get('EnableUserData')).toBe('true');
        expect(url.searchParams.get('EnableImages')).toBe('false');
        expect(url.searchParams.get('EnableTotalRecordCount')).toBe('false');
        expect(url.searchParams.get('Fields')).toBe('ProviderIds,Path');
        const ids = url.searchParams.get('Ids')!.split(',');
        expect(ids.length).toBeLessThanOrEqual(MAX_DESTINATION_BATCH_IDS);
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
      expect(calls).toHaveLength(59);
      expect(new Set(calls.flatMap((url) => url.searchParams.get('Ids')!.split(','))).size).toBe(
        candidates.length,
      );
      expect(items[0]?.UserData).toEqual({ Played: false });
    } finally {
      await client.close();
    }
  });

  it('retains unplayed and empty accessible states, omits exact-check unavailable IDs', async () => {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
      JellyportLibraryIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      JellyportLibraryConfigHash: fixtureConfigHash,
    };
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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

  it('reuses already-read parent names for episode review without extra API requests', async () => {
    const shared = {
      JellyportLibraryIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      JellyportLibraryConfigHash: fixtureConfigHash,
    };
    const candidates: MediaItem[] = [
      {
        Id: 'episode',
        Type: 'Episode',
        Name: 'Synthetic pilot',
        SeriesId: 'series',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        SeriesProviderIds: { Tvdb: '42' },
        ...shared,
      },
      {
        Id: 'series',
        Type: 'Series',
        Name: 'Cached show name',
        ProviderIds: { Tvdb: '42' },
        ...shared,
      },
    ];
    const reads = vi.fn(async () =>
      json({
        Items: candidates.map((candidate) => ({
          ...candidate,
          ...(candidate.Type === 'Series' ? { Name: 'Current show name' } : {}),
          UserData: { Played: false },
        })),
      }),
    );
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: reads,
    });
    try {
      const items = await client.destinationItems('alice', candidates);
      expect(items.find((item) => item.Id === 'episode')).toMatchObject({
        SeriesName: 'Current show name',
        UserData: { Played: false },
      });
      expect(reads).toHaveBeenCalledTimes(1);
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => json({ Items: repeat ? [value, value] : [value] }),
    });
    try {
      await expect(client.destinationItems('alice', catalog(2))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it('bounds encoded IDs and confirms deleted/inaccessible batch omissions', async () => {
    const candidates = catalog(40).map((item, index) => ({
      ...item,
      Id: `${'😀'.repeat(30)}-${index}`,
    }));
    const batches: string[][] = [];
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({ attempts: 3, items: 1, outcome: 'completed' });
    } finally {
      await client.close();
    }
  });

  it('cancels between bounded pages before starting another API call', async () => {
    const candidates = catalog(171);
    let calls = 0;
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
      transport: async () => {
        calls++;
        setTimeout(() => void client.close(), 0);
        return json({
          Items: candidates.slice(0, 170).map((item) => ({ ...item, UserData: {} })),
        });
      },
    });
    await expect(client.destinationItems('alice', candidates)).rejects.toThrow(/canceled/);
    expect(calls).toBe(1);
  });

  it('bounds an active candidate request with the configured read timeout', async () => {
    const transport = vi.fn(async () => new Promise<Response>(() => {}));
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-secret', 'jellyfin', {
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
      expect(events).toHaveLength(5);
      expect(events.map(({ operation, items }) => [operation, items])).toEqual([
        ['catalog', 1],
        ['catalog', 0],
        ['user_access', 0],
        ['user_access', 3],
        ['user_state', 1],
      ]);
      for (const event of events) {
        expect(event).toEqual({
          event: 'destination_read',
          operation: expect.stringMatching(/catalog|user_access|user_state/),
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
    const failed = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    const canceled = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
    expect(events.map((event) => event.outcome)).toEqual([
      'completed',
      'completed',
      'failed',
      'completed',
      'completed',
      'canceled',
    ]);
    expect(
      events
        .filter((event) => event.operation === 'user_state')
        .every((event) => event.items === 0),
    ).toBe(true);
    expect(events.map((event) => event.attempts)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('counts overlapping request attempts separately for each operation', async () => {
    const candidate = catalog(1)[0]!;
    const events: DestinationReadEvent[] = [];
    const attempts = new Map<string, number>();
    const client = clientWithPolicy('http://jellyfin.test', 'fixture-key', 'jellyfin', {
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
      expect(events.map((event) => event.attempts).sort()).toEqual([1, 1, 1, 1, 1, 2]);
      expect(
        events
          .filter((event) => event.operation === 'user_state')
          .every((event) => event.items === 1 && event.outcome === 'completed'),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
