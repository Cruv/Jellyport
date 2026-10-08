import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoServers } from '../server/demo.js';
import { MediaError } from '../server/errors.js';
import { Service, type BotAdapter, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import type { AccountRole } from '../server/account-roles.js';
import type { JsonObject, MediaUser } from '../server/media.js';
import type { RoleParameters } from '../server/role-parameters.js';

interface Call {
  method: string;
  id?: string;
  value?: JsonObject;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('saved role provisioning and controlled account updates', () => {
  let path: string, store: Store, servers: DemoServers, service: Service;
  let calls: Call[];
  let onSystemInfo: (() => Promise<void>) | undefined;
  let onUser: ((user: MediaUser) => Promise<void>) | undefined;
  let onDisplayRead: (() => Promise<void>) | undefined;
  let beforeWrite: ((method: string, id: string) => Promise<void>) | undefined;
  let serverIdentity: string;
  const releases: Array<() => void> = [];
  const parameters: RoleParameters = {
    policy: {
      IsAdministrator: false,
      EnableAllFolders: false,
      EnabledFolders: ['safe-library'],
      EnableMediaPlayback: true,
      EnableContentDownloading: false,
    },
    configuration: {
      AudioLanguagePreference: 'en',
      SubtitleLanguagePreference: 'en',
      SubtitleMode: 'Smart',
      EnableNextEpisodeAutoPlay: true,
    },
    display: {
      ShowBackdrop: true,
      CustomPrefs: { homesection0: 'resume', homesection1: 'nextup' },
    },
  };
  const sharedHomeOrder = {
    tvhome: 'vertical',
    homesection0: 'smalllibrarytiles',
    homesection1: 'resume',
    homesection2: 'nextup',
    homesection3: 'latestmedia',
    homesection4: 'resumeaudio',
    homesection5: 'resumebook',
    homesection6: 'livetv',
    homesection7: 'activerecordings',
    homesection8: 'none',
    homesection9: 'none',
  };
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'jellyport-role-service-'));
    store = new Store(path);
    servers = new DemoServers();
    calls = [];
    onSystemInfo = undefined;
    onUser = undefined;
    onDisplayRead = undefined;
    beforeWrite = undefined;
    serverIdentity = 'demo-jellyfin';
    const settings = {
      ...DEFAULT_SETTINGS,
      emby_url: 'http://emby',
      emby_api_key: 'fake-emby-key',
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'fake-jellyfin-key',
      template_user_id: '',
    };
    const pending = store.resetAuth(settings.jellyfin_url);
    expect(
      store.completeAuth(
        pending.generation,
        {
          kind: 'configured',
          serverUrl: settings.jellyfin_url,
          serverId: 'demo-jellyfin',
          apiKeyName: 'test',
        },
        () => settings,
      ),
    ).toBe(true);
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        if (args[2] === 'emby') return client;
        const originalInfo = client.systemInfo.bind(client);
        client.systemInfo = async () => {
          await onSystemInfo?.();
          return { ...(await originalInfo()), Id: serverIdentity };
        };
        const originalUser = client.user.bind(client);
        client.user = async (id) => {
          calls.push({ method: 'user', id });
          const user = await originalUser(id);
          await onUser?.(user);
          return user;
        };
        const originalCreate = client.createUser.bind(client);
        client.createUser = async (name, password) => {
          calls.push({ method: 'createUser', id: name });
          const created = await originalCreate(name, password);
          const stored = servers.users.jellyfin.find((user) => user.Id === created.Id)!;
          stored.Policy = { IsAdministrator: false, IsDisabled: false, EnableRemoteAccess: true };
          return structuredClone(stored);
        };
        for (const method of ['setPolicy', 'setConfiguration', 'setDisplayPreferences'] as const) {
          const original = client[method]!.bind(client) as (
            id: string,
            value: JsonObject,
          ) => Promise<void>;
          client[method] = async (id: string, value: JsonObject) => {
            calls.push({ method, id, value: structuredClone(value) });
            await beforeWrite?.(method, id);
            await original(id, value);
          };
        }
        const originalPassword = client.setPassword.bind(client);
        client.setPassword = async (id, password) => {
          calls.push({ method: 'setPassword', id });
          await originalPassword(id, password);
        };
        const originalDisplay = client.displayPreferences!.bind(client);
        client.displayPreferences = async (id) => {
          const value = await originalDisplay(id);
          await onDisplayRead?.();
          return value;
        };
        const originalMigrationItems = client.migrationItems!.bind(client);
        client.migrationItems = async (id) => {
          calls.push({ method: 'migrationItems', id });
          return originalMigrationItems(id);
        };
        for (const method of [
          'markPlayed',
          'updateUserData',
          'markFavorite',
          'setUserImage',
          'createPlaylist',
          'addPlaylistItems',
        ] as const) {
          const original = client[method];
          if (!original) continue;
          // Track remote mutation categories without retaining generated passwords or personal payloads.
          (client as unknown as Record<string, unknown>)[method] = async (...values: unknown[]) => {
            calls.push({ method, id: String(values[0] ?? '') });
            return (original as (...values: unknown[]) => Promise<unknown>).apply(client, values);
          };
        }
        return client;
      },
    });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await service.stop();
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  function role(asDefault = false, snapshot: RoleParameters = parameters): AccountRole {
    const saved = service.roles.save(
      { name: 'Crew members', parameters: structuredClone(snapshot) },
      store.settings(),
    );
    if (asDefault) store.saveSettings({ ...store.settings(), default_role_id: saved.id });
    return saved;
  }
  function assigned(snapshot: RoleParameters = parameters) {
    const saved = role(false, snapshot);
    const user = servers.users.jellyfin.find((entry) => entry.Id === 'j-river')!;
    const [assignment] = service.roles.assign(saved.id, saved.revision, [user], store.settings());
    return { saved, user, assignment };
  }
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  function writes() {
    return calls.filter(
      (call) =>
        call.method.startsWith('set') ||
        [
          'markPlayed',
          'updateUserData',
          'markFavorite',
          'createUser',
          'createPlaylist',
          'addPlaylistItems',
        ].includes(call.method),
    );
  }
  function gateInfoAt(ordinal: number) {
    const entered = deferred(),
      release = deferred();
    releases.push(release.resolve);
    let count = 0;
    onSystemInfo = async () => {
      if (++count === ordinal) {
        entered.resolve();
        await release.promise;
      }
    };
    return { entered: entered.promise, release: release.resolve };
  }
  function installBot() {
    const delivered: string[] = [];
    service.bot = {
      status: () => ({ connected: true }),
      validateRecipient: async () => {},
      recipientIdentity: async (id) => ({ id, username: 'alex' }),
      sendCredentials: async (id) => {
        delivered.push(id);
      },
      membershipActive: async () => true,
      activeMembers: async () => [],
    } satisfies BotAdapter;
    return delivered;
  }

  it('creates an account from a saved default without querying or retaining a template account', async () => {
    const saved = role(true);
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id !== 'template');
    const job = await finish(await service.createAccount('casey'));
    expect(job.status).toBe('completed');
    const created = servers.users.jellyfin.find((user) => user.Name === 'casey')!;
    expect(created.Policy).toMatchObject(parameters.policy);
    expect(created.Policy).toMatchObject({ IsDisabled: false, EnableRemoteAccess: true });
    expect(created.Configuration).toMatchObject(parameters.configuration);
    expect(servers.display[created.Id]).toMatchObject(parameters.display!);
    expect(
      calls.filter((call) => call.method === 'user').some((call) => call.id === 'template'),
    ).toBe(false);
    const assignment = service.roles.getAssignment(created.Id, store.settings());
    expect(assignment).toMatchObject({ role_id: saved.id, applied_revision: saved.revision });
    expect(assignment?.applied_sections).toEqual({
      policy: saved.revision,
      configuration: saved.revision,
      display: saved.revision,
    });
    const credentials = store.takeCredentials(job.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.password).toHaveLength(24);
    expect(JSON.stringify(job)).not.toContain(credentials[0]?.password);
  });
  it('lets default role preferences win over Emby preferences on new migrated accounts', async () => {
    const saved = role(true);
    const source = servers.users.emby.find((user) => user.Id === 'e-alex')!;
    source.Configuration = {
      AudioLanguagePreference: 'fr',
      SubtitleLanguagePreference: 'de',
      SubtitleMode: 'Always',
      EnableNextEpisodeAutoPlay: false,
    };
    const job = await finish(await service.migrateUsers(['e-alex']));
    expect(job.results[0]?.created).toBe(true);
    const created = servers.users.jellyfin.find((user) => user.Name === 'alex')!;
    expect(created.Configuration).toMatchObject(parameters.configuration);
    expect(servers.played[created.Id]?.size).toBeGreaterThan(0);
    expect(service.roles.getAssignment(created.Id, store.settings())?.role_id).toBe(saved.id);
    expect(job.results[0]?.data?.preferences).toEqual(Object.keys(parameters.configuration));
    expect(calls.filter((call) => call.method === 'setConfiguration')).toHaveLength(1);
  });
  it('provisions all ten shared Home sections and TV layout from a saved role without a template', async () => {
    const snapshot: RoleParameters = {
      ...parameters,
      display: { CustomPrefs: sharedHomeOrder },
    };
    const saved = role(true, snapshot);
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id !== 'template');
    const job = await finish(await service.createAccount('casey'));
    expect(job.status).toBe('completed');
    const created = servers.users.jellyfin.find((user) => user.Name === 'casey')!;
    expect(servers.display[created.Id]?.CustomPrefs).toEqual(sharedHomeOrder);
    expect(
      calls.find((call) => call.method === 'setDisplayPreferences')?.value?.CustomPrefs,
    ).toEqual(sharedHomeOrder);
    expect(service.roles.getAssignment(created.Id, store.settings())?.applied_revision).toBe(
      saved.revision,
    );
    expect(calls.some((call) => call.method === 'user' && call.id === 'template')).toBe(false);
  });
  it('previews a new migration without a template and explains that the role may limit library access', async () => {
    role(true);
    servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id !== 'template');
    const preview = await service.preview(['e-alex']);
    expect(preview.users[0]?.target_exists).toBe(false);
    expect(preview.users[0]?.stats.matched).toBeGreaterThan(0);
    expect(preview.users[0]?.warnings.join(' ')).toMatch(
      /server catalog.*role may limit library access/,
    );
    expect(calls.filter((call) => call.method === 'migrationItems')).toEqual([
      { method: 'migrationItems', id: undefined },
    ]);
    expect(writes()).toEqual([]);
  });
  it('preserves existing Jellyfin policy, preferences, home layout, and lack of role assignment during migration', async () => {
    role(true);
    const user = servers.users.jellyfin.find((entry) => entry.Id === 'j-river')!;
    user.Policy = {
      IsAdministrator: false,
      IsDisabled: false,
      EnableAllFolders: true,
      EnableContentDownloading: true,
    };
    user.Configuration = {
      AudioLanguagePreference: 'fr',
      SubtitleMode: 'None',
      EnableNextEpisodeAutoPlay: false,
    };
    servers.display[user.Id] = {
      ShowBackdrop: false,
      CustomPrefs: { homesection0: 'latestmedia', theme: 'dark' },
    };
    const before = structuredClone(user),
      home = structuredClone(servers.display[user.Id]);
    const job = await finish(await service.migrateUsers(['e-river']));
    expect(job.status).toBe('completed');
    expect(job.results[0]?.created).toBe(false);
    expect(user).toEqual(before);
    expect(servers.display[user.Id]).toEqual(home);
    expect(service.roles.getAssignment(user.Id, store.settings())).toBeNull();
    expect(
      calls.some((call) =>
        ['setPolicy', 'setConfiguration', 'setDisplayPreferences', 'setPassword'].includes(
          call.method,
        ),
      ),
    ).toBe(false);
    expect(store.takeCredentials(job.id)).toEqual([]);
  });
  it('updates only selected preference groups without changing passwords, permissions, or watch state', async () => {
    const { saved, user } = assigned();
    user.Policy!.EnableContentDownloading = true;
    user.Configuration = {
      AudioLanguagePreference: 'fr',
      EnableNextEpisodeAutoPlay: false,
      ClientSpecificOption: 'preserve',
    };
    servers.display[user.Id] = { CustomPrefs: { homesection0: 'latestmedia', theme: 'dark' } };
    servers.userData[user.Id] = {
      '1': { Played: true, PlaybackPositionTicks: 1234, IsFavorite: true },
    };
    const policy = structuredClone(user.Policy),
      home = structuredClone(servers.display[user.Id]);
    const played = structuredClone(servers.played),
      history = structuredClone(servers.userData),
      playlists = structuredClone(servers.playlists);
    const job = await finish(
      await service.applyRole(saved.id, saved.revision, [user.Id], ['configuration']),
    );
    expect(job.status).toBe('completed');
    expect(user.Policy).toEqual(policy);
    expect(user.Configuration).toMatchObject({
      ...parameters.configuration,
      ClientSpecificOption: 'preserve',
    });
    expect(servers.display[user.Id]).toEqual(home);
    expect(servers.played).toEqual(played);
    expect(servers.userData).toEqual(history);
    expect(servers.playlists).toEqual(playlists);
    expect(writes().map((call) => call.method)).toEqual(['setConfiguration']);
    expect(store.takeCredentials(job.id)).toEqual([]);
    expect(service.roles.getAssignment(user.Id, store.settings())).toMatchObject({
      applied_revision: null,
      applied_sections: { configuration: saved.revision },
    });
  });
  it('merges home screen settings while preserving unrelated current client preferences', async () => {
    const { saved, user } = assigned();
    servers.display[user.Id] = {
      ShowSidebar: true,
      CustomPrefs: { homesection0: 'latestmedia', theme: 'dark', enableExternalPlayers: 'true' },
    };
    const originalConfiguration = structuredClone(user.Configuration);
    const job = await finish(
      await service.applyRole(saved.id, saved.revision, [user.Id], ['display']),
    );
    expect(job.status).toBe('completed');
    expect(servers.display[user.Id]).toEqual({
      ShowSidebar: true,
      ShowBackdrop: true,
      CustomPrefs: {
        homesection0: 'resume',
        homesection1: 'nextup',
        theme: 'dark',
        enableExternalPlayers: 'true',
      },
    });
    expect(user.Configuration).toEqual(originalConfiguration);
    expect(writes().map((call) => call.method)).toEqual(['setDisplayPreferences']);
  });
  it('applies TV layout and the complete shared Home order ad hoc without changing other account data', async () => {
    const { saved, user } = assigned({ ...parameters, display: { CustomPrefs: sharedHomeOrder } });
    servers.display[user.Id] = {
      ShowSidebar: true,
      CustomPrefs: {
        tvhome: 'horizontal',
        homesection0: 'latestmedia',
        homesection8: 'resume',
        homesection9: 'nextup',
        theme: 'dark',
      },
    };
    servers.userData[user.Id] = {
      '1': { Played: true, PlaybackPositionTicks: 1234, IsFavorite: true },
    };
    const account = structuredClone(user);
    const played = structuredClone(servers.played),
      history = structuredClone(servers.userData),
      playlists = structuredClone(servers.playlists);
    const job = await finish(
      await service.applyRole(saved.id, saved.revision, [user.Id], ['display']),
    );
    expect(job.status).toBe('completed');
    expect(servers.display[user.Id]).toEqual({
      ShowSidebar: true,
      CustomPrefs: { ...sharedHomeOrder, theme: 'dark' },
    });
    expect(
      calls.find((call) => call.method === 'setDisplayPreferences')?.value?.CustomPrefs,
    ).toEqual({ ...sharedHomeOrder, theme: 'dark' });
    expect(user).toEqual(account);
    expect(servers.played).toEqual(played);
    expect(servers.userData).toEqual(history);
    expect(servers.playlists).toEqual(playlists);
    expect(writes().map((call) => call.method)).toEqual(['setDisplayPreferences']);
    expect(store.takeCredentials(job.id)).toEqual([]);
    expect(service.roles.getAssignment(user.Id, store.settings())).toMatchObject({
      applied_revision: null,
      applied_sections: { display: saved.revision },
    });
  });
  it('records completed groups accurately when a later write fails', async () => {
    const { saved, user } = assigned();
    const configuration = structuredClone(user.Configuration),
      home = structuredClone(servers.display[user.Id]);
    beforeWrite = async (method) => {
      if (method === 'setConfiguration') throw new Error('private-failing-server-detail');
    };
    const job = await finish(
      await service.applyRole(
        saved.id,
        saved.revision,
        [user.Id],
        ['policy', 'configuration', 'display'],
      ),
    );
    expect(job.status).toBe('failed');
    expect(job.results[0]?.role_sections).toEqual(['policy']);
    expect(user.Policy).toMatchObject(parameters.policy);
    expect(user.Configuration).toEqual(configuration);
    expect(servers.display[user.Id]).toEqual(home);
    expect(service.roles.getAssignment(user.Id, store.settings())).toMatchObject({
      applied_revision: null,
      applied_sections: { policy: saved.revision },
    });
    expect(JSON.stringify(job)).not.toContain('private-failing-server-detail');
    expect(writes().map((call) => call.method)).toEqual(['setPolicy', 'setConfiguration']);
  });
  it('retains account creation and marks only successful groups if the default home write fails', async () => {
    const saved = role(true);
    beforeWrite = async (method) => {
      if (method === 'setDisplayPreferences')
        throw new MediaError('Display preferences unavailable.', 503);
    };
    const job = await finish(await service.createAccount('casey'));
    const user = servers.users.jellyfin.find((entry) => entry.Name === 'casey')!;
    expect(user).toBeDefined();
    expect(job.results[0]?.warnings?.join(' ')).toMatch(/Home screen preferences/);
    expect(job.results[0]?.role_sections).toEqual(['policy', 'configuration']);
    expect(service.roles.getAssignment(user.Id, store.settings())).toMatchObject({
      applied_revision: null,
      applied_sections: { policy: saved.revision, configuration: saved.revision },
    });
    expect(store.takeCredentials(job.id)).toHaveLength(1);
  });
  it.each(['administrator', 'disabled', 'template', 'renamed'])(
    'treats a new account becoming %s during Home reads as fatal before Home, migration, and DM',
    async (kind) => {
      role(true);
      const delivered = installBot();
      onDisplayRead = async () => {
        const target = servers.users.jellyfin.find((user) => user.Name === 'alex')!;
        if (kind === 'administrator') target.Policy!.IsAdministrator = true;
        if (kind === 'disabled') target.Policy!.IsDisabled = true;
        if (kind === 'template')
          store.saveSettings({ ...store.settings(), template_user_id: target.Id });
        if (kind === 'renamed') target.Name = 'renamed-account';
      };
      const job = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': '123456789' }));
      expect(job.status).toBe('failed');
      expect(job.results[0]?.error).toMatch(/changed or is protected/);
      expect(writes().map((call) => call.method)).toEqual([
        'createUser',
        'setPolicy',
        'setConfiguration',
      ]);
      expect(delivered).toEqual([]);
      expect(store.link('123456789')).toBeNull();
      const targetId = job.results[0]?.target_user_id;
      expect(targetId).toBeDefined();
      expect(servers.played[targetId!]).toBeUndefined();
      expect(service.roles.getAssignment(targetId!, store.settings())?.applied_revision).toBeNull();
    },
  );
  it('stops new account provisioning when the Jellyfin server identity is replaced between role groups', async () => {
    role(true);
    const delivered = installBot();
    beforeWrite = async (method) => {
      if (method === 'setPolicy') serverIdentity = 'replacement-jellyfin';
    };
    const job = await finish(await service.migrateUsers(['e-alex'], { 'e-alex': '123456789' }));
    expect(job.status).toBe('failed');
    expect(job.results[0]?.error).toMatch(/server identity changed/);
    expect(writes().map((call) => call.method)).toEqual(['createUser', 'setPolicy']);
    expect(delivered).toEqual([]);
    expect(store.link('123456789')).toBeNull();
    expect(servers.users.jellyfin.some((user) => user.Name === 'alex')).toBe(true);
  });
  it('refuses unassigned users before queuing any remote mutation', async () => {
    const saved = role();
    await expect(
      service.applyRole(saved.id, saved.revision, ['j-river'], ['policy']),
    ).rejects.toThrow(/Assign this role/);
    expect(writes()).toEqual([]);
    expect(store.jobs()).toEqual([]);
  });
  it.each(['administrator', 'disabled', 'unknown-policy', 'template'])(
    'refuses protected %s targets even if assigned',
    async (kind) => {
      const { saved, user } = assigned();
      if (kind === 'administrator') user.Policy!.IsAdministrator = true;
      if (kind === 'disabled') user.Policy!.IsDisabled = true;
      if (kind === 'unknown-policy') user.Policy = {};
      if (kind === 'template')
        store.saveSettings({ ...store.settings(), template_user_id: user.Id });
      await expect(
        service.applyRole(saved.id, saved.revision, [user.Id], ['policy']),
      ).rejects.toThrow(/protected/);
      expect(writes()).toEqual([]);
      expect(store.jobs()).toEqual([]);
    },
  );
  it('stops queued role updates when the role revision changes before execution', async () => {
    const { saved, user } = assigned();
    const gate = gateInfoAt(2);
    const job = await service.applyRole(
      saved.id,
      saved.revision,
      [user.Id],
      ['policy', 'configuration'],
    );
    await gate.entered;
    service.roles.save({ ...saved, revision: saved.revision, name: 'Changed' }, store.settings());
    gate.release();
    const done = await finish(job);
    expect(done.status).toBe('failed');
    expect(writes()).toEqual([]);
    expect(done.results[0]?.error).toMatch(/assignment changed/);
  });
  it('stops queued role updates after assignment removal', async () => {
    const { saved, user } = assigned();
    const gate = gateInfoAt(2);
    const job = await service.applyRole(saved.id, saved.revision, [user.Id], ['configuration']);
    await gate.entered;
    service.roles.unassign([user.Id], store.settings());
    gate.release();
    const done = await finish(job);
    expect(done.status).toBe('failed');
    expect(writes()).toEqual([]);
  });
  it('stops in-flight home updates when the role changes during the fresh preference read', async () => {
    const { saved, user } = assigned();
    let changed = false;
    onDisplayRead = async () => {
      if (!changed) {
        changed = true;
        service.roles.save(
          { ...saved, revision: saved.revision, name: 'Changed' },
          store.settings(),
        );
      }
    };
    const job = await finish(
      await service.applyRole(saved.id, saved.revision, [user.Id], ['display']),
    );
    expect(job.status).toBe('failed');
    expect(writes()).toEqual([]);
    expect(service.roles.getAssignment(user.Id, store.settings())?.applied_sections).toEqual({});
  });
  it('reports a completed group when a role revision changes during its write, and stops remaining groups', async () => {
    const { saved, user } = assigned();
    beforeWrite = async (method) => {
      if (method === 'setConfiguration')
        service.roles.save(
          { ...saved, revision: saved.revision, name: 'Changed' },
          store.settings(),
        );
    };
    const job = await finish(
      await service.applyRole(saved.id, saved.revision, [user.Id], ['configuration', 'display']),
    );
    expect(job.status).toBe('failed');
    expect(job.results[0]?.role_sections).toEqual(['configuration']);
    expect(user.Configuration).toMatchObject(parameters.configuration);
    expect(writes().map((call) => call.method)).toEqual(['setConfiguration']);
    expect(service.roles.getAssignment(user.Id, store.settings())?.applied_sections).toEqual({});
  });
  it('stops after a completed write if the account becomes protected before the next group', async () => {
    const { saved, user } = assigned();
    beforeWrite = async (method) => {
      if (method === 'setPolicy')
        onUser = async (current) => {
          if (current.Id === user.Id) {
            user.Policy!.IsAdministrator = true;
            current.Policy!.IsAdministrator = true;
          }
        };
    };
    const job = await finish(
      await service.applyRole(saved.id, saved.revision, [user.Id], ['policy', 'configuration']),
    );
    expect(job.status).toBe('failed');
    expect(writes().map((call) => call.method)).toEqual(['setPolicy']);
  });
  it('stops default provisioning if its saved role is revised while the job is queued', async () => {
    const saved = role(true);
    const gate = gateInfoAt(1);
    const job = await service.createAccount('casey');
    await gate.entered;
    service.roles.save({ ...saved, revision: saved.revision, name: 'Changed' }, store.settings());
    gate.release();
    const done = await finish(job);
    expect(done.status).toBe('failed');
    expect(writes()).toEqual([]);
    expect(servers.users.jellyfin.some((user) => user.Name === 'casey')).toBe(false);
  });
  it('stops default provisioning if the selected default changes while the job is queued', async () => {
    role(true);
    const gate = gateInfoAt(1),
      job = await service.createAccount('casey');
    await gate.entered;
    store.saveSettings({ ...store.settings(), default_role_id: '' });
    gate.release();
    const done = await finish(job);
    expect(done.status).toBe('failed');
    expect(writes()).toEqual([]);
  });
});
