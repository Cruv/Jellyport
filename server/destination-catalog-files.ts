import type { SnapshotBinding } from './snapshot-files.js';
import { snapshotId } from './snapshot-files.js';

export const DESTINATION_CATALOG_MAX_AGE = 48 * 60 * 60_000;
export const DESTINATION_CATALOG_DEADLINE = 5 * 60_000;
export const DESTINATION_CATALOG_FORMAT = 1;
export interface DestinationCatalogRequest {
  purpose: 'jellyfin_catalog';
  id: string;
  requested_at: string;
  binding: SnapshotBinding;
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
    normalizedServerVersion(value.binding.version)
  );
}
export function validDestinationResult(value: DestinationCatalogResult): boolean {
  return !!(
    validDestinationRequest(value) &&
    value.ok === true &&
    value.projection_format === DESTINATION_CATALOG_FORMAT &&
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
  };
}
