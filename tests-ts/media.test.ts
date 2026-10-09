import { describe, expect, it, vi } from 'vitest';
import { MediaClient, type FetchTransport, type MediaUserDataPatch } from '../server/media.js';
import { MediaError } from '../server/errors.js';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
describe('media API boundary', () => {
  it('filters quick source reads to watched playable items and enriches episodes from unfiltered series', async () => {
    const requests: URL[] = [];
    const movies = [
      { Id: 'e1', Type: 'Episode', SeriesId: 's1', UserData: { Played: true } },
      { Id: 'm1', Type: 'Movie', UserData: { Played: true } },
      { Id: 'e2', Type: 'Episode', SeriesId: 's1', UserData: { Played: true } },
    ];
    const client = new MediaClient('http://emby.test', 'synthetic-key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        requests.push(url);
        expect(url.pathname).toBe('/Users/alice/Items');
        expect(url.searchParams.get('EnableUserData')).toBe('true');
        if (url.searchParams.get('IncludeItemTypes') === 'Series') {
          expect(url.searchParams.has('IsPlayed')).toBe(false);
          return json({ Items: [{ Id: 's1', ProviderIds: { Tvdb: '42' } }], TotalRecordCount: 1 });
        }
        expect(url.searchParams.get('IsPlayed')).toBe('true');
        expect(url.searchParams.get('IncludeItemTypes')).toBe(
          'Movie,Episode,Audio,MusicVideo,Video,Book,AudioBook,Trailer',
        );
        expect(url.searchParams.get('Fields')).toContain('UserDataLastPlayedDate');
        const start = Number(url.searchParams.get('StartIndex'));
        return json({
          Items: movies.slice(start, start + 2),
          TotalRecordCount: start === 0 ? 3 : 0,
        });
      },
    });
    client.pageSize = 2;
    try {
      const items = await client.watchedItems('alice');
      expect(items.map((item) => item.Id)).toEqual(['e1', 'm1', 'e2']);
      expect(items[0]?.SeriesProviderIds).toEqual({ Tvdb: '42' });
      expect(items[2]?.SeriesProviderIds).toEqual({ Tvdb: '42' });
      expect(requests).toHaveLength(3);
    } finally {
      await client.close();
    }
  });
  it('uses user-scoped pagination and enriches episode series identity', async () => {
    const requests: URL[] = [];
    const transport: FetchTransport = async (address, init) => {
      const url = new URL(address);
      requests.push(url);
      expect(init.headers).toMatchObject({ 'X-Emby-Token': 'secret-token' });
      expect(address).not.toContain('secret-token');
      expect(url.pathname).toBe('/emby/Users/alice/Items');
      expect(url.searchParams.get('Fields')).toBe('ProviderIds,Path');
      expect(url.searchParams.get('EnableUserData')).toBe('true');
      if (url.searchParams.get('IncludeItemTypes') === 'Series')
        return json({ Items: [{ Id: 's1', ProviderIds: { Tvdb: '42' } }], TotalRecordCount: 1 });
      const values = [
        { Id: 'e1', Type: 'Episode', SeriesId: 's1', UserData: { Played: true } },
        { Id: 'm1', Type: 'Movie', UserData: { Played: false } },
        { Id: 'e2', Type: 'Episode', SeriesId: 's1' },
      ];
      const start = Number(url.searchParams.get('StartIndex'));
      return json({ Items: values.slice(start, start + 2), TotalRecordCount: values.length });
    };
    const client = new MediaClient('http://emby.test/emby/', 'secret-token', 'emby', { transport });
    client.pageSize = 2;
    const items = await client.items('alice');
    await client.close();
    expect(items.map((item) => item.Id)).toEqual(['e1', 'm1', 'e2']);
    expect(items[0]?.SeriesProviderIds).toEqual({ Tvdb: '42' });
    expect(items[2]?.SeriesProviderIds).toEqual({ Tvdb: '42' });
    expect(items[0]?.UserData?.Played).toBe(true);
    expect(items[1]?.UserData?.Played).toBe(false);
    expect(requests).toHaveLength(3);
  });
  it.each([
    ['jellyfin', 'page-size'],
    ['jellyfin', 'zero'],
    ['emby', 'page-size'],
    ['emby', 'zero'],
  ] as const)(
    'counts only the first %s page and ignores later %s totals',
    async (kind, totalMode) => {
      const values = Array.from({ length: 53 }, (_, index) => ({
        Id: `item-${index}`,
        Type: 'Movie',
        UserData: { PlayCount: index, LastPlayedDate: '2026-10-01T12:00:00.000Z' },
      }));
      const seen: URL[] = [];
      const client = new MediaClient(`http://${kind}.test`, 'synthetic-key', kind, {
        transport: async (address) => {
          const url = new URL(address);
          seen.push(url);
          const start = Number(url.searchParams.get('StartIndex'));
          const page = values.slice(start, start + 3);
          return json({
            Items: page,
            TotalRecordCount: start === 0 ? values.length : totalMode === 'zero' ? 0 : page.length,
          });
        },
      });
      client.pageSize = 3;
      try {
        expect(await client.migrationItems('alice')).toEqual(values);
        expect(seen).toHaveLength(18);
        expect(seen.map((url) => url.searchParams.get('EnableTotalRecordCount'))).toEqual([
          'true',
          ...Array(17).fill('false'),
        ]);
        expect(seen.every((url) => url.pathname === '/Users/alice/Items')).toBe(true);
        expect(seen.every((url) => url.searchParams.get('EnableUserData') === 'true')).toBe(true);
      } finally {
        await client.close();
      }
    },
  );
  it.each([undefined, 0, -1, '9'])(
    'reads until an empty page when the initial total is unusable (%j)',
    async (initialTotal) => {
      const values = Array.from({ length: 9 }, (_, index) => ({
        Id: `item-${index}`,
        Type: 'Movie',
      }));
      const starts: number[] = [];
      const client = new MediaClient('http://jellyfin.test', 'synthetic-key', 'jellyfin', {
        transport: async (address) => {
          const url = new URL(address);
          const start = Number(url.searchParams.get('StartIndex'));
          starts.push(start);
          // A server may clamp Limit below our request even before the final page.
          return json({
            Items: values.slice(start, start + 2),
            ...(start === 0 && initialTotal !== undefined
              ? { TotalRecordCount: initialTotal }
              : start === 0
                ? {}
                : { TotalRecordCount: 0 }),
          });
        },
      });
      client.pageSize = 5;
      try {
        expect(await client.migrationItems('alice')).toEqual(values);
        expect(starts).toEqual([0, 2, 4, 6, 8, 9]);
      } finally {
        await client.close();
      }
    },
  );
  it('preserves creation, template, configuration, password and played endpoint contracts', async () => {
    const seen: unknown[] = [];
    const client = new MediaClient('http://jellyfin.test/base', 'key', 'jellyfin', {
      transport: async (url, init) => {
        const pathname = new URL(url).pathname,
          body = init.body ? JSON.parse(String(init.body)) : null;
        seen.push([init.method, pathname, body]);
        return pathname.endsWith('/Users/New')
          ? json({ Id: 'new-user', Name: body.Name, HasPassword: true })
          : new Response(null, { status: 204 });
      },
    });
    const user = await client.createUser('Alice', 'generated-pass');
    await client.setPolicy(user.Id, { IsAdministrator: false, EnableAllFolders: true });
    await client.setConfiguration(user.Id, { AudioLanguagePreference: 'eng' });
    await client.setPassword(user.Id, 'replacement-pass');
    await client.markPlayed(user.Id, 'movie-1');
    await client.close();
    expect(seen).toEqual([
      ['POST', '/base/Users/New', { Name: 'Alice', Password: 'generated-pass' }],
      ['POST', '/base/Users/new-user/Policy', { IsAdministrator: false, EnableAllFolders: true }],
      ['POST', '/base/Users/new-user/Configuration', { AudioLanguagePreference: 'eng' }],
      [
        'POST',
        '/base/Users/new-user/Password',
        { CurrentPw: '', NewPw: 'replacement-pass', ResetPassword: false },
      ],
      ['POST', '/base/Users/new-user/PlayedItems/movie-1', null],
    ]);
  });
  it('encodes identifiers without adding query parameters', async () => {
    let request = '';
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (url) => {
        request = url;
        return json({ Id: 'user', Name: 'alice' });
      },
    });
    await client.user('alice/?api_key=stolen#x');
    await client.close();
    expect(new URL(request).search).toBe('');
    expect(request).toContain('alice%2F%3Fapi_key%3Dstolen%23x');
  });
  it('reads and writes account display preferences only through the fixed web namespace', async () => {
    const seen: Array<{
      method: string;
      pathname: string;
      query: Record<string, string>;
      body: unknown;
    }> = [];
    const client = new MediaClient('http://jellyfin.test/base', 'private-key', 'jellyfin', {
      transport: async (address, init) => {
        const url = new URL(address);
        seen.push({
          method: init.method!,
          pathname: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
        expect(address).not.toContain('private-key');
        return init.method === 'GET'
          ? json({ CustomPrefs: { homesection0: 'resume' } })
          : new Response(null, { status: 204 });
      },
    });
    const id = 'user/?client=other#fragment';
    const preferences = await client.displayPreferences(id);
    expect(preferences).toEqual({ CustomPrefs: { homesection0: 'resume' } });
    await client.setDisplayPreferences(id, preferences);
    expect(seen).toEqual([
      {
        method: 'GET',
        pathname: '/base/DisplayPreferences/usersettings',
        query: { userId: id, client: 'emby' },
        body: null,
      },
      {
        method: 'POST',
        pathname: '/base/DisplayPreferences/usersettings',
        query: { userId: id, client: 'emby' },
        body: preferences,
      },
    ]);
    await client.close();
  });
  it('rejects invalid display responses and all Emby display writes before contacting the server', async () => {
    const transport = vi.fn(async () => json([]));
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
    await expect(client.displayPreferences('user')).rejects.toThrow('invalid API response');
    await expect(client.displayPreferences('')).rejects.toThrow('valid media server identifier');
    await expect(
      client.setDisplayPreferences('user', [] as unknown as Record<string, unknown>),
    ).rejects.toThrow('Valid display preferences');
    expect(transport).toHaveBeenCalledTimes(1);
    const emby = new MediaClient('http://emby.test', 'key', 'emby', { transport });
    await expect(emby.setDisplayPreferences('user', {})).rejects.toThrow('only on Jellyfin');
    expect(transport).toHaveBeenCalledTimes(1);
    await client.close();
    await emby.close();
  });
  it('does not retry uncertain display preference mutations', async () => {
    const transport = vi.fn(async () => {
      throw new Error('private-key upstream response');
    });
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
    await expect(client.setDisplayPreferences('user', { CustomPrefs: {} })).rejects.toThrow(
      'operation may have been applied',
    );
    expect(transport).toHaveBeenCalledTimes(1);
    await client.close();
  });
  it('bounds read retries and never retries mutations', async () => {
    const counts: Record<string, number> = { GET: 0, POST: 0 },
      sleeps: number[] = [];
    const client = new MediaClient('http://jellyfin.test', 'secret', 'jellyfin', {
      transport: async (_url, init) => {
        counts[init.method!]++;
        return new Response('upstream-secret-body', {
          status: 503,
          headers: { 'Retry-After': '36000' },
        });
      },
      sleep: async (time) => {
        sleeps.push(time);
      },
    });
    await expect(client.users()).rejects.toMatchObject({
      statusCode: 503,
      message: 'Jellyfin rejected the request (HTTP 503).',
    });
    await expect(client.createUser('Alice', 'password')).rejects.toBeInstanceOf(MediaError);
    await client.close();
    expect(counts).toEqual({ GET: 3, POST: 1 });
    expect(sleeps).toEqual([2000, 2000]);
  });
  it('sanitizes timeout and network errors and labels mutation outcomes uncertain', async () => {
    for (const name of ['TimeoutError', 'Error']) {
      const client = new MediaClient('http://secret-host', 'secret', 'jellyfin', {
        transport: async () => {
          const error = new Error('secret-host?api_key=secret');
          error.name = name;
          throw error;
        },
      });
      await expect(client.createUser('Alice', 'generated-pass')).rejects.toThrow(
        'may have been applied',
      );
      await expect(client.createUser('Alice', 'generated-pass')).rejects.not.toThrow('secret');
      await client.close();
    }
  });
  it('rejects repeated library pages instead of looping', async () => {
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async () => json({ Items: [{ Id: 'one', Type: 'Movie' }], TotalRecordCount: 20 }),
    });
    await expect(client.items()).rejects.toThrow('repeated a library page');
    await client.close();
  });
  it.each([{ not: 'users' }, ['bad'], [{ Id: 'id' }], [{ Id: '', Name: 'name' }]])(
    'rejects malformed user lists: %j',
    async (response) => {
      const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async () => json(response),
      });
      await expect(client.users()).rejects.toThrow('invalid user list');
      await client.close();
    },
  );
  it.each([
    'ftp://host',
    'http://user:password@host',
    'http://host?api_key=secret',
    'http://host/#fragment',
    'http://host:bad',
    'http://host?',
    'http://host#',
  ])('rejects unsafe base URLs without disclosure: %s', (url) => {
    expect(() => new MediaClient(url, 'key')).toThrow(
      'Server URL must be an HTTP(S) address without credentials or query parameters.',
    );
  });
  it('does not follow redirects carrying authentication headers', async () => {
    let calls = 0;
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (_url, init) => {
        calls++;
        expect(init.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://attacker.invalid' },
        });
      },
    });
    await expect(client.users()).rejects.toMatchObject({ statusCode: 302 });
    expect(calls).toBe(1);
    await client.close();
  });
  it.each([{ Items: ['bad'] }, { Items: [{ Name: 'missing Id' }] }, { Items: 'bad' }])(
    'rejects malformed library pages: %j',
    async (data) => {
      const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
        transport: async () => json(data),
      });
      await expect(client.items()).rejects.toBeInstanceOf(MediaError);
      await client.close();
    },
  );
  it('rejects invalid JSON without including response bodies', async () => {
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async () => new Response('secret-invalid-json'),
    });
    await expect(client.systemInfo()).rejects.toThrow('invalid API response');
    await client.close();
  });

  it('rejects declared oversized responses before reading and cancels the body', async () => {
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: canceled });
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      maxResponseBytes: 64,
      transport: async () => new Response(body, { headers: { 'Content-Length': '65' } }),
    });
    await expect(client.users()).rejects.toThrow('exceeds the supported size');
    expect(canceled).toHaveBeenCalledOnce();
    await client.close();
  });

  it.each([undefined, '1'])(
    'bounds chunked responses even with an absent or false length (%s)',
    async (length) => {
      const canceled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"Id":"id","Name":"'));
          controller.enqueue(new TextEncoder().encode('private-response-body'.repeat(20)));
        },
        cancel: canceled,
      });
      const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
        maxResponseBytes: 64,
        transport: async () =>
          new Response(body, { headers: length ? { 'Content-Length': length } : {} }),
      });
      await expect(client.users()).rejects.toThrow('exceeds the supported size');
      expect(canceled).toHaveBeenCalledOnce();
      await client.close();
    },
  );

  it('accepts a valid response at the exact configured byte ceiling', async () => {
    const data = JSON.stringify([{ Id: 'id', Name: 'é' }]);
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      maxResponseBytes: Buffer.byteLength(data),
      transport: async () => new Response(data),
    });
    await expect(client.users()).resolves.toEqual([{ Id: 'id', Name: 'é' }]);
    await client.close();
  });

  it('times out stalled streams and never awaits cancellation that also stalls', async () => {
    const canceled = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('['));
      },
      cancel: canceled,
    });
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      timeoutMs: 25,
      transport: async () => new Response(body),
    });
    await expect(client.users()).rejects.toThrow('Jellyfin request timed out.');
    expect(canceled).toHaveBeenCalledOnce();
    await client.close();
  });

  it('enforces the deadline even when immediate empty chunks would starve timer callbacks', async () => {
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(0));
      },
      cancel: canceled,
    });
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      timeoutMs: 25,
      transport: async () => new Response(body),
    });
    await expect(client.users()).rejects.toThrow('timed out');
    expect(canceled).toHaveBeenCalledOnce();
    await client.close();
  });

  it('bounds transports that ignore abort and cancels their late response', async () => {
    let resolve!: (response: Response) => void;
    const canceled = vi.fn();
    const transport = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      timeoutMs: 25,
      transport,
    });
    await expect(client.createUser('alice', 'private-password')).rejects.toThrow(
      'The operation may have been applied; check before retrying.',
    );
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel: canceled })));
    await Promise.resolve();
    expect(canceled).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    await client.close();
  });

  it('close aborts an active stalled body and prevents any subsequent transport call', async () => {
    const canceled = vi.fn();
    const transport = vi.fn(
      async () => new Response(new ReadableStream<Uint8Array>({ cancel: canceled })),
    );
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      transport,
    });
    const request = client.users();
    const rejected = expect(request).rejects.toThrow('Jellyfin request timed out.');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await client.close();
    await rejected;
    await expect(client.users()).rejects.toThrow('timed out');
    expect(canceled).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('never waits for cancellation on error or retry bodies and sanitizes their contents', async () => {
    const canceled = vi.fn(() => new Promise<void>(() => {}));
    const transport = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('PRIVATE-UPSTREAM-SECRET'));
            },
            cancel: canceled,
          }),
          { status: 503 },
        ),
    );
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      timeoutMs: 100,
      transport,
      sleep: async () => {},
    });
    await expect(client.users()).rejects.toMatchObject({
      statusCode: 503,
      message: 'Jellyfin rejected the request (HTTP 503).',
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(canceled).toHaveBeenCalledTimes(3);
    await client.close();
  });

  it('does not retry an oversized mutation response and cancels its body', async () => {
    const canceled = vi.fn();
    const transport = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65));
            },
            cancel: canceled,
          }),
        ),
    );
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      maxResponseBytes: 64,
      transport,
    });
    await expect(client.createUser('alice', 'private-password')).rejects.toThrow(
      'exceeds the supported size',
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(canceled).toHaveBeenCalledOnce();
    await client.close();
  });

  it('sends the Jellyfin token only in its escaped MediaBrowser Authorization header', async () => {
    const client = new MediaClient('http://jellyfin.test', 'key"\\value', 'jellyfin', {
      transport: async (url, init) => {
        expect(url).not.toContain('key');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toContain('Token="key\\"\\\\value"');
        expect(headers['X-Emby-Token']).toBeUndefined();
        return json([]);
      },
    });
    await expect(client.users()).resolves.toEqual([]);
    await client.close();
  });

  it('reads broad user data and requests Emby history fields explicitly', async () => {
    const seen: URL[] = [];
    const client = new MediaClient('http://emby.test', 'key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        seen.push(url);
        expect(url.pathname).toBe('/Users/alice/Items');
        expect(url.searchParams.get('Fields')).toBe(
          'ProviderIds,Path,UserDataPlayCount,UserDataLastPlayedDate',
        );
        expect(url.searchParams.get('EnableUserData')).toBe('true');
        return json({
          Items: [
            { Id: 'series', Type: 'Series', ProviderIds: { Tvdb: '42' } },
            { Id: 'season', Type: 'Season', SeriesId: 'series' },
            { Id: 'episode', Type: 'Episode', SeriesId: 'series' },
            { Id: 'song', Type: 'Audio', UserData: { PlayCount: 4, IsFavorite: true } },
          ],
          TotalRecordCount: 4,
        });
      },
    });
    const items = await client.migrationItems('alice');
    expect(items.map((item) => item.Id)).toEqual(['series', 'season', 'episode', 'song']);
    expect(items[1]?.SeriesProviderIds).toEqual({ Tvdb: '42' });
    expect(items[2]?.SeriesProviderIds).toEqual({ Tvdb: '42' });
    expect(items[3]?.UserData?.PlayCount).toBe(4);
    expect(seen).toHaveLength(1);
    const types = seen[0]!.searchParams.get('IncludeItemTypes')!.split(',');
    expect(types).toEqual(
      expect.arrayContaining([
        'Series',
        'Season',
        'Book',
        'AudioBook',
        'MusicArtist',
        'PhotoAlbum',
        'BoxSet',
      ]),
    );
    await client.close();
  });

  it.each([
    ['10.8.13', false, false],
    ['10.9.0', true, false],
    ['10.11.10', true, false],
    ['12.0', true, true],
    ['12.2.0', true, true],
    ['12.2.0-rc.1', false, false],
    ['unknown', false, false],
    [undefined, false, false],
  ])(
    'checks writable capabilities for Jellyfin version %s',
    async (version, supported, duplicates) => {
      const transport = vi.fn(async () => json({ Version: version }));
      const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
      const capabilities = await client.migrationCapabilities();
      expect(capabilities.userData).toBe(supported);
      expect(capabilities.privatePlaylists).toBe(supported);
      expect(capabilities.playlistDuplicates).toBe(duplicates);
      await client.migrationCapabilities();
      expect(transport).toHaveBeenCalledOnce();
      await client.close();
    },
  );

  it('whitelists detailed user-data reads and partial writes without carrying item identifiers', async () => {
    const writes: unknown[] = [];
    const patch = {
      Played: true,
      IsFavorite: true,
      Likes: false,
      PlaybackPositionTicks: 12_000_000,
      PlayCount: 8,
      LastPlayedDate: '2026-01-02T03:04:05Z',
      Rating: 7.5,
      Key: 'source-key',
      ItemId: 'source-item',
      PlayedPercentage: 98,
      UnplayedItemCount: 22,
      api_key: 'source-secret',
    };
    const expected = {
      Played: true,
      IsFavorite: true,
      Likes: false,
      PlaybackPositionTicks: 12_000_000,
      PlayCount: 8,
      LastPlayedDate: '2026-01-02T03:04:05.000Z',
      Rating: 7.5,
    };
    const client = new MediaClient('http://jellyfin.test/base', 'private-key', 'jellyfin', {
      transport: async (address, init) => {
        const url = new URL(address);
        if (url.pathname.endsWith('/System/Info')) return json({ Version: '12.2' });
        expect(url.pathname).toBe('/base/UserItems/target-item/UserData');
        expect(url.searchParams.get('userId')).toBe('target-user');
        expect(address).not.toContain('private-key');
        if (init.method === 'POST') {
          writes.push(JSON.parse(String(init.body)));
          return new Response(null, { status: 204 });
        }
        return json(patch);
      },
    });
    expect(await client.userData('target-user', 'target-item')).toEqual(expected);
    await client.updateUserData('target-user', 'target-item', patch);
    await client.updateUserData('target-user', 'target-item', { IsFavorite: true });
    expect(writes).toEqual([expected, { IsFavorite: true }]);
    await client.close();
  });

  it.each([
    { Played: 'true' },
    { IsFavorite: 1 },
    { Likes: 'yes' },
    { PlaybackPositionTicks: -1 },
    { PlaybackPositionTicks: Number.MAX_SAFE_INTEGER + 1 },
    { PlayCount: 1.5 },
    { PlayCount: 2_147_483_648 },
    { LastPlayedDate: 'invalid-date' },
    { LastPlayedDate: '+010000-01-01T00:00:00Z' },
    { Rating: Infinity },
    { Rating: 11 },
    { ItemId: 'source', Key: 'source-key' },
  ])('rejects invalid user-data mutations before making any request: %j', async (patch) => {
    const transport = vi.fn(async () => json({ Version: '12.2' }));
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
    await expect(
      client.updateUserData('target-user', 'target-item', patch as MediaUserDataPatch),
    ).rejects.toBeInstanceOf(MediaError);
    expect(transport).not.toHaveBeenCalled();
    await client.close();
  });

  it('preserves legacy favorite and historical played-date endpoint contracts', async () => {
    const seen: URL[] = [];
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address, init) => {
        expect(init.method).toBe('POST');
        seen.push(new URL(address));
        return new Response(null, { status: 204 });
      },
    });
    await client.markPlayed('alice', 'movie', '2026-01-02T03:04:05.123Z');
    await client.markFavorite('alice', 'movie');
    expect(seen[0]!.pathname).toBe('/Users/alice/PlayedItems/movie');
    expect(seen[0]!.searchParams.get('DatePlayed')).toBe('20260102030405');
    expect(seen[1]!.pathname).toBe('/Users/alice/FavoriteItems/movie');
    expect(seen[1]!.search).toBe('');
    await client.close();
  });

  it('reads only the selected user playlists and preserves duplicate occurrences in their order', async () => {
    const client = new MediaClient('http://emby.test', 'key', 'emby', {
      transport: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/Users/alice/Items') {
          expect(url.searchParams.get('IncludeItemTypes')).toBe('Playlist');
          return json({
            Items: [{ Id: 'playlist', Name: 'A mix', Type: 'Playlist' }],
            TotalRecordCount: 1,
          });
        }
        expect(url.pathname).toBe('/Playlists/playlist/Items');
        expect(url.searchParams.get('userId')).toBe('alice');
        expect(url.searchParams.get('SortBy')).toBeNull();
        const entries = [
          { Id: 'song-b', PlaylistItemId: 'song-b' },
          { Id: 'song-a', PlaylistItemId: 'song-a' },
          { Id: 'song-b', PlaylistItemId: 'song-b' },
          { Id: 'song-b', PlaylistItemId: 'song-b' },
          { Id: 'song-b', PlaylistItemId: 'song-b' },
        ];
        const start = Number(url.searchParams.get('StartIndex'));
        return json({ Items: entries.slice(start, start + 2), TotalRecordCount: entries.length });
      },
    });
    client.pageSize = 2;
    expect(await client.playlists('alice')).toMatchObject([{ Id: 'playlist', Name: 'A mix' }]);
    expect((await client.playlistItems('playlist', 'alice')).map((item) => item.Id)).toEqual([
      'song-b',
      'song-a',
      'song-b',
      'song-b',
      'song-b',
    ]);
    await client.close();
  });

  it('creates empty private owner-bound playlists and appends ordered bounded batches', async () => {
    const seen: { url: URL; method?: string; body: unknown }[] = [];
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      transport: async (address, init) => {
        const url = new URL(address);
        if (url.pathname === '/System/Info') return json({ Version: '12.2' });
        expect(address).not.toContain('private-key');
        seen.push({
          url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return url.pathname === '/Playlists'
          ? json({ Id: 'new-playlist' })
          : new Response(null, { status: 204 });
      },
    });
    expect(await client.createPlaylist('target-user', 'An imported mix', 'Audio')).toEqual({
      Id: 'new-playlist',
      Name: 'An imported mix',
      Type: 'Playlist',
      MediaType: 'Audio',
    });
    await client.addPlaylistItems('new-playlist', 'target-user', ['song-b', 'song-a', 'song-b']);
    expect(seen[0]!.body).toEqual({
      Name: 'An imported mix',
      UserId: 'target-user',
      Ids: [],
      Users: [],
      IsPublic: false,
      MediaType: 'Audio',
    });
    expect(seen[1]!.url.pathname).toBe('/Playlists/new-playlist/Items');
    expect(seen[1]!.url.searchParams.get('userId')).toBe('target-user');
    expect(seen[1]!.url.searchParams.get('ids')).toBe('song-b,song-a,song-b');
    await expect(
      client.addPlaylistItems('new-playlist', 'target-user', ['one,other']),
    ).rejects.toThrow('valid playlist item identifiers');
    await expect(
      client.addPlaylistItems('new-playlist', 'target-user', Array(101).fill('id')),
    ).rejects.toThrow('valid playlist item identifiers');
    expect(seen).toHaveLength(2);
    await client.close();
  });

  it.each(['10.8.13', 'unknown'])(
    'refuses potentially public playlist creation on version %s',
    async (version) => {
      const transport = vi.fn(async () => json({ Version: version }));
      const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
      await expect(client.createPlaylist('alice', 'Private')).rejects.toThrow('10.9 or newer');
      await expect(client.updateUserData('alice', 'movie', { Played: true })).rejects.toThrow(
        '10.9 or newer',
      );
      await expect(client.addPlaylistItems('playlist', 'alice', ['one'])).rejects.toThrow(
        '10.9 or newer',
      );
      expect(transport).toHaveBeenCalledOnce();
      await client.close();
    },
  );

  it('creates the full private playlist atomically with a bounded ordered ID list', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new MediaClient('http://jellyfin.test', 'private-key', 'jellyfin', {
      transport: async (address, init) => {
        if (new URL(address).pathname === '/System/Info') return json({ Version: '12.2' });
        expect(new URL(address).pathname).toBe('/Playlists');
        bodies.push(JSON.parse(String(init.body)));
        return json({ Id: 'target-list' });
      },
    });
    await client.createPlaylist('target-user', 'Private atomic import', 'Audio', [
      'song-b',
      'song-a',
      'song-b',
    ]);
    expect(bodies[0]).toEqual({
      Name: 'Private atomic import',
      UserId: 'target-user',
      Ids: ['song-b', 'song-a', 'song-b'],
      Users: [],
      IsPublic: false,
      MediaType: 'Audio',
    });
    await client.createPlaylist(
      'target-user',
      'Maximum entries',
      'Audio',
      Array(100_000).fill('target-id'),
    );
    expect((bodies[1]!.Ids as string[]).length).toBe(100_000);
    await expect(
      client.createPlaylist('target-user', 'Too many', 'Audio', Array(100_001).fill('target-id')),
    ).rejects.toThrow('100,000');
    await expect(
      client.createPlaylist(
        'target-user',
        'Too large',
        'Audio',
        Array(40_000).fill('x'.repeat(128)),
      ),
    ).rejects.toThrow('supported size');
    await expect(
      client.createPlaylist('target-user', 'Invalid', 'Audio', ['one,other']),
    ).rejects.toThrow('valid item identifiers');
    expect(bodies).toHaveLength(2);
    await client.close();
  });

  it('never retries uncertain playlist creation or append mutations', async () => {
    const posts: string[] = [];
    const client = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', {
      transport: async (address, init) => {
        const url = new URL(address);
        if (init.method === 'GET') return json({ Version: '12.2' });
        posts.push(url.pathname);
        return new Response('private-upstream-data', { status: 503 });
      },
    });
    await expect(client.createPlaylist('alice', 'Private')).rejects.toThrow('HTTP 503');
    await expect(client.addPlaylistItems('playlist', 'alice', ['one'])).rejects.toThrow('HTTP 503');
    expect(posts).toEqual(['/Playlists', '/Playlists/playlist/Items']);
    await client.close();
  });

  it('bounds and validates raster avatars and posts upstream base64 without JSON encoding', async () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(64, 20);
    const client = new MediaClient('http://emby.test', 'source-key', 'emby', {
      transport: async (address, init) => {
        const url = new URL(address);
        expect(url.pathname).toBe('/Users/alice/Images/Primary');
        expect(url.searchParams.get('Format')).toBe('Png');
        expect(url.searchParams.get('MaxWidth')).toBe('256');
        expect(url.searchParams.get('MaxHeight')).toBe('256');
        expect(init.headers).toMatchObject({ Accept: 'image/png, image/jpeg' });
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      },
    });
    const avatar = await client.userImage('alice');
    expect(avatar?.contentType).toBe('image/png');
    expect(avatar?.data).toEqual(new Uint8Array(png));
    const target = new MediaClient('http://jellyfin.test', 'target-key', 'jellyfin', {
      transport: async (address, init) => {
        expect(new URL(address).pathname).toBe('/Users/new-user/Images/Primary');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ 'Content-Type': 'image/png' });
        expect(init.body).toBe(png.toString('base64'));
        return new Response(null, { status: 204 });
      },
    });
    await target.setUserImage('new-user', avatar!);
    await client.close();
    await target.close();
  });

  it('treats absent avatars as optional and refuses non-raster or oversized images', async () => {
    const absent = new MediaClient('http://emby.test', 'key', 'emby', {
      transport: async () => new Response(null, { status: 404 }),
    });
    expect(await absent.userImage('alice')).toBeNull();
    await absent.close();
    for (const [body, type, length] of [
      ['<svg><script>private-data</script></svg>', 'image/svg+xml', undefined],
      ['private-data', 'image/png', undefined],
      ['', 'image/png', String(1024 * 1024 + 1)],
    ]) {
      const client = new MediaClient('http://emby.test', 'key', 'emby', {
        transport: async () =>
          new Response(body, {
            headers: { 'Content-Type': type!, ...(length ? { 'Content-Length': length } : {}) },
          }),
      });
      await expect(client.userImage('alice')).rejects.toBeInstanceOf(MediaError);
      await client.close();
    }
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(100_000, 16);
    png.writeUInt32BE(100_000, 20);
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const target = new MediaClient('http://jellyfin.test', 'key', 'jellyfin', { transport });
    await expect(
      target.setUserImage('alice', { contentType: 'image/png', data: png }),
    ).rejects.toBeInstanceOf(MediaError);
    expect(transport).not.toHaveBeenCalled();
    await target.close();
  });

  it('accepts small JPEG avatars while bounding chunked image responses and redirects', async () => {
    const jpeg = Buffer.from('ffd8ffe000044142ffc0000b080001000101011100ffd9', 'hex');
    const client = new MediaClient('http://emby.test', 'private-key', 'emby', {
      transport: async () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }),
    });
    expect(await client.userImage('alice')).toEqual({
      contentType: 'image/jpeg',
      data: new Uint8Array(jpeg),
    });
    await client.close();

    const oversized = new MediaClient('http://emby.test', 'private-key', 'emby', {
      transport: async () =>
        new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }),
    });
    await expect(oversized.userImage('alice')).rejects.toThrow('exceeds the supported size');
    await oversized.close();

    const transport = vi.fn(async (_address, init) => {
      expect(init.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://other.invalid/private-image' },
      });
    });
    const redirected = new MediaClient('http://emby.test', 'private-key', 'emby', { transport });
    await expect(redirected.userImage('alice')).rejects.toMatchObject({ statusCode: 302 });
    expect(transport).toHaveBeenCalledOnce();
    await redirected.close();
  });
});
