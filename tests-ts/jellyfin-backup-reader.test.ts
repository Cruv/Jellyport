import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { importJellyfinBackupCatalog } from '../server/jellyfin-backup-reader.js';
import {
  buildJellyfinCatalogIndex,
  readJellyfinCatalogCandidates,
} from '../server/jellyfin-catalog-index.js';
import { jellyfinLibraryConfigHash } from '../server/jellyfin-library-membership.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const id = (number: number) =>
  `${number.toString(16).padStart(8, '0')}-0000-0000-0000-000000000001`;
const apiId = (number: number) => id(number).replaceAll('-', '');
const manifest = {
  ServerVersion: '12.2.0.0',
  BackupEngineVersion: '0.2.0',
  DateCreated: '2026-10-16T05:15:07.4251613+00:00',
  DatabaseTables: ['DbSet`1'],
  Options: { Database: true, Metadata: false, Subtitles: false, Trickplay: false },
};
interface SyntheticEntry {
  name: string;
  text: string;
  data?: Buffer;
  corruptCrc?: boolean;
  mode?: number;
  stored?: boolean;
  declaredSize?: number;
}
/** Minimal synthetic ZIP fixture, independent of the archive reader implementation. */
function zip(entries: SyntheticEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = entry.data ?? Buffer.from(entry.text);
    const compressed = entry.stored ? raw : deflateRawSync(raw);
    const checksum = crc32(raw) ^ (entry.corruptCrc ? 1 : 0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.stored ? 0 : 8, 8);
    header.writeUInt32LE(checksum >>> 0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.stored ? 0 : 8, 10);
    directory.writeUInt32LE(checksum >>> 0, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.declaredSize ?? raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture(
  items: unknown[],
  providers: unknown[] = [],
  extra: SyntheticEntry[] = [],
  manifestValue: unknown = manifest,
) {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-jf-catalog-test-'));
  temporary.push(directory);
  const archive = join(directory, 'backup.zip');
  const output = join(directory, 'catalog.db');
  const entries = [
    { name: 'manifest.json', text: JSON.stringify(manifestValue) },
    { name: 'Database/BaseItems.json', text: JSON.stringify(items) },
    { name: 'Database/BaseItemProviders.json', text: JSON.stringify(providers) },
    ...extra,
  ];
  await writeFile(archive, zip(entries));
  return { archive, output, entries, directory };
}
const item = (
  number: number,
  type = 'MediaBrowser.Controller.Entities.Movies.Movie',
  extra = {},
) => ({
  Id: id(number),
  Type: type,
  Name: `Synthetic item ${number}`,
  Path: `/synthetic/${number}`,
  ...extra,
});
function projected(output: string) {
  const database = new DatabaseSync(output, { readOnly: true, allowExtension: false });
  try {
    return {
      items: database
        .prepare('SELECT item FROM catalog_items ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.item))),
      tables: database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name),
    };
  } finally {
    database.close();
  }
}

describe('Jellyfin backup catalog reader', () => {
  it('projects only matching identities, resolves providers and preserves multi-episode bounds', async () => {
    const source = await fixture(
      [
        item(1, 'MediaBrowser.Controller.Entities.TV.Series', {
          UserData: [{ secret: 'never-project' }],
          Owner: { secret: 'never-project' },
        }),
        item(2, 'MediaBrowser.Controller.Entities.TV.Episode', {
          SeriesId: id(1).toUpperCase(),
          IndexNumber: 3,
          ParentIndexNumber: 2,
          RunTimeTicks: 123456789,
          Data: JSON.stringify({ IndexNumberEnd: 4, RemoteTrailers: ['private'] }),
        }),
        item(3, 'MediaBrowser.Controller.Entities.Person'),
      ],
      [
        {
          ItemId: id(1),
          ProviderId: 'Tvdb',
          ProviderValue: '1234',
          Item: { secret: 'never-project' },
        },
        { ItemId: id(2), ProviderId: 'Imdb', ProviderValue: 'tt0000001' },
        { ItemId: id(3), ProviderId: 'Imdb', ProviderValue: 'nm0000001' },
      ],
    );
    const progress: unknown[] = [];
    const result = await importJellyfinBackupCatalog(source.archive, source.output, {
      onProgress: (event) => progress.push(event),
    });
    expect(result.manifest).toEqual({
      serverVersion: '12.2.0.0',
      backupEngineVersion: '0.2.0',
      createdAt: '2026-10-16T05:15:07.425Z',
    });
    expect(result.stats).toMatchObject({
      sourceRows: 3,
      providerRows: 3,
      ignoredRows: 1,
      projectedItems: 2,
    });
    expect(projected(source.output)).toEqual({
      tables: [
        'catalog_item_roots',
        'catalog_items',
        'catalog_library_config',
        'catalog_library_roots',
        'catalog_membership',
        'catalog_roots',
      ],
      items: [
        {
          Id: apiId(1),
          Name: 'Synthetic item 1',
          Type: 'Series',
          Path: '/synthetic/1',
          ProviderIds: { Tvdb: '1234' },
        },
        {
          Id: apiId(2),
          Name: 'Synthetic item 2',
          Type: 'Episode',
          Path: '/synthetic/2',
          SeriesId: apiId(1),
          IndexNumber: 3,
          ParentIndexNumber: 2,
          IndexNumberEnd: 4,
          RunTimeTicks: 123456789,
          ProviderIds: { Imdb: 'tt0000001' },
          SeriesProviderIds: { Tvdb: '1234' },
        },
      ],
    });
    expect(JSON.stringify(progress)).not.toContain('Synthetic');
    expect(JSON.stringify(progress)).not.toContain(apiId(1));
    expect((await stat(source.output)).mode & 0o777).toBe(0o600);
    expect((await readFile(source.output)).includes(Buffer.from('never-project'))).toBe(false);
  });

  it('projects exact neutral physical-root memberships without retaining a parent graph or collection settings', async () => {
    const root = item(100, 'MediaBrowser.Controller.Entities.Folder', {
      Path: '/synthetic/root',
      ParentId: id(900),
    });
    const collection = item(200, 'MediaBrowser.Controller.Entities.CollectionFolder', {
      Path: '/synthetic/virtual',
      Data: JSON.stringify({
        PhysicalFolderIds: [apiId(100)],
        PhysicalLocationsList: ['/synthetic/virtual', '/synthetic/root'],
        PrivateSetting: 'never-project-membership-secret',
      }),
    });
    const source = await fixture([
      root,
      collection,
      item(1, undefined, { TopParentId: id(100) }),
      item(2, undefined, { TopParentId: null }),
      item(3, undefined, { TopParentId: id(999) }),
    ]);
    await importJellyfinBackupCatalog(source.archive, source.output);
    await buildJellyfinCatalogIndex(source.output);
    const candidates = await readJellyfinCatalogCandidates(
      source.output,
      projected(source.output).items,
    );
    expect(candidates.find((item) => item.Id === apiId(1))?.JellyportLibraryIds).toEqual([
      apiId(200),
    ]);
    expect(candidates.find((item) => item.Id === apiId(1))?.JellyportLibraryConfigHash).toBe(
      jellyfinLibraryConfigHash([{ id: apiId(200), locations: ['/synthetic/root'] }]),
    );
    expect(candidates.find((item) => item.Id === apiId(2))).not.toHaveProperty(
      'JellyportLibraryIds',
    );
    expect(candidates.find((item) => item.Id === apiId(3))).not.toHaveProperty(
      'JellyportLibraryIds',
    );
    expect(
      (await readFile(source.output)).includes(Buffer.from('never-project-membership-secret')),
    ).toBe(false);
    const database = new DatabaseSync(source.output, { readOnly: true });
    expect(
      database
        .prepare('PRAGMA table_info(catalog_item_roots)')
        .all()
        .map((row) => row.name),
    ).toEqual(['id', 'root_id']);
    expect(database.prepare('SELECT version FROM catalog_index').get()?.version).toBe(2);
    database.close();
  });

  it('keeps inconsistent cached physical IDs and locations unknown instead of guessing a library', async () => {
    const source = await fixture([
      item(100, 'MediaBrowser.Controller.Entities.Folder', { Path: '/synthetic/root-a' }),
      item(101, 'MediaBrowser.Controller.Entities.Folder', { Path: '/synthetic/root-b' }),
      item(200, 'MediaBrowser.Controller.Entities.CollectionFolder', {
        Path: '/synthetic/virtual',
        Data: JSON.stringify({
          PhysicalFolderIds: [apiId(100)],
          PhysicalLocationsList: ['/synthetic/virtual', '/synthetic/root-b'],
        }),
      }),
      item(1, undefined, { TopParentId: id(100) }),
      item(2, undefined, { TopParentId: id(101) }),
    ]);
    await importJellyfinBackupCatalog(source.archive, source.output);
    await buildJellyfinCatalogIndex(source.output);
    const candidates = await readJellyfinCatalogCandidates(
      source.output,
      projected(source.output).items,
    );
    expect(candidates.every((item) => !Object.hasOwn(item, 'JellyportLibraryIds'))).toBe(true);
  });

  it.each([
    ['/Synthetic/Root', '/synthetic/root', true],
    ['/synthetic/café', '/synthetic/café', true],
    ['/synthetic/Ä', '/synthetic/ä', false],
  ])(
    'handles verified ASCII case changes while leaving unverified Unicode case unknown',
    async (rootPath, location, known) => {
      const source = await fixture([
        item(100, 'MediaBrowser.Controller.Entities.Folder', { Path: rootPath }),
        item(200, 'MediaBrowser.Controller.Entities.CollectionFolder', {
          Path: '/synthetic/Virtual',
          Data: JSON.stringify({
            PhysicalFolderIds: [apiId(100)],
            PhysicalLocationsList: ['/SYNTHETIC/VIRTUAL', location],
          }),
        }),
        item(1, undefined, { TopParentId: id(100) }),
      ]);
      await importJellyfinBackupCatalog(source.archive, source.output);
      await buildJellyfinCatalogIndex(source.output);
      const [candidate] = await readJellyfinCatalogCandidates(
        source.output,
        projected(source.output).items,
      );
      if (known) {
        expect(candidate?.JellyportLibraryIds).toEqual([apiId(200)]);
        expect(candidate?.JellyportLibraryConfigHash).toBe(
          jellyfinLibraryConfigHash([{ id: apiId(200), locations: [String(location)] }]),
        );
      } else expect(candidate).not.toHaveProperty('JellyportLibraryIds');
    },
  );

  it('leaves ASCII case-colliding physical paths unknown even when one cached ID matches', async () => {
    const source = await fixture([
      item(100, 'MediaBrowser.Controller.Entities.Folder', { Path: '/synthetic/Root' }),
      item(101, 'MediaBrowser.Controller.Entities.Folder', { Path: '/synthetic/root' }),
      item(200, 'MediaBrowser.Controller.Entities.CollectionFolder', {
        Path: '/synthetic/virtual',
        Data: JSON.stringify({
          PhysicalFolderIds: [apiId(100)],
          PhysicalLocationsList: ['/synthetic/virtual', '/SYNTHETIC/ROOT'],
        }),
      }),
      item(1, undefined, { TopParentId: id(100) }),
      item(2, undefined, { TopParentId: id(101) }),
    ]);
    await importJellyfinBackupCatalog(source.archive, source.output);
    await buildJellyfinCatalogIndex(source.output);
    const candidates = await readJellyfinCatalogCandidates(
      source.output,
      projected(source.output).items,
    );
    expect(candidates.every((item) => !Object.hasOwn(item, 'JellyportLibraryIds'))).toBe(true);
  });

  it.each([
    { PhysicalFolderIds: ['not-an-id'], PhysicalLocationsList: ['/synthetic/root'] },
    { PhysicalFolderIds: [apiId(100), apiId(100)], PhysicalLocationsList: ['/synthetic/root'] },
    { PhysicalFolderIds: [apiId(100)], PhysicalLocationsList: ['/synthetic/\u0000root'] },
    { PhysicalFolderIds: [apiId(100)] },
  ])(
    'rejects unsupported or malformed physical-membership fields without publishing a projection',
    async (data) => {
      const source = await fixture([
        item(1),
        item(200, 'MediaBrowser.Controller.Entities.CollectionFolder', {
          Data: JSON.stringify(data),
        }),
      ]);
      await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
        'invalid catalog',
      );
      await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('supports every migration media type without guessing CLR suffixes', async () => {
    const types = [
      'Movies.Movie',
      'TV.Episode',
      'TV.Series',
      'TV.Season',
      'Audio.Audio',
      'Audio.MusicAlbum',
      'Audio.MusicArtist',
      'MusicVideo',
      'Video',
      'Book',
      'AudioBook',
      'Photo',
      'PhotoAlbum',
      'Movies.BoxSet',
      'Trailer',
    ];
    const source = await fixture(
      types
        .map((type, index) => item(index + 1, `MediaBrowser.Controller.Entities.${type}`))
        .concat([item(100, 'Untrusted.Custom.Movie')]),
    );
    const result = await importJellyfinBackupCatalog(source.archive, source.output);
    expect(result.stats.projectedItems).toBe(15);
    expect(result.stats.ignoredRows).toBe(1);
    expect(projected(source.output).items.map((value) => value.Type)).toEqual(
      types.map((value) => value.split('.').at(-1)),
    );
  });

  it('preserves legitimate long display names within a bounded catalog item', async () => {
    const name = 'Synthetic long title '.repeat(110);
    const source = await fixture([item(1, undefined, { Name: name })]);
    await importJellyfinBackupCatalog(source.archive, source.output);
    expect(projected(source.output).items[0]!.Name).toBe(name);
    const oversized = await fixture([item(1, undefined, { Name: 'n'.repeat(8193) })]);
    await expect(importJellyfinBackupCatalog(oversized.archive, oversized.output)).rejects.toThrow(
      'invalid catalog',
    );
  });

  it.each([
    ['duplicate item IDs', [item(1), item(1)], []],
    [
      'duplicate ignored item IDs',
      [
        item(1),
        item(2, 'MediaBrowser.Controller.Entities.Person'),
        item(2, 'MediaBrowser.Controller.Entities.Person'),
      ],
      [],
    ],
    ['invalid item ID', [item(1, undefined, { Id: 'invalid-private-id' })], []],
    ['invalid numbering', [item(1, undefined, { IndexNumber: -1 })], []],
    ['invalid top parent', [item(1, undefined, { TopParentId: 'invalid-private-parent' })], []],
    [
      'unknown provider item',
      [item(1)],
      [{ ItemId: id(2), ProviderId: 'Tmdb', ProviderValue: '1' }],
    ],
    [
      'duplicate provider keys',
      [item(1)],
      [
        { ItemId: id(1), ProviderId: 'Tmdb', ProviderValue: '1' },
        { ItemId: id(1), ProviderId: 'tmdb', ProviderValue: '2' },
      ],
    ],
    [
      'missing series reference',
      [item(2, 'MediaBrowser.Controller.Entities.TV.Episode', { SeriesId: id(1) })],
      [],
    ],
    [
      'invalid series reference',
      [item(1), item(2, 'MediaBrowser.Controller.Entities.TV.Episode', { SeriesId: id(1) })],
      [],
    ],
    [
      'invalid episode extra data',
      [item(1, 'MediaBrowser.Controller.Entities.TV.Episode', { Data: '{private invalid' })],
      [],
    ],
    [
      'oversized irrelevant string',
      [item(1, undefined, { Overview: 'a'.repeat(1024 * 1024 + 1) })],
      [],
    ],
  ])('rejects %s and never leaves a partial projection', async (_label, items, providers) => {
    const source = await fixture(items, providers);
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'The Jellyfin backup has an unsupported or invalid catalog.',
    );
    await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { ...manifest, ServerVersion: '12.3.0.0' },
    { ...manifest, BackupEngineVersion: '0.3.0' },
    { ...manifest, DateCreated: 'not-a-date' },
    { ...manifest, Options: { Database: false } },
  ])('rejects unverified manifest formats', async (value) => {
    const source = await fixture([item(1)], [], [], value);
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
  });

  it.each([
    { name: '../private.json', text: '{}' },
    { name: 'Database\\other.json', text: '{}' },
    { name: 'database/baseitems.json', text: '[]' },
    { name: 'link', text: 'elsewhere', mode: 0o120777 },
  ])('rejects unsafe or ambiguous archive entries', async (extra) => {
    const source = await fixture([item(1)], [], [extra]);
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
  });

  it('validates CRC and actual selected-entry sizes', async () => {
    const source = await fixture([item(1)]);
    source.entries[1]!.corruptCrc = true;
    await writeFile(source.archive, zip(source.entries));
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
    await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects false selected-entry size declarations', async () => {
    const source = await fixture([item(1)]);
    source.entries[1]!.declaredSize = 5;
    await writeFile(source.archive, zip(source.entries));
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
    await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed or ambiguous JSON without buffering a full table', async () => {
    for (const text of [
      '{}',
      '[1]',
      '[null]',
      '[]{}',
      `[{"Id":"${id(1)}","Id":"${id(2)}","Type":"MediaBrowser.Controller.Entities.Movies.Movie"}]`,
      JSON.stringify([
        item(1, undefined, {
          extra: Array.from({ length: 20 }).reduce((value) => [value], [] as unknown[]),
        }),
      ]),
    ]) {
      const source = await fixture([item(1)]);
      source.entries[1]!.text = text;
      await writeFile(source.archive, zip(source.entries));
      await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
        'invalid catalog',
      );
    }
  });

  it('bounds a single ignored field before assembling it', async () => {
    const source = await fixture([item(1, undefined, { Overview: 'z'.repeat(1024 * 1024 + 1) })]);
    // Stored form bypasses the separate compression-ratio guard so this tests token limits.
    source.entries[1]!.stored = true;
    await writeFile(source.archive, zip(source.entries));
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
  });

  it('bounds keys and numeric literals incrementally, including ignored nested fields', async () => {
    for (const text of [
      `[{"Id":"${id(1)}","Type":"MediaBrowser.Controller.Entities.Movies.Movie","${'k'.repeat(1025)}":0}]`,
      `[{"Id":"${id(1)}","Type":"MediaBrowser.Controller.Entities.Movies.Movie","ignored":{"${'k'.repeat(1025)}":0}}]`,
      `[{"Id":"${id(1)}","Type":"MediaBrowser.Controller.Entities.Movies.Movie","ignored":${'9'.repeat(65)}}]`,
      `[{"Id":"${id(1)}","Type":"MediaBrowser.Controller.Entities.Movies.Movie","ignored":[${'9'.repeat(65)}]}]`,
    ]) {
      const source = await fixture([item(1)]);
      source.entries[1]!.text = text;
      source.entries[1]!.stored = true;
      await writeFile(source.archive, zip(source.entries));
      await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
        'invalid catalog',
      );
      await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects invalid UTF-8 rather than altering catalog identifiers or paths', async () => {
    const source = await fixture([item(1)]);
    const text = JSON.stringify([item(1)]);
    source.entries[1]!.data = Buffer.concat([
      Buffer.from(text.slice(0, -1)),
      Buffer.from([0xff]),
      Buffer.from(']'),
    ]);
    await writeFile(source.archive, zip(source.entries));
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
  });

  it('rejects input mutation during extraction and leaves the last input bytes untouched', async () => {
    const source = await fixture([item(1)]);
    const before = await readFile(source.archive);
    let changed = false;
    await expect(
      importJellyfinBackupCatalog(source.archive, source.output, {
        onProgress() {
          if (!changed) {
            changed = true;
            const later = new Date(Date.now() + 10_000);
            utimesSync(source.archive, later, later);
          }
        },
      }),
    ).rejects.toThrow('invalid catalog');
    expect(await readFile(source.archive)).toEqual(before);
    await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects excessive entry counts and compression expansion before table reads', async () => {
    const many = await fixture(
      [item(1)],
      [],
      Array.from({ length: 510 }, (_value, number) => ({
        name: `unused/${number}.json`,
        text: '{}',
      })),
    );
    await expect(importJellyfinBackupCatalog(many.archive, many.output)).rejects.toThrow(
      'invalid catalog',
    );
    const expanded = await fixture(
      [item(1)],
      [],
      [{ name: 'unused/bomb.txt', text: 'z'.repeat(2 * 1024 * 1024) }],
    );
    await expect(importJellyfinBackupCatalog(expanded.archive, expanded.output)).rejects.toThrow(
      'invalid catalog',
    );
  });

  it('does not read unrelated account/session tables, even if their contents are corrupt', async () => {
    const source = await fixture(
      [item(1)],
      [],
      [{ name: 'Database/Users.json', text: 'private-invalid-json', corruptCrc: true }],
    );
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).resolves.toMatchObject(
      { stats: { projectedItems: 1 } },
    );
  });

  it('rejects symlinked archives and preserves pre-existing outputs', async () => {
    const source = await fixture([item(1)]);
    const link = join(source.directory, 'linked.zip');
    await symlink(source.archive, link);
    await expect(importJellyfinBackupCatalog(link, source.output)).rejects.toThrow(
      'invalid catalog',
    );
    await writeFile(source.output, 'existing foreign output');
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'invalid catalog',
    );
    expect(await readFile(source.output, 'utf8')).toBe('existing foreign output');
  });

  it('sanitizes malformed ZIP failures and does not create output', async () => {
    const source = await fixture([item(1)]);
    await writeFile(source.archive, 'malformed synthetic private archive');
    await expect(importJellyfinBackupCatalog(source.archive, source.output)).rejects.toThrow(
      'The Jellyfin backup has an unsupported or invalid catalog.',
    );
    await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels an import promptly without adopting its partial projection', async () => {
    const source = await fixture(
      Array.from({ length: 10_000 }, (_value, index) => item(index + 1)),
    );
    const controller = new AbortController();
    let canceledAt = 0;
    await expect(
      importJellyfinBackupCatalog(source.archive, source.output, {
        signal: controller.signal,
        onProgress(event) {
          if (event.sourceRows === 1) {
            setTimeout(() => {
              canceledAt = performance.now();
              controller.abort();
            }, 0);
          }
        },
      }),
    ).rejects.toThrow('import canceled');
    expect(performance.now() - canceledAt).toBeLessThan(1000);
    await expect(stat(source.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps observer exceptions from changing the validated result', async () => {
    const source = await fixture([item(1)]);
    await expect(
      importJellyfinBackupCatalog(source.archive, source.output, {
        onProgress() {
          throw new Error('observer-private');
        },
      }),
    ).resolves.toMatchObject({ stats: { projectedItems: 1 } });
  });
});
