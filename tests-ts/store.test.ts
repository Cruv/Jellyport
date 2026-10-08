import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretCipher } from '../server/crypto.js';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS } from '../server/types.js';
import type { Job } from '../server/service.js';

const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
// Fixture produced with Python cryptography.fernet, not this implementation.
const legacy =
  'gAAAAABqxrBaaTHcaSoXTnxgaTOaboJ723_OwCCRMu-D57xi5pO-CJOsNhqPhOS3yxbXa15QwYGT21have55lAJrUSrPyYh2DmnsHeZo6iK634TxEYW1W3Eg5zKEsLI0gSVkGtFmHLNDmVn8WOzoB84-sVYNryMOTQ==';
const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'jellyport-store-'));
  directories.push(path);
  return path;
}
const job = (status = 'queued'): Job => ({
  id: 'job-1',
  kind: 'create',
  status,
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
  progress: { processed: 0, total: 1 },
  results: [],
});
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Fernet compatibility and authentication', () => {
  it('decrypts a Python-produced encrypted settings record', () => {
    expect(new SecretCipher(key).decrypt(legacy)).toEqual({
      emby_api_key: 'legacy-test-key',
      discord_enabled: false,
    });
  });
  it('rejects tampered ciphertext and mismatched keys', () => {
    const token = Buffer.from(legacy, 'base64url');
    token[30] ^= 1;
    expect(() => new SecretCipher(key).decrypt(token.toString('base64url'))).toThrow(
      'could not be decrypted',
    );
    expect(() =>
      new SecretCipher(Buffer.alloc(32, 9).toString('base64url')).decrypt(legacy),
    ).toThrow('could not be decrypted');
  });
  it.each(['', 'invalid!', Buffer.alloc(10).toString('base64url')])(
    'rejects invalid encrypted input',
    (input) => {
      expect(() => new SecretCipher(key).decrypt(input)).toThrow('could not be decrypted');
    },
  );
});

describe('persistent operational state', () => {
  it('opens a Python-schema database and preserves links, audit history and secrets', () => {
    const path = directory();
    writeFileSync(join(path, 'secret.key'), key);
    const db = new DatabaseSync(join(path, 'jellyport.db'));
    db.exec(
      'CREATE TABLE settings(id INTEGER PRIMARY KEY, encrypted BLOB NOT NULL); CREATE TABLE links(discord_user_id TEXT PRIMARY KEY,username TEXT NOT NULL,remote_id TEXT UNIQUE NOT NULL,disabled_by_jellyport INTEGER DEFAULT 0);',
    );
    db.prepare('INSERT INTO settings VALUES(1,?)').run(Buffer.from(legacy));
    db.prepare('INSERT INTO links VALUES(?,?,?,?)').run('123456', 'legacy-user', 'jf-legacy', 1);
    db.close();
    const store = new Store(path);
    try {
      expect(store.settings().emby_api_key).toBe('legacy-test-key');
      expect(store.link('123456')).toMatchObject({
        username: 'legacy-user',
        remote_id: 'jf-legacy',
        disabled_by_jellyport: 1,
        pending_disabled: null,
      });
      store.saveJob(job('completed'));
      expect(store.jobs()[0].id).toBe('job-1');
    } finally {
      store.close();
    }
  });
  it('requires the original key if a database already exists', () => {
    const path = directory();
    const db = new DatabaseSync(join(path, 'jellyport.db'));
    db.close();
    expect(() => new Store(path)).toThrow('Restore secret.key');
  });
  it('retains never-started jobs and encrypted snapshots across restart and claims once', () => {
    const path = directory();
    let store = new Store(path);
    store.saveQueuedJob(job(), [{ username: 'member' }], {
      ...DEFAULT_SETTINGS,
      jellyfin_api_key: 'queue-secret',
    });
    store.close();
    store = new Store(path);
    try {
      expect(store.job('job-1')?.status).toBe('queued');
      expect(store.queuedJobs()[0].settings.jellyfin_api_key).toBe('queue-secret');
      expect(readFileSync(join(path, 'jellyport.db')).includes(Buffer.from('queue-secret'))).toBe(
        false,
      );
      expect(store.claimQueuedJob('job-1')).toBe(true);
      expect(store.claimQueuedJob('job-1')).toBe(false);
      expect(store.queuedJobs()).toEqual([]);
      expect(store.job('job-1')?.status).toBe('running');
    } finally {
      store.close();
    }
  });
  it.each(['running', 'queued'])(
    'marks unsafe legacy %s work interrupted instead of replaying it',
    (status) => {
      const path = directory();
      let store = new Store(path);
      store.saveJob(job(status));
      store.close();
      store = new Store(path);
      try {
        expect(store.job('job-1')?.status).toBe('interrupted');
        expect(store.queuedJobs()).toEqual([]);
      } finally {
        store.close();
      }
    },
  );
  it('marks interrupted subscription actions failed for explicit review', () => {
    const path = directory();
    let store = new Store(path);
    store.saveSubscription({
      id: 'event-1',
      action: 'expire',
      status: 'processing',
      created_at: '2026-10-07',
      discord_user_id: '123456',
    });
    store.close();
    store = new Store(path);
    try {
      expect(store.subscription('event-1')?.status).toBe('failed');
    } finally {
      store.close();
    }
  });
  it('consumes credentials once and removes expired passwords', () => {
    const store = new Store(directory());
    try {
      store.saveCredentials('job-1', 'member', 'temporary-password', 'https://jellyfin.example');
      expect(store.takeCredentials('job-1')).toEqual([
        {
          username: 'member',
          password: 'temporary-password',
          server_url: 'https://jellyfin.example',
        },
      ]);
      expect(store.takeCredentials('job-1')).toEqual([]);
      store.saveAccount('member', 'jf-1', 'provisioning', 'expired');
      store.db.prepare('UPDATE accounts SET expires=0').run();
      store.purgeExpired();
      expect(store.account('member')?.password).toBeNull();
    } finally {
      store.close();
    }
  });
  it('keeps full Unicode case folding and prevents conflicting identity links', () => {
    const store = new Store(directory());
    try {
      store.saveAccount('Straße', 'jf-1', 'ready');
      expect(store.account('STRASSE')?.remote_id).toBe('jf-1');
      store.saveLink('123456', 'member', 'jf-1');
      expect(() => store.saveLink('654321', 'other-member', 'jf-1')).toThrow();
      expect(store.link('123456')?.username).toBe('member');
    } finally {
      store.close();
    }
  });
});

