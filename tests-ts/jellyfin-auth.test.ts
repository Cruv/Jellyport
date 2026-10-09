import { describe, expect, it, vi } from 'vitest';
import {
  JellyfinAuthClient,
  JellyfinAuthError,
  normalizeJellyfinUrl,
} from '../server/jellyfin-auth.js';
import type { FetchTransport } from '../server/media.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const user = {
  Id: 'admin-id',
  Name: 'Administrator',
  ServerId: 'server-id',
  Policy: { IsAdministrator: true, IsDisabled: false },
};
const authentication = { User: user, AccessToken: 'user-token', ServerId: 'server-id' };
const identity = {
  serverId: 'server-id',
  userId: 'admin-id',
  username: 'Administrator',
  accessToken: 'user-token',
};

function successfulTransport(): FetchTransport {
  return async (address) => {
    const path = new URL(address).pathname;
    if (path.endsWith('/Users/AuthenticateByName')) return json(authentication);
    if (path.endsWith('/System/Info/Public')) return json({ Id: 'server-id' });
    if (path.endsWith('/Users/Me')) return json(user);
    if (path.endsWith('/Sessions/Logout')) return new Response(null, { status: 204 });
    throw new Error('Unexpected authentication test request.');
  };
}

describe('Jellyfin authentication client', () => {
  it('authenticates with the official body and unique device metadata, then checks the server and current administrator', async () => {
    const seen: Array<{ address: string; init: RequestInit }> = [];
    const success = successfulTransport();
    const client = new JellyfinAuthClient({
      deviceId: 'installation',
      transport: async (address, init) => {
        seen.push({ address, init });
        return success(address, init);
      },
    });
    await expect(
      client.authenticate('http://jellyfin:8096/base/', 'administrator', 'pw-$!@'),
    ).resolves.toEqual(identity);
    expect(seen.map(({ address }) => new URL(address).pathname)).toEqual([
      '/base/System/Info/Public',
      '/base/Users/AuthenticateByName',
      '/base/Users/Me',
    ]);
    expect(seen[1]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      Username: 'administrator',
      Pw: 'pw-$!@',
    });
    const authHeaders = new Headers(seen[1]?.init.headers);
    expect(authHeaders.get('Authorization')).toMatch(
      /^MediaBrowser Client="Jellyport", Device="Jellyport", DeviceId="installation-[a-f0-9-]{36}", Version="0\.3\.0"$/,
    );
    expect(authHeaders.has('X-Emby-Token')).toBe(false);
    expect(new Headers(seen[0]?.init.headers).has('Authorization')).toBe(false);
    expect(new Headers(seen[2]?.init.headers).get('Authorization')).toBe(
      'MediaBrowser Token="user-token"',
    );
    expect(new Headers(seen[2]?.init.headers).has('X-Emby-Authorization')).toBe(false);
    for (const { address, init } of seen) {
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(address).not.toContain('pw-$!@');
      expect(address).not.toContain('user-token');
      expect(new URL(address).search).toBe('');
    }
  });

  it('gives simultaneous browser authentications different device IDs, avoiding Jellyfin token revocation', async () => {
    const deviceIds: string[] = [];
    const success = successfulTransport();
    const client = new JellyfinAuthClient({
      transport: async (address, init) => {
        if (address.endsWith('/Users/AuthenticateByName'))
          deviceIds.push(new Headers(init.headers).get('Authorization')!);
        return success(address, init);
      },
    });
    await Promise.all([
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ]);
    expect(deviceIds).toHaveLength(2);
    expect(deviceIds[0]).not.toBe(deviceIds[1]);
  });

  it('returns the current canonical username and accepts a user DTO without optional ServerId', async () => {
    const client = new JellyfinAuthClient({
      transport: async (address) => {
        if (address.endsWith('/Users/AuthenticateByName')) return json(authentication);
        if (address.endsWith('/System/Info/Public')) return json({ Id: 'server-id' });
        return json({ ...user, Name: 'Renamed Administrator', ServerId: undefined });
      },
    });
    await expect(
      client.authenticate('https://jellyfin.test', 'Administrator', 'password'),
    ).resolves.toEqual({
      ...identity,
      username: 'Renamed Administrator',
    });
  });

  it.each([
    { IsAdministrator: false, IsDisabled: false },
    { IsAdministrator: 'true', IsDisabled: false },
    { IsAdministrator: 1, IsDisabled: false },
    { IsAdministrator: true, IsDisabled: true },
    { IsAdministrator: true, IsDisabled: 'false' },
    { IsAdministrator: true },
    {},
    null,
  ])(
    'rejects an unverified or disabled administrator policy and revokes the issued token: %j',
    async (policy) => {
      const seen: string[] = [];
      const client = new JellyfinAuthClient({
        transport: async (address) => {
          seen.push(new URL(address).pathname);
          if (address.endsWith('/System/Info/Public')) return json({ Id: 'server-id' });
          if (address.endsWith('/Sessions/Logout')) return new Response(null, { status: 204 });
          return json({ ...authentication, User: { ...user, Policy: policy } });
        },
      });
      await expect(
        client.authenticate('http://jellyfin', 'Administrator', 'password'),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: 'An enabled Jellyfin administrator account is required.',
      });
      expect(seen).toEqual([
        '/System/Info/Public',
        '/Users/AuthenticateByName',
        '/Sessions/Logout',
      ]);
    },
  );

  it('checks the live administrator policy even when the authentication response claimed admin access', async () => {
    const logout = vi.fn();
    const success = successfulTransport();
    const client = new JellyfinAuthClient({
      transport: async (address, init) => {
        if (address.endsWith('/Users/Me'))
          return json({ ...user, Policy: { ...user.Policy, IsAdministrator: false } });
        if (address.endsWith('/Sessions/Logout')) logout();
        return success(address, init);
      },
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(logout).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    {},
    { ...authentication, AccessToken: '' },
    { ...authentication, AccessToken: 'secret\r\nInjected: true' },
    { ...authentication, ServerId: '' },
    { ...authentication, ServerId: 1 },
    { ...authentication, User: { ...user, Id: '' } },
    { ...authentication, User: { ...user, Name: '' } },
    { ...authentication, User: { ...user, ServerId: 'other-server' } },
  ])(
    'rejects malformed authentication responses without exposing their contents: %j',
    async (value) => {
      const client = new JellyfinAuthClient({
        transport: async (address) => {
          if (address.endsWith('/System/Info/Public')) return json({ Id: 'server-id' });
          return address.endsWith('/Sessions/Logout')
            ? new Response(null, { status: 204 })
            : json(value);
        },
      });
      await expect(
        client.authenticate('http://jellyfin', 'Administrator', 'password'),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: 'Jellyfin returned an unexpected authentication response.',
      });
    },
  );

  it.each([null, {}, { Id: 'different-server' }, { Id: '' }])(
    'rejects another server before disclosing the session token: %j',
    async (response) => {
      const requests: RequestInit[] = [];
      const client = new JellyfinAuthClient({
        transport: async (_address, init) => {
          requests.push(init);
          return json(response);
        },
      });
      await expect(
        client.validateSession('http://jellyfin', 'user-token', 'server-id', 'admin-id'),
      ).rejects.toMatchObject({ statusCode: 502 });
      expect(requests).toHaveLength(1);
      expect(new Headers(requests[0]?.headers).has('X-Emby-Token')).toBe(false);
      expect(new Headers(requests[0]?.headers).has('Authorization')).toBe(false);
    },
  );

  it('rejects a token attached to another user', async () => {
    const client = new JellyfinAuthClient({
      transport: async (address) =>
        address.endsWith('/System/Info/Public')
          ? json({ Id: 'server-id' })
          : json({ ...user, Id: 'different-admin' }),
    });
    await expect(
      client.validateSession('http://jellyfin', 'user-token', 'server-id', 'admin-id'),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('checks the pinned server before transmitting a password to an existing installation', async () => {
    const transport = vi.fn<FetchTransport>(async (address, init) => {
      expect(new URL(address).pathname).toBe('/System/Info/Public');
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      return json({ Id: 'other-server' });
    });
    await expect(
      new JellyfinAuthClient({ transport }).authenticate(
        'http://jellyfin',
        'Administrator',
        'secret-password',
        'server-id',
      ),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The connected Jellyfin server does not match this installation.',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('checks that authentication came from the server fingerprinted before the password was submitted', async () => {
    const client = new JellyfinAuthClient({
      transport: async (address) => {
        if (address.endsWith('/System/Info/Public')) return json({ Id: 'server-id' });
        if (address.endsWith('/Sessions/Logout')) return new Response(null, { status: 204 });
        return json({ ...authentication, ServerId: 'changed-server' });
      },
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password', 'server-id'),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it.each([
    ['invalid-token\nheader', 'server-id', 'admin-id'],
    ['token"injected', 'server-id', 'admin-id'],
    ['token\\injected', 'server-id', 'admin-id'],
    ['token, Token="injected', 'server-id', 'admin-id'],
    ['user-token', '', 'admin-id'],
    ['user-token', 'server-id', ''],
  ])(
    'rejects invalid stored session fields without making network calls',
    async (accessToken, serverId, userId) => {
      const transport = vi.fn<FetchTransport>();
      const client = new JellyfinAuthClient({ transport });
      await expect(
        client.validateSession('http://jellyfin', accessToken, serverId, userId),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 500, 503])(
    'redacts upstream HTTP %i and never retries a rejected authentication',
    async (status) => {
      const transport = vi.fn<FetchTransport>(async (address) =>
        address.endsWith('/System/Info/Public')
          ? json({ Id: 'server-id' })
          : new Response('secret-user secret-password secret-token', { status }),
      );
      const client = new JellyfinAuthClient({ transport });
      await expect(
        client.authenticate('http://jellyfin', 'secret-user', 'secret-password'),
      ).rejects.toMatchObject({
        statusCode: [401, 403].includes(status) ? status : 502,
      });
      expect(transport).toHaveBeenCalledTimes(2);
      const error = await client
        .authenticate('http://jellyfin', 'secret-user', 'secret-password')
        .catch((value: unknown) => value);
      expect(String(error)).not.toContain('secret');
    },
  );

  it('does not follow redirects with passwords or tokens', async () => {
    const transport = vi.fn<FetchTransport>(async (_address, init) => {
      expect(init.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } });
    });
    const client = new JellyfinAuthClient({ transport });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['network secret-token secret-password', 'secret-host TLS failure'])(
    'redacts transport errors: %s',
    async (message) => {
      const client = new JellyfinAuthClient({
        transport: async () => {
          throw new Error(message);
        },
      });
      await expect(
        client.authenticate('http://jellyfin', 'Administrator', 'password'),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: 'Unable to connect to Jellyfin. Check the server address and availability.',
      });
    },
  );

  it('bounds a stalled fetch even when the injected transport ignores its AbortSignal', async () => {
    const client = new JellyfinAuthClient({
      transport: async () => new Promise(() => {}),
      timeoutMs: 15,
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The Jellyfin authentication request timed out.',
    });
  });

  it('bounds a stalled response stream as well as connection time', async () => {
    const cancelled = vi.fn();
    const client = new JellyfinAuthClient({
      transport: async () => new Response(new ReadableStream({ cancel: cancelled })),
      timeoutMs: 15,
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The Jellyfin authentication request timed out.',
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels a response that arrives after its transport deadline', async () => {
    let resolve!: (response: Response) => void;
    const canceled = vi.fn();
    const transport = vi.fn<FetchTransport>(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const client = new JellyfinAuthClient({ transport, timeoutMs: 15 });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The Jellyfin authentication request timed out.',
    });
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel: canceled })));
    await Promise.resolve();
    expect(canceled).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not await stalled stream cancellation after the read deadline', async () => {
    const canceled = vi.fn(() => new Promise<void>(() => {}));
    const client = new JellyfinAuthClient({
      transport: async () => new Response(new ReadableStream<Uint8Array>({ cancel: canceled })),
      timeoutMs: 15,
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The Jellyfin authentication request timed out.',
    });
    expect(canceled).toHaveBeenCalledOnce();
  });

  it('bounds immediate empty chunks without relying on a timer callback running', async () => {
    const canceled = vi.fn();
    const client = new JellyfinAuthClient({
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(0));
            },
            cancel: canceled,
          }),
        ),
      timeoutMs: 15,
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The Jellyfin authentication request timed out.',
    });
    expect(canceled).toHaveBeenCalledOnce();
  });

  it('accepts a valid chunked response at the exact byte ceiling without retaining each tiny chunk', async () => {
    const maximum = 1_048_576;
    const framing = JSON.stringify({ Id: 'server-id', Padding: '' });
    const text = JSON.stringify({
      Id: 'server-id',
      Padding: 'x'.repeat(maximum - Buffer.byteLength(framing)),
    });
    expect(Buffer.byteLength(text)).toBe(maximum);
    const success = successfulTransport();
    const client = new JellyfinAuthClient({
      transport: async (address, init) => {
        if (!address.endsWith('/System/Info/Public')) return success(address, init);
        const bytes = new TextEncoder().encode(text);
        let offset = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === bytes.length) {
                controller.close();
                return;
              }
              const end = Math.min(bytes.length, offset + 257);
              controller.enqueue(bytes.subarray(offset, end));
              offset = end;
            },
          }),
        );
      },
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).resolves.toEqual(identity);
  });

  it('cancels a declared oversized body before reading its stream', async () => {
    const canceled = vi.fn();
    const transport = vi.fn<FetchTransport>(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel: canceled }), {
          headers: { 'Content-Length': '1048577' },
        }),
    );
    const client = new JellyfinAuthClient({ transport });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Jellyfin returned an unexpected authentication response.',
    });
    expect(canceled).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('bounds actual streamed bytes when the content length understates their size', async () => {
    const canceled = vi.fn();
    const transport = vi.fn<FetchTransport>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1_048_576));
              controller.enqueue(new Uint8Array(1));
            },
            cancel: canceled,
          }),
          { headers: { 'Content-Length': '1' } },
        ),
    );
    const client = new JellyfinAuthClient({ transport });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Jellyfin returned an unexpected authentication response.',
    });
    expect(canceled).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('redacts errors from a response stream and does not attach the remote error as a cause', async () => {
    const client = new JellyfinAuthClient({
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('private-password private-token'));
            },
          }),
        ),
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Unable to connect to Jellyfin. Check the server address and availability.',
    });
    try {
      await client.authenticate('http://jellyfin', 'Administrator', 'password');
    } catch (error) {
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toMatch(/private-password|private-token/);
    }
  });

  it.each([
    () => new Response('secret-invalid-json'),
    () => new Response('x', { headers: { 'Content-Length': '1048577' } }),
    () => new Response('x'.repeat(1_048_577)),
    () => new Response(null),
  ])('rejects malformed, missing, or oversized JSON bodies', async (response) => {
    const client = new JellyfinAuthClient({ transport: async () => response() });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Jellyfin returned an unexpected authentication response.',
    });
  });

  it('logs out only the supplied Jellyfin session without request-body or query credentials', async () => {
    const transport = vi.fn<FetchTransport>(async (address, init) => {
      expect(address).toBe('http://jellyfin/base/Sessions/Logout');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'MediaBrowser Token="user-token"',
      );
      return new Response(null, { status: 204 });
    });
    await expect(
      new JellyfinAuthClient({ transport }).signOut('http://jellyfin/base', 'user-token'),
    ).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('keeps the original rejected-login error when best-effort logout fails', async () => {
    const client = new JellyfinAuthClient({
      transport: async (address) =>
        address.endsWith('/System/Info/Public')
          ? json({ Id: 'server-id' })
          : address.endsWith('/Sessions/Logout')
            ? new Response('secret', { status: 503 })
            : json({
                ...authentication,
                User: { ...user, Policy: { ...user.Policy, IsAdministrator: false } },
              }),
    });
    await expect(
      client.authenticate('http://jellyfin', 'Administrator', 'password'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it.each([
    'ftp://server',
    'http://user:secret@server',
    'http://server?secret=x',
    'http://server?',
    'http://server/#fragment',
    'http://server#',
    'http://server:bad',
    'http://server\n.evil',
    'http://server\\@evil',
    '',
  ])('rejects unsafe URLs without disclosing their value: %j', async (address) => {
    const transport = vi.fn<FetchTransport>();
    const client = new JellyfinAuthClient({ transport });
    await expect(client.authenticate(address, 'Administrator', 'password')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('normalizes HTTP(S), including LAN names and reverse-proxy base paths', () => {
    expect(normalizeJellyfinUrl('  http://jellyfin:8096/  ')).toBe('http://jellyfin:8096');
    expect(normalizeJellyfinUrl('https://media.test/jellyfin///')).toBe(
      'https://media.test/jellyfin',
    );
    expect(normalizeJellyfinUrl('http://[::1]:8096/base')).toBe('http://[::1]:8096/base');
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { deviceId: 'header" injection' },
    { deviceId: '' },
  ])('rejects unsafe client options', (options) => {
    expect(() => new JellyfinAuthClient(options)).toThrow(JellyfinAuthError);
  });
});

describe('user-provided Jellyfin API keys', () => {
  it.each([false, true, undefined])(
    'validates an existing key with IsActive %s, without requiring a particular or unique name',
    async (isActive) => {
      const requests: Array<{ address: string; init: RequestInit }> = [];
      const client = new JellyfinAuthClient({
        transport: async (address, init) => {
          requests.push({ address, init });
          if (!address.endsWith('/Auth/Keys')) return json({ Id: 'linked-server' });
          return json({
            Items: [
              { AppName: 'Any chosen label', AccessToken: 'unrelated-key' },
              {
                AppName: 'Any chosen label',
                AccessToken: 'dedicated-key',
                IsActive: isActive,
                DateRevoked: null,
              },
            ],
          });
        },
      });
      await expect(
        client.validateApiKey('http://jellyfin/base', 'dedicated-key', 'linked-server'),
      ).resolves.toEqual({ serverId: 'linked-server', apiKeyName: 'Any chosen label' });
      expect(requests.map(({ address }) => new URL(address).pathname)).toEqual([
        '/base/System/Info/Public',
        '/base/System/Info',
        '/base/Auth/Keys',
      ]);
      expect(new Headers(requests[0]!.init.headers).has('Authorization')).toBe(false);
      for (const { init } of requests.slice(1)) {
        expect(new Headers(init.headers).get('Authorization')).toBe(
          'MediaBrowser Token="dedicated-key"',
        );
      }
      for (const { address, init } of requests) {
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(new URL(address).search).toBe('');
        expect(address).not.toContain('dedicated-key');
      }
    },
  );

  it.each([
    { Items: [] },
    { Items: [{ AppName: 'Same label', AccessToken: 'unrelated-key' }] },
    { Items: [{ AccessToken: '' }] },
    {
      Items: [
        {
          AppName: 'Any name',
          AccessToken: 'dedicated-key',
          IsActive: false,
          DateRevoked: '2026-10-07',
        },
      ],
    },
    {
      Items: [
        { AppName: 'First label', AccessToken: 'dedicated-key' },
        { AppName: 'Second label', AccessToken: 'dedicated-key', IsActive: false },
      ],
    },
  ])('rejects unlisted, revoked, or ambiguous supplied keys: %j', async (value) => {
    const client = new JellyfinAuthClient({
      transport: async (address) =>
        json(address.endsWith('/Auth/Keys') ? value : { Id: 'linked-server' }),
    });
    await expect(client.validateApiKey('http://jellyfin', 'dedicated-key')).rejects.toMatchObject({
      statusCode: 403,
      message:
        'Enter an API key created in the Jellyfin dashboard, rather than a user session token.',
    });
  });

  it('does not retry or expose connection errors and never mutates keys', async () => {
    const transport = vi.fn<FetchTransport>(async () => {
      throw new Error('secret key validation timeout dedicated-key');
    });
    const client = new JellyfinAuthClient({ transport });
    await expect(client.validateApiKey('http://jellyfin', 'dedicated-key')).rejects.toMatchObject({
      statusCode: 502,
      message: 'Unable to connect to Jellyfin. Check the server address and availability.',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('refuses a different pinned server before submitting the key', async () => {
    const transport = vi.fn<FetchTransport>(async (_address, init) => {
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      return json({ Id: 'different-server' });
    });
    await expect(
      new JellyfinAuthClient({ transport }).validateApiKey(
        'http://jellyfin',
        'dedicated-key',
        'linked-server',
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['', ' key ', 'unsafe\nkey', 'unsafe"key', 'x'.repeat(4097), '.', '..'])(
    'rejects invalid keys before making requests',
    async (apiKey) => {
      const transport = vi.fn<FetchTransport>();
      await expect(
        new JellyfinAuthClient({ transport }).validateApiKey('http://jellyfin', apiKey),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])('sanitizes rejected key responses with status %i', async (status) => {
    const client = new JellyfinAuthClient({
      transport: async (address) =>
        address.endsWith('/Public')
          ? json({ Id: 'linked-server' })
          : json({ detail: 'dedicated-key unrelated-key http://internal' }, status),
    });
    await expect(client.validateApiKey('http://jellyfin', 'dedicated-key')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Jellyfin rejected the API key. Create an API key in the Jellyfin dashboard.',
    });
  });

  it('rejects an authenticated server identity mismatch before reading keys', async () => {
    const transport = vi.fn<FetchTransport>(async (address) =>
      json({ Id: address.endsWith('/Public') ? 'linked-server' : 'different-server' }),
    );
    await expect(
      new JellyfinAuthClient({ transport }).validateApiKey('http://jellyfin', 'dedicated-key'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { Items: 'dedicated-key' }])(
    'rejects malformed key listings',
    async (value) => {
      const client = new JellyfinAuthClient({
        transport: async (address) =>
          json(address.endsWith('/Auth/Keys') ? value : { Id: 'linked-server' }),
      });
      await expect(client.validateApiKey('http://jellyfin', 'dedicated-key')).rejects.toMatchObject(
        { statusCode: 502 },
      );
    },
  );

  it.each([undefined, '', 'unsafe\nlabel'])(
    'allows keys without a usable display name',
    async (appName) => {
      const client = new JellyfinAuthClient({
        transport: async (address) =>
          json(
            address.endsWith('/Auth/Keys')
              ? { Items: [{ AccessToken: 'dedicated-key', AppName: appName }] }
              : { Id: 'linked-server' },
          ),
      });
      await expect(client.validateApiKey('http://jellyfin', 'dedicated-key')).resolves.toEqual({
        serverId: 'linked-server',
        apiKeyName: 'User-provided API key',
      });
    },
  );
});
