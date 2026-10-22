import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';
import { UserMappings } from '../server/user-mappings.js';
import { AccountRoles } from '../server/account-roles.js';
import { AccountProfiles } from '../server/account-profiles.js';
import { AccountRenames, type RenameInput } from '../server/account-rename.js';
import { MediaOwnerships } from '../server/media-ownership.js';

const stores: Store[] = [];
const directories: string[] = [];
const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  emby_url: 'https://emby.example.invalid',
  jellyfin_url: 'https://jellyfin.example.invalid',
  jellyfin_api_key: 'synthetic-service-key',
  template_user_id: 'template',
};
const input = (overrides: Partial<RenameInput> = {}): RenameInput => ({
  user_id: 'kids-account',
  old_username: 'Kids',
  username: 'Taylor',
  configuration_hash: 'a'.repeat(64),
  server_id: 'synthetic-server',
  ...overrides,
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-account-renames-'));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  const pending = store.ensureAuthState();
  if (pending.kind !== 'pending') throw new Error('Expected fresh fixture.');
  store.completeAuth(
    pending.generation,
    {
      kind: 'configured',
      serverUrl: settings.jellyfin_url,
      serverId: input().server_id,
      apiKeyName: 'synthetic',
    },
    () => structuredClone(settings),
  );
  const mappings = new UserMappings(store);
  const roles = new AccountRoles(store);
  const profiles = new AccountProfiles(store);
  return {
    directory,
    store,
    mappings,
    roles,
    profiles,
    renames: new AccountRenames(store, mappings, roles),
  };
}
function map(
  mappings: UserMappings,
  fields: Partial<Parameters<UserMappings['save']>[0]> = {},
  scope = settings,
) {
  return mappings.save(
    {
      source_user_id: 'emby-kids',
      source_username: 'Kids',
      target_user_id: input().user_id,
      target_username: 'Kids',
      discord_user_id: null,
      discord_username: null,
      ...fields,
    },
    scope,
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable scoped account rename reconciliation', () => {
  it('renames stable identity references atomically while preserving credentials, membership state and profiles', () => {
    const { store, mappings, roles, profiles, renames } = fixture();
    const mapping = map(mappings);
    const role = roles.save(
      {
        name: 'Kids defaults',
        parameters: {
          policy: { IsAdministrator: false },
          configuration: { SubtitleMode: 'Smart' },
          display: null,
        },
      },
      settings,
    );
    const assignment = roles.assign(
      role.id,
      role.revision,
      [{ Id: input().user_id, Name: 'Kids' }],
      settings,
    )[0]!;
    const profile = profiles.save(
      {
        kind: 'jellyfin',
        user_id: input().user_id,
        family: true,
        owner_name: 'Family',
        notes: 'Synthetic child account.',
      },
      settings,
    );
    store.saveAccount('Kids', input().user_id, 'ready', 'synthetic-unshared-password');
    const before = store.account('Kids')!;
    store.saveLink('111111', 'Kids', input().user_id, true, 2);
    store.setLinkPending('111111', false, 2);
    const pin = renames.prepare(input(), settings);
    expect(renames.get(input().user_id, settings)).toEqual(pin);
    expect(renames.commit(pin, settings)).toEqual({
      user_id: input().user_id,
      username: 'Taylor',
      previous_username: 'Kids',
    });
    expect(renames.get(input().user_id, settings)).toBeNull();
    expect(store.account('Kids')).toBeNull();
    expect(store.account('Taylor')).toEqual({ ...before, name_key: 'taylor', username: 'Taylor' });
    expect(store.accountPassword(store.account('Taylor')!)).toBe('synthetic-unshared-password');
    expect(store.link('111111', 2)).toEqual({
      discord_user_id: '111111',
      membership_slot: 2,
      username: 'Taylor',
      remote_id: input().user_id,
      disabled_by_jellyport: 1,
      pending_disabled: 0,
    });
    const renamedMapping = mappings.get(mapping.id, settings)!;
    expect(renamedMapping).toMatchObject({
      ...mapping,
      target_username: 'Taylor',
      revision: expect.any(String),
    });
    expect(renamedMapping.revision).not.toBe(mapping.revision);
    expect(mappings.getForTarget(input().user_id, 'Taylor', settings)).toEqual(renamedMapping);
    expect(mappings.getForTarget(null, 'Kids', settings)).toBeNull();
    const renamedAssignment = roles.getAssignment(input().user_id, settings)!;
    expect(renamedAssignment.username).toBe('Taylor');
    expect(renamedAssignment.revision).not.toBe(assignment.revision);
    expect(renamedAssignment.applied_sections).toEqual(assignment.applied_sections);
    expect(profiles.get('jellyfin', input().user_id, settings)).toEqual(profile);
    expect(store.links()).toHaveLength(1);
  });

  it.each(['account', 'link', 'mapping'])(
    'blocks an existing destination %s name without adopting its identity',
    (kind) => {
      const { store, mappings, renames } = fixture();
      if (kind === 'account')
        store.saveAccount('TAYLOR', 'stranger', 'uncertain', 'synthetic-secret');
      if (kind === 'link') store.saveLink('222222', 'TAYLOR', 'stranger');
      if (kind === 'mapping')
        map(mappings, {
          source_user_id: 'other-source',
          target_user_id: 'stranger',
          target_username: 'TAYLOR',
        });
      expect(() => renames.prepare(input(), settings)).toThrow(/conflict|already uses/);
      expect(renames.get(input().user_id, settings)).toBeNull();
    },
  );

  it('blocks pending one-time credentials until revealed, without deleting or changing them', () => {
    const { store, renames } = fixture();
    store.saveCredentials(
      'creation-job',
      'Kids',
      'synthetic-pending-password',
      settings.jellyfin_url,
      'Original captured message.',
    );
    const before = store.db.prepare('SELECT * FROM credentials').all();
    expect(() => renames.prepare(input(), settings)).toThrow(
      'Reveal the pending account credentials',
    );
    expect(store.db.prepare('SELECT * FROM credentials').all()).toEqual(before);
    expect(store.takeCredentials('creation-job')).toEqual([
      {
        username: 'Kids',
        password: 'synthetic-pending-password',
        server_url: settings.jellyfin_url,
        message: 'Original captured message.',
      },
    ]);
    expect(renames.prepare(input(), settings).status).toBe('uncertain');
  });

  it('ignores expired credentials without deleting or extending them', () => {
    const { store, renames } = fixture();
    store.saveCredentials('expired-job', 'Kids', 'expired', settings.jellyfin_url);
    store.db.prepare('UPDATE credentials SET expires=0 WHERE job_id=?').run('expired-job');
    const pin = renames.prepare(input(), settings);
    renames.commit(pin, settings);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM credentials').get()!.count).toBe(1);
  });

  it.each(['https://public-jellyfin.example.invalid', 'https://previous-jellyfin.example.invalid'])(
    'protects pending credentials captured with a distinct sign-in URL %s',
    (publicUrl) => {
      const { store, renames } = fixture();
      store.saveCredentials(
        'public-url-job',
        'Kids',
        'synthetic-pending-password',
        publicUrl,
        'Original captured credential message.',
      );
      const before = store.db.prepare('SELECT * FROM credentials').all();
      expect(() => renames.prepare(input(), settings)).toThrow(
        'Reveal the pending account credentials',
      );
      expect(store.db.prepare('SELECT * FROM credentials').all()).toEqual(before);
      expect(store.takeCredentials('public-url-job')).toEqual([
        {
          username: 'Kids',
          password: 'synthetic-pending-password',
          server_url: publicUrl,
          message: 'Original captured credential message.',
        },
      ]);
      const pin = renames.prepare(input(), settings);
      expect(renames.commit(pin, settings).username).toBe('Taylor');
    },
  );

  it('renames an untracked source without requiring a family flag, mapping or account journal', () => {
    const { store, renames } = fixture();
    const pin = renames.prepare(input(), settings);
    expect(renames.commit(pin, settings).username).toBe('Taylor');
    expect(store.account('Taylor')).toBeNull();
    expect(store.links()).toEqual([]);
    expect(store.accountProfileRecords()).toEqual([]);
  });

  it.each(['account', 'link'] as const)(
    'requires explicit current-server corroboration for an unscoped legacy %s',
    (kind) => {
      const { store, mappings, renames } = fixture();
      store.saveAccount('Kids', input().user_id, 'ready', 'synthetic-preserved-password');
      store.saveLink('111111', 'Kids', input().user_id);
      store.setLinkPending('111111', true);
      store.deleteAccountIdentityBinding(kind, kind === 'account' ? 'kids' : input().user_id);
      expect(() => renames.prepare(input(), settings)).toThrow('Verify and save its user mapping');
      expect(store.account('Kids')?.username).toBe('Kids');
      expect(store.link('111111')?.pending_disabled).toBe(1);
      const mapping = map(mappings);
      const pin = renames.prepare(input(), settings);
      renames.commit(pin, settings);
      expect(mappings.get(mapping.id, settings)?.target_username).toBe('Taylor');
      expect(store.accountPassword(store.account('Taylor')!)).toBe('synthetic-preserved-password');
      expect(
        store.accountIdentityBinding(kind, kind === 'account' ? 'taylor' : input().user_id),
      ).toMatchObject({
        server_id: input().server_id,
        username: 'Taylor',
        remote_id: input().user_id,
      });
    },
  );

  it.each(['account', 'link'] as const)(
    'does not rewrite a %s binding from a previous server even when the same ID and name recur',
    (kind) => {
      const { store, mappings, renames } = fixture();
      if (kind === 'account')
        store.saveAccount('Kids', input().user_id, 'ready', 'synthetic-other-server-password');
      else store.saveLink('111111', 'Kids', input().user_id);
      const before = store.db.prepare('SELECT * FROM account_identity_bindings').all();
      const pending = store.resetAuth(settings.jellyfin_url);
      store.completeAuth(
        pending.generation,
        {
          kind: 'configured',
          serverUrl: settings.jellyfin_url,
          serverId: 'different-server',
          apiKeyName: 'synthetic',
        },
        () => settings,
      );
      map(mappings);
      expect(() => renames.prepare(input({ server_id: 'different-server' }), settings)).toThrow(
        'different Jellyfin server or identity',
      );
      expect(store.db.prepare('SELECT * FROM account_identity_bindings').all()).toEqual(before);
      if (kind === 'account') expect(store.account('Kids')?.username).toBe('Kids');
      else expect(store.link('111111')?.username).toBe('Kids');
    },
  );

  it('rolls back a partially synchronized mapping and invalidates its shared cache after failure', () => {
    const { store, mappings, roles, renames } = fixture();
    const mapping = map(mappings);
    store.saveLink('111111', 'Kids', input().user_id);
    store.setLinkPending('111111', true);
    const ownerships = new MediaOwnerships(store);
    ownerships.save(
      [
        {
          kind: 'jellyfin',
          server_id: input().server_id,
          account_id: input().user_id,
          username: 'Kids',
          discord_user_id: '111111',
          slot: 1,
        },
      ],
      settings,
    );
    const owner = ownerships.get('jellyfin', input().server_id, input().user_id, settings);
    const pin = renames.prepare(input(), settings);
    vi.spyOn(roles, 'renameAssignment').mockImplementation(() => {
      expect(mappings.get(mapping.id, settings)!.target_username).toBe('Taylor');
      expect(ownerships.get('jellyfin', input().server_id, input().user_id, settings)).toEqual({
        ...owner,
        username: 'Taylor',
      });
      throw new Error('Synthetic local disk failure.');
    });
    expect(() => renames.commit(pin, settings)).toThrow('Synthetic local disk failure.');
    expect(mappings.get(mapping.id, settings)).toEqual(mapping);
    expect(store.link('111111')).toMatchObject({ username: 'Kids', pending_disabled: 1 });
    expect(ownerships.get('jellyfin', input().server_id, input().user_id, settings)).toEqual(owner);
    expect(renames.get(input().user_id, settings)).toEqual(pin);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM account_renames').get()!.count).toBe(1);
  });

  it('pins the uncertain request across restarts, rejects forgery and does not replay preparation', () => {
    const { directory, store, renames } = fixture();
    const pin = renames.prepare(input(), settings);
    expect(() => renames.prepare(input(), settings)).toThrow('earlier rename outcome is uncertain');
    expect(() => renames.commit({ ...pin, username: 'Different child' }, settings)).toThrow(
      'saved rename changed',
    );
    expect(renames.get(input().user_id, settings)).toEqual(pin);
    expect(
      Buffer.from(
        store.db.prepare('SELECT encrypted FROM account_renames').get()!.encrypted as Uint8Array,
      ).toString(),
    ).not.toContain('Kids');
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(directory);
    stores.push(reopened);
    const resumed = new AccountRenames(
      reopened,
      new UserMappings(reopened),
      new AccountRoles(reopened),
    );
    expect(resumed.get(input().user_id, settings)).toEqual(pin);
    expect(() => resumed.prepare(input(), settings)).toThrow('earlier rename outcome is uncertain');
    expect(
      readFileSync(join(directory, 'jellyport.db')).includes(
        Buffer.from('Synthetic child account'),
      ),
    ).toBe(false);
  });

  it('does not mutate old-server mappings, roles, profiles or rename records', () => {
    const { store, mappings, roles, renames } = fixture();
    const previous = renames.prepare(input(), settings);
    const oldMapping = map(mappings);
    const oldRole = roles.save(
      { name: 'Old role', parameters: { policy: {}, configuration: {}, display: null } },
      settings,
    );
    roles.assign(oldRole.id, oldRole.revision, [{ Id: input().user_id, Name: 'Kids' }], settings);
    const oldRecords = store.accountRoleAssignmentRecords();
    const nextSettings = { ...settings, jellyfin_url: 'https://new-jellyfin.example.invalid' };
    const pending = store.resetAuth(nextSettings.jellyfin_url);
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: nextSettings.jellyfin_url,
        serverId: 'new-server',
        apiKeyName: 'synthetic',
      },
      () => nextSettings,
    );
    expect(() => renames.commit(previous, settings)).toThrow('server changed');
    expect(renames.get(input().user_id, nextSettings)).toBeNull();
    const current = renames.prepare(input({ server_id: 'new-server' }), nextSettings);
    renames.commit(current, nextSettings);
    expect(
      store.decrypt(
        store.db.prepare('SELECT encrypted FROM user_mappings WHERE id=?').get(oldMapping.id)!
          .encrypted as Uint8Array,
      ),
    ).toEqual(oldMapping);
    expect(store.accountRoleAssignmentRecords()).toEqual(oldRecords);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM account_renames').get()!.count).toBe(1);
  });

  it('detects local changes after the remote request and keeps the durable uncertain pin', () => {
    const { store, renames } = fixture();
    const pin = renames.prepare(input(), settings);
    store.saveCredentials(
      'racing-creation-job',
      'Kids',
      'synthetic-new-password',
      settings.jellyfin_url,
    );
    expect(() => renames.commit(pin, settings)).toThrow('Reveal the pending account credentials');
    expect(renames.get(input().user_id, settings)).toEqual(pin);
  });

  it('retains the pending rename and old registry when the Discord identity scope changes after preparation', () => {
    const { store, renames } = fixture();
    const ownerships = new MediaOwnerships(store);
    ownerships.save(
      [
        {
          kind: 'jellyfin',
          server_id: input().server_id,
          account_id: input().user_id,
          username: 'Kids',
          discord_user_id: '111111',
          slot: 1,
        },
      ],
      settings,
    );
    const owner = ownerships.get('jellyfin', input().server_id, input().user_id, settings);
    const pin = renames.prepare(input(), settings);
    store.saveSettings({ ...settings, discord_guild_id: '987654321012345678' });
    expect(() => renames.commit(pin, settings)).toThrow('ownership scope changed');
    expect(ownerships.get('jellyfin', input().server_id, input().user_id, settings)).toEqual(owner);
    expect(renames.get(input().user_id, settings)).toEqual(pin);
  });

  it('composes with an enclosing transaction and restores both references and the pending pin on rollback', () => {
    const { store, mappings, renames } = fixture();
    const mapping = map(mappings);
    const pin = renames.prepare(input(), settings);
    store.db.exec('BEGIN IMMEDIATE');
    renames.commit(pin, settings);
    store.db.exec('ROLLBACK');
    mappings.invalidateCache();
    expect(mappings.get(mapping.id, settings)).toEqual(mapping);
    expect(renames.get(input().user_id, settings)).toEqual(pin);
  });

  it.each(['account_renames', 'account_identity_bindings'])(
    'keeps a %s-only production volume out of demo mode',
    (table) => {
      const { directory, store } = fixture();
      if (table === 'account_renames')
        store.saveAccountRenameRecord('synthetic-key', {
          server_id: 'synthetic-server',
          username: 'Kids',
        });
      else store.saveAccount('Kids', input().user_id, 'ready');
      store.db.exec('DELETE FROM auth_state; DELETE FROM settings; DELETE FROM accounts');
      store.close();
      stores.splice(stores.indexOf(store), 1);
      expect(() => new Store(directory, { demo: true })).toThrow('Production data was not loaded');
    },
  );
});
