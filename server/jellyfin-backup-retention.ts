import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, rename, link, unlink, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectJellyfinBackupManifest } from './jellyfin-backup-reader.js';
import { validJellyfinBackupName, type JellyfinBackupManifest } from './jellyfin-backup-api.js';
import { normalizedServerVersion, validDestinationRequest } from './destination-catalog-files.js';
import { readEnvelope, writeEnvelope, snapshotId, type SnapshotBinding } from './snapshot-files.js';

export const BACKUP_CLEANUP_DEADLINE = 15 * 60_000;
export const BACKUP_CLEANUP_MAX_FILES = 16;
export const BACKUP_CLEANUP_ERROR =
  'Jellyfin backup cleanup could not finish. The imported catalog is available. Check the helper cleanup setting, writable backup mount and permissions. Unconfirmed files are preserved.';
export interface OwnedJellyfinBackup {
  attempt_id: string;
  binding: SnapshotBinding;
  manifest: JellyfinBackupManifest;
  /** Added only after this exact selected backup has passed the complete importer. */
  fingerprint?: string;
}
export interface BackupRetentionConfig {
  enabled: boolean;
  keep: number;
  revision: string;
}
export interface BackupCleanupRequest {
  purpose: 'jellyfin_backup_cleanup';
  id: string;
  requested_at: string;
  binding: SnapshotBinding;
  backups: Array<{ manifest: JellyfinBackupManifest; fingerprint: string }>;
}
export interface BackupCleanupResult extends BackupCleanupRequest {
  finished_at: string;
  ok: boolean;
  removed: string[];
}
export const backupCleanupPrefix = (id: string) => {
  if (!snapshotId.test(id)) throw new Error('Invalid backup cleanup request.');
  return `jellyfin-cleanup-${id}`;
};
export function sameBackupBinding(a: SnapshotBinding, b: SnapshotBinding): boolean {
  try {
    return (
      new URL(a.url).toString() === new URL(b.url).toString() &&
      a.server_id.toLowerCase() === b.server_id.toLowerCase() &&
      normalizedServerVersion(a.version) === normalizedServerVersion(b.version)
    );
  } catch {
    return false;
  }
}
function validManifest(value: JellyfinBackupManifest, binding: SnapshotBinding): boolean {
  return (
    !!value &&
    validJellyfinBackupName(value.name) &&
    typeof value.created_at === 'string' &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.server_version === 'string' &&
    normalizedServerVersion(value.server_version) === normalizedServerVersion(binding.version) &&
    value.backup_engine_version === '0.2.0' &&
    value.database === true &&
    value.metadata === false &&
    value.trickplay === false &&
    value.subtitles === false
  );
}
export function validBackupCleanupRequest(value: BackupCleanupRequest): boolean {
  return (
    !!value &&
    value.purpose === 'jellyfin_backup_cleanup' &&
    validDestinationRequest({ ...value, purpose: 'jellyfin_catalog' }) &&
    Array.isArray(value.backups) &&
    value.backups.length > 0 &&
    value.backups.length <= BACKUP_CLEANUP_MAX_FILES &&
    new Set(value.backups.map((item) => item?.manifest?.name)).size === value.backups.length &&
    value.backups.every(
      (item) =>
        item &&
        validManifest(item.manifest, value.binding) &&
        typeof item.fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(item.fingerprint),
    )
  );
}
export function validBackupCleanupResult(
  value: BackupCleanupResult,
  request: BackupCleanupRequest,
): boolean {
  return (
    validBackupCleanupRequest(value) &&
    value.id === request.id &&
    value.requested_at === request.requested_at &&
    sameBackupBinding(value.binding, request.binding) &&
    JSON.stringify(value.backups) === JSON.stringify(request.backups) &&
    typeof value.ok === 'boolean' &&
    typeof value.finished_at === 'string' &&
    Number.isFinite(Date.parse(value.finished_at)) &&
    Date.parse(value.finished_at) >= Date.parse(request.requested_at) &&
    Date.parse(value.finished_at) <= Date.now() + 60_000 &&
    Array.isArray(value.removed) &&
    new Set(value.removed).size === value.removed.length &&
    value.removed.every((name) => request.backups.some((entry) => entry.manifest.name === name)) &&
    (!value.ok || value.removed.length === request.backups.length)
  );
}
const identical = (a: BigIntStats, b: BigIntStats) =>
  b.isFile() &&
  !b.isSymbolicLink() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs;
