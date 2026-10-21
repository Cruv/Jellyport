import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main';
import { DemoServers } from '../server/demo';
import { MediaError } from '../server/errors';
import { DEFAULT_SETTINGS } from '../server/types';
import type { BotAdapter } from '../server/service';
import type { JellyfinAuthentication } from '../server/jellyfin-auth';
import type { MediaUserDataPatch } from '../server/media';

export const paidOwner = '111111111111111111';
export const guestOwner = '222222222222222222';
const members = [
  { id: paidOwner, username: 'crew_owner' },
  { id: guestOwner, username: 'family_guest' },
];

export interface AdminFixture {
  app: JellyportApp;
  servers: DemoServers;
  url: string;
  client: APIRequestContext;
  writes: Array<{ kind: string; method: string; id: string }>;
  cloneHistoryReads: string[];
  stateWrites: Array<{ user: string; item: string; value: MediaUserDataPatch }>;
  createdCredentials: Array<{ username: string; password: string }>;
  loseCreateResponse: (name: string) => void;
  loseRenameReadback: (name: string) => void;
}

// Writable end-to-end fixtures exercise the real HTTP handlers, Store and workers.
// Every media/auth/bot dependency is synthetic; no production target is accepted.
export const test = base.extend<{ admin: AdminFixture; mutations: string[] }>({
  admin: async ({ playwright }, use) => {
    const inherited = new Map<string, string>();
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('JELLYPORT_')) {
        inherited.set(name, process.env[name]!);
        delete process.env[name];
      }
    }
    let directory: string | undefined;
    let app: JellyportApp | undefined;
    let client: APIRequestContext | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'jellyport-admin-browser-'));
      const servers = new DemoServers();
      servers.users.jellyfin[0]!.Policy = {
        IsAdministrator: false,
        IsDisabled: false,
        EnableAllFolders: true,
        EnableMediaPlayback: true,
        EnableContentDownloading: false,
      };
      servers.users.jellyfin.push({
        Id: 'j-other',
        Name: 'other_member',
        Policy: { IsAdministrator: false, IsDisabled: false, EnableMediaPlayback: false },
        Configuration: { SubtitleMode: 'None' },
      });
      const writes: AdminFixture['writes'] = [];
      const cloneHistoryReads: string[] = [];
      const stateWrites: AdminFixture['stateWrites'] = [];
      const createdCredentials: AdminFixture['createdCredentials'] = [];
      let loseName: string | null = null;
      let loseRenameName: string | null = null;
      let lostRenameReadbackId: string | null = null;
      const identity = {
        serverId: 'demo-jellyfin',
        userId: 'synthetic-admin',
        username: 'admin',
        accessToken: 'synthetic-interactive-token',
      };
      const authClient: JellyfinAuthentication = {
        authenticate: async (_url, username) => {
          if (username !== 'admin') throw new Error('Synthetic administrator required.');
          return identity;
        },
        validateSession: async () => identity,
        signOut: async () => {},
        validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
      };
      app = await createApp({
        demo: false,
        dataDir: directory,
        secureCookie: false,
        allowedHosts: ['127.0.0.1'],
        authClient,
        stripeClientFactory: () => ({
          mode: 'test',
          snapshot: async () => ({
            mode: 'test',
            completed_at: new Date().toISOString(),
            products: [{ id: 'prod_Crew', name: 'Synthetic crew plan', active: true }],
            subscriptions: Array.from({ length: 24 }, (_, index) => ({
              id: `sub_Crew${index}`,
              customer_id: `cus_Crew${index}`,
              customer_name: index === 0 ? 'Synthetic crew owner' : `Synthetic member ${index}`,
              customer_email: `crew${index}@example.test`,
              status: 'active',
              collection_method: 'charge_automatically' as const,
              pause_collection: index === 0,
              cancel_at_period_end: false,
              items: [
                {
                  id: `si_Crew${index}`,
                  price_id: 'price_Crew',
                  product_id: 'prod_Crew',
                  quantity: 1,
                },
              ],
              identity_candidates: [
                {
                  discord_user_id: paidOwner,
                  source: 'subscription_metadata' as const,
                  field: 'discord_user_id',
                },
              ],
            })),
          }),
          checkoutIdentityCandidates: async () => [],
        }),
        clientFactory: (url, key, kind) => {
          const client = servers.factory(url, key, kind);
          if (url.includes('offline'))
            client.systemInfo = async () => {
              throw new MediaError('Synthetic offline server.');
            };
          const create = client.createUser.bind(client);
          const readUser = client.user.bind(client);
          client.user = async (id) => {
            if (id === lostRenameReadbackId) {
              lostRenameReadbackId = null;
              throw new MediaError('Synthetic connection lost during rename confirmation.');
            }
            return readUser(id);
          };
          client.createUser = async (name, password) => {
            writes.push({ kind: kind || 'jellyfin', method: 'create', id: name });
            const user = await create(name, password);
            createdCredentials.push({ username: name, password });
            if (name === loseName) {
              loseName = null;
              throw new MediaError('Synthetic connection lost after account creation.');
            }
            return user;
          };
          const clonePlayedItems = client.clonePlayedItems!.bind(client);
          client.clonePlayedItems = async (id) => {
            cloneHistoryReads.push(id);
            return clonePlayedItems(id);
          };
          const updateUserData = client.updateUserData!.bind(client);
          client.updateUserData = async (user, item, value) => {
            stateWrites.push({ user, item, value: structuredClone(value) });
            await updateUserData(user, item, value);
          };
          const renameUser = client.renameUser!.bind(client);
          client.renameUser = async (id, name, configuration) => {
            writes.push({ kind: kind || 'jellyfin', method: 'rename', id });
            await renameUser(id, name, configuration);
            if (name === loseRenameName) {
              loseRenameName = null;
              lostRenameReadbackId = id;
            }
          };
          for (const method of [
            'setPolicy',
            'setConfiguration',
            'setDisplayPreferences',
          ] as const) {
            const original = client[method]!.bind(client);
            client[method] = async (id, value) => {
              writes.push({ kind: kind || 'jellyfin', method, id });
              await original(id, value);
            };
          }
          return client;
        },
      });
      const pending = app.jellyport.store.authState();
      if (pending?.kind !== 'pending') throw new Error('Expected fresh isolated test storage.');
      app.jellyport.store.completeAuth(
        pending.generation,
        {
          kind: 'configured',
          serverUrl: 'http://jellyfin.example.invalid',
          serverId: identity.serverId,
          apiKeyName: 'synthetic',
        },
        () => ({
          ...structuredClone(DEFAULT_SETTINGS),
          emby_url: 'http://emby.example.invalid',
          emby_api_key: 'synthetic-emby-key',
          jellyfin_url: 'http://jellyfin.example.invalid',
          jellyfin_api_key: 'synthetic-jellyfin-key',
          template_user_id: 'template',
        }),
      );
      app.jellyport.service.bot = {
        status: () => ({ enabled: false, connected: true, name: 'Synthetic bot' }),
        recipientIdentity: async (id) => {
          const member = members.find((value) => value.id === id);
          if (!member) throw new Error('Unknown synthetic Discord member.');
          return member;
        },
        validateRecipient: async () => {},
        sendCredentials: async () => {},
        membershipActive: async () => true,
        activeMembers: async () => members,
        searchMembers: async (query) => ({
          members: members
            .filter((member) => member.username.includes(query.toLowerCase()))
            .map((member) => ({
              ...member,
              display_name: null,
              nickname: null,
              membership_active: true,
            })),
          truncated: false,
        }),
      } satisfies BotAdapter;
      await app.jellyport.service.start();
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      expect(new URL(url).hostname).toBe('127.0.0.1');
      client = await playwright.request.newContext({ baseURL: url });
      const anonymous = await client.get('/api/session');
      const login = await client.post('/api/login', {
        headers: { 'X-CSRF-Token': (await anonymous.json()).csrf_token },
        data: { username: 'admin', password: 'synthetic-admin-password' },
      });
      expect(login.ok()).toBe(true);
      expect((await login.json()).authenticated).toBe(true);
      await use({
        app,
        servers,
        url,
        client,
        writes,
        cloneHistoryReads,
        stateWrites,
        createdCredentials,
        loseCreateResponse: (name) => (loseName = name),
        loseRenameReadback: (name) => (loseRenameName = name),
      });
    } finally {
      try {
        await client?.dispose();
        await app?.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        for (const name of Object.keys(process.env))
          if (name.startsWith('JELLYPORT_')) delete process.env[name];
        for (const [name, value] of inherited) process.env[name] = value;
      }
    }
  },
  baseURL: async ({ admin }, use) => use(admin.url),
  storageState: async ({ admin }, use) => use(await admin.client.storageState()),
  page: async ({ page, admin }, use) => {
    const failures: string[] = [];
    await page.context().route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== admin.url) {
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
  mutations: async ({ page }, use) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method()))
        requests.push(`${request.method()} ${path}`);
    });
    await use(requests);
  },
});

export { expect };
export { navigate, expectContainedLayout } from './fixtures';
