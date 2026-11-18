import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SecretCipher } from './crypto.js';
import { nameKey } from './identity.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import { DEFAULT_SETTINGS, DEMO_SETTINGS, type Settings } from './types.js';
import { jobRetentionTimestamp, type JobRetentionCursor } from './job-retention.js';
import { finishJob } from './job-recovery.js';
import { jobOutcome } from './job-outcome.js';
import { legacyJobSummaryInput } from './job-summary-upgrade.js';
import { NewSubscriberPolicy } from './new-subscriber-policy.js';
import type { BotMessageHistory } from './bot-messages.js';
import { discordAuthority } from './discord-authority.js';
import type { MediaKind } from './media.js';
import type {
  Job,
  JobRequest,
  JobHistoryCleanupResult,
  JobHistoryCleanupSkipReason,
  SubscriptionEvent,
} from './service.js';
export { DEFAULT_SETTINGS } from './types.js';

export interface Account {
  name_key: string;
  username: string;
  remote_id: string | null;
  status: string;
  password: Uint8Array | null;
  expires: number | null;
}
export interface AccountIdentityBinding {
  server_url: string;
  server_id: string;
  remote_id: string | null;
  username: string;
}
export interface Link {
  discord_user_id: string;
  membership_slot: number;
  username: string;
  remote_id: string;
  disabled_by_jellyport: number;
  pending_disabled: number | null;
}
interface HouseholdAccessChange {
  id: string;
  at: string;
  kind: MediaKind;
  username: string;
  disabled: boolean;
}
export interface Credentials {
  username: string;
  password: string;
  server_url: string;
  message?: string;
}
const credentialRecoverySeconds = 90;
export interface QueuedJob {
  job: Job;
  requests: JobRequest[];
  settings: Settings;
}
export type JobSummary = Pick<
  Job,
  | 'id'
  | 'kind'
  | 'status'
  | 'created_at'
  | 'updated_at'
  | 'finished_at'
  | 'migration_scope'
  | 'progress'
  | 'cancel_requested'
> & {
  outcome_status: string;
  results: Pick<Job['results'][number], 'username' | 'status'>[];
};
export interface JobSummaryQuery {
  status?: string;
  query?: string;
  limit: number;
  offset?: number;
  oldestFirst?: boolean;
}
export interface MigrationSubmission {
  key: string;
  owner: string;
  requestHash: string;
}
export type AuthState =
  | { kind: 'pending'; generation: string; serverUrl?: string; previousServerId?: string }
  | { kind: 'configured'; serverUrl: string; serverId: string; apiKeyName: string };

export interface PlaylistImport {
  name: string;
  targetId?: string;
  status: 'creating' | 'ready' | 'complete' | 'uncertain';
  content_hash?: string;
}

export interface AdminAlertSource {
  kind: 'job' | 'subscription';
  id: string;
  status: string;
}
/** Hashed keys keep source IDs and recipient generations out of receipt indexes. */
export function adminAlertReceiptId(generation: string, source: AdminAlertSource): string {
  return createHash('sha256')
    .update(JSON.stringify([generation, source.kind, source.id, source.status]))
    .digest('hex');
}
function ownerIndexKey(value: unknown): string | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('discord_user_id' in value) ||
    typeof value.discord_user_id !== 'string'
  )
    return null;
  return createHash('sha256').update(value.discord_user_id).digest('hex');
}
const ADMIN_ALERT_SOURCES = `
  SELECT 'job' AS kind,id,json_extract(payload,'$.status') AS status FROM jobs
  WHERE json_extract(payload,'$.status') IN ('completed','partial','failed','interrupted','cancelled','canceled')
  UNION ALL
  SELECT 'subscription' AS kind,id,json_extract(payload,'$.status') AS status FROM subscriptions
  WHERE json_extract(payload,'$.status') IN ('pending','failed')`;

