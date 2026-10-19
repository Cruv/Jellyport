import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaClient, type FetchTransport } from '../server/media.js';
import { MediaError } from '../server/errors.js';
import {
  parseJellyfinBackupManifest,
  parseJellyfinBackups,
  validJellyfinBackupName,
} from '../server/jellyfin-backup-api.js';

const privatePath = '/synthetic-private-server/data/backups/jellyfin-backup-20261018021530.zip';
const nativeManifest = () => ({
  ServerVersion: '12.2.0.0',
  BackupEngineVersion: '0.2.0',
  DateCreated: '2026-10-18T02:15:30.1234567+00:00',
  Path: privatePath,
  Options: { Database: true, Metadata: false, Trickplay: false, Subtitles: false },
  UnrelatedPrivateData: 'synthetic-private-value',
});
const projected = {
  name: 'jellyfin-backup-20261018021530.zip',
  created_at: '2026-10-18T02:15:30.123Z',
  server_version: '12.2.0.0',
  backup_engine_version: '0.2.0',
  database: true,
  metadata: false,
  trickplay: false,
  subtitles: false,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const clients: MediaClient[] = [];
function client(transport: FetchTransport, options: { timeoutMs?: number } = {}) {
  const value = new MediaClient(
    'https://jellyfin.test/base/',
    'synthetic-private-key',
    'jellyfin',
    {
      transport,
      ...options,
    },
  );
  clients.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
  vi.useRealTimers();
});

