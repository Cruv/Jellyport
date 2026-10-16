import { ServiceError } from './errors.js';
import { isObject, projectCatalogItem, type MediaItem, type MediaUserDataPatch } from './media.js';
import type { MigrationScope } from './migration.js';

export const USER_DATA_FIELDS = [
  'Played',
  'IsFavorite',
  'Likes',
  'PlaybackPositionTicks',
  'PlayCount',
  'LastPlayedDate',
  'Rating',
] as const;
export type UserDataField = (typeof USER_DATA_FIELDS)[number];

export interface VerificationExpectation {
  /** Matching identity only: no personal state, labels, or unrelated server DTO fields. */
  item: MediaItem;
  /** Fresh destination state plus the intended patch, captured before the write. */
  state: MediaUserDataPatch;
  /** Attempted fields which the destination cannot preserve; never count them as verified. */
  unsupported_fields?: string[];
}

export interface VerificationEvaluation {
  status: 'verified' | 'preserved_newer' | 'missing' | 'mismatch';
  fields: UserDataField[];
  unsupported_fields: string[];
  identity_mismatch?: boolean;
}

const playable = new Set([
  'Movie',
  'Episode',
  'Audio',
  'MusicVideo',
  'Video',
  'Book',
  'AudioBook',
  'Trailer',
]);
const activityFields = new Set<UserDataField>([
  'Played',
  'PlaybackPositionTicks',
  'PlayCount',
  'LastPlayedDate',
]);
const supportedFields = new Set<string>(USER_DATA_FIELDS);

function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function fieldValue(field: UserDataField, value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (field === 'LastPlayedDate') return date(value);
  if (field === 'Played' || field === 'IsFavorite' || field === 'Likes')
    return typeof value === 'boolean' ? value : undefined;
  if (field === 'Rating')
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10
      ? value
      : undefined;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (field !== 'PlayCount' || value <= 2_147_483_647)
    ? value
    : undefined;
}

function fieldName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value) ? value : '(invalid field name)';
}

function identityItem(item: MediaItem): MediaItem {
  const projected = projectCatalogItem(item);
  delete projected.Name;
  // Runtime is needed during merge validation, but is not part of matching identity.
  delete projected.RunTimeTicks;
  return projected;
}

function identity(item: MediaItem): string {
  return JSON.stringify([
    item.Id,
    item.Type,
    item.Path ?? null,
    item.SeriesId ?? null,
    ...(['ProviderIds', 'SeriesProviderIds'] as const).map((field) =>
      Object.entries(item[field] ?? {})
        .map(([key, value]) => [key, String(value)])
        .sort(([a], [b]) => a!.localeCompare(b!)),
    ),
    ...(['IndexNumber', 'ParentIndexNumber', 'IndexNumberEnd'] as const).map((field) =>
      item[field] === undefined ? null : Number(item[field]),
    ),
  ]);
}

/**
 * Capture before mutation, including no-op matches. Recomputing the merge against
 * final state is unsafe: an applied date can conceal an ignored resume position.
 * A caller serializing multiple source editions for one target must retain earlier
 * expectations too: a later fresh read could otherwise conceal an ignored write.
 * Read each target once during verification and evaluate every expectation for it.
 */
export function captureExpectation(
  target: MediaItem,
  patch: MediaUserDataPatch,
  scope: MigrationScope = 'complete',
): VerificationExpectation {
  if (!isObject(patch) || Object.keys(patch).length > 64)
    throw new ServiceError('Invalid migration verification patch.');
  const item = identityItem(target);
  const state: MediaUserDataPatch = {};
  const unsupported = new Set<string>();
  const included = (field: UserDataField) =>
    scope === 'watched_only'
      ? field === 'Played' || field === 'LastPlayedDate'
      : playable.has(item.Type ?? '') || !activityFields.has(field);
  for (const [key, value] of Object.entries(patch)) {
    if (!supportedFields.has(key) || !included(key as UserDataField)) {
      unsupported.add(fieldName(key));
      continue;
    }
    if (
      value !== undefined &&
      value !== null &&
      fieldValue(key as UserDataField, value) === undefined
    )
      throw new ServiceError('Invalid migration verification patch.');
  }
  for (const field of USER_DATA_FIELDS) {
    if (!included(field)) continue;
    const previous = fieldValue(field, target.UserData?.[field]);
    const intended = fieldValue(field, patch[field]);
    const value = intended ?? previous;
    if (value !== undefined) (state as Record<string, unknown>)[field] = value;
  }
  return {
    item,
    state,
    ...(unsupported.size ? { unsupported_fields: [...unsupported] } : {}),
  };
}

/** Independent readback evaluation only; this function never schedules repair writes. */
export function evaluateExpectation(
  expectation: VerificationExpectation,
  observed?: MediaItem,
): VerificationEvaluation {
  const unsupported = [...new Set((expectation.unsupported_fields ?? []).map(fieldName))];
  const fields = USER_DATA_FIELDS.filter(
    (field) => expectation.state[field] !== undefined && !unsupported.includes(field),
  );
  if (!observed || !isObject(observed.UserData))
    return { status: 'missing', fields, unsupported_fields: unsupported };
  try {
    if (identity(identityItem(observed)) !== identity(expectation.item))
      return {
        status: 'mismatch',
        fields: [],
        unsupported_fields: unsupported,
        identity_mismatch: true,
      };
  } catch {
    return {
      status: 'mismatch',
      fields: [],
      unsupported_fields: unsupported,
      identity_mismatch: true,
    };
  }
  const expectedDate = date(expectation.state.LastPlayedDate);
  const observedDate = date(observed.UserData.LastPlayedDate);
  const newer = !!observedDate && !!expectedDate && observedDate > expectedDate;
  const mismatches: UserDataField[] = [];
  for (const field of fields) {
    const expected = fieldValue(field, expectation.state[field]);
    const actual = fieldValue(field, observed.UserData[field]);
    if (field === 'Played' || field === 'IsFavorite') {
      // Additive migration does not undo a watched/favorite flag added by Jellyfin.
      if (typeof actual !== 'boolean' || (expected === true && actual !== true))
        mismatches.push(field);
    } else if (field === 'PlayCount') {
      if (typeof actual !== 'number' || typeof expected !== 'number' || actual < expected)
        mismatches.push(field);
    } else if (field === 'LastPlayedDate') {
      if (typeof actual !== 'string' || typeof expected !== 'string' || actual < expected)
        mismatches.push(field);
    } else if (field === 'PlaybackPositionTicks') {
      // A later playback date proves the resume position belongs to subsequent activity.
      // Missing/malformed state is not evidence of a newer valid position.
      if (actual === undefined || (actual !== expected && !newer)) mismatches.push(field);
    } else if (actual !== expected) mismatches.push(field);
  }
  return {
    status: mismatches.length ? 'mismatch' : newer ? 'preserved_newer' : 'verified',
    fields: mismatches,
    unsupported_fields: unsupported,
  };
}
