import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { nameKey } from './identity.js';
import { captureRoleParameters, type RoleParameters } from './role-parameters.js';
import type { MediaUser, JsonObject } from './media.js';

export interface CloneAccountInput {
  username: string;
  family: boolean;
  owner_name?: string;
  notes?: string;
}
export interface CloneAccountsInput {
  source_user_id: string;
  expected_source_username: string;
  accounts: CloneAccountInput[];
}
/** Private reviewed values; persisted only inside the encrypted job request. */
export interface ReviewedCloneSource {
  server_id: string;
  source_user_id: string;
  source_username: string;
  parameters: RoleParameters;
  parameters_hash: string;
  warnings: string[];
}
export interface CloneAccountsReview {
  id: string;
  source_user_id: string;
  source_username: string;
  accounts: CloneAccountInput[];
  warnings: string[];
  expires_at: string;
}
export interface StoredCloneReview {
  source: ReviewedCloneSource;
  review: CloneAccountsReview;
}
export function accountConfigurationHash(value: unknown): string {
  const ordered = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(ordered)
      : entry !== null && typeof entry === 'object'
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : entry;
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}

const control = /[\u0000-\u001f\u007f-\u009f]/;
const noteControl = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
export function validateCloneInput(input: CloneAccountsInput): void {
  if (
    !input ||
    typeof input.source_user_id !== 'string' ||
    !input.source_user_id ||
    input.source_user_id.length > 128 ||
    typeof input.expected_source_username !== 'string' ||
    !input.expected_source_username ||
    input.expected_source_username.length > 256 ||
    !Array.isArray(input.accounts) ||
    !input.accounts.length ||
    input.accounts.length > 10
  )
    throw new ServiceError('Select one existing account and 1–10 new accounts to clone.');
  const names = new Set<string>();
  for (const account of input.accounts) {
    if (
      !account ||
      typeof account.username !== 'string' ||
      !account.username ||
      account.username !== account.username.trim() ||
      [...account.username].length > 64 ||
      /[\u0000-\u001f\u007f-\u009f\\/<>]/.test(account.username) ||
      typeof account.family !== 'boolean' ||
      (account.owner_name !== undefined &&
        (typeof account.owner_name !== 'string' ||
          [...account.owner_name].length > 120 ||
          control.test(account.owner_name))) ||
      (account.notes !== undefined &&
        (typeof account.notes !== 'string' ||
          [...account.notes].length > 2000 ||
          noteControl.test(account.notes))) ||
      names.has(nameKey(account.username))
    )
      throw new ServiceError('Choose distinct new usernames and valid account notes.');
    names.add(nameKey(account.username));
  }
}
export function cloneParameters(user: MediaUser, preferences: JsonObject | null) {
  const captured = captureRoleParameters(user, preferences);
  // A partial projection must never silently remove a child's access restriction.
  // Only these identity/login bookkeeping fields are deliberately not inherited.
  const bookkeeping = new Set([
    'IsDisabled',
    'InvalidLoginAttemptCount',
    'FailedLoginAttempts',
    'AuthenticationProviderId',
    'PasswordResetProviderId',
  ]);
  for (const key of Object.keys(user.Policy ?? {}))
    if (!bookkeeping.has(key) && !Object.hasOwn(captured.parameters.policy, key))
      throw new ServiceError(
        'This account has unsupported permission fields. Cloning stopped to preserve its access restrictions.',
      );
  return { ...captured, hash: accountConfigurationHash(captured.parameters) };
}
export function newCloneReview(
  input: CloneAccountsInput,
  source: ReviewedCloneSource,
): StoredCloneReview {
  validateCloneInput(input);
  return {
    source: structuredClone(source),
    review: {
      id: randomUUID(),
      source_user_id: source.source_user_id,
      source_username: source.source_username,
      accounts: structuredClone(input.accounts),
      warnings: [...source.warnings],
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  };
}

/** One short-lived private review per administrator session; no playback state is retained. */
export class CloneReviews {
  private readonly reviews = new Map<
    string,
    { owner: string; context: string; value: StoredCloneReview }
  >();
  private prune() {
    for (const [id, entry] of this.reviews)
      if (Date.parse(entry.value.review.expires_at) <= Date.now()) this.reviews.delete(id);
  }
  save(owner: string, context: string, value: StoredCloneReview): CloneAccountsReview {
    this.prune();
    this.cancelOwner(owner);
    if (this.reviews.size >= 16)
      throw new ServiceError('Too many account reviews. Wait and try again.');
    this.reviews.set(value.review.id, { owner, context, value: structuredClone(value) });
    return structuredClone(value.review);
  }
  take(owner: string, context: string, id: string): StoredCloneReview {
    this.prune();
    const entry = this.reviews.get(id);
    if (!entry || entry.owner !== owner || entry.context !== context)
      throw new ServiceError('This account clone review expired or changed. Prepare a new review.');
    this.reviews.delete(id);
    return structuredClone(entry.value);
  }
  cancelOwner(owner: string) {
    for (const [id, entry] of this.reviews) if (entry.owner === owner) this.reviews.delete(id);
  }
  close() {
    this.reviews.clear();
  }
}
