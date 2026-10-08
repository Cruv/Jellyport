import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';

export interface MembershipTier {
  id: string;
  name: string;
  plan_name: string;
  account_limit: number;
}
export const DEFAULT_MEMBERSHIP_TIERS: MembershipTier[] = [
  { id: 'sloop', name: 'Sloop', plan_name: 'Sloop Crewman Plan', account_limit: 1 },
  { id: 'brigantine', name: 'Brigantine', plan_name: 'Brigantine Crewman Plan', account_limit: 2 },
  { id: 'galleon', name: 'Galleon', plan_name: 'Galleon Crewman Plan', account_limit: 3 },
];
export type MembershipAccessMode = 'subscription' | 'complimentary';
export interface MembershipInput {
  discord_user_id: string;
  base_username: string;
  tier_id: string;
  account_limit: number;
  /** Omitted legacy inputs retain subscription-managed behavior. */
  access_mode?: MembershipAccessMode;
  active?: boolean;
  inactive_reason?: 'cancel' | 'expire';
}
export interface Membership extends MembershipInput {
  access_mode: MembershipAccessMode;
  server_url: string;
  server_id?: string;
  revision: string;
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    [...value].length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function tierId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
export function validateMembershipSlot(slot: number): number {
  if (!Number.isInteger(slot) || slot < 1 || slot > 3)
    throw new ServiceError('Membership account slots must be between 1 and 3.');
  return slot;
}
export function validateMembershipTiers(value: unknown): MembershipTier[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new ServiceError('Configure between 1 and 20 membership tiers.');
  const ids = new Set<string>();
  const plans = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new ServiceError('Membership tiers contain invalid fields.');
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(',') !== 'account_limit,id,name,plan_name' ||
      !tierId(item.id) ||
      !text(item.name, 64) ||
      !text(item.plan_name, 100) ||
      typeof item.account_limit !== 'number'
    )
      throw new ServiceError('Membership tiers contain invalid fields.');
    validateMembershipSlot(item.account_limit);
    const idKey = item.id.toLowerCase();
    const planKey = item.plan_name.toLowerCase();
    if (ids.has(idKey) || plans.has(planKey))
      throw new ServiceError('Membership tier IDs and subscription plan names must be unique.');
    ids.add(idKey);
    plans.add(planKey);
    return {
      id: item.id,
      name: item.name,
      plan_name: item.plan_name,
      account_limit: item.account_limit,
    };
  });
}
/** Exact configured plan names only; unrelated or future plans require administrator review. */
export function resolveMembershipTier(
  planName: string,
  tiers: MembershipTier[] = DEFAULT_MEMBERSHIP_TIERS,
): MembershipTier | null {
  if (typeof planName !== 'string') return null;
  const key = planName.trim().toLowerCase();
  const tier = validateMembershipTiers(tiers).find((item) => item.plan_name.toLowerCase() === key);
  return tier ? structuredClone(tier) : null;
}
export function membershipUsername(baseUsername: string, slot: number): string {
  validateMembershipSlot(slot);
  if (!text(baseUsername, 64) || /[\\/<>]/.test(baseUsername))
    throw new ServiceError(
      'Use a membership base username of 1–64 printable characters without slashes or angle brackets.',
    );
  const username = slot === 1 ? baseUsername : `${baseUsername}_${slot}`;
  if ([...username].length > 64)
    throw new ServiceError(
      'The membership base username is too long for numbered accounts. Choose a shorter approved username.',
    );
  return username;
}
function validateInput(value: MembershipInput): void {
  if (
    !value ||
    typeof value.discord_user_id !== 'string' ||
    !/^[0-9]{5,22}$/.test(value.discord_user_id) ||
    !tierId(value.tier_id) ||
    (value.access_mode !== undefined &&
      !['subscription', 'complimentary'].includes(value.access_mode)) ||
    (value.active !== undefined && typeof value.active !== 'boolean') ||
    (value.inactive_reason !== undefined && !['cancel', 'expire'].includes(value.inactive_reason))
  )
    throw new ServiceError('The membership contains invalid identity fields.');
  validateMembershipSlot(value.account_limit);
  membershipUsername(value.base_username, value.account_limit);
}
type ServerScope = { server_url: string; server_id?: string };
function scope(store: Store, settings: Settings): ServerScope | null {
  if (!settings.jellyfin_url) return null;
  const server_url = normalizeJellyfinUrl(settings.jellyfin_url);
  const auth = store.authState();
  if (auth?.kind === 'configured') {
    if (normalizeJellyfinUrl(auth.serverUrl) !== server_url) return null;
    return { server_url, server_id: auth.serverId };
  }
  return { server_url };
}
function recordId(value: ServerScope & { discord_user_id: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([value.server_url, value.server_id ?? null, value.discord_user_id]))
    .digest('hex');
}
function sameScope(membership: Membership, server: ServerScope): boolean {
  return membership.server_url === server.server_url && membership.server_id === server.server_id;
}

