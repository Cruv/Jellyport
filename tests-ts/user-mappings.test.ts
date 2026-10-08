import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';
import { UserMappings, type SaveUserMapping } from '../server/user-mappings.js';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';
import type { BotAdapter } from '../server/service.js';
import type { JellyfinAuthentication } from '../server/jellyfin-auth.js';

const directories: string[] = [];
const stores: Store[] = [];
const apps: JellyportApp[] = [];
const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  emby_url: 'http://emby.example:8096',
  jellyfin_url: 'https://jellyfin.example',
  emby_api_key: 'private-emby-key',
  jellyfin_api_key: 'private-jellyfin-key',
  template_user_id: 'template',
};
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-user-mappings-'));
  directories.push(directory);
  return directory;
}
function unitFixture() {
  const directory = temporaryDirectory();
  const store = new Store(directory);
  stores.push(store);
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS user_mappings (id TEXT PRIMARY KEY,encrypted BLOB NOT NULL)',
  );
  return { directory, store, mappings: new UserMappings(store) };
}
function input(fields: Partial<SaveUserMapping> = {}): SaveUserMapping {
  return {
    source_user_id: 'source-one',
    source_username: 'private-source-user',
    target_user_id: null,
    target_username: 'private-target-user',
    discord_user_id: null,
    discord_username: null,
    ...fields,
  };
}
async function apiFixture(demo = false) {
  const directory = temporaryDirectory();
  const servers = new DemoServers();
  servers.users.emby.push({ Id: 'strange-source', Name: '<Weird / Emby Name>', Policy: {} });
  servers.users.jellyfin.push(
    {
      Id: 'administrator',
      Name: 'administrator',
      Policy: { IsAdministrator: true, IsDisabled: false },
    },
    { Id: 'disabled', Name: 'disabled', Policy: { IsAdministrator: false, IsDisabled: true } },
    { Id: 'unknown-policy', Name: 'unknown-policy', Policy: {} },
    {
      Id: 'existing-spaces',
      Name: 'Existing Account',
      Policy: { IsAdministrator: false, IsDisabled: false },
    },
  );
  const identity = {
    serverId: 'server',
    userId: 'admin-id',
    username: 'admin',
    accessToken: 'private-session-token',
  };
  const authClient: JellyfinAuthentication = {
    authenticate: async () => identity,
    validateSession: async () => identity,
    signOut: async () => {},
    createApiKey: async () => 'private-managed-key',
    deleteApiKey: async () => {},
  };
  const app = await createApp({
    demo,
    dataDir: directory,
    clientFactory: servers.factory,
    authClient,
  });
  apps.push(app);
  if (!demo) {
    const pending = app.jellyport.store.authState();
    if (pending?.kind !== 'pending') throw new Error('Expected fresh setup');
    app.jellyport.store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: settings.jellyfin_url,
        serverId: 'server',
        apiKeyName: 'test',
      },
      () => structuredClone(settings),
    );
  }
  const bot = {
    status: () => ({ connected: true }),
    recipientIdentity: vi.fn<BotAdapter['recipientIdentity']>(async (id) => ({
      id,
      username: 'verified.discord',
    })),
    validateRecipient: vi.fn(async () => {}),
    sendCredentials: vi.fn(async () => {}),
    membershipActive: async () => false,
    activeMembers: async () => [],
  } satisfies BotAdapter;
  app.jellyport.service.bot = bot;
  const anonymous = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
      'x-csrf-token': anonymous.json().csrf_token,
    },
    payload: { username: 'admin', password: demo ? 'demo-jellyport' : 'admin-password' },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: `jellyport_session=${login.cookies[0]!.value}`,
    'x-csrf-token': login.json().csrf_token as string,
  };
  return { app, servers, bot, headers };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('encrypted explicit user mappings', () => {
  it('creates, resolves, edits with a new revision, and deletes a mapping', () => {
    const { mappings } = unitFixture();
    const saved = mappings.save(
      input({ discord_user_id: '123456789', discord_username: 'verified.discord' }),
      settings,
    );
    expect(mappings.list(settings)).toEqual([saved]);
    expect(mappings.getForSource('source-one', settings)).toEqual(saved);
    expect(mappings.getForDiscord('123456789', settings)).toEqual(saved);
    const edited = mappings.save(
      input({ id: saved.id, target_username: 'renamed.user' }),
      settings,
    );
    expect(edited.id).toBe(saved.id);
    expect(edited.revision).not.toBe(saved.revision);
    expect(mappings.getForDiscord('123456789', settings)).toBeNull();
    expect(mappings.getForSource('source-one', settings)?.target_username).toBe('renamed.user');
    mappings.delete(saved.id, settings);
    expect(mappings.list(settings)).toEqual([]);
  });
  it('pins both normalized server URLs and leaves mappings for other servers inactive', () => {
    const { mappings } = unitFixture();
    const saved = mappings.save(input(), {
      ...settings,
      emby_url: 'http://EMBY.example:8096/',
      jellyfin_url: 'https://JELLYFIN.example:443/',
    });
    expect(saved.source_server_url).toBe(settings.emby_url);
    expect(saved.target_server_url).toBe(settings.jellyfin_url);
    expect(mappings.list(settings)).toEqual([saved]);
    const other = { ...settings, emby_url: 'http://another-emby.example:8096' };
    expect(mappings.getForSource(saved.source_user_id, other)).toBeNull();
    expect(() => mappings.delete(saved.id, other)).toThrow('configured servers');
    expect(() => mappings.save(input({ id: saved.id }), other)).toThrow('configured servers');
    mappings.save(input(), other);
    expect(mappings.list(other)).toHaveLength(1);
    expect(mappings.list({ ...settings, emby_url: '' })).toEqual([]);
  });
  it('maps several distinct Emby accounts to slots owned by one Discord member', () => {
    const { mappings, store } = unitFixture();
    const primary = mappings.save(
      input({ discord_user_id: '123456789', target_username: 'Jim' }),
      settings,
    );
    const second = mappings.save(
      input({
        source_user_id: 'source-two',
        source_username: 'Jim_2',
        target_username: 'Jim_2',
        discord_user_id: '123456789',
        membership_slot: 2,
      }),
      settings,
    );
    const third = mappings.save(
      input({
        source_user_id: 'source-three',
        source_username: 'Jim_3',
        target_username: 'Jim_3',
        discord_user_id: '123456789',
        membership_slot: 3,
      }),
      settings,
    );
    expect(primary.membership_slot).toBe(1);
    expect(mappings.getForDiscord('123456789', settings)).toEqual(primary);
    expect(mappings.getForDiscord('123456789', settings, 2)).toEqual(second);
    expect(mappings.getAllForDiscord('123456789', settings)).toEqual([primary, second, third]);
    expect(() =>
      mappings.save(
        input({
          source_user_id: 'other-source',
          target_username: 'other-target',
          discord_user_id: '123456789',
          membership_slot: 2,
        }),
        settings,
      ),
    ).toThrow('already mapped');
    expect(() =>
      mappings.save(
        input({
          source_user_id: 'other-source',
          target_username: 'Jim_2',
          discord_user_id: '987654321',
          membership_slot: 2,
        }),
        settings,
      ),
    ).toThrow('already mapped');
    store.saveLink('123456789', 'Jim', 'target-one');
    store.saveLink('123456789', 'Jim_2', 'target-two', false, 2);
    const bound = mappings.bindTarget(second.id, second.revision, 'target-two', settings);
    expect(bound.target_user_id).toBe('target-two');
    expect(() => mappings.save({ ...bound, membership_slot: 3 }, settings)).toThrow();
    expect(() => mappings.save({ ...bound, discord_user_id: '987654321' }, settings)).toThrow(
      'ownership',
    );
    expect(store.link('123456789', 2)?.remote_id).toBe('target-two');
  });
  it('normalizes legacy encrypted mappings without slots to the primary slot', () => {
    const { mappings, store } = unitFixture();
    const legacy = {
      ...input({ discord_user_id: '123456789' }),
      id: 'legacy-map',
      source_server_url: settings.emby_url,
      target_server_url: settings.jellyfin_url,
      revision: 'legacy-revision',
    };
    store.db
      .prepare('INSERT INTO user_mappings VALUES (?,?)')
      .run(legacy.id, store.encrypt(legacy));
    expect(mappings.getForDiscord('123456789', settings)?.membership_slot).toBe(1);
    expect(mappings.getForDiscord('123456789', settings, 2)).toBeNull();
  });
  it.each([0, 4, 1.5, NaN])('rejects invalid user mapping membership slot %s', (slot) => {
    const { mappings } = unitFixture();
    expect(() => mappings.save(input({ membership_slot: slot }), settings)).toThrow('slots');
  });
  it('enforces one-to-one source IDs, case-folded target names, target IDs and Discord IDs', () => {
    const { mappings } = unitFixture();
    mappings.save(
      input({
        target_user_id: 'target-one',
        discord_user_id: '123456789',
        target_username: 'Straße',
      }),
      settings,
    );
    for (const other of [
      input({ target_username: 'another' }),
      input({ source_user_id: 'source-two', target_username: 'STRASSE' }),
      input({
        source_user_id: 'source-two',
        target_username: 'another',
        target_user_id: 'target-one',
      }),
      input({
        source_user_id: 'source-two',
        target_username: 'another',
        discord_user_id: '123456789',
      }),
    ])
      expect(() => mappings.save(other, settings)).toThrow('already');
    expect(mappings.list(settings)).toHaveLength(1);
  });
  it('rejects new aliases with unsupported characters while preserving unusual source names', () => {
    const { mappings } = unitFixture();
    for (const target_username of [
      ' leading',
      'trailing ',
      'first last',
      '<tag>',
      'a/b',
      '_first',
      '.first',
      'üser',
      'a\u0000',
      'a'.repeat(65),
    ])
      expect(() => mappings.save(input({ target_username }), settings)).toThrow();
    const saved = mappings.save(
      input({ source_username: '<Original / Name>', target_username: 'new.user_123-ok' }),
      settings,
    );
    expect(saved.source_username).toBe('<Original / Name>');
    expect(saved.target_username).toBe('new.user_123-ok');
  });
  it('preserves existing Discord account ownership and never changes a durable identity link', () => {
    const { mappings, store } = unitFixture();
    store.saveLink('123456789', 'already-linked', 'linked-target', false);
    expect(() =>
      mappings.save(
        input({ target_user_id: 'another-target', discord_user_id: '123456789' }),
        settings,
      ),
    ).toThrow('ownership');
    expect(() =>
      mappings.save(
        input({ target_user_id: 'linked-target', discord_user_id: '987654321' }),
        settings,
      ),
    ).toThrow('ownership');
    const saved = mappings.save(
      input({
        target_user_id: 'linked-target',
        target_username: 'already-linked',
        discord_user_id: '123456789',
      }),
      settings,
    );
    expect(saved.target_user_id).toBe('linked-target');
    expect(store.link('123456789')?.remote_id).toBe('linked-target');
  });
  it('encrypts identity details in SQLite and its journal and selects safe DTO fields explicitly', () => {
    const { mappings, store, directory } = unitFixture();
    const saved = mappings.save(
      input({ discord_user_id: '123456789', discord_username: 'private-discord-label' }),
      settings,
    );
    const row = store.db.prepare('SELECT encrypted FROM user_mappings WHERE id=?').get(saved.id)!;
    expect(store.decrypt(row.encrypted as Uint8Array)).toEqual(saved);
    store.db
      .prepare('UPDATE user_mappings SET encrypted=? WHERE id=?')
      .run(store.encrypt({ ...saved, access_token: 'future-private-token' }), saved.id);
    expect(JSON.stringify(mappings.list(settings))).not.toContain('future-private-token');
    for (const filename of ['jellyport.db', 'jellyport.db-wal']) {
      const bytes = readFileSync(join(directory, filename));
      for (const secret of [
        'private-source-user',
        'private-target-user',
        'private-discord-label',
        '123456789',
        settings.emby_url,
        settings.jellyfin_url,
      ])
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });
  it('keeps SQL-shaped identity values as data and refuses missing edits and deletes', () => {
    const { mappings, store } = unitFixture();
    const source_user_id = "source'); DROP TABLE links; --";
    const saved = mappings.save(input({ source_user_id }), settings);
    expect(mappings.getForSource(source_user_id, settings)?.id).toBe(saved.id);
    expect(store.links()).toEqual([]);
    expect(() => mappings.save(input({ id: 'missing' }), settings)).toThrow('no longer exists');
    expect(() => mappings.delete('missing', settings)).toThrow('no longer exists');
  });
  it('shares invalidation across module instances and returns copies of cached identities', () => {
    const { mappings, store } = unitFixture();
    const other = new UserMappings(store);
    const saved = mappings.save(input(), settings);
    const first = other.getForSource(saved.source_user_id, settings)!;
    first.target_username = 'changed-outside-store';
    expect(mappings.getForSource(saved.source_user_id, settings)?.target_username).toBe(
      saved.target_username,
    );
    const list = other.list(settings);
    list[0]!.source_username = 'changed-list-copy';
    expect(mappings.get(saved.id, settings)?.source_username).toBe(saved.source_username);
    const updated = mappings.save(
      input({ id: saved.id, target_username: 'approved-change' }),
      settings,
    );
    expect(other.getForSource(saved.source_user_id, settings)).toEqual(updated);
    mappings.delete(saved.id, settings);
    expect(other.get(saved.id, settings)).toBeNull();
  });
  it('pins a newly created target with revision checks and rejects later account replacement', () => {
    const { mappings } = unitFixture();
    const saved = mappings.save(input(), settings);
    const bound = mappings.bindTarget(saved.id, saved.revision, 'new-jellyfin-id', settings);
    expect(bound.target_user_id).toBe('new-jellyfin-id');
    expect(bound.revision).not.toBe(saved.revision);
    expect(() => mappings.bindTarget(saved.id, saved.revision, 'another-id', settings)).toThrow(
      'changed',
    );
    expect(() => mappings.bindTarget(saved.id, bound.revision, 'another-id', settings)).toThrow(
      'ownership',
    );
    expect(mappings.bindTarget(saved.id, bound.revision, 'new-jellyfin-id', settings)).toEqual(
      bound,
    );
  });
});

describe('administrator mapping routes', () => {
  it('requires authentication and CSRF for mapping mutations', async () => {
    const { app, headers } = await apiFixture();
    expect((await app.inject('/api/user-mappings')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/user-mappings',
          headers: { cookie: headers.cookie },
          payload: { source_user_id: 'e-alex', target_username: 'alias' },
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'alias' },
    });
    expect(response.statusCode).toBe(200);
    const mapping = response.json();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/user-mappings/${mapping.id}`,
          headers: { cookie: headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/api/user-mappings', headers })).json().mappings).toHaveLength(
      1,
    );
  });
  it('maps unusual Emby names to a new alias and supports edit and delete without provisioning', async () => {
    const { app, servers, headers, bot } = await apiFixture();
    const usersBefore = structuredClone(servers.users.jellyfin);
    const created = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: {
        source_user_id: 'strange-source',
        target_username: 'simple.alias',
        discord_username: 'Unverified label',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      source_username: '<Weird / Emby Name>',
      target_username: 'simple.alias',
      target_user_id: null,
      discord_user_id: null,
      discord_username: 'Unverified label',
    });
    const edited = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: {
        id: created.json().id,
        source_user_id: 'strange-source',
        target_username: 'other.alias',
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().revision).not.toBe(created.json().revision);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/user-mappings/${created.json().id}`,
          headers,
        })
      ).json(),
    ).toEqual({ deleted: true });
    expect(servers.users.jellyfin).toEqual(usersBefore);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(app.jellyport.store.jobs()).toEqual([]);
  });
  it('requires an explicit existing target selection and preserves its current username', async () => {
    const { app, headers } = await apiFixture();
    const collision = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'RIVER' },
    });
    expect(collision.statusCode).toBe(400);
    expect(collision.json().detail).toContain('Select its existing account');
    const selected = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_user_id: 'existing-spaces' },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      target_user_id: 'existing-spaces',
      target_username: 'Existing Account',
    });
    const rename = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-sam', target_user_id: 'j-river', target_username: 'new-name' },
    });
    expect(rename.statusCode).toBe(400);
  });
  it('protects administrators, disabled targets, unknown policy and the template account', async () => {
    const { app, headers } = await apiFixture();
    for (const target_user_id of ['template', 'administrator', 'disabled', 'unknown-policy']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/user-mappings',
        headers,
        payload: { source_user_id: 'e-alex', target_user_id },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toContain('Choose an enabled Jellyfin user');
    }
    expect((await app.inject({ url: '/api/user-mappings', headers })).json().mappings).toEqual([]);
  });
  it('verifies stable Discord IDs without requiring an active subscription and sends no messages', async () => {
    const { app, headers, bot } = await apiFixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'alias', discord_user_id: '123456789' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      discord_user_id: '123456789',
      discord_username: 'verified.discord',
    });
    expect(bot.recipientIdentity).toHaveBeenCalledWith('123456789', false);
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(bot.validateRecipient).not.toHaveBeenCalled();
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: {
        source_user_id: 'e-sam',
        target_username: 'another-alias',
        discord_user_id: '987654321',
        discord_username: 'Someone else',
      },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().detail).toContain('verified username');
  });
  it('accepts multiple verified account slots for one Discord member through the admin API', async () => {
    const { app, headers, bot } = await apiFixture();
    const primary = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'Jim', discord_user_id: '123456789' },
    });
    expect(primary.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: {
        source_user_id: 'e-sam',
        target_username: 'Jim_2',
        discord_user_id: '123456789',
        membership_slot: 2,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      membership_slot: 2,
      discord_user_id: '123456789',
      discord_username: 'verified.discord',
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: {
        source_user_id: 'strange-source',
        target_username: 'Jim_4',
        discord_user_id: '123456789',
        membership_slot: 4,
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect((await app.inject({ url: '/api/user-mappings', headers })).json().mappings).toHaveLength(
      2,
    );
    expect(bot.sendCredentials).not.toHaveBeenCalled();
    expect(app.jellyport.store.links()).toEqual([]);
    expect(app.jellyport.store.jobs()).toEqual([]);
  });
  it('rejects unavailable or conflicting Discord identities and preserves existing account links', async () => {
    const { app, headers, bot } = await apiFixture();
    bot.recipientIdentity.mockRejectedValueOnce(new Error('private-upstream-token'));
    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'alias', discord_user_id: '123456789' },
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.body).not.toContain('private-upstream-token');
    app.jellyport.store.saveLink('123456789', 'river', 'j-river', false);
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'alias', discord_user_id: '123456789' },
    });
    expect(conflict.statusCode).toBe(400);
    expect(app.jellyport.store.link('123456789')?.remote_id).toBe('j-river');
  });
  it('validates request fields and prevents competing mappings from claiming one target', async () => {
    const { app, headers } = await apiFixture();
    for (const payload of [
      { source_user_id: 'e-alex', target_username: 'alias', access_token: 'injected-secret' },
      { source_user_id: 'e-alex', target_username: 'alias', discord_user_id: 'not-an-id' },
      { source_user_id: 'e-alex', target_user_id: 42 },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/user-mappings', headers, payload }))
          .statusCode,
      ).toBe(422);
    const responses = await Promise.all(
      ['e-alex', 'e-sam'].map((source_user_id) =>
        app.inject({
          method: 'POST',
          url: '/api/user-mappings',
          headers,
          payload: { source_user_id, target_username: 'same-alias' },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    const list = await app.inject({ url: '/api/user-mappings', headers });
    expect(list.json().mappings).toHaveLength(1);
    for (const secret of ['private-emby-key', 'private-jellyfin-key', 'private-session-token'])
      expect(list.body).not.toContain(secret);
  });
  it('keeps demo mapping mutations read-only', async () => {
    const { app, headers } = await apiFixture(true);
    expect((await app.inject({ url: '/api/user-mappings', headers })).statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/user-mappings',
      headers,
      payload: { source_user_id: 'e-alex', target_username: 'alias' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('read-only');
  });
});
