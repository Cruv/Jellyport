import { ServiceError } from './errors.js';
import { isObject, projectCatalogItem, type MediaItem, type MediaUserDataPatch } from './media.js';
import type { MigrationScope } from './migration.js';

export const USER_DATA_FIELDS = ['Played'] as const;
export const FAVORITE_USER_DATA_FIELDS = ['Played', 'IsFavorite'] as const;
export type UserDataField = (typeof FAVORITE_USER_DATA_FIELDS)[number];

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

const fieldValue = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

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
 * Capture the intended positive flags before mutation, including already-merged matches.
 * A caller serializing multiple source editions for one target must retain earlier
 * expectations too: a later fresh read could otherwise conceal an ignored write.
 * Read each target once during verification and evaluate every expectation for it.
 */
export function captureExpectation(
  target: MediaItem,
  patch: MediaUserDataPatch,
  scope: MigrationScope = 'watched_only',
): VerificationExpectation {
  if (!isObject(patch) || Object.keys(patch).length > 64)
    throw new ServiceError('Invalid migration verification patch.');
  const item = identityItem(target);
  const state: MediaUserDataPatch = {};
  const unsupported = new Set<string>();
  const fields = scope === 'played_favorites' ? FAVORITE_USER_DATA_FIELDS : USER_DATA_FIELDS;
  // Old reviewed jobs remain played-only. Other snapshot fields cannot become
  // verification evidence merely because a newer importer retained them.
  for (const [key, value] of Object.entries(patch)) {
    if (!(fields as readonly string[]).includes(key)) {
      unsupported.add(fieldName(key));
      continue;
    }
    if (value !== undefined && value !== null && fieldValue(value) === undefined)
      throw new ServiceError('Invalid migration verification patch.');
  }
  for (const field of fields) {
    const previous = fieldValue(target.UserData?.[field]);
    const intended = fieldValue(patch[field]);
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
  const fields = FAVORITE_USER_DATA_FIELDS.filter(
    (field) => expectation.state[field] !== undefined,
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
  const mismatches: UserDataField[] = [];
  for (const field of fields) {
    const expected = fieldValue(expectation.state[field]);
    const actual = fieldValue(observed.UserData[field]);
    // Additive migration never undoes a watched or favorite flag added by Jellyfin.
    if (typeof actual !== 'boolean' || (expected === true && actual !== true))
      mismatches.push(field);
  }
  return {
    status: mismatches.length ? 'mismatch' : 'verified',
    fields: mismatches,
    unsupported_fields: unsupported,
  };
}
