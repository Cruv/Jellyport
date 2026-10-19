import type { SnapshotBinding } from './snapshot-files.js';
import { snapshotId } from './snapshot-files.js';
import { ServiceError } from './errors.js';
import { validJellyfinBackupName } from './jellyfin-backup-api.js';

export const DESTINATION_BACKUP_SERVER_VERSION = '12.2.0.0';
export const DESTINATION_CATALOG_MAX_AGE = 48 * 60 * 60_000;
// Offline ZIP/index preparation is separate from the user migration performance target.
export const DESTINATION_CATALOG_DEADLINE = 30 * 60_000;
export const DESTINATION_CATALOG_REQUEST_MAX_AGE = 5 * 60_000;
export const DESTINATION_CATALOG_RECOVERY_GRACE = 60_000;
// A helper may claim a request at the end of its admission window. Do not release
// its lease while that worker can still be running or finalizing its result.
export const DESTINATION_CATALOG_RECOVERY_DEADLINE =
  DESTINATION_CATALOG_REQUEST_MAX_AGE +
  DESTINATION_CATALOG_DEADLINE +
  DESTINATION_CATALOG_RECOVERY_GRACE;
export const DESTINATION_CATALOG_FORMAT = 2;
export const DESTINATION_CATALOG_STAGES = [
  'validating_backup',
  'reading_items',
  'reading_providers',
  'enriching',
  'indexing',
  'fingerprinting',
  'encrypting',
  'validating_catalog',
] as const;
export type DestinationCatalogStage = (typeof DESTINATION_CATALOG_STAGES)[number];
export const DESTINATION_CATALOG_ERROR_CODES = [
  'backup_missing',
  'backup_expired',
  'backup_future',
  'version_mismatch',
  'backup_invalid',
  'backup_changed',
  'storage_error',
  'timeout',
  'interrupted',
  'canceled',
  'worker_failed',
] as const;
export type DestinationCatalogErrorCode = (typeof DESTINATION_CATALOG_ERROR_CODES)[number];
export interface DestinationCatalogDiagnostic {
  stage: DestinationCatalogStage;
  started_at: string;
  updated_at: string;
  source_rows: number;
  provider_rows: number;
  items: number;
  keys: number;
  bytes: number;
}
const failureMessages: Record<DestinationCatalogErrorCode, string> = {
  backup_missing:
    'No completed Jellyfin backup was found. Create a database backup and check the mounted backup folder.',
  backup_expired:
    'The latest Jellyfin backup is older than 48 hours. Create a new database backup and import it.',
  backup_future:
    'The Jellyfin backup time is in the future. Check the server clocks and create a new database backup.',
  version_mismatch:
    'The Jellyfin backup version does not match the linked server. Create a database backup from that server.',
  backup_invalid:
    'The Jellyfin backup has an unsupported or invalid catalog. It could not be validated. Create a completed database backup and import it again.',
  backup_changed:
    'The Jellyfin backup changed during import. Wait for backup creation to finish and import it again.',
  storage_error:
    'The Jellyfin import could not use its private storage. Check free space and helper folder permissions.',
  timeout:
    'Jellyfin backup import exceeded its 30-minute preparation watchdog. Check helper resources before trying again.',
  interrupted:
    'Jellyfin backup import was interrupted. Check the helper, then import the completed backup again.',
  canceled: 'Jellyfin backup import canceled.',
  worker_failed:
    'The Jellyfin import worker stopped unexpectedly. Check helper status before trying again.',
};
export function validDestinationErrorCode(value: unknown): value is DestinationCatalogErrorCode {
  return DESTINATION_CATALOG_ERROR_CODES.includes(value as DestinationCatalogErrorCode);
}
export const destinationCatalogFailureMessage = (code: DestinationCatalogErrorCode): string =>
  failureMessages[code];