/** Encrypted entitlement decisions, independent of usernames and scoped to the configured server. */
export class Memberships {
  constructor(readonly store: Store) {}
  private record(id: string, value: Membership): Membership {
    validateInput(value);
    if (
      !text(value.server_url, 2048) ||
      normalizeJellyfinUrl(value.server_url) !== value.server_url ||
      (value.server_id !== undefined && !text(value.server_id, 256)) ||
      !text(value.revision, 128) ||
      recordId(value) !== id
    )
      throw new ServiceError('The saved membership contains invalid server identity fields.');
    return {
      discord_user_id: value.discord_user_id,
      base_username: value.base_username,
      tier_id: value.tier_id,
      account_limit: value.account_limit,
      access_mode: value.access_mode ?? 'subscription',
      active: value.active ?? true,
      ...(value.active === false && value.inactive_reason
        ? { inactive_reason: value.inactive_reason }
        : {}),
      server_url: value.server_url,
      ...(value.server_id ? { server_id: value.server_id } : {}),
      revision: value.revision,
    };
  }
  private records(): Membership[] {
    const records = this.store.membershipRecords<Membership>();
    if (records.length > 10_000) throw new ServiceError('Too many saved memberships.');
    return records.map(({ id, value }) => this.record(id, value));
  }
  list(settings: Settings): Membership[] {
    const server = scope(this.store, settings);
    if (!server) return [];
    return this.records()
      .filter((value) => sameScope(value, server))
      .sort(
        (a, b) =>
          a.base_username.localeCompare(b.base_username) ||
          a.discord_user_id.localeCompare(b.discord_user_id),
      );
  }
  get(discordId: string, settings: Settings): Membership | null {
    const server = scope(this.store, settings);
    if (!server) return null;
    const id = recordId({ ...server, discord_user_id: discordId });
    const row = this.store.db.prepare('SELECT encrypted FROM memberships WHERE id=?').get(id);
    // Membership guards run before individual media writes: read and authenticate
    // only this member, without caching decisions that may change during a job.
    return row
      ? this.record(id, this.store.decrypt<Membership>(row.encrypted as Uint8Array))
      : null;
  }
  /** Scoped records must never be mistaken for an unscoped legacy single-account member. */
  hasOtherScope(discordId: string, settings: Settings): boolean {
    const server = scope(this.store, settings);
    return this.records().some(
      (member) => member.discord_user_id === discordId && (!server || !sameScope(member, server)),
    );
  }
  save(input: MembershipInput, settings: Settings, expectedRevision?: string): Membership {
    validateInput(input);
    const server = scope(this.store, settings);
    if (!server) throw new ServiceError('Configure Jellyfin before creating memberships.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const all = this.records();
      const existing = all.find(
        (value) => sameScope(value, server) && value.discord_user_id === input.discord_user_id,
      );
      if (expectedRevision !== undefined && existing?.revision !== expectedRevision)
        throw new ServiceError('The membership changed. Review it before retrying.');
      if (!existing && all.length >= 10_000) throw new ServiceError('Too many saved memberships.');
      if (
        existing &&
        existing.base_username === input.base_username &&
        existing.tier_id === input.tier_id &&
        existing.account_limit === input.account_limit &&
        existing.access_mode === (input.access_mode ?? 'subscription') &&
        existing.active === (input.active ?? true) &&
        existing.inactive_reason === (input.active === false ? input.inactive_reason : undefined)
      ) {
        this.store.db.exec('COMMIT');
        return existing;
      }
      const membership: Membership = {
        discord_user_id: input.discord_user_id,
        base_username: input.base_username,
        tier_id: input.tier_id,
        account_limit: input.account_limit,
        access_mode: input.access_mode ?? 'subscription',
        active: input.active ?? true,
        ...(input.active === false && input.inactive_reason
          ? { inactive_reason: input.inactive_reason }
          : {}),
        ...server,
        revision: randomUUID(),
      };
      this.store.saveMembershipRecord(recordId(membership), membership);
      this.store.db.exec('COMMIT');
      return membership;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
