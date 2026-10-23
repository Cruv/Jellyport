import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.js';
import {
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ITEMS,
  projectCatalogItem,
  isObject,
  type ClientFactory,
  type MediaItem,
  type MediaAPI,
} from './media.js';
import type { Settings } from './types.js';
import type { PathMapping } from './matching.js';
import {
  BACKUP_CLEANUP_DEADLINE,
  BACKUP_CLEANUP_MAX_FILES,
  BACKUP_CLEANUP_ERROR,
  backupCleanupPrefix,
  sameBackupBinding,
  validBackupCleanupResult,
  type OwnedJellyfinBackup,
  type BackupRetentionConfig,
  type BackupCleanupRequest,
  type BackupCleanupResult,
} from './jellyfin-backup-retention.js';
import { MediaError, ServiceError } from './errors.js';
import { validJellyfinBackupName, type JellyfinBackupManifest } from './jellyfin-backup-api.js';
import {
  dailyImportSchedule,
  ImportCoordinator,
  validateDailyImportConfig,
  type DailyImportConfig,
  type ImportOutcome,
} from './daily-import-schedule.js';
import { snapshotProcess } from './snapshot-process.js';
import { decryptDatabase, readEnvelope, snapshotKey, writeEnvelope } from './snapshot-files.js';
import {
  DESTINATION_CATALOG_MAX_AGE,
  DESTINATION_BACKUP_SERVER_VERSION,
  DESTINATION_CATALOG_RECOVERY_DEADLINE,
  DESTINATION_CATALOG_REQUEST_MAX_AGE,
  destinationCatalogMetadata,
  destinationCatalogPrefix,
  normalizedServerVersion,
  validDestinationResult,
  validDestinationDiagnostic,
  validDestinationProgress,
  validDestinationErrorCode,
  destinationCatalogFailureMessage,
  type DestinationCatalogDiagnostic,
  type DestinationCatalogErrorCode,
  type DestinationCatalogProgress,
  type DestinationCatalogMetadata,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
} from './destination-catalog-files.js';

const CLEANUP_ERROR =
  'Temporary Jellyfin catalog cleanup failed. Review private storage permissions before importing or reading more data.';
const IDLE_MS = 60_000;
export const JELLYFIN_BACKUP_WAIT_MS = 30 * 60_000;
const BACKUP_POLL_MS = 15_000;
const BACKUP_PREFLIGHT_RETRY_MS = 60_000;
class BackupPreflightBusy extends ServiceError {}
type CatalogConfig = DailyImportConfig & { create_backup?: boolean };
interface BackupCreation {
  id: string;
  binding: DestinationCatalogRequest['binding'];
  connection: string;
  phase: 'creating' | 'waiting' | 'uncertain';
  started_at: string;
  deadline_at: string;
  baseline: string[];
  completed?: JellyfinBackupManifest;
}
const connectionHash = (settings: Settings) =>
  createHash('sha256')
    .update(JSON.stringify([settings.jellyfin_url, settings.jellyfin_api_key]))
    .digest('hex');
const BACKUP_UNCERTAIN =
  'Jellyfin backup completion could not be confirmed. No new backup will be requested automatically. Check Jellyfin Backups, then refresh status. Confirm it has finished or stopped before releasing this attempt. The last saved catalog is preserved.';
interface State {
  config: CatalogConfig;
  configured: boolean;
  generations: DestinationCatalogResult[];
  active?: DestinationCatalogRequest;
  active_publication_pending?: boolean;
  backup_preflight_retry_at?: string;
  backup_creation?: BackupCreation;
  last_attempt_at: string | null;
  last_error: string | null;
  last_finished_at?: string | null;
  last_outcome?: ImportOutcome;
  last_scheduled_date?: string;
  last_diagnostic?: DestinationCatalogDiagnostic;
  last_error_code?: DestinationCatalogErrorCode | null;
  backup_retention?: BackupRetentionConfig;
  owned_backups?: OwnedJellyfinBackup[];
  backup_cleanup?: {
    pending?: BackupCleanupRequest;
    last_run_at: string | null;
    last_outcome: 'succeeded' | 'failed' | 'interrupted' | null;
    last_deleted: number;
    error: string | null;
  };
}
interface DatabaseEntry {
  promise: Promise<string>;
  directory?: string;
  users: number;
  lastUsed: number;
}
function canceled(): ServiceError {
  return new ServiceError('Saved Jellyfin catalog preparation was canceled.');
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw canceled();
}
async function cancelable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(canceled());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
function sameBinding(
  first: DestinationCatalogRequest['binding'],
  second: DestinationCatalogRequest['binding'],
): boolean {
  try {
    return (
      new URL(first.url).toString() === new URL(second.url).toString() &&
      first.server_id.toLowerCase() === second.server_id.toLowerCase() &&
      normalizedServerVersion(first.version) === normalizedServerVersion(second.version)
    );
  } catch {
    return false;
  }
}
function current(value: DestinationCatalogResult): boolean {
  return (
    validDestinationResult(value) &&
    Date.now() - Date.parse(value.backup_created_at!) <= DESTINATION_CATALOG_MAX_AGE &&
    Date.parse(value.backup_created_at!) <= Date.now() + 60_000 &&
    Date.parse(value.finished_at) <= Date.now() + 60_000
  );
}
function neutralItems(value: unknown, trustedMembership = false): MediaItem[] {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ITEMS)
    throw new ServiceError('The saved Jellyfin catalog returned too many matching candidates.');
  let bytes = 2;
  return value.map((raw) => {
    const item = projectCatalogItem(raw);
    if (trustedMembership && isObject(raw) && Object.hasOwn(raw, 'JellyportLibraryConfigHash')) {
      if (
        typeof raw.JellyportLibraryConfigHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.JellyportLibraryConfigHash)
      )
        throw new ServiceError(
          'The saved Jellyfin library configuration is invalid. Import again.',
        );
      item.JellyportLibraryConfigHash = raw.JellyportLibraryConfigHash;
    }
    // Only the authenticated private projection worker can supply this reserved
    // membership field. Remote DTO projectors deliberately never copy it.
    if (trustedMembership && isObject(raw) && Object.hasOwn(raw, 'JellyportLibraryIds')) {
      const ids = raw.JellyportLibraryIds;
      if (
        !Array.isArray(ids) ||
        item.JellyportLibraryConfigHash === undefined ||
        ids.length > 1000 ||
        ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new ServiceError('The saved Jellyfin library membership is invalid. Import again.');
      item.JellyportLibraryIds = [...ids] as string[];
    }
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > MAX_CATALOG_BYTES)
      throw new ServiceError(
        'The saved Jellyfin matching candidates exceed the supported account size.',
      );
    return item;
  });
}

