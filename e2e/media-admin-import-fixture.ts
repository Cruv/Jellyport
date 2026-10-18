import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createApp, type JellyportApp } from '../server/main';
import { DemoServers } from '../server/demo';
import { DEFAULT_SETTINGS } from '../server/types';
import type { JellyfinAuthentication } from '../server/jellyfin-auth';
import type { SourceSnapshots } from '../server/source-snapshots';
import type { DestinationCatalogs } from '../server/destination-catalogs';

export const sourceMember = '00112233445566778899aabbccddeeff';
export const destinationMember = '112233445566778899aabbccddeeff00';
export const movieId = '00000001000000000000000000000001';
const protectedMovieId = '00000002000000000000000000000001';
const sourceServer = 'ffeeddccbbaa99887766554433221100';
const destinationServer = 'ffeeddccbbaa99887766554433221111';
const templateUser = '2233445566778899aabbccddeeff0011';
const username = 'synthetic_member';
type Kind = 'emby' | 'jellyfin';
type BackupState = 'valid' | 'missing' | 'incomplete' | 'expired';

// Small independently generated ZIPs exercise the actual archive validator.
function archive(entries: Array<{ name: string; text: string }>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      raw = Buffer.from(entry.text),
      compressed = deflateRawSync(raw);
    const checksum = crc32(raw),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export interface ImportFixture {
  readonly app: JellyportApp;
  readonly client: APIRequestContext;
  readonly url: string;
  readonly backupAt: string;
  readonly servers: DemoServers;
  readonly exchange: string;
  readonly writes: Array<{ user: string; item: string }>;
  backup: (kind: Kind, state: BackupState) => Promise<void>;
  restart: () => Promise<void>;
  stopHelper: () => Promise<void>;
  helperImports: () => number;
  sourceStatus: () => ReturnType<SourceSnapshots['status']>;
  destinationStatus: () => ReturnType<DestinationCatalogs['status']>;
}

// Real helper/worker/filesystem boundaries; media and administrator identities
// are synthetic. The fixture accepts no external URL, credential or backup path.
export const test = base.extend<{ imports: ImportFixture }>({
  imports: async ({ playwright }, use) => {
    const inherited = new Map<string, string>();
    for (const name of Object.keys(process.env))
      if (name.startsWith('JELLYPORT_') || name === 'TZ') {
        inherited.set(name, process.env[name]!);
        delete process.env[name];
      }
    let directory: string | undefined,
      app: JellyportApp | undefined,
      client: APIRequestContext | undefined;
    let helper: ChildProcess | undefined, helperClosed: Promise<void> | undefined;
    let helperOutput = '',
      completedImports = 0;
    const helperPath = resolve('dist/server/snapshot-helper.js');
    try {
      await readFile(helperPath);
      directory = await mkdtemp(join(tmpdir(), 'jellyport-real-import-browser-'));
      const dataDir = join(directory, 'app'),
        exchange = join(directory, 'exchange'),
        work = join(directory, 'work');
      const sourceBackups = join(directory, 'emby-backups'),
        destinationBackups = join(directory, 'jellyfin-backups');
      for (const path of [exchange, work, sourceBackups, destinationBackups])
        await mkdir(path, { recursive: true, mode: 0o700 });
      const backupAt = new Date(Date.now() - 60 * 60_000).toISOString();
      const schema = await readFile(resolve('tests-ts/fixtures/emby-4.10.1.0-schema.sql'), 'utf8');
      async function backup(kind: Kind, state: BackupState) {
        if (kind === 'emby') {
          const full = join(sourceBackups, 'embyserver-backup-full'),
            data = join(full, 'data');
          await rm(full, { recursive: true, force: true });
          if (state === 'missing') return;
          await mkdir(data, { recursive: true, mode: 0o700 });
          const library = new DatabaseSync(join(data, 'library.db'));
          try {
            library.exec(schema.slice(0, schema.indexOf('CREATE TABLE LocalUsersv2')));
            library.exec(`
              INSERT INTO UserDataKeys2(Id,UserDataKey) VALUES (1,'synthetic-one'),(2,'synthetic-two');
              INSERT INTO MediaItems(Id,type,Name,Path,ProviderIds,UserDataKeyId) VALUES
                (1,5,'Synthetic first movie','/synthetic/one.mkv','Tmdb=424242',1),
                (2,5,'Synthetic protected movie','/synthetic/two.mkv','Tmdb=434343',2);
              INSERT INTO UserDatas(UserDataKeyId,userId,played,playCount,isFavorite,HideFromResume,playbackPositionTicks,LastPlayedDateInt,RatingLastModified,PlaystateLastModified) VALUES
                (1,1,1,1,0,0,0,0,0,0),(2,1,0,0,0,0,0,0,0,0);
            `);
          } finally {
            library.close();
          }
          const users = new DatabaseSync(join(data, 'users.db'));
          try {
            users.exec(
              'CREATE TABLE LocalUsersv2 (Id INTEGER PRIMARY KEY AUTOINCREMENT,guid BLOB NOT NULL,data TEXT NOT NULL) STRICT;',
            );
            users
              .prepare('INSERT INTO LocalUsersv2 VALUES (1,?,?)')
              .run(
                Buffer.from('33221100554477668899aabbccddeeff', 'hex'),
                'synthetic-private-account-data',
              );
          } finally {
            users.close();
          }
          await writeFile(join(data, 'device.txt'), sourceServer);
          await writeFile(
            join(full, 'backupinfo.json'),
            JSON.stringify({
              ServerVersion: '4.10.1.0',
              PluginVersion: '1.8.7.0',
              CanRestore: state !== 'incomplete',
              IsFullBackup: true,
              DateCreated:
                state === 'expired'
                  ? new Date(Date.now() - 49 * 60 * 60_000).toISOString()
                  : backupAt,
              Users: [{ Id: sourceMember, Name: username }],
            }),
          );
          const settled = new Date(Date.now() - 6 * 60_000);
          for (const path of [
            'backupinfo.json',
            'data/device.txt',
            'data/library.db',
            'data/users.db',
          ])
            await utimes(join(full, path), settled, settled);
          return;
        }
        if (state === 'valid' || state === 'missing')
          for (const name of await readdir(destinationBackups))
            await rm(join(destinationBackups, name));
        if (state === 'missing') return;
        const stamp = new Date(Date.now() - (state === 'valid' ? 60 : 30) * 60_000)
          .toISOString()
          .slice(0, 19)
          .replaceAll(/[-:T]/g, '');
        const path = join(destinationBackups, `jellyfin-backup-${stamp}.zip`);
        await writeFile(
          path,
          state === 'incomplete'
            ? Buffer.from('synthetic-truncated-zip')
            : archive([
                {
                  name: 'manifest.json',
                  text: JSON.stringify({
                    ServerVersion: '12.2.0.0',
                    BackupEngineVersion: '0.2.0',
                    DateCreated:
                      state === 'expired'
                        ? new Date(Date.now() - 49 * 60 * 60_000).toISOString()
                        : backupAt,
                    DatabaseTables: ['DbSet`1'],
                    Options: {
                      Database: true,
                      Metadata: false,
                      Subtitles: false,
                      Trickplay: false,
                    },
                  }),
                },
                {
                  name: 'Database/BaseItems.json',
                  text: JSON.stringify([
                    {
                      Id: '00000001-0000-0000-0000-000000000001',
                      Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
                      Name: 'Synthetic first movie',
                      Path: '/synthetic/one.mkv',
                    },
                    {
                      Id: '00000002-0000-0000-0000-000000000001',
                      Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
                      Name: 'Synthetic protected movie',
                      Path: '/synthetic/two.mkv',
                    },
                  ]),
                },
                {
                  name: 'Database/BaseItemProviders.json',
                  text: JSON.stringify([
                    {
                      ItemId: '00000001-0000-0000-0000-000000000001',
                      ProviderId: 'Tmdb',
                      ProviderValue: '424242',
                    },
                    {
                      ItemId: '00000002-0000-0000-0000-000000000001',
                      ProviderId: 'Tmdb',
                      ProviderValue: '434343',
                    },
                  ]),
                },
              ]),
        );
      }
      await backup('emby', 'valid');
      await backup('jellyfin', 'valid');
      process.env.TZ = 'Etc/UTC';
      process.env.JELLYPORT_SNAPSHOT_DIR = exchange;
      process.env.JELLYPORT_JELLYFIN_CATALOG_MODE = 'backup';
      const servers = new DemoServers();
      servers.users.emby = [{ Id: sourceMember, Name: username, Policy: {} }];
      servers.users.jellyfin = [
        {
          Id: destinationMember,
          Name: username,
          Policy: { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true },
          Configuration: {},
        },
        {
          Id: templateUser,
          Name: 'Synthetic member template',
          Policy: { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true },
          Configuration: {},
        },
      ];
      servers.media = [
        {
          Id: movieId,
          Name: 'Synthetic first movie',
          Type: 'Movie',
          Path: '/synthetic/one.mkv',
          ProviderIds: { Tmdb: '424242' },
        },
        {
          Id: protectedMovieId,
          Name: 'Synthetic protected movie',
          Type: 'Movie',
          Path: '/synthetic/two.mkv',
          ProviderIds: { Tmdb: '434343' },
        },
      ];
      servers.played = { [destinationMember]: new Set([protectedMovieId]) };
      const writes: ImportFixture['writes'] = [];
      const identity = {
        serverId: destinationServer,
        userId: 'synthetic-admin',
        username: 'admin',
        accessToken: 'synthetic-interactive-token',
      };
      const authClient: JellyfinAuthentication = {
        authenticate: async (_url, name) => {
          if (name !== 'admin') throw new Error('Synthetic administrator required.');
          return identity;
        },
        validateSession: async () => identity,
        signOut: async () => {},
        validateApiKey: async () => ({ serverId: destinationServer, apiKeyName: 'synthetic' }),
      };
      async function create(port = 0) {
        app = await createApp({
          demo: false,
          dataDir,
          secureCookie: false,
          allowedHosts: ['127.0.0.1'],
          authClient,
          clientFactory: (url, key, kind = 'jellyfin') => {
            const media = servers.factory(url, key, kind);
            media.systemInfo = async () => ({
              Id: kind === 'emby' ? sourceServer : destinationServer,
              Version: kind === 'emby' ? '4.10.1.0' : '12.2.0.0',
            });
            media.catalogItems = async () => {
              throw new Error('Live catalog scans are prohibited in this saved-backup fixture.');
            };
            if (kind === 'emby')
              media.migrationItems = async () => {
                throw new Error(
                  'Live source history scans are prohibited in this saved-backup fixture.',
                );
              };
            const mark = media.markPlayed.bind(media);
            media.markPlayed = async (user, item, date) => {
              writes.push({ user, item });
              await mark(user, item, date);
            };
            return media;
          },
        });
        const pending = app.jellyport.store.authState();
        if (pending?.kind === 'pending') {
          app.jellyport.store.completeAuth(
            pending.generation,
            {
              kind: 'configured',
              serverUrl: 'http://jellyfin.example.invalid',
              serverId: destinationServer,
              apiKeyName: 'synthetic',
            },
            () => ({
              ...structuredClone(DEFAULT_SETTINGS),
              emby_url: 'http://emby.example.invalid',
              emby_api_key: 'synthetic-source-key',
              jellyfin_url: 'http://jellyfin.example.invalid',
              jellyfin_api_key: 'synthetic-destination-key',
              template_user_id: templateUser,
            }),
          );
          await app.jellyport.service.start();
        }
        return app.listen({ host: '127.0.0.1', port });
      }
      let url = await create();
      const marker = join(directory, 'network-attempt'),
        guard = join(directory, 'deny-helper-network.mjs');
      await writeFile(
        guard,
        `import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module'; import {appendFileSync} from 'node:fs';
const denied=()=>{appendFileSync(${JSON.stringify(marker)},'attempt\\n');throw new Error('Network access prohibited in synthetic helper.');};
globalThis.fetch=denied;net.Socket.prototype.connect=denied;http.request=denied;http.get=denied;https.request=denied;https.get=denied;dgram.Socket.prototype.send=denied;
for(const object of [dns,dns.promises]) for(const name of Object.keys(object)) if(name==='lookup'||name.startsWith('resolve')||name==='reverse') object[name]=denied;syncBuiltinESMExports();`,
        { mode: 0o600 },
      );
      helper = fork(helperPath, [], {
        execArgv: [],
        cwd: directory,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH,
          TZ: 'Etc/UTC',
          NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
          JELLYPORT_SNAPSHOT_DIR: exchange,
          JELLYPORT_SNAPSHOT_WORK_DIR: work,
          JELLYPORT_SNAPSHOT_METHOD: 'plugin_backup',
          JELLYPORT_EMBY_BACKUP_DIR: sourceBackups,
          JELLYPORT_JELLYFIN_BACKUP_DIR: destinationBackups,
          JELLYPORT_EMBY_VERSION: '4.10.1.0',
        },
      });
      helperClosed = new Promise<void>((done, reject) => {
        helper!.once('close', () => done());
        helper!.once('error', reject);
      });
      helperClosed.catch(() => {});
      let partial = '';
      helper.stdout?.on('data', (bytes: Buffer) => {
        partial += bytes.toString();
        const lines = partial.split('\n');
        partial = lines.pop()!;
        for (const line of lines) {
          helperOutput = (helperOutput + line + '\n').slice(-8192);
          try {
            const event = JSON.parse(line);
            if (event.event === 'destination_catalog_import' && event.outcome === 'completed')
              completedImports++;
          } catch {
            /* non-JSON diagnostics remain bounded */
          }
        }
      });
      helper.stderr?.on('data', (bytes: Buffer) => {
        helperOutput = (helperOutput + bytes.toString()).slice(-8192);
      });
      await expect
        .poll(async () => (await app!.jellyport.service.destinationSnapshots.status()).available, {
          timeout: 10_000,
        })
        .toBe(true);
      async function signIn() {
        client = await playwright.request.newContext({ baseURL: url });
        const anonymous = await client.get('/api/session');
        const login = await client.post('/api/login', {
          headers: { 'X-CSRF-Token': (await anonymous.json()).csrf_token },
          data: { username: 'admin', password: 'synthetic-admin-password' },
        });
        expect(login.ok()).toBe(true);
      }
      await signIn();
      async function stopHelper() {
        if (helper && helper.exitCode === null && helper.signalCode === null)
          helper.kill('SIGTERM');
        const force = setTimeout(() => helper?.kill('SIGKILL'), 2000);
        try {
          await helperClosed;
        } finally {
          clearTimeout(force);
        }
        await rm(join(exchange, 'helper.status'), { force: true });
      }
      await use({
        get app() {
          return app!;
        },
        get client() {
          return client!;
        },
        get url() {
          return url;
        },
        backupAt,
        servers,
        exchange,
        writes,
        backup,
        restart: async () => {
          const port = Number(new URL(url).port);
          await client?.dispose();
          await app?.close();
          app = undefined;
          url = await create(port);
          await signIn();
        },
        stopHelper,
        helperImports: () => completedImports,
        sourceStatus: () => app!.jellyport.service.sourceSnapshots.status(),
        destinationStatus: () => app!.jellyport.service.destinationSnapshots.status(),
      });
      expect(await readdir(directory), 'Helper must never attempt network access.').not.toContain(
        'network-attempt',
      );
      expect(helperOutput).not.toContain('synthetic-private-account-data');
    } finally {
      if (helper && helper.exitCode === null && helper.signalCode === null) helper.kill('SIGTERM');
      const force = setTimeout(() => helper?.kill('SIGKILL'), 2000);
      try {
        await helperClosed;
      } finally {
        clearTimeout(force);
        await Promise.allSettled([client?.dispose(), app?.close()]);
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          for (const name of Object.keys(process.env))
            if (name.startsWith('JELLYPORT_') || name === 'TZ') delete process.env[name];
          for (const [name, value] of inherited) process.env[name] = value;
        }
      }
    }
  },
  baseURL: async ({ imports }, use) => use(imports.url),
  storageState: async ({ imports }, use) => use(await imports.client.storageState()),
  page: async ({ page, imports }, use) => {
    const failures: string[] = [];
    await page.context().route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== imports.url) {
        failures.push('Unexpected external browser request.');
        await route.abort();
      } else await route.continue();
    });
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500)
        failures.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    await use(page);
    expect(failures, 'No crashes, server errors or external requests.').toEqual([]);
  },
});

export { expect };
export { navigate, expectContainedLayout } from './fixtures';