async function exists(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
/** A file is isolated by atomic rename before unlink; a replaced pathname is restored, never deleted. */
async function removeOwnedBackup(
  backups: string,
  quarantine: string,
  candidate: BackupCleanupRequest['backups'][number],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const source = join(backups, candidate.manifest.name),
    isolated = join(quarantine, candidate.manifest.name);
  const alreadyIsolated = await exists(isolated);
  const path = alreadyIsolated ? isolated : source;
  const initial = await exists(path);
  // A prior interrupted cleanup may already have unlinked it. No replacement is inferred owned.
  if (!initial) return;
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size <= 0 ||
    initial.size > 8n * 1024n ** 3n
  )
    throw new Error('Invalid cleanup archive.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let moved = !!alreadyIsolated;
  try {
    if (!identical(initial, await file.stat({ bigint: true })))
      throw new Error('Changed cleanup archive.');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest('hex') !== candidate.fingerprint) throw new Error('Changed cleanup archive.');
    const manifest = await inspectJellyfinBackupManifest(file.fd, signal);
    if (
      manifest.createdAt !== new Date(candidate.manifest.created_at).toISOString() ||
      normalizedServerVersion(manifest.serverVersion) !==
        normalizedServerVersion(candidate.manifest.server_version) ||
      manifest.backupEngineVersion !== candidate.manifest.backup_engine_version
    )
      throw new Error('Changed cleanup manifest.');
    signal.throwIfAborted();
    if (
      !identical(initial, await file.stat({ bigint: true })) ||
      !identical(initial, await lstat(path, { bigint: true }))
    )
      throw new Error('Changed cleanup archive.');
    if (!alreadyIsolated) {
      await rename(source, isolated);
      moved = true;
    }
    if (!identical(initial, await lstat(isolated, { bigint: true })))
      throw new Error('Changed cleanup archive.');
    signal.throwIfAborted();
    await unlink(isolated);
    moved = false;
  } catch (error) {
    if (moved) {
      // Exclusive hard-link restoration cannot overwrite a newly created manual backup.
      // If the original name is occupied, preserve the isolated file for administrator review.
      try {
        await link(isolated, source);
        await unlink(isolated);
      } catch {}
    }
    throw error;
  } finally {
    await file.close();
  }
}

/** Authenticated IPC only. No raw path or pattern is accepted from the web process. */
export async function processJellyfinBackupCleanupRequest(
  name: string,
  exchange: string,
  backups: string | undefined,
  enabled: boolean,
  key: Buffer,
  shutdown: AbortSignal,
): Promise<boolean> {
  const match = /^jellyfin-cleanup-([a-f0-9-]{36})\.(request|working)$/.exec(name);
  if (!match || !snapshotId.test(match[1]!)) return false;
  const prefix = backupCleanupPrefix(match[1]!),
    path = join(exchange, name);
  let request: BackupCleanupRequest;
  try {
    request = await readEnvelope(path, key);
    if (
      !validBackupCleanupRequest(request) ||
      request.id !== match[1] ||
      Math.abs(Date.now() - Date.parse(request.requested_at)) >
        (match[2] === 'request' ? 5 * 60_000 : BACKUP_CLEANUP_DEADLINE + 6 * 60_000)
    )
      throw new Error('Invalid cleanup request.');
    try {
      const completed = await readEnvelope<BackupCleanupResult>(
        join(exchange, `${prefix}.result`),
        key,
      );
      if (validBackupCleanupResult(completed, request)) {
        await rm(path, { force: true });
        return true;
      }
    } catch {}
    if (match[2] === 'request') await rename(path, join(exchange, `${prefix}.working`));
  } catch {
    await rm(path, { force: true });
    return true;
  }
  const removed: string[] = [];
  let ok = false;
  // Recovered work keeps the original absolute budget; restarts cannot renew it.
  const remaining =
    Date.parse(request.requested_at) + BACKUP_CLEANUP_DEADLINE + 5 * 60_000 - Date.now();
  const signal = AbortSignal.any([
    shutdown,
    remaining > 0
      ? AbortSignal.timeout(Math.min(BACKUP_CLEANUP_DEADLINE, remaining))
      : AbortSignal.abort(),
  ]);
  const quarantine = backups ? join(backups, `.jellyport-retention-${request.id}`) : '';
  try {
    if (!enabled || !backups) throw new Error('Backup cleanup disabled.');
    const root = await lstat(backups);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid backup mount.');
    await mkdir(quarantine, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await writeEnvelope(
        join(exchange, `${prefix}.result`),
        { ...request, ok, removed, finished_at: new Date().toISOString() },
        key,
      );
      await rm(join(exchange, `${prefix}.working`), { force: true });
      return true;
    }
  }
  try {
    const directory = await lstat(quarantine);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
      throw new Error('Invalid cleanup work directory.');
    for (const candidate of request.backups) {
      await removeOwnedBackup(backups!, quarantine, candidate, signal);
      removed.push(candidate.manifest.name);
    }
    ok = true;
  } catch {
    /* Failure is independent from successful catalog import. */
  }
  try {
    await rmdir(quarantine);
  } catch {
    /* Preserve uncertain isolated files. */
  }
  await writeEnvelope(
    join(exchange, `${prefix}.result`),
    { ...request, ok, removed, finished_at: new Date().toISOString() },
    key,
  );
  await rm(join(exchange, `${prefix}.working`), { force: true });
  return true;
}
