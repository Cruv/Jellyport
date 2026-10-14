import { describe, expect, it, vi } from 'vitest';
import { DemoServers } from '../server/demo.js';
import { readMigrationSource } from '../server/migration.js';

describe('bounded complete source playlist collection', () => {
  it('bounds the aggregate of individually valid playlists before destination work', async () => {
    const client = new DemoServers().factory('http://emby.test', 'fixture', 'emby');
    client.playlists = async () => [
      { Id: 'one', Name: 'One', Type: 'Playlist' },
      { Id: 'two', Name: 'Two', Type: 'Playlist' },
      { Id: 'three', Name: 'Three', Type: 'Playlist' },
    ];
    const entries = vi.fn(async () =>
      Array.from({ length: 10 }, (_, i) => ({
        Id: String(i),
        Type: 'Audio',
        Name: 'x'.repeat(2 * 1024 * 1024),
      })),
    );
    client.playlistItems = entries;
    await expect(readMigrationSource(client, 'e-river', 'complete', [])).rejects.toThrow(
      'memory budget',
    );
    expect(entries).toHaveBeenCalledTimes(2);
  });

  it('does not swallow cancellation as an optional-playlist warning or begin the next playlist', async () => {
    const client = new DemoServers().factory('http://emby.test', 'fixture', 'emby');
    const controller = new AbortController();
    client.playlists = async () => [
      { Id: 'one', Name: 'One', Type: 'Playlist' },
      { Id: 'two', Name: 'Two', Type: 'Playlist' },
    ];
    const entries = vi.fn(async () => {
      controller.abort(new Error('Canceled fixture'));
      throw new Error('Canceled read');
    });
    client.playlistItems = entries;
    await expect(
      readMigrationSource(client, 'e-river', 'complete', [], controller.signal),
    ).rejects.toThrow('Canceled fixture');
    expect(entries).toHaveBeenCalledTimes(1);
  });

  it('does not issue an identity request after cancellation', async () => {
    const client = new DemoServers().factory('http://emby.test', 'fixture', 'emby');
    const user = vi.spyOn(client, 'user');
    const controller = new AbortController();
    controller.abort();
    await expect(
      readMigrationSource(client, 'e-river', 'complete', [], controller.signal),
    ).rejects.toThrow();
    expect(user).not.toHaveBeenCalled();
  });
});