export class DestinationCatalogs {
  private readonly directory = process.env.JELLYPORT_SNAPSHOT_DIR || '';
  private key?: Buffer;
  private state: State;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private clearing = false;
  private starting = false;
  private backupSelectionSupported = false;
  private backupCleanupSupported = false;
  private cleanupStarting = false;
  private backupClient?: MediaAPI;
  private readonly backupReadClients = new Set<MediaAPI>();
  private backupPollAt = 0;
  private backupRetryAt = 0;
  private handoffRetryAt = 0;
  private readonly imports: ImportCoordinator;
  private revision = 0;
  private readonly reads = new AbortController();
  private readonly databases = new Map<string, DatabaseEntry>();
  private readonly pendingCleanup = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly options: {
      demo?: boolean;
      clientFactory: () => ClientFactory;
      imports?: ImportCoordinator;
    },
  ) {
    const mode = process.env.JELLYPORT_JELLYFIN_CATALOG_MODE;
    if (mode !== undefined && mode !== '' && mode !== 'backup')
      throw new ServiceError('JELLYPORT_JELLYFIN_CATALOG_MODE must be backup or unset.');
    const row = store.db
      .prepare('SELECT encrypted FROM destination_catalog_state WHERE id=1')
      .get();
    this.state = row
      ? store.decrypt<State>(row.encrypted as Uint8Array)
      : {
          config: {
            enabled: false,
            hour: 3,
            minute: 0,
            time_zone: process.env.TZ || 'Etc/UTC',
            revision: randomUUID(),
          },
          configured: false,
          generations: [],
          last_attempt_at: null,
          last_error: null,
        };
    this.imports = options.imports ?? new ImportCoordinator();
    const retryAt = Date.parse(this.state.backup_preflight_retry_at ?? '');
    if (Number.isFinite(retryAt) && retryAt <= Date.now() + BACKUP_PREFLIGHT_RETRY_MS)
      this.backupRetryAt = retryAt;
    this.state.backup_retention ??= { enabled: false, keep: 7, revision: randomUUID() };
    this.state.owned_backups ??= [];
    this.state.backup_cleanup ??= {
      last_run_at: null,
      last_outcome: null,
      last_deleted: 0,
      error: null,
    };
    if (this.state.backup_cleanup.pending)
      this.imports.restore(`jellyfin-cleanup:${this.state.backup_cleanup.pending.id}`);
    if (!validDestinationDiagnostic(this.state.last_diagnostic)) delete this.state.last_diagnostic;
    if (!validDestinationErrorCode(this.state.last_error_code)) delete this.state.last_error_code;
    if (this.state.active) this.imports.restore(`jellyfin:${this.state.active.id}`);
    if (this.state.backup_creation) {
      // The server has no idempotency key or job cancellation API. A saved POST
      // intent is reconciled read-only after restart, never sent a second time.
      if (this.state.backup_creation.phase === 'creating')
        this.state.backup_creation.phase = 'waiting';
      this.imports.restore(`jellyfin:${this.state.backup_creation.id}`);
    }
    if (!this.state.config) {
      this.state.config = {
        enabled: false,
        hour: 3,
        minute: 0,
        time_zone: process.env.TZ || 'Etc/UTC',
        revision: randomUUID(),
      };
      this.save();
    }
    if (
      !this.state.active &&
      !this.state.backup_creation &&
      this.state.last_outcome === 'running'
    ) {
      this.state.last_outcome = 'interrupted';
      this.state.last_error_code = 'interrupted';
      this.state.last_finished_at = new Date().toISOString();
      this.state.last_error =
        'Jellyfin import preparation was interrupted before a helper request was saved. Check status before starting a new import. Any previously saved catalog is preserved.';
      this.save();
    }
    if (mode === 'backup' && !this.state.configured) {
      this.state.configured = true;
      this.save();
    }
  }
  private save() {
    this.store.db
      .prepare('INSERT OR REPLACE INTO destination_catalog_state VALUES(1,?)')
      .run(this.store.encrypt(this.state));
  }
  async start(): Promise<void> {
    if (!this.directory || this.options.demo || this.timer) return;
    this.key = await snapshotKey(this.directory, true);
    for (const name of await readdir(this.directory))
      if (/^read-jellyfin-[a-f0-9-]{36}-[A-Za-z0-9]+$/.test(name))
        await rm(join(this.directory, name), { recursive: true, force: true });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
  }
  private async helper(): Promise<boolean> {
    if (!this.key || this.options.demo) return false;
    try {
      const value = await readEnvelope<{
        version: number;
        jellyfin_catalog_enabled?: boolean;
        jellyfin_backup_selection_enabled?: boolean;
        jellyfin_backup_cleanup_enabled?: boolean;
        updated_at: string;
      }>(join(this.directory, 'helper.status'), this.key);
      if (
        value.version !== 1 ||
        value.jellyfin_catalog_enabled !== true ||
        typeof value.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(value.updated_at)) ||
        Math.abs(Date.now() - Date.parse(value.updated_at)) >= 20_000
      )
        return false;
      this.backupSelectionSupported = value.jellyfin_backup_selection_enabled === true;
      this.backupCleanupSupported = value.jellyfin_backup_cleanup_enabled === true;
      if (!this.state.configured) {
        this.state.configured = true;
        this.save();
      }
      return true;
    } catch {
      this.backupSelectionSupported = false;
      this.backupCleanupSupported = false;
      return false;
    }
  }
  private pins(): Set<string> {
    return new Set(
      this.store
        .jobs()
        .filter((job) => ['queued', 'running'].includes(job.status))
        .flatMap((job) => (job.destination_catalog_id ? [job.destination_catalog_id] : [])),
    );
  }
  private async completeFile(value: DestinationCatalogResult): Promise<boolean> {
    try {
      const stat = await lstat(
        join(this.directory, `${destinationCatalogPrefix(value.id)}.db.enc`),
      );
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === value.bytes! + 28;
    } catch {
      return false;
    }
  }
  async status() {
    const available = await this.helper();
    const latest = this.state.generations[0];
    const record =
      latest && validDestinationResult(latest) ? destinationCatalogMetadata(latest) : null;
    let usable = false;
    try {
      usable =
        !!latest &&
        current(latest) &&
        new URL(latest.binding.url).toString() ===
          new URL(this.store.settings().jellyfin_url).toString() &&
        (await this.completeFile(latest));
    } catch {
      /* An expired/missing record remains visible, but cannot be selected. */
    }
    return {
      config: { ...this.state.config, create_backup: this.state.config.create_backup === true },
      backup_cleanup: {
        config: { ...this.state.backup_retention! },
        supported: available && this.backupCleanupSupported,
        running: this.cleanupStarting || !!this.state.backup_cleanup!.pending,
        owned_backups: this.state.owned_backups!.length,
        last_run_at: this.state.backup_cleanup!.last_run_at,
        last_outcome: this.state.backup_cleanup!.last_outcome,
        last_deleted: this.state.backup_cleanup!.last_deleted,
        error: this.state.backup_cleanup!.error,
      },
      backup_creation: this.state.backup_creation
        ? {
            attempt_id: this.state.backup_creation.id,
            phase: this.state.backup_creation.phase,
            started_at: this.state.backup_creation.started_at,
            deadline_at: this.state.backup_creation.deadline_at,
          }
        : null,
      next_run_at:
        this.backupRetryAt > Date.now() &&
        dailyImportSchedule(this.state.config, this.state.last_scheduled_date).due
          ? new Date(this.backupRetryAt).toISOString()
          : dailyImportSchedule(this.state.config, this.state.last_scheduled_date).next_run_at,
      configured: this.state.configured,
      available,
      usable,
      running:
        this.starting ||
        !!this.state.active ||
        this.cleanupStarting ||
        !!this.state.backup_cleanup!.pending ||
        !!(this.state.backup_creation && this.state.backup_creation.phase !== 'uncertain'),
      record,
      last_attempt_at: this.state.last_attempt_at,
      last_finished_at:
        this.state.last_finished_at === undefined
          ? (this.state.generations[0]?.finished_at ?? null)
          : this.state.last_finished_at,
      last_error: this.state.last_error,
      error_code: this.state.last_error_code ?? null,
      diagnostic: this.state.last_diagnostic ?? null,
      last_outcome:
        this.starting ||
        this.state.active ||
        (this.state.backup_creation && this.state.backup_creation.phase !== 'uncertain')
          ? ('running' as const)
          : (this.state.last_outcome ??
            (this.state.last_error
              ? 'failed'
              : this.state.generations.length
                ? 'succeeded'
                : null)),
    };
  }
  async configure(input: Omit<CatalogConfig, 'revision'> & { expected_revision: string }) {
    if (this.options.demo)
      throw new ServiceError('Jellyfin import changes are unavailable in demo mode.');
    if (input.expected_revision !== this.state.config.revision)
      throw new ServiceError('The import schedule changed. Reload it before saving.');
    validateDailyImportConfig(input);
    if (input.create_backup !== undefined && typeof input.create_backup !== 'boolean')
      throw new ServiceError(
        'Choose whether to create a Jellyfin backup before the scheduled import.',
      );
    if (input.enabled && (!this.key || !this.state.configured))
      throw new ServiceError('Configure the Jellyfin backup helper and shared directory first.');
    this.state.config = {
      enabled: input.enabled,
      hour: input.hour,
      minute: input.minute,
      time_zone: input.time_zone,
      revision: randomUUID(),
      create_backup: input.create_backup ?? this.state.config.create_backup ?? false,
    };
    this.backupRetryAt = 0;
    delete this.state.backup_preflight_retry_at;
    this.save();
    return this.status();
  }
  async configureRetention(input: { enabled: boolean; keep: number; expected_revision: string }) {
    if (this.options.demo)
      throw new ServiceError('Jellyfin backup cleanup changes are unavailable in demo mode.');
    if (input.expected_revision !== this.state.backup_retention!.revision)
      throw new ServiceError('The backup cleanup settings changed. Reload them before saving.');
    if (
      typeof input.enabled !== 'boolean' ||
      !Number.isInteger(input.keep) ||
      input.keep < 1 ||
      input.keep > 100
    )
      throw new ServiceError(
        'Choose whether cleanup is enabled and retain between 1 and 100 backups.',
      );
    if (
      this.stopping ||
      this.clearing ||
      this.starting ||
      this.cleanupStarting ||
      this.state.active ||
      this.state.backup_creation ||
      this.state.backup_cleanup!.pending
    )
      throw new ServiceError(
        'Wait for the Jellyfin backup operation to finish before changing cleanup.',
      );
    this.state.backup_retention = {
      enabled: input.enabled,
      keep: input.keep,
      revision: randomUUID(),
    };
    this.save();
    return this.status();
  }
  private async queueBackupCleanup(binding: DestinationCatalogRequest['binding']) {
    const retention = this.state.backup_retention!;
    if (
      !retention.enabled ||
      this.stopping ||
      this.starting ||
      this.cleanupStarting ||
      this.state.backup_creation ||
      this.state.active ||
      this.state.backup_cleanup!.pending
    )
      return;
    const owned = this.state
      .owned_backups!.filter((entry) => sameBackupBinding(entry.binding, binding))
      .sort((a, b) => Date.parse(b.manifest.created_at) - Date.parse(a.manifest.created_at));
    const protectedDates = new Set(
      this.state.generations
        .filter((entry) => sameBinding(entry.binding, binding))
        .map((entry) => entry.backup_created_at),
    );
    if (owned.length <= retention.keep) return;
    const id = randomUUID(),
      owner = `jellyfin-cleanup:${id}`;
    if (!this.imports.acquire(owner)) return;
    this.cleanupStarting = true;
    const cleanup = this.state.backup_cleanup!;
    cleanup.last_run_at = new Date().toISOString();
    cleanup.last_deleted = 0;
    try {
      if (!(await this.helper()) || !this.backupCleanupSupported)
        throw new Error('Cleanup helper unavailable.');
      const settings = this.store.settings();
      const client = this.options.clientFactory()(
        settings.jellyfin_url,
        settings.jellyfin_api_key,
        'jellyfin',
      );
      this.backupReadClients.add(client);
      let present: JellyfinBackupManifest[];
      try {
        const info = await client.systemInfo();
        if (
          this.stopping ||
          this.state.active ||
          this.state.backup_creation ||
          connectionHash(settings) !== connectionHash(this.store.settings()) ||
          !sameBackupBinding(binding, {
            url: settings.jellyfin_url,
            server_id: String(info.Id),
            version: String(info.Version),
          })
        )
          throw new Error('Cleanup server changed.');
        if (!client.jellyfinBackups) throw new Error('Backup listing unavailable.');
        // This bounded native manifest listing is positive presence evidence, not
        // a catalog scan. An unavailable listing never prunes ownership records.
        present = await client.jellyfinBackups();
      } finally {
        this.backupReadClients.delete(client);
        await client.close();
      }
      if (
        this.stopping ||
        connectionHash(settings) !== connectionHash(this.store.settings()) ||
        this.state.backup_retention!.revision !== retention.revision ||
        this.state.active ||
        this.state.backup_creation
      )
        throw new Error('Cleanup settings changed.');
      const byName = new Map(present.map((entry) => [entry.name, entry]));
      this.state.owned_backups = this.state.owned_backups!.filter(
        (entry) => !sameBackupBinding(entry.binding, binding) || byName.has(entry.manifest.name),
      );
      const unchanged = owned.filter((entry) => {
        const current = byName.get(entry.manifest.name);
        return (
          !!current &&
          current.created_at === entry.manifest.created_at &&
          normalizedServerVersion(current.server_version) ===
            normalizedServerVersion(entry.manifest.server_version) &&
          current.backup_engine_version === entry.manifest.backup_engine_version &&
          current.database === entry.manifest.database &&
          current.metadata === entry.manifest.metadata &&
          current.trickplay === entry.manifest.trickplay &&
          current.subtitles === entry.manifest.subtitles
        );
      });
      const candidates = unchanged
        .slice(retention.keep)
        .filter((entry) => entry.fingerprint && !protectedDates.has(entry.manifest.created_at))
        .slice(0, BACKUP_CLEANUP_MAX_FILES);
      if (!candidates.length) {
        cleanup.last_outcome = 'succeeded';
        cleanup.error = null;
        this.save();
        return;
      }
      const request: BackupCleanupRequest = {
        purpose: 'jellyfin_backup_cleanup',
        id,
        requested_at: new Date().toISOString(),
        binding: { ...binding },
        backups: candidates.map((entry) => ({
          manifest: { ...entry.manifest },
          fingerprint: entry.fingerprint!,
        })),
      };
      cleanup.pending = request;
      cleanup.last_outcome = null;
      cleanup.error = null;
      // Durable exact deletion intent precedes publication. A restart only checks this result.
      this.save();
      await writeEnvelope(
        join(this.directory, `${backupCleanupPrefix(request.id)}.request`),
        request,
        this.key!,
      );
    } catch {
      if (!cleanup.pending) cleanup.last_outcome = 'failed';
      cleanup.error = BACKUP_CLEANUP_ERROR;
      this.save();
    } finally {
      this.cleanupStarting = false;
      if (!cleanup.pending) this.imports.release(owner);
    }
  }
  private async reconcileBackupCleanup() {
    const cleanup = this.state.backup_cleanup!,
      request = cleanup.pending!;
    let result: BackupCleanupResult | undefined;
    try {
      result = await readEnvelope(
        join(this.directory, `${backupCleanupPrefix(request.id)}.result`),
        this.key!,
      );
    } catch {}
    if (result && validBackupCleanupResult(result, request)) {
      this.state.owned_backups = this.state.owned_backups!.filter(
        (entry) =>
          !sameBackupBinding(entry.binding, request.binding) ||
          !result!.removed.includes(entry.manifest.name),
      );
      cleanup.last_run_at = result.finished_at;
      cleanup.last_outcome = result.ok ? 'succeeded' : 'failed';
      cleanup.last_deleted = result.removed.length;
      cleanup.error = result.ok ? null : BACKUP_CLEANUP_ERROR;
    } else if (
      Date.now() - Date.parse(request.requested_at) >
      BACKUP_CLEANUP_DEADLINE + 6 * 60_000
    ) {
      cleanup.last_run_at = new Date().toISOString();
      cleanup.last_outcome = 'interrupted';
      cleanup.error = BACKUP_CLEANUP_ERROR;
    } else return;
    delete cleanup.pending;
    this.imports.release(`jellyfin-cleanup:${request.id}`);
    this.save();
    // Retain the authenticated terminal receipt beyond request freshness to reject replays.
    await rm(join(this.directory, `${backupCleanupPrefix(request.id)}.request`), { force: true });
  }
  /** Queue pinning is synchronous; execution authenticates the file and live identity again. */
  queuedSelection(settings: Settings): string | undefined {
    if (this.stopping || this.clearing)
      throw new ServiceError('Saved Jellyfin catalogs are unavailable.');
    if (!this.state.configured) return;
    const latest = this.state.generations[0];
    let usable = false;
    try {
      usable =
        !!latest &&
        current(latest) &&
        new URL(latest.binding.url).toString() === new URL(settings.jellyfin_url).toString();
    } catch {}
    if (!usable)
      throw new ServiceError(
        'Import a current Jellyfin matching catalog before migrating. Live library scans are disabled for this backup configuration.',
      );
    return latest.id;
  }
  async refresh(createBackup = false, scheduledDate?: string) {
    const revision = this.revision;
    if (this.stopping || this.clearing)
      throw new ServiceError('The Jellyfin import is changing or stopping. Retry shortly.');
    const id = randomUUID();
    const owner = `jellyfin:${id}`;
    if (
      this.cleanupStarting ||
      this.state.active ||
      this.state.backup_creation ||
      this.state.backup_cleanup!.pending ||
      !this.imports.acquire(owner)
    )
      throw new ServiceError(
        'A backup import or capture is already running. Wait for it to finish.',
      );
    this.starting = true;
    this.state.last_attempt_at = new Date().toISOString();
    this.state.last_finished_at = null;
    this.state.last_outcome = 'running';
    this.state.last_error = null;
    this.state.last_error_code = null;
    delete this.state.last_diagnostic;
    try {
      const due = dailyImportSchedule(this.state.config, this.state.last_scheduled_date).due;
      // Importing an old archive is not evidence that a create-before-import
      // occurrence has run. Preserve the legacy import-only deduplication rule.
      if (due && !this.state.config.create_backup) this.state.last_scheduled_date = due.date;
      this.save();
      if (
        this.stopping ||
        this.clearing ||
        this.options.demo ||
        !this.key ||
        !(await this.helper())
      )
        throw new ServiceError(
          'The Jellyfin backup helper is unavailable. Check its backup folder and shared directory.',
        );
      if (this.state.active)
        throw new ServiceError('A Jellyfin catalog import is already running.');
      await this.prune();
      if (this.pendingCleanup.size) throw new ServiceError(CLEANUP_ERROR);
      if (this.state.generations.length >= 8)
        throw new ServiceError(
          'Older Jellyfin catalogs are still used by jobs. Finish them before importing again.',
        );
      const settings = this.store.settings();
      const client = this.options.clientFactory()(
        settings.jellyfin_url,
        settings.jellyfin_api_key,
        'jellyfin',
      );
      let keepClient = false;
      if (createBackup) this.backupReadClients.add(client);
      let request: DestinationCatalogRequest;
      try {
        const info = await client.systemInfo();
        if (
          typeof info.Id !== 'string' ||
          !/^[a-f0-9]{32}$/i.test(info.Id) ||
          typeof info.Version !== 'string' ||
          !normalizedServerVersion(info.Version)
        )
          throw new ServiceError('The linked Jellyfin server identity could not be verified.');
        request = {
          purpose: 'jellyfin_catalog',
          id,
          requested_at: new Date().toISOString(),
          binding: {
            url: new URL(settings.jellyfin_url).toString(),
            server_id: info.Id,
            version: info.Version,
          },
        };
        if (createBackup) {
          if (normalizedServerVersion(info.Version) !== DESTINATION_BACKUP_SERVER_VERSION)
            throw new ServiceError(
              'The linked Jellyfin version is unsupported by the backup importer. No backup was requested; update Jellyport when support for that server version is available.',
            );
          if (!this.backupSelectionSupported)
            throw new ServiceError(
              'Update both Jellyport and its snapshot helper before enabling automatic Jellyfin backup creation.',
            );
          if (
            !client.jellyfinBackups ||
            !client.createJellyfinBackup ||
            !client.jellyfinBackupTasks
          )
            throw new ServiceError(
              'The linked Jellyfin connection does not support native backup creation.',
            );
          const tasks = await client.jellyfinBackupTasks();
          if (tasks.some((task) => task.key === 'RefreshLibrary' && task.state !== 'Idle'))
            throw new BackupPreflightBusy(
              scheduledDate
                ? 'Jellyfin is scanning its library. No backup was requested; Jellyport will retry preflight once per minute within this scheduled hour.'
                : 'Jellyfin is scanning its library. No backup was requested; retry after the scan finishes.',
            );
          const baseline = await client.jellyfinBackups();
          if (
            this.stopping ||
            this.clearing ||
            this.revision !== revision ||
            connectionHash(this.store.settings()) !== connectionHash(settings)
          )
            throw new ServiceError(
              'The Jellyfin connection or import changed. Reload before importing.',
            );
          const started_at = new Date().toISOString();
          const backup: BackupCreation = {
            id,
            binding: request.binding,
            connection: connectionHash(settings),
            phase: 'creating',
            started_at,
            deadline_at: new Date(Date.now() + JELLYFIN_BACKUP_WAIT_MS).toISOString(),
            baseline: baseline.map((entry) => entry.name),
          };
          this.state.backup_creation = backup;
          if (scheduledDate) this.state.last_scheduled_date = scheduledDate;
          this.backupRetryAt = 0;
          delete this.state.backup_preflight_retry_at;
          // Commit the intent BEFORE issuing this non-idempotent mutation.
          this.save();
          keepClient = true;
          this.backupClient = client;
          void this.createBackup(backup, client).catch(() => {
            // A failed persistence/close cannot authorize another mutation.
            try {
              if (!this.stopping) this.uncertainBackup(backup);
            } catch {}
          });
          return this.status();
        }
        if (this.backupSelectionSupported && client.jellyfinBackups) {
          // The native API lists completed archives. A filename on disk may still
          // be an unfinished ZIP, and its local-time name is not a UTC ordering.
          const completed = await client.jellyfinBackups();
          const latest = [...completed].sort(
            (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
          )[0];
          if (!latest)
            throw new ServiceError(
              'No completed Jellyfin backup was found. Create a database backup or enable scheduled backup creation.',
            );
          request.expected_backup = { name: latest.name, created_at: latest.created_at };
        }
      } finally {
        this.backupReadClients.delete(client);
        if (!keepClient) await client.close();
      }
      if (
        this.state.active ||
        this.stopping ||
        this.clearing ||
        this.revision !== revision ||
        this.pendingCleanup.size ||
        this.store.settings().jellyfin_url !== settings.jellyfin_url ||
        this.store.settings().jellyfin_api_key !== settings.jellyfin_api_key
      )
        throw new ServiceError(
          'The Jellyfin connection or import changed. Reload before importing.',
        );
      this.state.active = request;
      this.state.last_attempt_at = request.requested_at;
      this.state.last_error = null;
      this.save();
      try {
        await writeEnvelope(
          join(this.directory, `${destinationCatalogPrefix(request.id)}.request`),
          request,
          this.key,
        );
      } catch {
        delete this.state.active;
        this.state.last_error = 'Unable to request the Jellyfin catalog import.';
        this.save();
        throw new ServiceError(this.state.last_error);
      }
      return this.status();
    } catch (error) {
      if (this.state.backup_creation) throw error;
      if (scheduledDate) {
        if (error instanceof BackupPreflightBusy) {
          this.backupRetryAt = Date.now() + BACKUP_PREFLIGHT_RETRY_MS;
          this.state.backup_preflight_retry_at = new Date(this.backupRetryAt).toISOString();
        } else this.state.last_scheduled_date = scheduledDate;
      }
      delete this.state.active;
      this.state.last_finished_at = new Date().toISOString();
      this.state.last_outcome = 'failed';
      this.state.last_error =
        error instanceof ServiceError
          ? error.message
          : 'Jellyfin catalog import could not start. Check the helper and configured Jellyfin connection. Any previously saved catalog is preserved.';
      this.save();
      throw error;
    } finally {
      this.starting = false;
      if (!this.state.active && !this.state.backup_creation) this.imports.release(owner);
    }
  }
  private matchesBackup(backup: BackupCreation, value: JellyfinBackupManifest): boolean {
    const created = Date.parse(value.created_at);
    return (
      validJellyfinBackupName(value.name) &&
      !backup.baseline.includes(value.name) &&
      Number.isFinite(created) &&
      created >= Date.parse(backup.started_at) - 60_000 &&
      created <= Date.now() + 60_000 &&
      normalizedServerVersion(value.server_version) ===
        normalizedServerVersion(backup.binding.version) &&
      value.backup_engine_version === '0.2.0' &&
      value.database === true &&
      value.metadata === false &&
      value.trickplay === false &&
      value.subtitles === false
    );
  }
  private async createBackup(backup: BackupCreation, client: MediaAPI): Promise<void> {
    try {
      const completed = await client.createJellyfinBackup!();
      if (this.stopping || this.state.backup_creation?.id !== backup.id) return;
      if (!this.matchesBackup(backup, completed)) {
        this.uncertainBackup(backup);
        return;
      }
      backup.completed = completed;
      if (
        !this.state.owned_backups!.some(
          (entry) =>
            entry.manifest.name === completed.name &&
            sameBackupBinding(entry.binding, backup.binding),
        )
      ) {
        this.state.owned_backups!.push({
          attempt_id: backup.id,
          binding: { ...backup.binding },
          manifest: { ...completed },
        });
      }
      backup.phase = 'waiting';
      this.backupPollAt = 0;
      this.save();
    } catch (error) {
      if (this.stopping || this.state.backup_creation?.id !== backup.id) return;
      if (error instanceof MediaError && [401, 403, 404, 405].includes(error.statusCode ?? 0)) {
        delete this.state.backup_creation;
        this.imports.release(`jellyfin:${backup.id}`);
        this.state.last_finished_at = new Date().toISOString();
        this.state.last_outcome = 'failed';
        this.state.last_error =
          'Jellyfin rejected native backup creation. Check API-key administrator access and native backup support. No catalog import was started; the last saved catalog is preserved.';
      } else {
        // A network failure can leave Jellyfin working. Observe completed backups
        // rather than repeating a mutation that has no idempotency token.
        backup.phase = 'waiting';
      }
      this.save();
    } finally {
      if (this.backupClient === client) this.backupClient = undefined;
      await client.close();
    }
  }
  private uncertainBackup(backup: BackupCreation): void {
    if (this.state.backup_creation?.id !== backup.id) return;
    backup.phase = 'uncertain';
    this.state.last_error = BACKUP_UNCERTAIN;
    this.state.last_error_code = null;
    this.state.last_outcome = 'interrupted';
    this.state.last_finished_at = new Date().toISOString();
    this.save();
  }
  /** Reconcile a durable mutation intent; this path never creates a backup. */
  private async reconcileBackup(backup: BackupCreation): Promise<'queued' | 'empty' | 'blocked'> {
    const settings = this.store.settings();
    if (new URL(settings.jellyfin_url).toString() !== new URL(backup.binding.url).toString()) {
      this.uncertainBackup(backup);
      return 'blocked';
    }
    // A rotated key may safely observe the original verified server. Recheck
    // the credentials used by each read before publishing any helper request.
    const readConnection = connectionHash(settings);
    const client = this.options.clientFactory()(
      settings.jellyfin_url,
      settings.jellyfin_api_key,
      'jellyfin',
    );
    this.backupReadClients.add(client);
    try {
      const info = await client.systemInfo();
      if (
        !sameBinding(backup.binding, {
          url: settings.jellyfin_url,
          server_id: String(info.Id),
          version: String(info.Version),
        })
      ) {
        this.uncertainBackup(backup);
        return 'blocked';
      }
      if (!client.jellyfinBackups) {
        this.uncertainBackup(backup);
        return 'blocked';
      }
      const candidates = backup.completed
        ? [backup.completed]
        : (await client.jellyfinBackups()).filter((entry) => this.matchesBackup(backup, entry));
      if (
        this.stopping ||
        this.state.backup_creation?.id !== backup.id ||
        connectionHash(this.store.settings()) !== readConnection
      )
        return 'blocked';
      if (candidates.length > 1) {
        this.uncertainBackup(backup);
        return 'blocked';
      }
      if (!candidates.length) {
        if (Date.now() >= Date.parse(backup.deadline_at)) this.uncertainBackup(backup);
        return 'empty';
      }
      const value = candidates[0]!;
      if (
        !this.matchesBackup(backup, value) ||
        !(await this.helper()) ||
        !this.backupSelectionSupported
      ) {
        this.uncertainBackup(backup);
        return 'blocked';
      }
      if (
        this.stopping ||
        this.state.backup_creation?.id !== backup.id ||
        connectionHash(this.store.settings()) !== readConnection
      )
        return 'blocked';
      const request: DestinationCatalogRequest = {
        purpose: 'jellyfin_catalog',
        id: backup.id,
        requested_at: new Date().toISOString(),
        binding: backup.binding,
        expected_backup: { name: value.name, created_at: value.created_at },
      };
      // Persist the transition before publishing. Restarts resume checking this
      // request, not the native mutation. Offline import has its own worker watchdog.
      this.state.active = request;
      this.state.active_publication_pending = true;
      delete this.state.backup_creation;
      this.state.last_error = null;
      this.state.last_outcome = 'running';
      this.state.last_finished_at = null;
      this.save();
      try {
        await this.publishPendingImport(request, readConnection);
        delete this.state.active_publication_pending;
        this.save();
      } catch {
        // Keep the durable active attempt; IPC failure never replays the POST.
        this.state.last_error =
          'The completed Jellyfin backup could not be handed to the helper. Jellyport will retry this same import request within its admission window; no additional backup will be requested. Check shared-folder permissions.';
        this.save();
      }
      return 'queued';
    } finally {
      this.backupReadClients.delete(client);
      await client.close();
    }
  }
  private async publishPendingImport(
    request: DestinationCatalogRequest,
    verifiedConnection?: string,
  ): Promise<void> {
    if (this.stopping || !this.key || this.state.active?.id !== request.id)
      throw new ServiceError('The Jellyfin import is stopping or changed.');
    const prefix = destinationCatalogPrefix(request.id);
    // The helper atomically renames request -> working and publishes result
    // before removing working. Observing any state means it must not be replayed.
    for (const suffix of ['request', 'working', 'result']) {
      try {
        const value = await lstat(join(this.directory, `${prefix}.${suffix}`));
        if (!value.isFile() || value.isSymbolicLink())
          throw new ServiceError('The Jellyfin import handoff could not be validated.');
        return;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
          throw error;
      }
    }
    if (Date.now() - Date.parse(request.requested_at) > DESTINATION_CATALOG_REQUEST_MAX_AGE)
      throw new ServiceError('The Jellyfin import admission window expired.');
    const settings = this.store.settings();
    const connection = connectionHash(settings);
    if (new URL(settings.jellyfin_url).toString() !== new URL(request.binding.url).toString())
      throw new ServiceError('The Jellyfin import connection changed.');
    if (verifiedConnection !== connection) {
      const client = this.options.clientFactory()(
        settings.jellyfin_url,
        settings.jellyfin_api_key,
        'jellyfin',
      );
      this.backupReadClients.add(client);
      try {
        const info = await client.systemInfo();
        if (
          !sameBinding(request.binding, {
            url: settings.jellyfin_url,
            server_id: String(info.Id),
            version: String(info.Version),
          })
        )
          throw new ServiceError('The Jellyfin import server identity changed.');
      } finally {
        this.backupReadClients.delete(client);
        await client.close();
      }
    }
    if (
      this.stopping ||
      this.state.active?.id !== request.id ||
      connectionHash(this.store.settings()) !== connection
    )
      throw new ServiceError('The Jellyfin import connection changed or stopped.');
    await writeEnvelope(
      join(this.directory, `${prefix}.request`),
      request,
      this.key,
      this.reads.signal,
    );
  }
  async acknowledgeBackup(expectedAttemptId: string) {
    const backup = this.state.backup_creation;
    const confirmedConnection = connectionHash(this.store.settings());
    if (
      !backup ||
      backup.id !== expectedAttemptId ||
      backup.phase !== 'uncertain' ||
      this.starting ||
      this.ticking ||
      this.stopping
    )
      throw new ServiceError('Refresh status before confirming a stopped Jellyfin backup.');
    this.starting = true;
    try {
      const outcome = await this.reconcileBackup(backup);
      // Reconciliation also awaits client closure. An old confirmation cannot
      // release the lease after shutdown, credential changes or a newer attempt.
      if (
        this.stopping ||
        connectionHash(this.store.settings()) !== confirmedConnection ||
        (this.state.backup_creation && this.state.backup_creation.id !== backup.id)
      )
        throw new ServiceError(
          'The Jellyfin backup attempt or connection changed. Refresh status before confirming it again.',
        );
      if (outcome === 'blocked')
        throw new ServiceError(
          'Jellyfin backup completion is still inconclusive. Restore the original server connection and helper, then refresh status. No backup will be requested again automatically.',
        );
      if (outcome === 'empty' && this.state.backup_creation?.id === backup.id) {
        delete this.state.backup_creation;
        this.imports.release(`jellyfin:${backup.id}`);
        this.state.last_outcome = 'interrupted';
        this.state.last_finished_at = new Date().toISOString();
        this.state.last_error =
          'You confirmed the native Jellyfin backup has finished or stopped. No backup was deleted. The next scheduled run may create a backup; manual imports remain available.';
        this.save();
      }
      return this.status();
    } finally {
      this.starting = false;
    }
  }
  private async validated(
    id: string,
    settings: Settings,
    serverId: string,
    version: string,
  ): Promise<DestinationCatalogResult> {
    if (!this.key || this.stopping || this.clearing)
      throw new ServiceError('The saved Jellyfin catalog is unavailable.');
    try {
      const value = await readEnvelope<DestinationCatalogResult>(
        join(this.directory, `${destinationCatalogPrefix(id)}.result`),
        this.key,
      );
      const stored = this.state.generations.find((record) => record.id === id);
      if (
        !stored ||
        !current(value) ||
        !validDestinationResult(stored) ||
        value.id !== id ||
        value.backup_fingerprint !== stored.backup_fingerprint ||
        value.backup_created_at !== stored.backup_created_at ||
        value.finished_at !== stored.finished_at ||
        value.bytes !== stored.bytes ||
        value.items !== stored.items ||
        value.keys !== stored.keys ||
        value.projection_format !== stored.projection_format ||
        !sameBinding(value.binding, stored.binding) ||
        !sameBinding(value.binding, { url: settings.jellyfin_url, server_id: serverId, version }) ||
        !(await this.completeFile(value)) ||
        this.clearing ||
        this.stopping
      )
        throw new Error('Invalid catalog.');
      return value;
    } catch {
      throw new ServiceError(
        'The pinned Jellyfin catalog is expired, changed or incompatible. Import a current backup and review a new migration.',
      );
    }
  }
  async metadata(
    id: string,
    settings: Settings,
    serverId: string,
    version: string,
  ): Promise<DestinationCatalogMetadata> {
    return destinationCatalogMetadata(await this.validated(id, settings, serverId, version));
  }
  async candidates(
    id: string,
    settings: Settings,
    serverId: string,
    version: string,
    source: MediaItem[],
    mappings: PathMapping[],
    signal?: AbortSignal,
  ): Promise<MediaItem[]> {
    await this.validated(id, settings, serverId, version);
    const combined = AbortSignal.any([this.reads.signal, ...(signal ? [signal] : [])]);
    check(combined);
    if (this.clearing || this.pendingCleanup.size) throw new ServiceError(CLEANUP_ERROR);
    const neutral = neutralItems(source);
    let entry = this.databases.get(id);
    if (!entry) {
      const created: DatabaseEntry = {
        promise: Promise.resolve(''),
        users: 0,
        lastUsed: Date.now(),
      };
      created.promise = (async () => {
        try {
          created.directory = await mkdtemp(join(this.directory, `read-jellyfin-${id}-`));
          const path = join(created.directory, 'catalog.db');
          await decryptDatabase(
            join(this.directory, `${destinationCatalogPrefix(id)}.db.enc`),
            path,
            this.key!,
            id,
            this.reads.signal,
          );
          return path;
        } catch {
          if (this.databases.get(id) === created) this.databases.delete(id);
          if (created.directory) await this.cleanReadDirectory(created.directory);
          throw new ServiceError(
            'Saved Jellyfin catalog authentication failed. Import its backup again.',
          );
        }
      })();
      entry = created;
      this.databases.set(id, created);
    }
    entry.users++;
    try {
      const path = await cancelable(entry.promise, combined);
      check(combined);
      return neutralItems(
        await snapshotProcess<MediaItem[]>(
          { operation: 'destination_read', path, source: neutral, mappings },
          combined,
        ),
        true,
      );
    } finally {
      entry.users--;
      entry.lastUsed = Date.now();
    }
  }
  private async generationFiles(id: string): Promise<void> {
    for (const suffix of ['request', 'result', 'progress', 'db.enc'])
      await rm(join(this.directory, `${destinationCatalogPrefix(id)}.${suffix}`), { force: true });
  }
  private acceptDiagnostic(value: unknown, request: DestinationCatalogRequest): boolean {
    if (!validDestinationDiagnostic(value)) return false;
    const updated = Date.parse(value.updated_at);
    const requested = Date.parse(request.requested_at);
    if (
      Date.parse(value.started_at) < requested - 60_000 ||
      updated < requested ||
      updated > Date.now() + 60_000 ||
      (this.state.last_diagnostic && updated < Date.parse(this.state.last_diagnostic.updated_at))
    )
      return false;
    if (JSON.stringify(value) === JSON.stringify(this.state.last_diagnostic)) return false;
    this.state.last_diagnostic = { ...value };
    return true;
  }
  private async readProgress(active: DestinationCatalogRequest): Promise<void> {
    try {
      const progress = await readEnvelope<DestinationCatalogProgress>(
        join(this.directory, `${destinationCatalogPrefix(active.id)}.progress`),
        this.key!,
      );
      if (
        validDestinationProgress(progress) &&
        progress.id === active.id &&
        progress.requested_at === active.requested_at &&
        sameBinding(progress.binding, active.binding) &&
        this.acceptDiagnostic(progress.diagnostic, active)
      )
        this.save();
    } catch {
      // Progress is optional. Missing, stale or invalid observations cannot fail
      // an import, extend its deadline, or become a successful result.
    }
  }
  private async tick(): Promise<void> {
    if (!this.key || this.ticking || this.stopping || this.clearing || this.starting) return;
    this.ticking = true;
    try {
      await this.helper();
      if (this.state.backup_cleanup!.pending) {
        await this.reconcileBackupCleanup();
        return;
      }
      if (this.state.backup_creation) {
        if (Date.now() >= this.backupPollAt) {
          const backup = this.state.backup_creation;
          this.backupPollAt = Date.now() + (backup.phase === 'uncertain' ? 60_000 : BACKUP_POLL_MS);
          try {
            await this.reconcileBackup(backup);
          } catch {
            if (Date.now() >= Date.parse(backup.deadline_at)) this.uncertainBackup(backup);
          }
        }
        return;
      }
      const active = this.state.active;
      if (active) {
        if (this.state.active_publication_pending && Date.now() >= this.handoffRetryAt) {
          this.handoffRetryAt = Date.now() + BACKUP_POLL_MS;
          try {
            await this.publishPendingImport(active);
            delete this.state.active_publication_pending;
            this.state.last_error = null;
            this.save();
          } catch {
            // Retain the exact durable request and mutation intent. In particular,
            // a restart or expired admission never authorizes a new native POST.
          }
        }
        await this.readProgress(active);
        const due = dailyImportSchedule(this.state.config, this.state.last_scheduled_date).due;
        if (due && !this.state.config.create_backup) {
          this.state.last_scheduled_date = due.date;
          this.save();
        }
        let value: DestinationCatalogResult | undefined;
        try {
          value = await readEnvelope(
            join(this.directory, `${destinationCatalogPrefix(active.id)}.result`),
            this.key,
          );
        } catch {}
        if (
          value &&
          value.id === active.id &&
          value.requested_at === active.requested_at &&
          sameBinding(value.binding, active.binding)
        ) {
          let adopted = false;
          this.acceptDiagnostic(value.diagnostic, active);
          this.state.last_error_code = null;
          if (value.ok === false) {
            this.state.last_error_code = validDestinationErrorCode(value.error_code)
              ? value.error_code
              : value.error?.includes('was interrupted')
                ? 'interrupted'
                : 'backup_invalid';
            this.state.last_error = destinationCatalogFailureMessage(this.state.last_error_code);
          } else if (!current(value) || !(await this.completeFile(value))) {
            const created =
              typeof value.backup_created_at === 'string'
                ? Date.parse(value.backup_created_at)
                : NaN;
            this.state.last_error_code =
              validDestinationResult(value) && Date.now() - created > DESTINATION_CATALOG_MAX_AGE
                ? 'backup_expired'
                : Number.isFinite(created) && created > Date.now() + 60_000
                  ? 'backup_future'
                  : 'backup_invalid';
            this.state.last_error = destinationCatalogFailureMessage(this.state.last_error_code);
          } else if (
            active.expected_backup &&
            Date.parse(value.backup_created_at!) !== Date.parse(active.expected_backup.created_at)
          ) {
            this.state.last_error_code = 'backup_changed';
            this.state.last_error =
              'The imported catalog does not match the newly completed Jellyfin backup. Check the helper mount and import that backup again. The previous catalog is preserved.';
          } else {
            const previous = this.state.generations.find((record) =>
              sameBinding(record.binding, value!.binding),
            );
            if (
              previous &&
              Date.parse(value.backup_created_at!) < Date.parse(previous.backup_created_at!)
            )
              this.state.last_error =
                'The Jellyfin backup is older than the last imported catalog.';
            else if (previous && previous.projection_format! > value.projection_format!)
              this.state.last_error =
                'The snapshot helper produced an older Jellyfin catalog format. Update the helper and import again.';
            else if (
              previous &&
              previous.backup_fingerprint === value.backup_fingerprint &&
              previous.projection_format === value.projection_format
            )
              this.state.last_error = null;
            else {
              this.state.generations.unshift(value);
              this.state.last_error = null;
              adopted = true;
            }
          }
          this.state.last_finished_at = Number.isFinite(Date.parse(value.finished_at))
            ? value.finished_at
            : new Date().toISOString();
          this.state.last_outcome = this.state.last_error
            ? this.state.last_error_code === 'interrupted'
              ? 'interrupted'
              : 'failed'
            : 'succeeded';
          if (this.state.last_outcome === 'succeeded' && active.expected_backup) {
            const owned = this.state.owned_backups!.find(
              (entry) =>
                entry.attempt_id === active.id &&
                entry.manifest.name === active.expected_backup!.name &&
                sameBackupBinding(entry.binding, active.binding),
            );
            if (owned) owned.fingerprint = value.backup_fingerprint;
          }
          delete this.state.active;
          delete this.state.active_publication_pending;
          this.imports.release(`jellyfin:${active.id}`);
          this.save();
          await rm(join(this.directory, `${destinationCatalogPrefix(active.id)}.progress`), {
            force: true,
          });
          if (!adopted) await this.generationFiles(active.id);
          if (this.state.last_outcome === 'succeeded') await this.queueBackupCleanup(value.binding);
        } else if (
          Date.now() - Date.parse(active.requested_at) >
          DESTINATION_CATALOG_RECOVERY_DEADLINE
        ) {
          delete this.state.active;
          delete this.state.active_publication_pending;
          this.imports.release(`jellyfin:${active.id}`);
          this.state.last_error_code = 'timeout';
          this.state.last_error = destinationCatalogFailureMessage('timeout');
          this.state.last_finished_at = new Date().toISOString();
          this.state.last_outcome = 'failed';
          this.save();
          await this.generationFiles(active.id);
        }
      }
      const due = dailyImportSchedule(this.state.config, this.state.last_scheduled_date).due;
      if (due && this.state.active && !this.state.config.create_backup) {
        this.state.last_scheduled_date = due.date;
        this.save();
      } else if (due && !this.imports.busy && Date.now() >= this.backupRetryAt) {
        try {
          await this.refresh(this.state.config.create_backup === true, due.date);
        } catch {
          /* refresh records a sanitized failed attempt. */
        }
      }
      await this.prune();
    } catch {
      this.state.last_error =
        'Jellyfin catalog status could not be validated. Any previously saved catalog is preserved.';
      this.save();
    } finally {
      this.ticking = false;
    }
  }
  private recordCleanupError() {
    this.state.last_error = CLEANUP_ERROR;
    try {
      this.save();
    } catch {
      /* Stop may run after persistence has closed. */
    }
  }
  private async cleanReadDirectory(directory: string): Promise<void> {
    this.pendingCleanup.add(directory);
    try {
      await rm(directory, { recursive: true, force: true });
      this.pendingCleanup.delete(directory);
    } catch {
      this.recordCleanupError();
      throw new ServiceError(CLEANUP_ERROR);
    }
  }
  private async removeDatabase(id: string): Promise<void> {
    const entry = this.databases.get(id);
    if (!entry || entry.users) return;
    this.databases.delete(id);
    await entry.promise.catch(() => {});
    if (entry.directory) await this.cleanReadDirectory(entry.directory);
  }
  private async prune() {
    const pins = this.pins(),
      latest = this.state.generations[0]?.id;
    for (const [id, entry] of this.databases)
      if (
        !entry.users &&
        !pins.has(id) &&
        (id !== latest || Date.now() - entry.lastUsed >= IDLE_MS)
      )
        await this.removeDatabase(id);
    const keep = new Set([
      ...this.state.generations.slice(0, 2).map((record) => record.id),
      ...pins,
      ...this.databases.keys(),
    ]);
    for (const value of this.state.generations)
      if (!keep.has(value.id)) await this.generationFiles(value.id);
    this.state.generations = this.state.generations.filter((record) => keep.has(record.id));
    this.save();
    if (this.state.active) keep.add(this.state.active.id);
    for (const name of await readdir(this.directory)) {
      if (/^jellyfin-cleanup-[a-f0-9-]{36}\.result$/.test(name)) {
        const path = join(this.directory, name),
          info = await lstat(path);
        if (
          info.isFile() &&
          !info.isSymbolicLink() &&
          Date.now() - info.mtimeMs >= 24 * 60 * 60_000
        )
          await rm(path);
        continue;
      }
      const match = /^jellyfin-([a-f0-9-]{36})\.(?:request|result|progress|db\.enc)$/.exec(name);
      if (!match || keep.has(match[1]!)) continue;
      const path = join(this.directory, name),
        stat = await lstat(path);
      if (Date.now() - stat.mtimeMs >= IDLE_MS) await rm(path, { force: true });
    }
  }
  async clear() {
    if (
      this.stopping ||
      this.clearing ||
      this.ticking ||
      this.options.demo ||
      this.state.active ||
      this.state.backup_creation ||
      this.cleanupStarting ||
      this.state.backup_cleanup!.pending ||
      this.pins().size ||
      [...this.databases.values()].some((value) => value.users)
    )
      throw new ServiceError('A job or import is using this catalog. Finish it before clearing.');
    this.clearing = true;
    this.revision++;
    try {
      for (const id of this.databases.keys()) await this.removeDatabase(id);
      for (const directory of this.pendingCleanup) await this.cleanReadDirectory(directory);
      for (const value of this.state.generations) await this.generationFiles(value.id);
      this.state.generations = [];
      this.state.last_error = null;
      this.state.last_error_code = null;
      this.save();
    } finally {
      this.clearing = false;
    }
    return this.status();
  }
  async stop() {
    this.stopping = true;
    this.revision++;
    clearInterval(this.timer);
    this.reads.abort();
    await this.backupClient?.close();
    await Promise.all([...this.backupReadClients].map((client) => client.close()));
    while (this.ticking || [...this.databases.values()].some((value) => value.users))
      await new Promise((resolve) => setTimeout(resolve, 20));
    for (const id of this.databases.keys()) await this.removeDatabase(id);
    for (const directory of this.pendingCleanup) await this.cleanReadDirectory(directory);
  }
}
