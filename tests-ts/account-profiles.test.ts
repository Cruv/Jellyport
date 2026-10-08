import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';
import { AccountProfiles, type AccountProfileInput } from '../server/account-profiles.js';

const directories: string[] = [];
const stores: Store[] = [];
const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  emby_url: 'https://emby.example',
  jellyfin_url: 'https://jellyfin.example',
};
const input = (fields: Partial<AccountProfileInput> = {}): AccountProfileInput => ({
  kind: 'jellyfin',
  user_id: 'media-account-id',
  family: true,
  owner_name: 'Taylor',
  notes: 'Family account for Taylor.',
  ...fields,
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-account-profiles-'));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  return { directory, store, profiles: new AccountProfiles(store) };
}
function bindServer(store: Store, serverId: string) {
  const pending = store.ensureAuthState();
  if (pending.kind !== 'pending') throw new Error('Expected pending fixture');
  store.completeAuth(
    pending.generation,
    { kind: 'configured', serverUrl: settings.jellyfin_url, serverId, apiKeyName: 'fixture' },
    () => structuredClone(settings),
  );
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('encrypted scoped account profiles', () => {
  it('pins independent Emby and Jellyfin annotations to the selected account IDs', () => {
    const { profiles } = fixture();
    const jellyfin = profiles.save(input(), settings, '');
    const emby = profiles.save(
      input({ kind: 'emby', family: false, owner_name: 'Different owner' }),
      settings,
      '',
    );
    expect(profiles.get('jellyfin', input().user_id, settings)).toEqual(jellyfin);
    expect(profiles.get('emby', input().user_id, settings)).toEqual(emby);
    expect(profiles.get('jellyfin', 'new-account-reusing-a-username', settings)).toBeNull();
    expect(profiles.list(settings)).toEqual([emby, jellyfin]);
  });
  it('trims annotations, supports empty values and multiline notes, and preserves idempotent revisions', () => {
    const { profiles } = fixture();
    const saved = profiles.save(
      input({ owner_name: ' Taylor ', notes: '\nFirst line\n\tSecond line\n' }),
      settings,
    );
    expect(saved).toMatchObject({ owner_name: 'Taylor', notes: 'First line\n\tSecond line' });
    expect(
      profiles.save(input({ owner_name: 'Taylor', notes: saved.notes }), settings, saved.revision),
    ).toEqual(saved);
    const cleared = profiles.save(
      input({ family: false, owner_name: ' ', notes: '\n\t' }),
      settings,
      saved.revision,
    );
    expect(cleared).toMatchObject({ family: false, owner_name: '', notes: '' });
    expect(cleared.revision).not.toBe(saved.revision);
  });
  it('revises every annotation change and rejects stale and racing first-save edits', () => {
    const { profiles, store } = fixture();
    const saved = profiles.save(input(), settings, '');
    expect(() => profiles.save(input({ owner_name: 'Wrong editor' }), settings, '')).toThrow(
      'changed',
    );
    let current = saved;
    for (const update of [
      { family: false },
      { owner_name: 'Updated owner' },
      { notes: 'Updated notes' },
    ]) {
      const next = profiles.save({ ...current, ...update }, settings, current.revision);
      expect(next.revision).not.toBe(current.revision);
      current = next;
    }
    expect(() => profiles.save(input(), settings, saved.revision)).toThrow('changed');
    expect(profiles.get('jellyfin', input().user_id, settings)).toEqual(current);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM account_profiles').get()?.count).toBe(1);
  });
  it('normalizes URL scopes and never carries profiles to other media servers or paired Jellyfin IDs', () => {
    const { profiles, store } = fixture();
    bindServer(store, 'server-one');
    const normalized = {
      ...settings,
      emby_url: 'https://EMBY.example:443/',
      jellyfin_url: 'https://JELLYFIN.example:443/',
    };
    const emby = profiles.save(input({ kind: 'emby' }), normalized);
    const jellyfin = profiles.save(input(), normalized);
    expect(profiles.list(settings)).toEqual([emby, jellyfin]);
    expect(
      profiles.get('emby', input().user_id, { ...settings, emby_url: 'https://new-emby.example' }),
    ).toBeNull();
    expect(
      profiles.get('jellyfin', input().user_id, {
        ...settings,
        jellyfin_url: 'https://other.example',
      }),
    ).toBeNull();
    expect(profiles.list({ ...settings, jellyfin_url: 'https://other.example' })).toEqual([]);
    expect(() =>
      profiles.save(input(), { ...settings, jellyfin_url: 'https://other.example' }),
    ).toThrow('Configure');
    store.db.prepare('UPDATE auth_state SET encrypted=? WHERE id=1').run(
      store.encrypt({
        kind: 'configured',
        serverUrl: settings.jellyfin_url,
        serverId: 'replacement-server',
        apiKeyName: 'fixture',
      }),
    );
    expect(profiles.list(settings)).toEqual([]);
    expect(profiles.get('emby', input().user_id, settings)).toBeNull();
    expect(profiles.get('jellyfin', input().user_id, settings)).toBeNull();
    expect(() => profiles.save(input(), settings, jellyfin.revision)).toThrow('changed');
  });
  it('does not reuse unbound annotations after pairing with an authenticated Jellyfin server', () => {
    const { profiles, store } = fixture();
    profiles.save(input(), settings);
    profiles.save(input({ kind: 'emby' }), settings);
    bindServer(store, 'new-paired-server');
    expect(profiles.list(settings)).toEqual([]);
  });
  it('keeps scope metadata, unknown fields, and private future metadata out of returned DTOs', () => {
    const { profiles, store } = fixture();
    bindServer(store, 'server-one');
    const saved = profiles.save(input(), settings);
    const record = store.accountProfileRecords<Record<string, unknown>>()[0]!;
    expect(record.value).toMatchObject({
      server_url: settings.jellyfin_url,
      jellyfin_server_url: settings.jellyfin_url,
      jellyfin_server_id: 'server-one',
    });
    store.saveAccountProfileRecord(record.id, {
      ...record.value,
      access_token: 'private-token',
      session: 'private-session',
      discord_user_id: '123456789',
    });
    expect(profiles.get('jellyfin', saved.user_id, settings)).toEqual(saved);
    expect(profiles.list(settings)).toEqual([saved]);
    expect(Object.keys(saved).sort()).toEqual([
      'family',
      'kind',
      'notes',
      'owner_name',
      'revision',
      'user_id',
    ]);
  });
  it('encrypts owner names, account IDs, notes, and scope metadata in both the database and WAL', () => {
    const { profiles, directory, store } = fixture();
    bindServer(store, 'private-server-identity');
    profiles.save(
      input({
        user_id: 'private-account-identity',
        owner_name: 'Private owner name',
        notes: 'Private family account notes',
      }),
      settings,
    );
    for (const file of ['jellyport.db', 'jellyport.db-wal']) {
      const bytes = readFileSync(join(directory, file));
      for (const secret of [
        'private-account-identity',
        'Private owner name',
        'Private family account notes',
        'private-server-identity',
        settings.jellyfin_url,
      ])
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });
  it('reads later saved changes directly without stale family exemptions or notes', () => {
    const { profiles, store } = fixture();
    const saved = profiles.save(input(), settings);
    const record = store.accountProfileRecords<Record<string, unknown>>()[0]!;
    store.saveAccountProfileRecord(record.id, {
      ...record.value,
      family: false,
      notes: 'Changed by another admin process',
    });
    expect(profiles.get('jellyfin', saved.user_id, settings)).toMatchObject({
      family: false,
      notes: 'Changed by another admin process',
    });
  });
  it.each([
    { kind: 'plex' },
    { user_id: '' },
    { user_id: 'wrong\nidentity' },
    { user_id: 'x'.repeat(129) },
    { family: 'true' },
    { family: null },
    { owner_name: null },
    { owner_name: 'x'.repeat(121) },
    { owner_name: 'Name\nOther name' },
    { owner_name: 'Name\tOther name' },
    { owner_name: 'Name\u0085Other name' },
    { notes: null },
    { notes: 'x'.repeat(2001) },
    { notes: 'Text\u0000secret' },
    { notes: 'Text\rReturn' },
    { notes: 'Text\u001bEscape' },
    { notes: 'Text\u007fDelete' },
    { notes: 'Text\u009fControl' },
  ])('rejects invalid fields without saving an exemption or notes %#', (fields) => {
    const { profiles } = fixture();
    expect(() => profiles.save(input(fields as Partial<AccountProfileInput>), settings)).toThrow();
    expect(profiles.list(settings)).toEqual([]);
  });
  it('accepts bounded Unicode owner names and notes without truncating them', () => {
    const { profiles } = fixture();
    const saved = profiles.save(
      input({ owner_name: '🙂'.repeat(120), notes: '🙂'.repeat(2000) }),
      settings,
    );
    expect([...saved.owner_name]).toHaveLength(120);
    expect([...saved.notes]).toHaveLength(2000);
  });
  it('rejects invalid identity lookups and missing server configuration', () => {
    const { profiles } = fixture();
    expect(() => profiles.get('emby', '', settings)).toThrow('identity');
    expect(() => profiles.get('plex' as 'emby', 'valid-id', settings)).toThrow('identity');
    expect(profiles.get('emby', 'valid-id', { ...settings, emby_url: '' })).toBeNull();
    expect(profiles.list(DEFAULT_SETTINGS)).toEqual([]);
    expect(() => profiles.save(input(), DEFAULT_SETTINGS)).toThrow('Configure');
    for (const revision of [null, 1, 'bad\nrevision'])
      expect(() => profiles.save(input(), settings, revision as string)).toThrow('revision');
  });
  it('fails closed on malformed encrypted identity fields and corrupted record IDs', () => {
    const { profiles, store } = fixture();
    const saved = profiles.save(input(), settings);
    const record = store.accountProfileRecords<Record<string, unknown>>()[0]!;
    store.saveAccountProfileRecord(record.id, { ...record.value, user_id: 'different-id' });
    expect(() => profiles.get('jellyfin', saved.user_id, settings)).toThrow('identity');
    expect(() => profiles.list(settings)).toThrow('identity');
    store.saveAccountProfileRecord(record.id, record.value);
    store.saveAccountProfileRecord('incorrect-id', record.value);
    expect(() => profiles.list(settings)).toThrow('identity');
  });
  it('adds the new table to existing installations without resetting media account links or settings', () => {
    const { directory, store } = fixture();
    store.saveSettings(settings);
    store.saveLink('123456789', 'Existing.account', 'existing-remote-id');
    const before = store.links();
    store.db.exec('DROP TABLE account_profiles');
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const reopened = new Store(directory);
    stores.push(reopened);
    expect(reopened.settings()).toEqual(settings);
    expect(reopened.links()).toEqual(before);
    const profiles = new AccountProfiles(reopened);
    const saved = profiles.save(input({ user_id: 'existing-remote-id' }), settings);
    expect(profiles.get('jellyfin', 'existing-remote-id', settings)).toEqual(saved);
    expect(reopened.links()).toEqual(before);
  });
  it('rejects a production data directory in demo mode even when it contains only account profiles', () => {
    const { directory, store, profiles } = fixture();
    const saved = profiles.save(input(), settings);
    const before = store.db.prepare('SELECT * FROM account_profiles').all();
    stores.splice(stores.indexOf(store), 1);
    store.close();
    expect(() => new Store(directory, { demo: true })).toThrow('Demo mode requires a separate');
    const db = new DatabaseSync(join(directory, 'jellyport.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT * FROM account_profiles').all()).toEqual(before);
    } finally {
      db.close();
    }
    const reopened = new Store(directory);
    stores.push(reopened);
    expect(new AccountProfiles(reopened).get('jellyfin', saved.user_id, settings)).toEqual(saved);
  });
});