describe('demo and production data isolation', () => {
  const demoSettings = {
    ...DEFAULT_SETTINGS,
    emby_url: 'http://demo-emby',
    emby_api_key: 'demo',
    jellyfin_url: 'http://demo-jellyfin',
    jellyfin_api_key: 'demo',
    jellyfin_public_url: 'https://jellyfin.example.com',
    template_user_id: 'template',
  };
  const tables = [
    'settings',
    'auth_state',
    'jobs',
    'accounts',
    'credentials',
    'links',
    'subscriptions',
    'job_queue',
  ] as const;
  function snapshot(db: DatabaseSync) {
    return Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    );
  }
  function assertRejectedWithoutChanges(path: string, original: Store) {
    const before = snapshot(original.db);
    original.close();
    let unexpectedDemo: Store | undefined;
    try {
      expect(() => {
        unexpectedDemo = new Store(path, { demo: true });
      }).toThrow('Demo mode requires a separate empty data directory');
    } finally {
      unexpectedDemo?.close();
    }
    const db = new DatabaseSync(join(path, 'jellyport.db'), { readOnly: true });
    try {
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  }
  function privateRecords(store: Store) {
    store.saveJob(job('running'));
    store.saveAccount('private-member', 'private-remote-id', 'provisioning', 'private-password');
    store.saveCredentials('job-1', 'private-member', 'private-password', 'https://private.example');
    store.db.prepare('UPDATE accounts SET expires=0').run();
    store.db.prepare('UPDATE credentials SET expires=0').run();
    store.saveLink('123456', 'private-member', 'private-remote-id');
    store.saveSubscription({
      id: 'private-event',
      action: 'expire',
      status: 'processing',
      created_at: '2026-10-07',
    });
  }

  it.each(['pending', 'configured'] as const)(
    'rejects a production %s authentication binding before touching any user records',
    (kind) => {
      const path = directory();
      const store = new Store(path);
      store.saveSettings(demoSettings);
      const state = store.ensureAuthState();
      if (state.kind !== 'pending') throw new Error('Expected fixture pending state');
      if (kind === 'configured')
        store.completeAuth(
          state.generation,
          {
            kind: 'configured',
            serverUrl: 'https://private.example',
            serverId: 'private-server-id',
            apiKeyName: 'private-key-name',
          },
          (settings) => settings,
        );
      privateRecords(store);
      assertRejectedWithoutChanges(path, store);
    },
  );

  it('rejects legacy production settings with no authentication binding and preserves jobs, subscriptions and expired secrets', () => {
    const path = directory();
    const store = new Store(path);
    store.saveSettings({
      ...DEFAULT_SETTINGS,
      emby_url: 'https://private-emby.example',
      emby_api_key: 'private-api-key',
    });
    privateRecords(store);
    assertRejectedWithoutChanges(path, store);
  });

  it.each(['jobs', 'accounts', 'credentials', 'links', 'subscriptions', 'job_queue'] as const)(
    'rejects blank settings with preexisting %s records',
    (table) => {
      const path = directory();
      const store = new Store(path);
      store.saveSettings(DEFAULT_SETTINGS);
      if (table === 'jobs') store.saveJob(job('running'));
      if (table === 'accounts')
        store.saveAccount('private-member', 'private-id', 'provisioning', 'private-password');
      if (table === 'credentials')
        store.saveCredentials(
          'private-job',
          'private-member',
          'private-password',
          'https://private.example',
        );
      if (table === 'links') store.saveLink('123456', 'private-member', 'private-id');
      if (table === 'subscriptions')
        store.saveSubscription({
          id: 'private-event',
          action: 'expire',
          status: 'processing',
          created_at: '2026-10-07',
        });
      if (table === 'job_queue')
        store.db
          .prepare('INSERT INTO job_queue VALUES (?,?)')
          .run(
            'private-queued-job',
            store.encrypt({
              requests: [{ username: 'private-member' }],
              settings: DEFAULT_SETTINGS,
            }),
          );
      assertRejectedWithoutChanges(path, store);
    },
  );

  it('accepts a fresh directory and recognized isolated demo fixtures on repeat startup', () => {
    const path = directory();
    let store = new Store(path, { demo: true });
    store.saveSettings(demoSettings);
    store.saveJob(job('completed'));
    store.close();
    store = new Store(path, { demo: true });
    try {
      expect(store.settings()).toEqual(demoSettings);
      expect(store.job('job-1')?.status).toBe('completed');
      expect(store.authState()).toBeNull();
    } finally {
      store.close();
    }
  });

  it.each([
    { emby_url: '' },
    { jellyfin_api_key: 'private-api-key' },
    { discord_bot_token: 'private-bot-token' },
    { jellyfin_public_url: 'https://private.example' },
  ])('rejects incomplete or modified legacy demo settings: %j', (change) => {
    const path = directory();
    const store = new Store(path);
    store.saveSettings({ ...demoSettings, ...change });
    assertRejectedWithoutChanges(path, store);
  });
});
