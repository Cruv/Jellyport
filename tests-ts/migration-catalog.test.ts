import { describe, expect, it, vi } from 'vitest';
import { MigrationCatalogCache } from '../server/migration-catalog.js';
import type { MediaItem } from '../server/media.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const item = (id = 'one'): MediaItem => ({ Id: id, Type: 'Movie', ProviderIds: { Tmdb: id } });

describe('bounded reusable migration catalog', () => {
  it('shares one in-flight build and subsequent hits without duplicate catalog arrays', async () => {
    const hit = vi.fn(),
      cache = new MigrationCatalogCache({ hit });
    const pending = deferred<MediaItem[]>(),
      load = vi.fn(() => pending.promise);
    const one = cache.get('same-key', load),
      two = cache.get('same-key', load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve([item()]);
    const [first, second] = await Promise.all([one, two]);
    expect(first).toBe(second);
    expect(await cache.get('same-key', load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hit.mock.calls).toEqual([[0], [1]]);
  });

  it('scopes keys to normalized URL, API credentials, server identity and version without revealing them', () => {
    const key = MigrationCatalogCache.key(
      'http://emby',
      'private-api-key',
      'server-one',
      '4.10.1.0',
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain('private-api-key');
    expect(
      MigrationCatalogCache.key('http://emby:80/', 'private-api-key', 'server-one', '4.10.1.0'),
    ).toBe(key);
    for (const args of [
      ['http://other-source', 'private-api-key', 'server-one', '4.10.1.0'],
      ['http://emby', 'different-api-key', 'server-one', '4.10.1.0'],
      ['http://emby', 'private-api-key', 'server-two', '4.10.1.0'],
      ['http://emby', 'private-api-key', 'server-one', '4.10.2.0'],
    ] as const)
      expect(MigrationCatalogCache.key(args[0], args[1], args[2], args[3])).not.toBe(key);
  });

  it('retains at most one scope and rejects conflicting builds while another scope is loading', async () => {
    const cache = new MigrationCatalogCache(),
      pending = deferred<MediaItem[]>();
    const loading = cache.get('one', () => pending.promise),
      conflicting = vi.fn(async () => [item('two')]);
    await expect(cache.get('two', conflicting)).rejects.toThrow('Another source catalog');
    expect(conflicting).not.toHaveBeenCalled();
    pending.resolve([item('one')]);
    await loading;
    expect((await cache.get('two', conflicting)).items[0]?.Id).toBe('two');
    const rebuild = vi.fn(async () => [item('new-one')]);
    expect((await cache.get('one', rebuild)).items[0]?.Id).toBe('new-one');
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('refreshes at the ten-minute boundary and measures age from collection start', async () => {
    let time = 0;
    const cache = new MigrationCatalogCache({ clock: () => time }),
      load = vi.fn(async () => [item()]);
    const first = await cache.get('key', load);
    time = 599_999;
    expect(await cache.get('key', load)).toBe(first);
    time = 600_000;
    expect(await cache.get('key', load)).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(2);
    const pending = deferred<MediaItem[]>();
    cache.clear();
    const slow = cache.get('key', () => pending.promise);
    time += 600_001;
    pending.resolve([item('slow')]);
    expect((await slow).capturedAt).toBe(600_000);
    expect((await cache.get('key', load)).capturedAt).toBe(time);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not republish a collection that finishes after cache invalidation', async () => {
    const cache = new MigrationCatalogCache(),
      pending = deferred<MediaItem[]>();
    const old = cache.get('key', () => pending.promise);
    cache.clear();
    pending.resolve([item('old')]);
    expect((await old).items[0]?.Id).toBe('old');
    const load = vi.fn(async () => [item('current')]);
    expect((await cache.get('key', load)).items[0]?.Id).toBe('current');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never admits partial work after a failed collection or falls back to a previous scope', async () => {
    const cache = new MigrationCatalogCache();
    await cache.get('old-scope', async () => [item('old')]);
    const partial = [item('partial')],
      failed = deferred<MediaItem[]>();
    const first = cache.get('new-scope', () => failed.promise);
    const rejected = expect(first).rejects.toThrow('late page failed');
    partial.push(item('more-partial'));
    failed.reject(new Error('late page failed'));
    await rejected;
    const fresh = vi.fn(async () => [item('full')]);
    expect((await cache.get('new-scope', fresh)).items.map((entry) => entry.Id)).toEqual(['full']);
    expect(fresh).toHaveBeenCalledTimes(1);
    const old = vi.fn(async () => [item('rebuilt')]);
    expect((await cache.get('old-scope', old)).items[0]?.Id).toBe('rebuilt');
    expect(old).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { Played: true }, undefined])(
    'rejects any UserData property before caching and permits a clean retry (%j)',
    async (UserData) => {
      const cache = new MigrationCatalogCache();
      await expect(
        cache.get('key', async () => [item('valid'), { ...item('private'), UserData }]),
      ).rejects.toThrow('Personal state');
      const clean = vi.fn(async () => [item('clean')]);
      expect((await cache.get('key', clean)).items[0]?.Id).toBe('clean');
      expect(clean).toHaveBeenCalledTimes(1);
    },
  );

  it('freezes the retained array, items and identity metadata against later mutation', async () => {
    const metadata = item(),
      cache = new MigrationCatalogCache();
    const value = await cache.get('key', async () => [metadata]);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.ProviderIds)).toBe(true);
    expect(() => value.items.push(item('extra'))).toThrow(TypeError);
    expect(() => {
      metadata.Id = 'different';
    }).toThrow(TypeError);
    expect(() => {
      metadata.ProviderIds!.Tmdb = 'different';
    }).toThrow(TypeError);
    expect((await cache.get('key', async () => [])).items).toBe(value.items);
  });

  it('rejects oversized item counts without retaining an entry', async () => {
    const cache = new MigrationCatalogCache();
    await expect(cache.get('key', async () => Array(200_001).fill(item()))).rejects.toThrow(
      'item limit',
    );
    expect((await cache.get('key', async () => [item('small')])).items).toHaveLength(1);
  });

  it('rejects metadata beyond the 64 MiB serialized budget without caching a partial array', async () => {
    const cache = new MigrationCatalogCache(),
      text = 'x'.repeat(1024 * 1024);
    await expect(
      cache.get('key', async () =>
        Array.from({ length: 65 }, (_, index) => ({
          Id: String(index),
          Type: 'Movie',
          Name: text,
        })),
      ),
    ).rejects.toThrow('memory budget');
    expect((await cache.get('key', async () => [item('small')])).items[0]?.Id).toBe('small');
  });
});