/** Compatible with existing Python SQLite volumes, including encrypted Fernet records. */
export class Store {
  readonly db: DatabaseSync;
  readonly cipher: SecretCipher;
  private readonly jobEpoch = randomBytes(8).toString('hex');
  private jobRevision = 0;
  constructor(directory: string, options: { demo?: boolean } = {}) {
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
    this.db.function(
      'jellyport_admin_alert_receipt',
      { deterministic: true },
      (generation, kind, id, status) =>
        adminAlertReceiptId(String(generation), {
          kind: kind === 'job' ? 'job' : 'subscription',
          id: String(id),
          status: String(status),
        }),
    );
    chmodSync(database, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS setting_revisions (field TEXT PRIMARY KEY, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS new_subscriber_policy (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS stripe_entitlement_policy (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS stripe_role_cleanup_policy (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_state (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_summaries (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
        outcome TEXT NOT NULL, search_text TEXT NOT NULL, payload TEXT NOT NULL,
        owner_id TEXT, source_pins TEXT, destination_pin TEXT
      );
      CREATE INDEX IF NOT EXISTS job_summaries_recent ON job_summaries(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS job_summaries_outcome ON job_summaries(outcome,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS job_summaries_active ON job_summaries(created_at DESC,id DESC)
        WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS job_summaries_active_owner ON job_summaries(owner_id)
        WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS job_summaries_owner_recent ON job_summaries(owner_id,created_at DESC,id DESC)
        WHERE owner_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS job_summaries_insert AFTER INSERT ON jobs BEGIN DELETE FROM job_summaries WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS job_summaries_update AFTER UPDATE ON jobs BEGIN DELETE FROM job_summaries WHERE id=OLD.id OR id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS job_summaries_delete AFTER DELETE ON jobs BEGIN DELETE FROM job_summaries WHERE id=OLD.id; END;
      CREATE TABLE IF NOT EXISTS job_retention (job_id TEXT PRIMARY KEY,age_ms REAL);
      CREATE INDEX IF NOT EXISTS job_retention_age ON job_retention(age_ms,job_id);
      CREATE TRIGGER IF NOT EXISTS job_retention_insert AFTER INSERT ON jobs BEGIN DELETE FROM job_retention WHERE job_id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS job_retention_update AFTER UPDATE ON jobs BEGIN DELETE FROM job_retention WHERE job_id=OLD.id OR job_id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS job_retention_delete AFTER DELETE ON jobs BEGIN DELETE FROM job_retention WHERE job_id=OLD.id; END;
      CREATE TABLE IF NOT EXISTS job_retention_config (id INTEGER PRIMARY KEY CHECK(id=1),days INTEGER NOT NULL CHECK(typeof(days)='integer' AND days BETWEEN 0 AND 3650));
      CREATE TABLE IF NOT EXISTS accounts (name_key TEXT PRIMARY KEY, username TEXT NOT NULL, remote_id TEXT, status TEXT NOT NULL, password BLOB, expires REAL);
      CREATE TABLE IF NOT EXISTS credentials (job_id TEXT NOT NULL, username TEXT NOT NULL, encrypted BLOB NOT NULL, expires REAL NOT NULL, reveal_session TEXT, PRIMARY KEY (job_id,username));
      CREATE TABLE IF NOT EXISTS bot_message_history (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_ms REAL NOT NULL, status TEXT NOT NULL, encrypted BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_message_history_job ON bot_message_history(job_id,created_ms);
      CREATE INDEX IF NOT EXISTS bot_message_history_age ON bot_message_history(created_ms);
      CREATE INDEX IF NOT EXISTS bot_uncertain_delivery ON bot_message_history(created_ms,job_id) WHERE status='uncertain';
      CREATE TRIGGER IF NOT EXISTS bot_message_history_delete AFTER DELETE ON jobs BEGIN DELETE FROM bot_message_history WHERE job_id=OLD.id; END;
      CREATE TABLE IF NOT EXISTS links (discord_user_id TEXT NOT NULL, membership_slot INTEGER NOT NULL DEFAULT 1 CHECK(membership_slot BETWEEN 1 AND 3), username TEXT NOT NULL, remote_id TEXT NOT NULL UNIQUE, disabled_by_jellyport INTEGER NOT NULL DEFAULT 0, pending_disabled INTEGER, PRIMARY KEY(discord_user_id,membership_slot));
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS household_access_history (
        id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, at TEXT NOT NULL, encrypted BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS household_access_owner ON household_access_history(owner_key,at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS job_queue (job_id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS migration_submissions (
        job_id TEXT PRIMARY KEY, receipt_key TEXT UNIQUE, owner_scope TEXT,
        request_hash TEXT, source_ids TEXT NOT NULL, source_scope TEXT
      );
      CREATE INDEX IF NOT EXISTS migration_submissions_owner ON migration_submissions(owner_scope);
      CREATE TRIGGER IF NOT EXISTS migration_submissions_delete AFTER DELETE ON jobs
        BEGIN DELETE FROM migration_submissions WHERE job_id=OLD.id; END;
      CREATE TABLE IF NOT EXISTS migration_playlists (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS user_mappings (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS account_roles (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS account_role_assignments (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS account_profiles (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS account_renames (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS account_identity_bindings (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_alert_config (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_alert_receipts (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS source_snapshot_state (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS destination_catalog_state (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS stripe_integration_state (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS media_ownership (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_review_exceptions (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_role_sync_tasks (id TEXT PRIMARY KEY, created_ms REAL NOT NULL, encrypted BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS credentials_expiry ON credentials(expires);
      CREATE INDEX IF NOT EXISTS subscriptions_job_id ON subscriptions(json_extract(payload,'$.job_id'));
      CREATE INDEX IF NOT EXISTS subscriptions_member ON subscriptions(json_extract(payload,'$.discord_user_id'),json_extract(payload,'$.source'));
      CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions(json_extract(payload,'$.status'));
    `);
    const columns = this.db.prepare('PRAGMA table_info(links)').all();
    if (!columns.some((row) => row.name === 'pending_disabled'))
      this.db.exec('ALTER TABLE links ADD COLUMN pending_disabled INTEGER');
    if (!columns.some((row) => row.name === 'membership_slot'))
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE links_membership_migration (discord_user_id TEXT NOT NULL, membership_slot INTEGER NOT NULL DEFAULT 1 CHECK(membership_slot BETWEEN 1 AND 3), username TEXT NOT NULL, remote_id TEXT NOT NULL UNIQUE, disabled_by_jellyport INTEGER NOT NULL DEFAULT 0, pending_disabled INTEGER, PRIMARY KEY(discord_user_id,membership_slot));
          INSERT INTO links_membership_migration (discord_user_id,membership_slot,username,remote_id,disabled_by_jellyport,pending_disabled) SELECT discord_user_id,1,username,remote_id,COALESCE(disabled_by_jellyport,0),pending_disabled FROM links;
          DROP TABLE links;
          ALTER TABLE links_membership_migration RENAME TO links;
        `);
      });
    if (!columns.some((row) => row.name === 'discord_authority'))
      this.db.exec('ALTER TABLE links ADD COLUMN discord_authority TEXT');
    for (const table of ['memberships', 'media_ownership'] as const) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === 'owner_hash')
      ) {
        this.transaction(() => {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN owner_hash TEXT`);
          const save = this.db.prepare(`UPDATE ${table} SET owner_hash=? WHERE id=?`);
          for (const row of this.db.prepare(`SELECT id,encrypted FROM ${table}`).iterate())
            save.run(ownerIndexKey(this.decrypt(row.encrypted as Uint8Array)), row.id);
        });
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(owner_hash)`);
    }
    if (
      !this.db
        .prepare('PRAGMA table_info(credentials)')
        .all()
        .some((row) => row.name === 'reveal_session')
    )
      this.db.exec('ALTER TABLE credentials ADD COLUMN reveal_session TEXT');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS credentials_reveal_session ON credentials(reveal_session) WHERE reveal_session IS NOT NULL',
    );
    // Authenticate existing settings before starting any worker or bot.
    const settings = this.settings();
    const auth = this.authState();
    // A demo must never replace a real installation's settings or expose its records.
    const recognizedDemo = !auth && isDeepStrictEqual(settings, DEMO_SETTINGS);
    const hasData =
      options.demo &&
      this.db
        .prepare(
          `SELECT 1 FROM settings
      UNION ALL SELECT 1 FROM jobs UNION ALL SELECT 1 FROM accounts
      UNION ALL SELECT 1 FROM credentials UNION ALL SELECT 1 FROM links
      UNION ALL SELECT 1 FROM subscriptions UNION ALL SELECT 1 FROM job_queue
      UNION ALL SELECT 1 FROM household_access_history
      UNION ALL SELECT 1 FROM migration_playlists UNION ALL SELECT 1 FROM user_mappings
      UNION ALL SELECT 1 FROM account_roles UNION ALL SELECT 1 FROM account_role_assignments
      UNION ALL SELECT 1 FROM memberships UNION ALL SELECT 1 FROM account_profiles
      UNION ALL SELECT 1 FROM account_renames
      UNION ALL SELECT 1 FROM account_identity_bindings
      UNION ALL SELECT 1 FROM admin_alert_config UNION ALL SELECT 1 FROM admin_alert_receipts
      UNION ALL SELECT 1 FROM source_snapshot_state UNION ALL SELECT 1 FROM destination_catalog_state
      UNION ALL SELECT 1 FROM stripe_integration_state
      UNION ALL SELECT 1 FROM media_ownership UNION ALL SELECT 1 FROM identity_review_exceptions
      UNION ALL SELECT 1 FROM identity_role_sync_tasks
      UNION ALL SELECT 1 FROM new_subscriber_policy
      UNION ALL SELECT 1 FROM stripe_entitlement_policy
      UNION ALL SELECT 1 FROM stripe_role_cleanup_policy
      UNION ALL SELECT 1 FROM bot_message_history
      UNION ALL SELECT 1 FROM job_retention_config UNION ALL SELECT 1 FROM job_retention LIMIT 1`,
        )
        .get();
    if (options.demo && (auth || (hasData && !recognizedDemo))) {
      this.db.close();
      throw new Error(
        'Demo mode requires a separate empty data directory. Production data was not loaded.',
      );
    }
    // Backfill only absent metadata, using a streaming projection instead of report
    // objects. Ordinary restarts do not parse existing reports for retention again.
    this.transaction(() => {
      const missing = this.db.prepare(`SELECT jobs.id,
        json_extract(payload,'$.status') AS status,
        json_extract(payload,'$.finished_at') AS finished_at,
        json_extract(payload,'$.updated_at') AS updated_at,
        json_extract(payload,'$.created_at') AS created_at
        FROM jobs LEFT JOIN job_retention ON job_retention.job_id=jobs.id
        WHERE job_retention.job_id IS NULL`);
      const save = this.db.prepare('INSERT INTO job_retention (job_id,age_ms) VALUES (?,?)');
      for (const row of missing.iterate()) save.run(String(row.id), jobRetentionTimestamp(row));
      this.db.exec(
        'DELETE FROM job_retention WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE jobs.id=job_retention.job_id)',
      );
      // Upgrade old volumes once, projecting metadata inside SQLite without materializing reports.
      for (const row of this.db.prepare(legacyJobSummaryInput).iterate()) {
        const job = JSON.parse(String(row.payload)) as Job;
        for (const result of job.results)
          if (result.discord_delivery === null) delete result.discord_delivery;
        this.saveJobSummary(job);
      }
    });
    this.transaction(() => {
      for (const job of this.recoverableJobs()) {
        job.status = 'interrupted';
        job.error =
          'App restarted during this job. Review its results and run again; existing accounts are preserved.';
        finishJob(job, new Date().toISOString());
        this.saveJob(job);
        this.db.prepare('DELETE FROM job_queue WHERE job_id=?').run(job.id);
      }
      for (const row of this.db
        .prepare("SELECT id FROM subscriptions WHERE json_extract(payload,'$.status')='processing'")
        .all()) {
        const event = this.subscription(String(row.id))!;
        const job = event.job_id
          ? this.db.prepare('SELECT status FROM job_summaries WHERE id=?').get(event.job_id)
          : undefined;
        if (job?.status === 'canceled') {
          event.status = 'canceled';
          event.error = null;
          event.result =
            'Canceled. Completed account changes were preserved. Review the linked operation.';
        } else {
          event.status = 'failed';
          event.error =
            'App restarted during this event. Review account and job status before applying again.';
        }
        this.saveSubscription(event);
      }
    });
    this.purgeExpired();
    // A process interruption cannot prove whether Discord accepted a DM.
    for (const row of this.db
      .prepare("SELECT id,encrypted FROM bot_message_history WHERE status='pending'")
      .iterate()) {
      const value = this.decrypt<BotMessageHistory>(row.encrypted as Uint8Array);
      this.db
        .prepare('UPDATE bot_message_history SET status=?,encrypted=? WHERE id=?')
        .run('uncertain', this.encrypt({ ...value, status: 'uncertain' }), row.id);
    }
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
  settingRevisions(): Record<string, string> {
    return Object.fromEntries(
      this.db
        .prepare('SELECT field,revision FROM setting_revisions')
        .all()
        .map((row) => [String(row.field), String(row.revision)]),
    );
  }
  saveSettings(settings: Settings): void {
    const previous = this.settings();
    this.db.exec('SAVEPOINT new_subscriber_settings');
    try {
      this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1,?)').run(this.encrypt(settings));
      const revise = this.db.prepare(
        'INSERT OR REPLACE INTO setting_revisions (field,revision) VALUES (?,?)',
      );
      for (const field of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[])
        if (!isDeepStrictEqual(previous[field], settings[field])) revise.run(field, randomUUID());
      new NewSubscriberPolicy(this).capture(previous, settings);
      this.db.exec('RELEASE new_subscriber_settings');
    } catch (error) {
      this.db.exec('ROLLBACK TO new_subscriber_settings; RELEASE new_subscriber_settings');
      throw error;
    }
  }
  adminAlertConfig<T>(): T | null {
    const row = this.db.prepare('SELECT encrypted FROM admin_alert_config WHERE id=1').get();
    return row ? this.decrypt<T>(row.encrypted as Uint8Array) : null;
  }
  saveAdminAlertConfig(value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO admin_alert_config (id,encrypted) VALUES (1,?)')
      .run(this.encrypt(value));
  }
  clearAdminAlerts(): void {
    this.db.exec('DELETE FROM admin_alert_config; DELETE FROM admin_alert_receipts');
  }
  saveAdminAlertReceipt(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO admin_alert_receipts (id,encrypted) VALUES (?,?)')
      .run(id, this.encrypt(value));
  }
  baselineAdminAlerts(generation: string): void {
    // Iterate a narrow projection so a large migration history is never loaded into memory.
    for (const source of this.db.prepare(ADMIN_ALERT_SOURCES).iterate()) {
      const record = source as unknown as AdminAlertSource;
      this.saveAdminAlertReceipt(adminAlertReceiptId(generation, record), { baseline: true });
    }
  }
  pendingAdminAlertSources(generation: string, limit = 100): AdminAlertSource[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid private notification batch limit.');
    return this.db
      .prepare(
        `SELECT source.kind,source.id,source.status FROM (${ADMIN_ALERT_SOURCES}) AS source
        LEFT JOIN admin_alert_receipts AS receipt
        ON receipt.id=jellyport_admin_alert_receipt(?,source.kind,source.id,source.status)
        WHERE receipt.id IS NULL ORDER BY source.kind,source.id LIMIT ?`,
      )
      .all(generation, limit) as unknown as AdminAlertSource[];
  }
  pendingAdminAlertCount(generation: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM (${ADMIN_ALERT_SOURCES}) AS source
        LEFT JOIN admin_alert_receipts AS receipt
        ON receipt.id=jellyport_admin_alert_receipt(?,source.kind,source.id,source.status)
        WHERE receipt.id IS NULL`,
      )
      .get(generation);
    return Number(row!.count);
  }
  playlistImport(id: string): PlaylistImport | null {
    const row = this.db.prepare('SELECT encrypted FROM migration_playlists WHERE id=?').get(id);
    return row ? this.decrypt<PlaylistImport>(row.encrypted as Uint8Array) : null;
  }
  savePlaylistImport(id: string, value: PlaylistImport): void {
    this.db
      .prepare('INSERT OR REPLACE INTO migration_playlists VALUES (?,?)')
      .run(id, this.encrypt(value));
  }
  accountRoleRecords<T>(): Array<{ id: string; value: T }> {
    return this.db
      .prepare('SELECT id,encrypted FROM account_roles')
      .all()
      .map((row) => ({
        id: row.id as string,
        value: this.decrypt<T>(row.encrypted as Uint8Array),
      }));
  }
  saveAccountRoleRecord(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO account_roles (id,encrypted) VALUES (?,?)')
      .run(id, this.encrypt(value));
  }
  membershipRecords<T>(): Array<{ id: string; value: T }> {
    return this.db
      .prepare('SELECT id,encrypted FROM memberships')
      .all()
      .map((row) => ({
        id: row.id as string,
        value: this.decrypt<T>(row.encrypted as Uint8Array),
      }));
  }
  ownerRecords<T>(
    table: 'memberships' | 'media_ownership',
    discordId: string,
  ): Array<{ id: string; value: T }> {
    return this.db
      .prepare(`SELECT id,encrypted FROM ${table} WHERE owner_hash=? ORDER BY id`)
      .all(ownerIndexKey({ discord_user_id: discordId }))
      .map((row) => ({ id: String(row.id), value: this.decrypt<T>(row.encrypted as Uint8Array) }));
  }
  saveMembershipRecord(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO memberships (id,encrypted,owner_hash) VALUES (?,?,?)')
      .run(id, this.encrypt(value), ownerIndexKey(value));
  }
  saveMediaOwnerRecord(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO media_ownership (id,encrypted,owner_hash) VALUES (?,?,?)')
      .run(id, this.encrypt(value), ownerIndexKey(value));
  }
  accountProfileRecords<T>(): Array<{ id: string; value: T }> {
    return this.db
      .prepare('SELECT id,encrypted FROM account_profiles')
      .all()
      .map((row) => ({
        id: row.id as string,
        value: this.decrypt<T>(row.encrypted as Uint8Array),
      }));
  }
  accountProfileRecord<T>(id: string): T | null {
    const row = this.db.prepare('SELECT encrypted FROM account_profiles WHERE id=?').get(id);
    return row ? this.decrypt<T>(row.encrypted as Uint8Array) : null;
  }
  saveAccountProfileRecord(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO account_profiles (id,encrypted) VALUES (?,?)')
      .run(id, this.encrypt(value));
  }
  deleteAccountRoleRecord(id: string): void {
    this.db.prepare('DELETE FROM account_roles WHERE id=?').run(id);
  }
  accountRoleAssignmentRecords<T>(): Array<{ id: string; value: T }> {
    return this.db
      .prepare('SELECT id,encrypted FROM account_role_assignments')
      .all()
      .map((row) => ({
        id: row.id as string,
        value: this.decrypt<T>(row.encrypted as Uint8Array),
      }));
  }
  saveAccountRoleAssignmentRecord(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO account_role_assignments (id,encrypted) VALUES (?,?)')
      .run(id, this.encrypt(value));
  }
  deleteAccountRoleAssignmentRecord(id: string): void {
    this.db.prepare('DELETE FROM account_role_assignments WHERE id=?').run(id);
  }
  accountRenameRecord<T>(id: string): T | null {
    const row = this.db.prepare('SELECT encrypted FROM account_renames WHERE id=?').get(id);
    return row ? this.decrypt<T>(row.encrypted as Uint8Array) : null;
  }
  saveAccountRenameRecord(id: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO account_renames (id,encrypted) VALUES (?,?)')
      .run(id, this.encrypt(value));
  }
  deleteAccountRenameRecord(id: string): void {
    this.db.prepare('DELETE FROM account_renames WHERE id=?').run(id);
  }
  private identityBindingId(kind: 'account' | 'link', key: string): string {
    return createHash('sha256')
      .update(JSON.stringify([kind, key]))
      .digest('hex');
  }
  accountIdentityBinding(kind: 'account' | 'link', key: string): AccountIdentityBinding | null {
    const row = this.db
      .prepare('SELECT encrypted FROM account_identity_bindings WHERE id=?')
      .get(this.identityBindingId(kind, key));
    return row ? this.decrypt<AccountIdentityBinding>(row.encrypted as Uint8Array) : null;
  }
  deleteAccountIdentityBinding(kind: 'account' | 'link', key: string): void {
    this.db
      .prepare('DELETE FROM account_identity_bindings WHERE id=?')
      .run(this.identityBindingId(kind, key));
  }
  saveAccountIdentityBinding(
    kind: 'account' | 'link',
    key: string,
    remoteId: string | null,
    username: string,
  ): void {
    const auth = this.authState();
    const settings = this.settings();
    if (
      auth?.kind !== 'configured' ||
      normalizeJellyfinUrl(auth.serverUrl) !== normalizeJellyfinUrl(settings.jellyfin_url)
    ) {
      this.deleteAccountIdentityBinding(kind, key);
      return;
    }
    this.db
      .prepare('INSERT OR REPLACE INTO account_identity_bindings (id,encrypted) VALUES (?,?)')
      .run(
        this.identityBindingId(kind, key),
        this.encrypt({
          server_url: normalizeJellyfinUrl(auth.serverUrl),
          server_id: auth.serverId,
          remote_id: remoteId,
          username,
        } satisfies AccountIdentityBinding),
      );
  }
  authState(): AuthState | null {
    const row = this.db.prepare('SELECT encrypted FROM auth_state WHERE id=1').get();
    return row ? this.decrypt<AuthState>(row.encrypted as Uint8Array) : null;
  }
  ensureAuthState(): AuthState {
    return this.transaction(() => {
      const existing = this.authState();
      if (existing?.kind === 'configured') return existing;
      if (existing?.kind === 'pending') {
        // Migrate unfinished wizards by dropping obsolete local bootstrap secrets.
        const serverUrl = existing.serverUrl || this.settings().jellyfin_url;
        const state: AuthState = {
          kind: 'pending',
          generation: existing.generation,
          ...(serverUrl ? { serverUrl } : {}),
          ...(existing.previousServerId ? { previousServerId: existing.previousServerId } : {}),
        };
        this.db.prepare('UPDATE auth_state SET encrypted=? WHERE id=1').run(this.encrypt(state));
        return state;
      }
      return this.resetAuth();
    });
  }
  /** Local operator recovery; run with Jellyport stopped. Existing media data is preserved. */
  resetAuth(newServerUrl?: string): Extract<AuthState, { kind: 'pending' }> {
    const previous = this.authState();
    const previousServerId =
      previous?.kind === 'configured' ? previous.serverId : previous?.previousServerId;
    const serverUrl = newServerUrl ?? previous?.serverUrl ?? this.settings().jellyfin_url;
    const state = {
      kind: 'pending' as const,
      generation: randomBytes(24).toString('base64url'),
      ...(serverUrl ? { serverUrl } : {}),
      ...(previousServerId ? { previousServerId } : {}),
    };
    this.db.prepare('INSERT OR REPLACE INTO auth_state VALUES (1,?)').run(this.encrypt(state));
    return state;
  }
  completeAuth(
    generation: string,
    state: Extract<AuthState, { kind: 'configured' }>,
    updateSettings: (current: Settings) => Settings,
  ): boolean {
    return this.transaction(() => {
      const current = this.authState();
      if (current?.kind !== 'pending' || current.generation !== generation) return false;
      this.saveSettings(updateSettings(this.settings()));
      this.db.prepare('UPDATE auth_state SET encrypted=? WHERE id=1').run(this.encrypt(state));
      return true;
    });
  }
  updateServiceKey(serverId: string, apiKey: string, apiKeyName: string): boolean {
    return this.transaction(() => {
      const state = this.authState();
      if (state?.kind !== 'configured' || state.serverId !== serverId) return false;
      this.saveSettings({ ...this.settings(), jellyfin_api_key: apiKey });
      this.db
        .prepare('UPDATE auth_state SET encrypted=? WHERE id=1')
        .run(this.encrypt({ ...state, apiKeyName }));
      return true;
    });
  }
  saveJob(job: Job): void {
    // A savepoint composes with queue/claim transactions and makes metadata atomic
    // with the report even when this method is called without an outer transaction.
    this.db.exec('SAVEPOINT jellyport_save_job');
    try {
      this.db
        .prepare(
          'INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
        )
        .run(job.id, JSON.stringify(job));
      this.db
        .prepare('INSERT OR REPLACE INTO job_retention (job_id,age_ms) VALUES (?,?)')
        .run(job.id, jobRetentionTimestamp(job));
      this.saveJobSummary(job);
      this.db.exec('RELEASE jellyport_save_job');
      this.jobRevision++;
    } catch (error) {
      this.db.exec('ROLLBACK TO jellyport_save_job; RELEASE jellyport_save_job');
      throw error;
    }
  }
  jobRetentionDays(): number {
    return Number(
      this.db.prepare('SELECT days FROM job_retention_config WHERE id=1').get()?.days ?? 0,
    );
  }
  saveJobRetentionDays(days: number): void {
    this.db.prepare('INSERT OR REPLACE INTO job_retention_config (id,days) VALUES (1,?)').run(days);
  }
  jobRetentionCandidates(
    cutoff: number,
    cursor: JobRetentionCursor | null,
    limit: number,
  ): JobRetentionCursor[] {
    if (!Number.isFinite(cutoff) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid activity retention scan.');
    const rows = cursor
      ? this.db
          .prepare(
            `SELECT job_id AS id,age_ms FROM job_retention
          WHERE age_ms<? AND (age_ms,job_id)>(?,?) ORDER BY age_ms,job_id LIMIT ?`,
          )
          .all(cutoff, cursor.age_ms, cursor.id, limit)
      : this.db
          .prepare(
            `SELECT job_id AS id,age_ms FROM job_retention
          WHERE age_ms<? ORDER BY age_ms,job_id LIMIT ?`,
          )
          .all(cutoff, limit);
    return rows.map((row) => ({ id: String(row.id), age_ms: Number(row.age_ms) }));
  }
  job(id: string): Job | null {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id);
    return row ? (JSON.parse(row.payload as string) as Job) : null;
  }
  private saveJobSummary(job: Job): void {
    const { id, created_at, updated_at, finished_at, migration_scope, progress } = job;
    const { kind = 'operation', status = 'unknown' } = job;
    const cancel_requested =
      job.cancel_requested == null ? undefined : Boolean(job.cancel_requested);
    const results = (job.results ?? []).map(({ username, status }) => ({ username, status }));
    const outcome_status = jobOutcome(job).value;
    const summary: JobSummary = {
      id,
      kind,
      status,
      created_at,
      updated_at,
      finished_at,
      migration_scope,
      progress,
      results,
      outcome_status,
      cancel_requested,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO job_summaries
      (id,created_at,status,outcome,search_text,payload,owner_id,source_pins,destination_pin)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        created_at ?? '',
        status,
        outcome_status,
        `${kind} ${id} ${results.map((result) => result.username).join(' ')}`.toLowerCase(),
        JSON.stringify(summary),
        job.membership_discord_user_id ?? null,
        job.source_snapshot_ids ? JSON.stringify(job.source_snapshot_ids) : null,
        job.destination_catalog_id ?? null,
      );
  }
  jobCount(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM job_summaries').get()?.n);
  }
  householdJobSummaries(discordId: string): JobSummary[] {
    return this.db
      .prepare(
        `SELECT payload FROM job_summaries
      WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 50`,
      )
      .all(discordId)
      .map((row) => JSON.parse(row.payload as string) as JobSummary);
  }
  jobSummaryRevision(): string {
    return `${this.jobEpoch}:${this.jobRevision}`;
  }
  subscriptionCount(status: string): number {
    return Number(
      this.db
        .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE json_extract(payload,'$.status')=?")
        .get(status)?.n,
    );
  }
  jobsAwaitingCredentials(limit: number): Array<{ id: string; count: number }> {
    return this.db
      .prepare(
        `SELECT credentials.job_id AS id, COUNT(*) AS n
      FROM credentials JOIN job_summaries ON job_summaries.id=credentials.job_id
      WHERE credentials.expires>? AND job_summaries.status NOT IN ('queued','running')
      GROUP BY credentials.job_id ORDER BY MIN(credentials.expires),credentials.job_id LIMIT ?`,
      )
      .all(Date.now() / 1000, limit)
      .map((row) => ({ id: String(row.id), count: Number(row.n) }));
  }
  uncertainDeliveries(limit: number): string[] {
    return this.db
      .prepare(
        `SELECT job_id FROM bot_message_history
      WHERE status='uncertain' AND created_ms>?
      GROUP BY job_id ORDER BY MAX(created_ms) DESC LIMIT ?`,
      )
      .all(Date.now() - (this.settings().bot_message_retention_days ?? 30) * 86_400_000, limit)
      .map(({ job_id }) => String(job_id));
  }
  jobSummaries({
    status = 'all',
    query = '',
    limit,
    offset = 0,
    oldestFirst = false,
  }: JobSummaryQuery) {
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (status === 'active') conditions.push("status IN ('queued','running')");
    else if (status === 'partial') conditions.push("outcome IN ('partial','interrupted')");
    else if (status === 'canceled') conditions.push("outcome IN ('canceled','cancelled')");
    else if (status !== 'all') {
      conditions.push('outcome=?');
      bindings.push(status);
    }
    if (query.trim()) {
      conditions.push('instr(search_text,?)>0');
      bindings.push(query.trim().toLowerCase());
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const from = oldestFirst
      ? 'job_summaries LEFT JOIN job_retention ON job_id=id'
      : 'job_summaries';
    const order = oldestFirst
      ? `CASE WHEN status IN ('completed','partial','failed','interrupted','cancelled','canceled') THEN 0 ELSE 1 END,
        age_ms IS NULL,age_ms,created_at,id`
      : 'created_at DESC,id DESC';
    const jobs = this.db
      .prepare(`SELECT payload FROM ${from}${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...bindings, limit, offset)
      .map((row) => JSON.parse(String(row.payload)) as JobSummary);
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS n FROM job_summaries${where}`).get(...bindings)?.n,
    );
    return { jobs, total };
  }
  jobSummary(id: string): JobSummary | null {
    const row = this.db.prepare('SELECT payload FROM job_summaries WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.payload)) as JobSummary) : null;
  }
  activeJobCount(): number {
    return Number(
      this.db
        .prepare("SELECT COUNT(*) AS n FROM job_summaries WHERE status IN ('queued','running')")
        .get()?.n,
    );
  }
  activeSnapshotPins(kind: 'source' | 'destination'): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT source_pins,destination_pin FROM job_summaries WHERE status IN ('queued','running')",
      )
      .all();
    return new Set(
      rows.flatMap((row) =>
        kind === 'source'
          ? Object.values(JSON.parse(String(row.source_pins ?? '{}')) as Record<string, string>)
          : row.destination_pin
            ? [String(row.destination_pin)]
            : [],
      ),
    );
  }
  hasActiveMemberJob(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM job_summaries WHERE owner_id=? AND status IN ('queued','running') LIMIT 1",
      )
      .get(id);
  }
  private recoverableJobs(): Job[] {
    return this.db
      .prepare(
        `SELECT jobs.payload FROM job_summaries
      JOIN jobs USING(id)
      WHERE job_summaries.status IN ('queued','running')
        AND (job_summaries.status='running'
          OR NOT EXISTS(SELECT 1 FROM job_queue WHERE job_id=jobs.id))`,
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)) as Job);
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT payload FROM jobs ORDER BY json_extract(payload,'$.created_at') DESC")
      .all()
      .map((row) => JSON.parse(row.payload as string) as Job);
  }
  clearJobHistory(
    jobIds: string[],
    activeIds: ReadonlySet<string>,
    retention?: { cutoff: number; now: number },
  ): JobHistoryCleanupResult {
    if (!jobIds.length || jobIds.length > 1000 || new Set(jobIds).size !== jobIds.length)
      throw new Error('Activity cleanup requires 1 to 1000 distinct report IDs.');
    if (retention && (!Number.isFinite(retention.cutoff) || !Number.isFinite(retention.now)))
      throw new Error('Invalid activity retention cutoff.');
    return this.transaction(() => {
      const result: JobHistoryCleanupResult = { removed_ids: [], skipped: [] };
      const time = (retention?.now ?? Date.now()) / 1000;
      const inspect = this.db.prepare(`
        SELECT json_extract(payload,'$.status') AS status,
          json_extract(payload,'$.finished_at') AS finished_at,
          json_extract(payload,'$.updated_at') AS updated_at,
          json_extract(payload,'$.created_at') AS created_at,
          EXISTS(SELECT 1 FROM job_queue WHERE job_id=jobs.id) AS queued,
          EXISTS(SELECT 1 FROM credentials WHERE job_id=jobs.id AND expires>?) AS credentials
        FROM jobs WHERE id=?`);
      const processing = this.db.prepare(`SELECT 1 FROM subscriptions
        WHERE json_extract(payload,'$.job_id')=?
          AND json_extract(payload,'$.status')='processing' LIMIT 1`);
      // Project only identity strings. A report may contain megabytes of migration
      // diagnostics; cleanup must not deserialize or retain those details in memory.
      const usernames = this.db.prepare(`SELECT json_extract(value,'$.username') AS username
        FROM jobs,json_each(jobs.payload,'$.results') WHERE jobs.id=?`);
      const removeCredentials = this.db.prepare('DELETE FROM credentials WHERE job_id=?');
      const remove = this.db.prepare('DELETE FROM jobs WHERE id=?');
      const detach = this.db.prepare(`UPDATE subscriptions
        SET payload=json_set(json_remove(payload,'$.job_id'),'$.report_cleared',json('true'))
        WHERE json_extract(payload,'$.job_id')=?`);
      const terminal = new Set([
        'completed',
        'partial',
        'failed',
        'interrupted',
        'cancelled',
        'canceled',
      ]);
      for (const id of jobIds) {
        let reason: JobHistoryCleanupSkipReason | undefined;
        const row = inspect.get(time, id);
        const age = retention && row ? jobRetentionTimestamp(row) : null;
        if (!row) reason = 'not_found';
        else if (activeIds.has(id)) reason = 'active';
        else if (!terminal.has(String(row.status)) || row.queued) reason = 'not_finished';
        else if (retention && (age === null || age >= retention.cutoff)) reason = 'not_finished';
        else if (row.credentials) reason = 'pending_credentials';
        else if (processing.get(id)) reason = 'subscription_processing';
        else {
          for (const row of usernames.iterate(id)) {
            const account = typeof row.username === 'string' ? this.account(row.username) : null;
            if (
              account &&
              ['uncertain', 'provisioning', 'clone_uncertain', 'clone_incomplete'].includes(
                account.status,
              )
            ) {
              reason = 'recovery_required';
              break;
            }
          }
        }
        if (reason) {
          result.skipped.push({ id, reason });
          continue;
        }
        detach.run(id);
        removeCredentials.run(id);
        remove.run(id);
        result.removed_ids.push(id);
      }
      if (result.removed_ids.length) this.jobRevision++;
      // Journals, subscription dedupe, identity links and alert receipts are separate
      // operational state. They deliberately survive removing a presentation report.
      return result;
    });
  }
  saveQueuedJob(
    job: Job,
    requests: JobRequest[],
    settings: Settings,
    beforePersist?: () => void,
    submission?: MigrationSubmission,
    sourceScope?: string,
  ): void {
    this.transaction(() => {
      beforePersist?.();
      this.saveJob(job);
      this.db
        .prepare('INSERT INTO job_queue VALUES (?,?)')
        .run(job.id, this.encrypt({ requests, settings }));
      const sources = requests.flatMap(({ source_user_id }) =>
        source_user_id ? [source_user_id] : [],
      );
      if (sources.length)
        this.db
          .prepare('INSERT INTO migration_submissions VALUES (?,?,?,?,?,?)')
          .run(
            job.id,
            submission?.key ?? null,
            submission?.owner ?? null,
            submission?.requestHash ?? null,
            JSON.stringify(sources),
            sourceScope ?? null,
          );
    });
  }
  migrationSubmission(key: string): { id: string; requestHash: string } | null {
    const row = this.db
      .prepare('SELECT job_id,request_hash FROM migration_submissions WHERE receipt_key=?')
      .get(key);
    return row ? { id: String(row.job_id), requestHash: String(row.request_hash) } : null;
  }
  latestMigrationSubmission(owner: string): string | null {
    const row = this.db
      .prepare(
        'SELECT job_id FROM migration_submissions WHERE owner_scope=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(owner);
    return row ? String(row.job_id) : null;
  }
  migrationSources(id: string): { ids: string[]; scope: string } | null {
    const row = this.db
      .prepare('SELECT source_ids,source_scope FROM migration_submissions WHERE job_id=?')
      .get(id);
    return row && typeof row.source_scope === 'string'
      ? { ids: JSON.parse(String(row.source_ids)) as string[], scope: row.source_scope }
      : null;
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
  cancelQueuedJob(id: string): Job | null {
    return this.transaction(() => {
      const job = this.job(id);
      if (!job || job.status !== 'queued') return null;
      job.status = 'canceled';
      job.cancel_requested = true;
      job.updated_at = new Date().toISOString();
      job.finished_at = job.updated_at;
      job.error = 'Canceled before account work began.';
      this.saveJob(job);
      this.db.prepare('DELETE FROM job_queue WHERE job_id=?').run(id);
      return job;
    });
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
    this.db.exec('SAVEPOINT jellyport_save_account');
    try {
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
      this.saveAccountIdentityBinding('account', nameKey(username), remoteId, username);
      this.db.exec('RELEASE jellyport_save_account');
    } catch (error) {
      this.db.exec('ROLLBACK TO jellyport_save_account; RELEASE jellyport_save_account');
      throw error;
    }
  }
  accountPassword(account: Account): string | null {
    return account.password && (account.expires ?? 0) > Date.now() / 1000
      ? this.decrypt<string>(account.password)
      : null;
  }
  saveCredentials(
    jobId: string,
    username: string,
    password: string,
    serverUrl: string,
    message?: string,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO credentials (job_id,username,encrypted,expires) VALUES (?,?,?,?)',
      )
      .run(
        jobId,
        username,
        this.encrypt({
          username,
          password,
          server_url: serverUrl,
          ...(message ? { message } : {}),
        }),
        Date.now() / 1000 + 86400,
      );
  }
  saveBotMessage(jobId: string, message: BotMessageHistory): void {
    if (!this.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId))
      throw new Error('Message history requires an existing activity.');
    const timestamp = Date.parse(message.created_at);
    if (!message.id || !Number.isFinite(timestamp) || message.content.length > 2000)
      throw new Error('Invalid bot message history.');
    const existing = this.db
      .prepare('SELECT job_id,encrypted FROM bot_message_history WHERE id=?')
      .get(message.id);
    if (existing) {
      const previous = this.decrypt<BotMessageHistory>(existing.encrypted as Uint8Array);
      if (
        existing.job_id !== jobId ||
        previous.created_at !== message.created_at ||
        previous.content !== message.content ||
        previous.recipient_id !== message.recipient_id ||
        previous.account_username !== message.account_username ||
        previous.membership_slot !== message.membership_slot ||
        previous.status !== 'pending'
      )
        throw new Error('Bot message history is immutable after delivery.');
    }
    this.db
      .prepare('INSERT OR REPLACE INTO bot_message_history VALUES (?,?,?,?,?)')
      .run(message.id, jobId, timestamp, message.status, this.encrypt(message));
  }
  botMessages(jobId: string): BotMessageHistory[] {
    const days = this.settings().bot_message_retention_days ?? 30;
    const cutoff = days > 0 ? Date.now() - days * 86400_000 : -Number.MAX_VALUE;
    return this.db
      .prepare(
        'SELECT encrypted FROM bot_message_history WHERE job_id=? AND created_ms>? ORDER BY created_ms,id LIMIT 1000',
      )
      .all(jobId, cutoff)
      .map((row) => this.decrypt<BotMessageHistory>(row.encrypted as Uint8Array));
  }
  pruneBotMessages(): void {
    const days = this.settings().bot_message_retention_days ?? 30;
    if (days > 0)
      this.db
        .prepare(
          'DELETE FROM bot_message_history WHERE id IN (SELECT id FROM bot_message_history WHERE created_ms<=? LIMIT 500)',
        )
        .run(Date.now() - days * 86400_000);
  }
  deleteCredentials(jobId: string, username: string): void {
    this.db.prepare('DELETE FROM credentials WHERE job_id=? AND username=?').run(jobId, username);
  }
  takeCredentials(jobId: string): Credentials[] {
    return this.transaction(() => {
      const time = Date.now() / 1000;
      const values = this.db
        .prepare(
          'SELECT encrypted FROM credentials WHERE job_id=? AND expires>? AND reveal_session IS NULL',
        )
        .all(jobId, time)
        .map((row) => this.decrypt<Credentials>(row.encrypted as Uint8Array));
      this.db
        .prepare(
          'DELETE FROM credentials WHERE (job_id=? AND reveal_session IS NULL) OR expires<=?',
        )
        .run(jobId, time);
      return values;
    });
  }
  revealCredentials(jobId: string, sessionId: string): Credentials[] {
    const owner = createHash('sha256').update(sessionId).digest('hex');
    return this.transaction(() => {
      const time = Date.now() / 1000;
      this.db
        .prepare(
          'UPDATE credentials SET reveal_session=?, expires=MIN(expires,?) WHERE job_id=? AND expires>? AND reveal_session IS NULL',
        )
        .run(owner, time + credentialRecoverySeconds, jobId, time);
      return this.db
        .prepare(
          'SELECT encrypted FROM credentials WHERE job_id=? AND reveal_session=? AND expires>? ORDER BY username',
        )
        .all(jobId, owner, time)
        .map((row) => this.decrypt<Credentials>(row.encrypted as Uint8Array));
    });
  }
  consumeCredentialReceipt(jobId: string, sessionId: string): void {
    const owner = createHash('sha256').update(sessionId).digest('hex');
    this.db
      .prepare('DELETE FROM credentials WHERE job_id=? AND reveal_session=?')
      .run(jobId, owner);
  }
  discardSessionCredentialReceipts(sessionId: string): void {
    const owner = createHash('sha256').update(sessionId).digest('hex');
    this.db.prepare('DELETE FROM credentials WHERE reveal_session=?').run(owner);
  }
  link(id: string, slot = 1): Link | null {
    return (
      (this.db
        .prepare(
          'SELECT discord_user_id,membership_slot,username,remote_id,disabled_by_jellyport,pending_disabled FROM links WHERE discord_user_id=? AND membership_slot=?',
        )
        .get(String(id), slot) as unknown as Link) ?? null
    );
  }
  linkForRemote(id: string): Link | null {
    return (
      (this.db
        .prepare(
          'SELECT discord_user_id,membership_slot,username,remote_id,disabled_by_jellyport,pending_disabled FROM links WHERE remote_id=?',
        )
        .get(id) as unknown as Link) ?? null
    );
  }
  links(): Link[] {
    return this.db
      .prepare(
        'SELECT discord_user_id,membership_slot,username,remote_id,disabled_by_jellyport,pending_disabled FROM links ORDER BY discord_user_id,membership_slot',
      )
      .all() as unknown as Link[];
  }
  linksForMember(id: string): Link[] {
    return this.db
      .prepare(
        'SELECT discord_user_id,membership_slot,username,remote_id,disabled_by_jellyport,pending_disabled FROM links WHERE discord_user_id=? ORDER BY membership_slot',
      )
      .all(String(id)) as unknown as Link[];
  }
  saveLink(
    discordId: string,
    username: string,
    remoteId: string,
    disabled = false,
    slot = 1,
  ): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > 3)
      throw new Error('Invalid membership account slot.');
    this.db.exec('SAVEPOINT jellyport_save_link');
    try {
      const previous = this.link(discordId, slot);
      this.db
        .prepare(
          'INSERT INTO links (discord_user_id,membership_slot,username,remote_id,disabled_by_jellyport,pending_disabled,discord_authority) VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(discord_user_id,membership_slot) DO UPDATE SET username=excluded.username, remote_id=excluded.remote_id, disabled_by_jellyport=excluded.disabled_by_jellyport, pending_disabled=NULL',
        )
        .run(
          String(discordId),
          slot,
          username,
          remoteId,
          Number(disabled),
          previous ? null : discordAuthority(this.settings()),
        );
      if (previous && previous.remote_id !== remoteId)
        this.deleteAccountIdentityBinding('link', previous.remote_id);
      this.saveAccountIdentityBinding('link', remoteId, remoteId, username);
      this.db.exec('RELEASE jellyport_save_link');
    } catch (error) {
      this.db.exec('ROLLBACK TO jellyport_save_link; RELEASE jellyport_save_link');
      throw error;
    }
  }
  linkAuthorities(discordId: string): Array<string | null> {
    return this.db
      .prepare(
        'SELECT discord_authority FROM links WHERE discord_user_id=? ORDER BY membership_slot',
      )
      .all(discordId)
      .map((row) => row.discord_authority as string | null);
  }
  approveLinkAuthority(link: Link, settings: Settings): void {
    const updated = this.db
      .prepare(
        'UPDATE links SET discord_authority=? WHERE discord_user_id=? AND membership_slot=? AND remote_id=? AND username=?',
      )
      .run(
        discordAuthority(settings),
        link.discord_user_id,
        link.membership_slot,
        link.remote_id,
        link.username,
      );
    if (updated.changes !== 1)
      throw new Error('The linked account changed. Review this household again.');
  }
  setLinkPending(discordId: string, disabled: boolean | null, slot = 1): void {
    this.db
      .prepare('UPDATE links SET pending_disabled=? WHERE discord_user_id=? AND membership_slot=?')
      .run(disabled === null ? null : Number(disabled), String(discordId), slot);
  }
  private householdAccessKey(discordId: string, settings: Settings): string {
    const auth = this.authState();
    return createHash('sha256')
      .update(
        JSON.stringify([
          discordId,
          settings.jellyfin_url,
          settings.emby_url,
          auth?.kind === 'configured' ? auth.serverId : null,
        ]),
      )
      .digest('hex');
  }
  householdAccessChanges(discordId: string, settings: Settings): HouseholdAccessChange[] {
    const owner = this.householdAccessKey(discordId, settings);
    return this.db
      .prepare(
        `SELECT id,encrypted FROM household_access_history
      WHERE owner_key=? ORDER BY at DESC,id DESC LIMIT 50`,
      )
      .all(owner)
      .map((row) => {
        const saved = this.decrypt<{ owner: string; change: HouseholdAccessChange }>(
          row.encrypted as Uint8Array,
        );
        if (saved.owner !== owner || saved.change.id !== row.id)
          throw new Error('The saved household access history belongs to another record.');
        return saved.change;
      });
  }
  saveHouseholdAccessChange(
    discordId: string,
    settings: Settings,
    input: Pick<HouseholdAccessChange, 'kind' | 'username' | 'disabled'>,
  ): void {
    const owner = this.householdAccessKey(discordId, settings);
    const change = { ...input, id: randomUUID(), at: new Date().toISOString() };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO household_access_history VALUES (?,?,?,?)')
        .run(change.id, owner, change.at, this.encrypt({ owner, change }));
      this.db
        .prepare(
          `DELETE FROM household_access_history WHERE id IN (
        SELECT id FROM household_access_history WHERE owner_key=? ORDER BY at DESC,id DESC LIMIT -1 OFFSET 50
      )`,
        )
        .run(owner);
    });
  }
  subscription(id: string): SubscriptionEvent | null {
    const row = this.db.prepare('SELECT payload FROM subscriptions WHERE id=?').get(id);
    return row ? this.decodeSubscription(row.payload as string) : null;
  }
  private decodeSubscription(payload: string): SubscriptionEvent {
    const event = JSON.parse(payload) as SubscriptionEvent & {
      _stripe_entitlement_encrypted?: string;
    };
    if (event._stripe_entitlement_encrypted !== undefined) {
      if (typeof event._stripe_entitlement_encrypted !== 'string')
        throw new Error('The saved Stripe entitlement could not be verified.');
      const saved = this.decrypt<{
        event_id: string;
        fact: NonNullable<SubscriptionEvent['stripe_entitlement']>;
      }>(Buffer.from(event._stripe_entitlement_encrypted, 'base64'));
      if (saved.event_id !== event.id || saved.fact?.event_id !== event.id)
        throw new Error('The saved Stripe entitlement belongs to a different subscription event.');
      event.stripe_entitlement = saved.fact;
      delete event._stripe_entitlement_encrypted;
    }
    return event;
  }
  subscriptionsForMember(discordId: string, source?: string, limit = -1): SubscriptionEvent[] {
    const filter = "json_extract(payload,'$.discord_user_id')=?";
    const order = "ORDER BY json_extract(payload,'$.created_at') DESC LIMIT ?";
    const rows =
      source === undefined
        ? this.db
            .prepare(`SELECT payload FROM subscriptions WHERE ${filter} ${order}`)
            .all(discordId, limit)
        : this.db
            .prepare(
              `SELECT payload FROM subscriptions WHERE ${filter} AND json_extract(payload,'$.source')=? ${order}`,
            )
            .all(discordId, source, limit);
    return rows.map((row) => this.decodeSubscription(row.payload as string));
  }
  subscriptions(): SubscriptionEvent[] {
    return this.db
      .prepare(
        "SELECT payload FROM subscriptions ORDER BY json_extract(payload,'$.created_at') DESC",
      )
      .all()
      .map((row) => this.decodeSubscription(row.payload as string));
  }
  saveSubscription(event: SubscriptionEvent): void {
    const { stripe_entitlement, ...payload } = event as SubscriptionEvent & {
      _stripe_entitlement_encrypted?: string;
    };
    delete payload._stripe_entitlement_encrypted;
    if (stripe_entitlement)
      payload._stripe_entitlement_encrypted = this.encrypt({
        event_id: event.id,
        fact: stripe_entitlement,
      }).toString('base64');
    this.db
      .prepare('INSERT OR REPLACE INTO subscriptions VALUES (?,?)')
      .run(event.id, JSON.stringify(payload));
  }
  purgeExpired(): void {
    const time = Date.now() / 1000;
    this.transaction(() => {
      this.db.prepare('DELETE FROM credentials WHERE expires<=?').run(time);
      this.db.prepare('UPDATE accounts SET password=NULL,expires=NULL WHERE expires<=?').run(time);
    });
    this.pruneBotMessages();
  }
  close(): void {
    this.db.close();
  }
}