export class DestinationCatalogError extends ServiceError {
  constructor(
    readonly error_code: DestinationCatalogErrorCode,
    readonly diagnostic?: DestinationCatalogDiagnostic,
  ) {
    super(destinationCatalogFailureMessage(error_code));
  }
}
export function destinationCatalogErrorCode(error: unknown): DestinationCatalogErrorCode {
  if (error instanceof DestinationCatalogError) return error.error_code;
  if (error && typeof error === 'object' && 'code' in error) {
    if (
      ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'SQLITE_FULL', 'SQLITE_IOERR'].includes(
        String(error.code),
      )
    )
      return 'storage_error';
    if (
      error.code === 'ERR_SQLITE_ERROR' &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      [3, 8, 10, 13, 14].includes(error.errcode & 0xff)
    )
      return 'storage_error';
  }
  return 'backup_invalid';
}
export function validDestinationDiagnostic(value: unknown): value is DestinationCatalogDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const bounds = {
    source_rows: 5_000_000,
    provider_rows: 10_000_000,
    items: 2_000_000,
    keys: 20_000_000,
    bytes: 8 * 1024 ** 3,
  };
  return (
    Object.keys(entry).length === 8 &&
    DESTINATION_CATALOG_STAGES.includes(entry.stage as DestinationCatalogStage) &&
    typeof entry.started_at === 'string' &&
    typeof entry.updated_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.started_at) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.updated_at) &&
    Number.isFinite(Date.parse(entry.started_at)) &&
    new Date(entry.started_at).toISOString() === entry.started_at &&
    Number.isFinite(Date.parse(entry.updated_at)) &&
    new Date(entry.updated_at).toISOString() === entry.updated_at &&
    Date.parse(entry.updated_at) >= Date.parse(entry.started_at) &&
    Object.entries(bounds).every(
      ([name, maximum]) =>
        typeof entry[name] === 'number' &&
        Number.isSafeInteger(entry[name]) &&
        Number(entry[name]) >= 0 &&
        Number(entry[name]) <= maximum,
    )
  );
}
export interface DestinationCatalogRequest {
  purpose: 'jellyfin_catalog';
  id: string;
  requested_at: string;
  binding: SnapshotBinding;
  /** A completed native backup selected by the web process; no credentials or raw paths. */
  expected_backup?: { name: string; created_at: string };
}
export interface DestinationCatalogResult extends DestinationCatalogRequest {
  ok: boolean;
  started_at: string;
  finished_at: string;
  bytes?: number;
  items?: number;
  keys?: number;
  backup_created_at?: string;
  backup_fingerprint?: string;
  server_version?: string;
  backup_engine_version?: string;
  projection_format?: number;
  error?: string;
  error_code?: DestinationCatalogErrorCode;
  diagnostic?: DestinationCatalogDiagnostic;
}
export interface DestinationCatalogProgress extends DestinationCatalogRequest {
  diagnostic: DestinationCatalogDiagnostic;
}
export function validDestinationProgress(value: unknown): value is DestinationCatalogProgress {
  return !!(
    value &&
    typeof value === 'object' &&
    validDestinationRequest(value as DestinationCatalogRequest) &&
    validDestinationDiagnostic((value as DestinationCatalogProgress).diagnostic)
  );
}
export interface DestinationCatalogMetadata {
  id: string;
  items: number;
  keys: number;
  bytes: number;
  server_version: string;
  backup_engine_version: string;
  backup_created_at: string;
  imported_at: string;
  import_elapsed_ms: number;
  expires_at: string;
  projection_format?: number;
}
export const destinationCatalogPrefix = (id: string) => {
  if (!snapshotId.test(id)) throw new Error('Invalid destination catalog generation.');
  return `jellyfin-${id}`;
};
export const normalizedServerVersion = (version: string) =>
  /^\d{1,5}\.\d{1,5}(?:\.\d{1,5}){0,2}$/.test(version)
    ? version.split('.').map(Number).concat([0, 0]).slice(0, 4).join('.')
    : '';
function validUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}
export function validDestinationRequest(value: DestinationCatalogRequest): boolean {
  return !!(
    value &&
    value.purpose === 'jellyfin_catalog' &&
    snapshotId.test(value.id) &&
    typeof value.requested_at === 'string' &&
    Number.isFinite(Date.parse(value.requested_at)) &&
    validUrl(value.binding?.url) &&
    typeof value.binding.server_id === 'string' &&
    /^[a-fA-F0-9]{32}$/.test(value.binding.server_id) &&
    typeof value.binding.version === 'string' &&
    normalizedServerVersion(value.binding.version) &&
    (value.expected_backup === undefined ||
      (validJellyfinBackupName(value.expected_backup?.name) &&
        typeof value.expected_backup.created_at === 'string' &&
        Number.isFinite(Date.parse(value.expected_backup.created_at))))
  );
}
export function validDestinationResult(value: DestinationCatalogResult): boolean {
  return !!(
    validDestinationRequest(value) &&
    value.ok === true &&
    value.error_code === undefined &&
    (value.diagnostic === undefined || validDestinationDiagnostic(value.diagnostic)) &&
    (value.projection_format === 1 || value.projection_format === DESTINATION_CATALOG_FORMAT) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.bytes <= 8 * 1024 ** 3 &&
    typeof value.items === 'number' &&
    Number.isSafeInteger(value.items) &&
    value.items >= 0 &&
    value.items <= 2_000_000 &&
    typeof value.keys === 'number' &&
    Number.isSafeInteger(value.keys) &&
    value.keys >= 0 &&
    value.keys <= 20_000_000 &&
    typeof value.backup_created_at === 'string' &&
    Number.isFinite(Date.parse(value.backup_created_at)) &&
    Number.isFinite(Date.parse(value.started_at)) &&
    Number.isFinite(Date.parse(value.finished_at)) &&
    Date.parse(value.finished_at) >= Date.parse(value.started_at) &&
    Date.parse(value.backup_created_at) <= Date.parse(value.finished_at) + 60_000 &&
    normalizedServerVersion(value.server_version ?? '') ===
      normalizedServerVersion(value.binding.version) &&
    value.backup_engine_version === '0.2.0' &&
    typeof value.backup_fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.backup_fingerprint)
  );
}
export function destinationCatalogMetadata(
  value: DestinationCatalogResult,
): DestinationCatalogMetadata {
  if (!validDestinationResult(value)) throw new Error('Unsupported destination catalog.');
  return {
    id: value.id,
    items: value.items!,
    keys: value.keys!,
    bytes: value.bytes!,
    server_version: value.server_version!,
    backup_engine_version: value.backup_engine_version!,
    backup_created_at: value.backup_created_at!,
    imported_at: value.finished_at,
    import_elapsed_ms: Math.max(0, Date.parse(value.finished_at) - Date.parse(value.requested_at)),
    expires_at: new Date(
      Date.parse(value.backup_created_at!) + DESTINATION_CATALOG_MAX_AGE,
    ).toISOString(),
    projection_format: value.projection_format!,
  };
}
