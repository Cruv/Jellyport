import { describe, expect, it } from 'vitest';
import { MediaClient, type FetchTransport } from '../server/media.js';
import { MediaError } from '../server/errors.js';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
describe('media API boundary', () => {
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
});
