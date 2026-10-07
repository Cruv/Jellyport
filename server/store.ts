import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecretCipher } from './crypto.js';
import { nameKey } from './identity.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';
import type { Job, JobRequest, SubscriptionEvent } from './service.js';
export { DEFAULT_SETTINGS } from './types.js';

export interface Account {
  name_key: string;
  username: string;
  remote_id: string | null;
  status: string;
  password: Uint8Array | null;
  expires: number | null;
}
export interface Link {
  discord_user_id: string;
  username: string;
  remote_id: string;
  disabled_by_jellyport: number;
  pending_disabled: number | null;
}
export interface Credentials {
  username: string;
  password: string;
  server_url: string;
}
export interface QueuedJob {
  job: Job;
  requests: JobRequest[];
  settings: Settings;
}

/** Compatible with existing Python SQLite volumes, including encrypted Fernet records. */
export class Store {
  readonly db: DatabaseSync;
  readonly cipher: SecretCipher;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyfile = join(directory, 'secret.key');
    const database = join(directory, 'jellyport.db');
    if (!existsSync(keyfile)) {
      if (existsSync(database))
        throw new Error(
          'The Jellyport database has no encryption key. Restore secret.key from the same backup.',
        );
      writeFileSync(
        keyfile,
        randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
        { flag: 'wx', mode: 0o600 },
      );
    }
    chmodSync(keyfile, 0o600);
    this.cipher = new SecretCipher(readFileSync(keyfile, 'utf8'));
    this.db = new DatabaseSync(database);
    chmodSync(database, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (name_key TEXT PRIMARY KEY, username TEXT NOT NULL, remote_id TEXT, status TEXT NOT NULL, password BLOB, expires REAL);
      CREATE TABLE IF NOT EXISTS credentials (job_id TEXT NOT NULL, username TEXT NOT NULL, encrypted BLOB NOT NULL, expires REAL NOT NULL, PRIMARY KEY (job_id,username));
      CREATE TABLE IF NOT EXISTS links (discord_user_id TEXT PRIMARY KEY, username TEXT NOT NULL, remote_id TEXT NOT NULL UNIQUE, disabled_by_jellyport INTEGER NOT NULL DEFAULT 0, pending_disabled INTEGER);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_queue (job_id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS credentials_expiry ON credentials(expires);
    `);
    const columns = this.db.prepare('PRAGMA table_info(links)').all();
    if (!columns.some((row) => row.name === 'pending_disabled'))
      this.db.exec('ALTER TABLE links ADD COLUMN pending_disabled INTEGER');
    // Authenticate existing settings before starting any worker or bot.
    this.settings();
    for (const job of this.jobs()) {
      if (
        job.status === 'running' ||
        (job.status === 'queued' &&
          !this.db.prepare('SELECT 1 FROM job_queue WHERE job_id=?').get(job.id))
      ) {
        job.status = 'interrupted';
        job.error =
          'App restarted during this job. Review its results and run again; existing accounts are preserved.';
        this.saveJob(job);
        this.db.prepare('DELETE FROM job_queue WHERE job_id=?').run(job.id);
      }
    }
    for (const event of this.subscriptions()) {
      if (event.status === 'processing') {
        event.status = 'failed';
        event.error =
          'App restarted during this event. Review account and job status before applying again.';
        this.saveSubscription(event);
      }
    }
    this.purgeExpired();
  }
  encrypt(value: unknown): Buffer {
    return this.cipher.encrypt(value);
  }
  decrypt<T>(value: Uint8Array): T {
    return this.cipher.decrypt<T>(value);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT encrypted FROM settings WHERE id=1').get();
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(row ? this.decrypt<Partial<Settings>>(row.encrypted as Uint8Array) : {}),
    };
  }
  saveSettings(settings: Settings): void {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1,?)').run(this.encrypt(settings));
  }
  saveJob(job: Job): void {
    this.db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(job.id, JSON.stringify(job));
  }
  job(id: string): Job | null {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id);
    return row ? (JSON.parse(row.payload as string) as Job) : null;
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT payload FROM jobs ORDER BY json_extract(payload,'$.created_at') DESC")
      .all()
      .map((row) => JSON.parse(row.payload as string) as Job);
  }
  saveQueuedJob(job: Job, requests: JobRequest[], settings: Settings): void {
    this.transaction(() => {
      this.saveJob(job);
      this.db
        .prepare('INSERT INTO job_queue VALUES (?,?)')
        .run(job.id, this.encrypt({ requests, settings }));
    });
  }
  queuedJobs(): QueuedJob[] {
    return this.db
      .prepare(
        "SELECT job_queue.encrypted,jobs.payload FROM job_queue JOIN jobs ON jobs.id=job_queue.job_id ORDER BY json_extract(jobs.payload,'$.created_at')",
      )
      .all()
      .map((row) => ({
        job: JSON.parse(row.payload as string) as Job,
        ...this.decrypt<{ requests: JobRequest[]; settings: Settings }>(
          row.encrypted as Uint8Array,
        ),
      }));
  }
  claimQueuedJob(id: string): boolean {
    return this.transaction(() => {
      const job = this.job(id);
      if (!job || job.status !== 'queued') return false;
      const result = this.db.prepare('DELETE FROM job_queue WHERE job_id=?').run(id);
      if (!result.changes) return false;
      job.status = 'running';
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
      return true;
    });
  }
  account(username: string): Account | null {
    return (
      (this.db
        .prepare('SELECT * FROM accounts WHERE name_key=?')
        .get(nameKey(username)) as unknown as Account) ?? null
    );
  }
  saveAccount(
    username: string,
    remoteId: string | null,
    status: string,
    password?: string | null,
  ): void {
    this.db
      .prepare('INSERT OR REPLACE INTO accounts VALUES (?,?,?,?,?,?)')
      .run(
        nameKey(username),
        username,
        remoteId,
        status,
        password ? this.encrypt(password) : null,
        password ? Date.now() / 1000 + 86400 : null,
      );
  }
  accountPassword(account: Account): string | null {
    return account.password && (account.expires ?? 0) > Date.now() / 1000
      ? this.decrypt<string>(account.password)
      : null;
  }
  saveCredentials(jobId: string, username: string, password: string, serverUrl: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,?)')
      .run(
        jobId,
        username,
        this.encrypt({ username, password, server_url: serverUrl }),
        Date.now() / 1000 + 86400,
      );
  }
  deleteCredentials(jobId: string, username: string): void {
    this.db.prepare('DELETE FROM credentials WHERE job_id=? AND username=?').run(jobId, username);
  }
  takeCredentials(jobId: string): Credentials[] {
    return this.transaction(() => {
      const time = Date.now() / 1000;
      const values = this.db
        .prepare('SELECT encrypted FROM credentials WHERE job_id=? AND expires>?')
        .all(jobId, time)
        .map((row) => this.decrypt<Credentials>(row.encrypted as Uint8Array));
      this.db.prepare('DELETE FROM credentials WHERE job_id=? OR expires<=?').run(jobId, time);
      return values;
    });
  }
  link(id: string): Link | null {
    return (
      (this.db
        .prepare('SELECT * FROM links WHERE discord_user_id=?')
        .get(String(id)) as unknown as Link) ?? null
    );
  }
  linkForRemote(id: string): Link | null {
    return (
      (this.db.prepare('SELECT * FROM links WHERE remote_id=?').get(id) as unknown as Link) ?? null
    );
  }
  links(): Link[] {
    return this.db.prepare('SELECT * FROM links').all() as unknown as Link[];
  }
  saveLink(discordId: string, username: string, remoteId: string, disabled = false): void {
    this.db
      .prepare(
        'INSERT INTO links (discord_user_id,username,remote_id,disabled_by_jellyport,pending_disabled) VALUES (?,?,?,?,NULL) ON CONFLICT(discord_user_id) DO UPDATE SET username=excluded.username, remote_id=excluded.remote_id, disabled_by_jellyport=excluded.disabled_by_jellyport, pending_disabled=NULL',
      )
      .run(String(discordId), username, remoteId, Number(disabled));
  }
  setLinkPending(discordId: string, disabled: boolean | null): void {
    this.db
      .prepare('UPDATE links SET pending_disabled=? WHERE discord_user_id=?')
      .run(disabled === null ? null : Number(disabled), String(discordId));
  }
  subscription(id: string): SubscriptionEvent | null {
    const row = this.db.prepare('SELECT payload FROM subscriptions WHERE id=?').get(id);
    return row ? (JSON.parse(row.payload as string) as SubscriptionEvent) : null;
  }
  subscriptions(): SubscriptionEvent[] {
    return this.db
      .prepare(
        "SELECT payload FROM subscriptions ORDER BY json_extract(payload,'$.created_at') DESC",
      )
      .all()
      .map((row) => JSON.parse(row.payload as string) as SubscriptionEvent);
  }
  saveSubscription(event: SubscriptionEvent): void {
    this.db
      .prepare('INSERT OR REPLACE INTO subscriptions VALUES (?,?)')
      .run(event.id, JSON.stringify(event));
  }
  purgeExpired(): void {
    const time = Date.now() / 1000;
    this.transaction(() => {
      this.db.prepare('DELETE FROM credentials WHERE expires<=?').run(time);
      this.db.prepare('UPDATE accounts SET password=NULL,expires=NULL WHERE expires<=?').run(time);
    });
  }
  close(): void {
    this.db.close();
  }
}