describe('native Jellyfin backup API', () => {
  it('uses the saved token and returns only bounded safe manifest data', async () => {
    const transport = vi.fn(async (address: string, init: RequestInit) => {
      expect(address).toBe('https://jellyfin.test/base/Backup');
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      expect(init.headers).toMatchObject({
        Authorization: expect.stringContaining('Token="synthetic-private-key"'),
      });
      expect(address).not.toContain('synthetic-private-key');
      return json([nativeManifest()]);
    });
    const result = await client(transport).jellyfinBackups();
    expect(result).toEqual([projected]);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    privatePath,
    'C:\\synthetic-private-server\\backups\\jellyfin-backup-20261018021530.zip',
    'jellyfin-backup-20261018021530.zip',
  ])('projects a canonical basename without retaining native path %s', (path) => {
    expect(parseJellyfinBackupManifest({ ...nativeManifest(), Path: path })).toEqual(projected);
  });

  it('normalizes an explicit native time offset and accepts non-minimal existing backups', () => {
    expect(
      parseJellyfinBackupManifest({
        ...nativeManifest(),
        DateCreated: '2026-10-17T22:15:30.1234567-04:00',
        Options: { Database: true, Metadata: true, Trickplay: true, Subtitles: true },
      }),
    ).toEqual({ ...projected, metadata: true, trickplay: true, subtitles: true });
  });

  it('creates exactly one database-only backup with fixed supported options', async () => {
    const transport = vi.fn(async (address: string, init: RequestInit) => {
      expect(address).toBe('https://jellyfin.test/base/Backup/Create');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      expect(JSON.parse(String(init.body))).toEqual({
        Database: true,
        Metadata: false,
        Trickplay: false,
        Subtitles: false,
      });
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: expect.stringContaining('Token="synthetic-private-key"'),
      });
      return json(nativeManifest());
    });
    await expect(client(transport).createJellyfinBackup()).resolves.toEqual(projected);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['Metadata', 'Trickplay', 'Subtitles'] as const)(
    'does not report database-only creation when Jellyfin confirms %s data',
    async (option) => {
      const transport = vi.fn(async () => {
        const manifest = nativeManifest();
        manifest.Options[option] = true;
        return json(manifest);
      });
      await expect(client(transport).createJellyfinBackup()).rejects.toThrow(
        'did not confirm a database-only backup',
      );
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([301, 302, 307, 308, 403, 429, 500, 503])(
    'never retries or follows a backup creation HTTP %s response',
    async (status) => {
      const transport = vi.fn(
        async () =>
          new Response('synthetic-private-response', {
            status,
            headers: { Location: 'https://private-other-host.test', 'Retry-After': '0' },
          }),
      );
      await expect(client(transport).createJellyfinBackup()).rejects.toThrow(
        `Jellyfin rejected the request (HTTP ${status}).`,
      );
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('keeps a timed-out backup mutation uncertain without automatically retrying', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    const pending = client(transport, { timeoutMs: 30_000 }).createJellyfinBackup();
    const result = expect(pending).rejects.toThrow(
      'Jellyfin request timed out. The operation may have been applied; check before retrying.',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(transport).toHaveBeenCalledOnce();
  });

  it('sanitizes transport exceptions without leaking token, path or response data', async () => {
    const transport = vi.fn(async () => {
      throw new Error(`synthetic-private-key ${privatePath} synthetic-private-response`);
    });
    await expect(client(transport).createJellyfinBackup()).rejects.toThrow(
      'Unable to connect to Jellyfin. The operation may have been applied; check before retrying.',
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['jellyfinBackups', 'jellyfinBackupTasks'] as const)(
    'does not retry the %s observation after a transient API failure',
    async (method) => {
      const transport = vi.fn(async () => json('synthetic-private-response', 503));
      await expect(client(transport)[method]()).rejects.toThrow('HTTP 503');
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('reads only task keys and states without retaining task details', async () => {
    const transport = vi.fn(async (address: string, init: RequestInit) => {
      expect(address).toBe('https://jellyfin.test/base/ScheduledTasks');
      expect(init.method).toBe('GET');
      return json(
        ['Idle', 'Running', 'Cancelling'].map((State) => ({
          Key: `RefreshLibrary${State}`,
          State,
          Name: 'synthetic-private-name',
          Description: privatePath,
          LastExecutionResult: { ErrorMessage: 'synthetic-private-response' },
        })),
      );
    });
    const result = await client(transport).jellyfinBackupTasks();
    expect(result).toEqual([
      { key: 'RefreshLibraryIdle', state: 'Idle' },
      { key: 'RefreshLibraryRunning', state: 'Running' },
      { key: 'RefreshLibraryCancelling', state: 'Cancelling' },
    ]);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });

  it.each(['jellyfinBackups', 'createJellyfinBackup', 'jellyfinBackupTasks'] as const)(
    'rejects %s for Emby without any request',
    async (method) => {
      const transport = vi.fn(async () => json(nativeManifest()));
      const emby = new MediaClient('http://emby.test', 'synthetic-private-key', 'emby', {
        transport,
      });
      clients.push(emby);
      await expect(emby[method]()).rejects.toThrow('requires Jellyfin');
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe('strict native backup observation validation', () => {
  it.each([
    null,
    [],
    {},
    { ...nativeManifest(), Path: `${privatePath}\nprivate` },
    { ...nativeManifest(), Path: '/private/not-a-backup.zip' },
    { ...nativeManifest(), Path: '/private/jellyfin-backup-20260230021530.zip' },
    { ...nativeManifest(), Path: '/private/jellyfin-backup-20261018241530.zip' },
    { ...nativeManifest(), Path: `${'a'.repeat(4096)}/${projected.name}` },
    { ...nativeManifest(), ServerVersion: 'private-invalid-version' },
    { ...nativeManifest(), ServerVersion: '12.2.0.0\n' },
    { ...nativeManifest(), BackupEngineVersion: {} },
    { ...nativeManifest(), Options: null },
    { ...nativeManifest(), Options: { ...nativeManifest().Options, Database: false } },
    { ...nativeManifest(), Options: { ...nativeManifest().Options, Metadata: 'false' } },
    { ...nativeManifest(), Options: { Database: true } },
    { ...nativeManifest(), DateCreated: 'private-invalid-time' },
    { ...nativeManifest(), DateCreated: '2026-02-30T02:15:30Z' },
    { ...nativeManifest(), DateCreated: '2026-10-18T24:15:30Z' },
    { ...nativeManifest(), DateCreated: '2026-10-18T02:15:30+14:01' },
    { ...nativeManifest(), DateCreated: '2026-10-18T02:15:30' },
    { ...nativeManifest(), DateCreated: '2026-10-18T02:15:30.12345678Z' },
    { ...nativeManifest(), DateCreated: '2026-10-18T02:15:30Z\n' },
  ])('rejects invalid or unsupported manifests with a fixed safe error', (value) => {
    expect(() => parseJellyfinBackupManifest(value)).toThrow(
      'Jellyfin returned invalid backup information.',
    );
  });

  it('rejects duplicate names and overlarge manifest lists before adoption', () => {
    expect(() => parseJellyfinBackups([nativeManifest(), nativeManifest()])).toThrow(MediaError);
    expect(() => parseJellyfinBackups(Array(10_001).fill(nativeManifest()))).toThrow(MediaError);
  });

  it('accepts exactly ten thousand distinct bounded manifest observations', () => {
    const values = Array.from({ length: 10_000 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 18, 0, 0, index));
      const timestamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
      return {
        ...nativeManifest(),
        Path: `/synthetic-private-server/jellyfin-backup-${timestamp}.zip`,
        DateCreated: date.toISOString(),
      };
    });
    expect(parseJellyfinBackups(values)).toHaveLength(10_000);
  });

  it.each([null, {}, [null], [nativeManifest(), null]])(
    'rejects malformed backup lists from the actual client',
    async (value) => {
      await expect(client(async () => json(value)).jellyfinBackups()).rejects.toThrow(
        'Jellyfin returned invalid backup information.',
      );
    },
  );

  it.each([
    null,
    {},
    [null],
    [{ Key: 'RefreshLibrary', State: 'Unknown' }],
    [{ Key: 'private/path', State: 'Idle' }],
    [{ Key: 'RefreshLibrary\n', State: 'Idle' }],
    [{ Key: 'a'.repeat(129), State: 'Idle' }],
    Array(10_001).fill({ Key: 'RefreshLibrary', State: 'Idle' }),
  ])('rejects malformed or overlarge task lists', async (value) => {
    await expect(client(async () => json(value)).jellyfinBackupTasks()).rejects.toThrow(
      'Jellyfin returned invalid backup information.',
    );
  });

  it('requires a canonical valid archive name rather than accepting paths in the public name', () => {
    expect(validJellyfinBackupName(projected.name)).toBe(true);
    expect(validJellyfinBackupName('jellyfin-backup-20240229000000.zip')).toBe(true);
    expect(validJellyfinBackupName('jellyfin-backup-20230229000000.zip')).toBe(false);
    expect(validJellyfinBackupName(privatePath)).toBe(false);
    expect(validJellyfinBackupName('../' + projected.name)).toBe(false);
    expect(validJellyfinBackupName(projected.name + '\n')).toBe(false);
    expect(validJellyfinBackupName(undefined)).toBe(false);
  });
});
