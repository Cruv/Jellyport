import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './store.js';
import { ServiceError } from './errors.js';
import { stripeBillingDecisions } from './stripe-entitlements.js';
import type { StripePaidPeriod, StripeSnapshot } from './stripe-client.js';

export interface StripeRoleCleanupAdapter {
  listRoles(): Promise<{
    roles: Array<{ id: string; name: string; manageable: boolean }>;
    can_manage_roles: boolean;
  }>;
  memberState(id: string): Promise<{ id: string; roles: string[] } | null>;
  removeRole(
    id: string,
    roleId: string,
    allowedRoleIds: string[],
    guard: () => void,
  ): Promise<void>;
  isExempt(id: string): boolean;
  /** Changes whenever Discord credentials, settings, or administrator pairing change. */
  context(): string;
}
export interface StripeRoleCleanupReport {
  discord_user_id: string;
  status: 'removed' | 'failed' | 'readded' | 'skipped';
  removed_role_ids: string[];
  attempted_at: string;
  message: string;
}
export interface StripeRoleCleanupStatus {
  enabled: boolean;
  role_ids: string[];
  last_run: string | null;
  running: boolean;
  removed_roles: number;
  failed_members: number;
  readded_members: number;
  last_error: string | null;
  reports: StripeRoleCleanupReport[];
}
interface MemberReceipt {
  id: string;
  removed: string[];
  pending: string[];
  failures: number;
  retry_at: number;
  blocked: boolean;
}
interface CleanupState {
  version: 1;
  generation: string;
  scope: string;
  revision: string;
  role_ids: string[];
  proof: { revision: string; authority: string; observed_at: number; expired: string[] } | null;
  last_run: string | null;
  last_error: string | null;
  removed_roles: number;
  reports: StripeRoleCleanupReport[];
  members: MemberReceipt[];
  cursor: number;
}
const freshMs = 30 * 60_000;
const maxMembersPerPass = 25;
const maxMembers = 10_000;
const snowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) < 2n ** 64n;
export function validCleanupRoles(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(snowflake) &&
    new Set(value).size === value.length
  );
}

/** Removal-only policy. Invoice evidence and uncertain Discord writes are kept
 * encrypted, independently from media membership event receipts. */
export class StripeRoleCleanup {
  private state: CleanupState | null;
  private task: Promise<void> | null = null;
  private stopped = false;
  private readonly stopController = new AbortController();
  constructor(
    readonly store: Store,
    private readonly adapter: StripeRoleCleanupAdapter | undefined,
    private readonly authority: () => string,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS stripe_role_cleanup_policy (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL)',
    );
    const row = store.db
      .prepare('SELECT encrypted FROM stripe_role_cleanup_policy WHERE id=1')
      .get();
    this.state = row ? store.decrypt<CleanupState>(row.encrypted as Uint8Array) : null;
    if (
      this.state &&
      (this.state.version !== 1 ||
        !validCleanupRoles(this.state.role_ids) ||
        !this.state.role_ids.length ||
        !Array.isArray(this.state.members) ||
        this.state.members.length > maxMembers ||
        !Array.isArray(this.state.reports) ||
        this.state.reports.length > 200 ||
        this.state.members.some(
          (entry) =>
            !snowflake(entry.id) ||
            !validCleanupRoles(entry.removed) ||
            !validCleanupRoles(entry.pending),
        ))
    )
      throw new ServiceError('The saved Stripe role cleanup policy could not be verified.');
    // A restart must obtain new billing evidence. Persist pending writes so a
    // fresh member read can reconcile them rather than assume they succeeded.
    if (this.state) {
      this.state.proof = null;
      this.persist();
    }
  }
  private scope(): string {
    const settings = this.store.settings();
    return createHash('sha256')
      .update(
        JSON.stringify([
          settings.discord_enabled,
          settings.discord_guild_id,
          settings.new_subscriber_source,
          this.store.authState(),
          this.adapter?.context(),
        ]),
      )
      .digest('hex');
  }
  private persist(): void {
    if (this.state)
      this.store.db
        .prepare('INSERT OR REPLACE INTO stripe_role_cleanup_policy VALUES (1,?)')
        .run(this.store.encrypt(this.state));
    else this.store.db.prepare('DELETE FROM stripe_role_cleanup_policy WHERE id=1').run();
  }
  enabled(generation: string): boolean {
    if (this.state && (this.state.generation !== generation || this.state.scope !== this.scope())) {
      this.state = null;
      this.persist();
    }
    return !!this.state && !this.stopped;
  }
  status(generation: string): StripeRoleCleanupStatus {
    this.enabled(generation);
    const state = this.state;
    return {
      enabled: !!state && !this.stopped,
      role_ids: [...(state?.role_ids ?? [])],
      last_run: state?.last_run ?? null,
      running: this.task !== null,
      removed_roles: state?.removed_roles ?? 0,
      failed_members: state?.members.filter((entry) => entry.failures > 0).length ?? 0,
      readded_members: state?.members.filter((entry) => entry.blocked).length ?? 0,
      last_error: state?.last_error ?? null,
      reports: structuredClone(state?.reports ?? []),
    };
  }
  configure(enabled: boolean, generation: string, roleIds: string[]): void {
    if (!enabled) {
      this.state = null;
      this.persist();
      return;
    }
    if (!this.adapter || !validCleanupRoles(roleIds) || !roleIds.length)
      throw new ServiceError(
        'Select up to 20 distinct subscriber or tier roles and connect the Discord bot.',
      );
    if (
      !this.store.settings().discord_enabled ||
      this.store.settings().new_subscriber_source !== 'stripe'
    )
      throw new ServiceError(
        'Select Stripe as the subscription source and connect Discord before enabling subscriber role cleanup.',
      );
    if (
      this.enabled(generation) &&
      JSON.stringify(this.state!.role_ids) === JSON.stringify(roleIds)
    )
      return;
    this.state = {
      version: 1,
      generation,
      scope: this.scope(),
      revision: randomUUID(),
      role_ids: [...roleIds],
      proof: null,
      last_run: null,
      last_error: null,
      removed_roles: 0,
      reports: [],
      members: [],
      cursor: 0,
    };
    this.persist();
  }
  invalidateProof(message: string): void {
    if (!this.state) return;
    this.state.proof = null;
    this.state.last_error = message;
    this.persist();
  }
  recordProof(
    generation: string,
    snapshot: StripeSnapshot,
    links: Array<{ customer_id: string; discord_user_id: string }>,
    prices: Array<{ price_id: string; tier_id: string }>,
    periods: Map<string, StripePaidPeriod | null>,
  ): void {
    if (!this.enabled(generation)) return;
    if (snapshot.mode !== 'live') {
      this.invalidateProof('Role cleanup requires verified live Stripe billing.');
      return;
    }
    const decisions = stripeBillingDecisions(snapshot, links, prices, periods, this.now());
    // A genuinely paid renewal starts a new access cycle. MEE6 restoring its
    // subscriber roles is expected, rather than a competing expired-role readd.
    // Pending uncertain writes remain available for later observation.
    for (const decision of decisions) {
      if (decision.action !== 'subscribe') continue;
      const receipt = this.state!.members.find((entry) => entry.id === decision.owner);
      if (receipt) {
        receipt.removed = [];
        receipt.failures = 0;
        receipt.retry_at = 0;
        receipt.blocked = false;
      }
    }
    this.state!.proof = {
      revision: randomUUID(),
      authority: this.authority(),
      observed_at: this.now(),
      expired: decisions.filter((fact) => fact.action === 'expire').map((fact) => fact.owner),
    };
    this.state!.last_error = null;
    this.persist();
  }
  private report(
    id: string,
    status: StripeRoleCleanupReport['status'],
    removed: string[],
    message: string,
  ): void {
    if (!this.state) return;
    this.state.reports.unshift({
      discord_user_id: id,
      status,
      removed_role_ids: [...removed],
      attempted_at: new Date(this.now()).toISOString(),
      message,
    });
    this.state.reports = this.state.reports.slice(0, 200);
    this.persist();
  }
  reconcile(generation: string): Promise<void> {
    if (this.task) return this.task;
    if (!this.enabled(generation) || !this.state?.proof || !this.adapter) return Promise.resolve();
    const state = this.state,
      proof = state.proof!,
      adapter = this.adapter;
    const guard = (id?: string) => {
      if (
        this.state !== state ||
        !this.enabled(generation) ||
        state.proof !== proof ||
        proof.authority !== this.authority() ||
        this.now() < proof.observed_at ||
        this.now() - proof.observed_at > freshMs ||
        (id && adapter.isExempt(id))
      )
        throw new ServiceError(
          'Role cleanup stopped because billing, ownership, exemptions or configuration changed.',
        );
    };
    const member = async (id: string) => {
      guard(id);
      const result = await adapter.memberState(id);
      guard(id);
      if (
        result &&
        (result.id !== id ||
          !Array.isArray(result.roles) ||
          result.roles.some((role) => !snowflake(role)))
      )
        throw new ServiceError('Discord member state could not be verified.');
      return result;
    };
    const work = async () => {
      try {
        guard();
        const roles = await adapter.listRoles();
        guard();
        if (
          !roles.can_manage_roles ||
          state.role_ids.some(
            (id) => !roles.roles.some((role) => role.id === id && role.manageable),
          )
        )
          throw new ServiceError(
            'The Discord bot cannot manage every configured cleanup role. Review its role order and permissions.',
          );
        const ids = proof.expired;
        const start = state.cursor % Math.max(ids.length, 1);
        const deadline = this.now() + 60_000;
        let mutations = 0;
        for (let offset = 0; offset < Math.min(ids.length, maxMembersPerPass); offset++) {
          guard();
          if (mutations >= 25 || this.now() >= deadline) break;
          const id = ids[(start + offset) % ids.length]!;
          state.cursor = start + offset + 1;
          if (adapter.isExempt(id)) continue;
          let receipt = state.members.find((entry) => entry.id === id);
          if (
            receipt?.blocked ||
            (receipt && (receipt.failures >= 3 || receipt.retry_at > this.now()))
          )
            continue;
          if (!receipt) {
            if (state.members.length >= maxMembers)
              throw new ServiceError(
                'Role cleanup reached its safe member limit. Review the policy before continuing.',
              );
            receipt = { id, removed: [], pending: [], failures: 0, retry_at: 0, blocked: false };
            state.members.push(receipt);
          }
          try {
            const current = await member(id);
            if (!current) continue;
            // A completed removal that reappears indicates another automation
            // disagrees. Report it and stop touching this member until review.
            if (receipt.removed.some((role) => current.roles.includes(role))) {
              receipt.blocked = true;
              this.report(
                id,
                'readded',
                [],
                'A previously removed subscriber role was added again. Cleanup is paused for this member; review competing role automation.',
              );
              continue;
            }
            // Resolve a crash/timeout after a DELETE using a fresh observation.
            const resolved = receipt.pending.filter((role) => !current.roles.includes(role));
            receipt.removed.push(...resolved.filter((role) => !receipt!.removed.includes(role)));
            state.removed_roles += resolved.length;
            receipt.pending = receipt.pending.filter((role) => current.roles.includes(role));
            const selected = state.role_ids.filter((role) => current.roles.includes(role));
            for (const role of selected) {
              guard(id);
              if (mutations >= 25 || this.now() >= deadline) break;
              if (!receipt.pending.includes(role)) receipt.pending.push(role);
              this.persist();
              mutations++;
              await adapter.removeRole(id, role, [...state.role_ids], () => guard(id));
              guard(id);
              // Keep writes serial and yield to shutdown/configuration changes.
              await delay(50, undefined, { signal: this.stopController.signal });
              guard(id);
            }
            if (!selected.length && !resolved.length) continue;
            const after = await member(id);
            if (!after)
              throw new ServiceError(
                'Discord member disappeared before role removal could be verified.',
              );
            const removed = receipt.pending.filter((role) => !after.roles.includes(role));
            receipt.removed.push(...removed.filter((role) => !receipt!.removed.includes(role)));
            receipt.pending = receipt.pending.filter((role) => after.roles.includes(role));
            state.removed_roles += removed.length;
            if (receipt.pending.length)
              throw new ServiceError('Discord role removal could not be verified.');
            receipt.failures = 0;
            receipt.retry_at = 0;
            if (state.role_ids.some((role) => after.roles.includes(role))) {
              // A pass can exhaust its mutation/time budget mid-member. Keep
              // the verified subset, resume this owner next time, and never
              // claim that every configured role has already been removed.
              state.cursor = start + offset;
              this.report(
                id,
                'skipped',
                [...resolved, ...removed],
                'Some subscriber roles were removed and verified. Remaining roles are deferred to the next bounded cleanup pass.',
              );
              break;
            }
            this.report(
              id,
              'removed',
              [...resolved, ...removed],
              'Expired paid access was verified and the configured subscriber roles are absent.',
            );
          } catch {
            // Never turn a stale scope or newly exempt member into an action
            // failure that might later retry against a different authority.
            guard();
            if (adapter.isExempt(id)) continue;
            receipt.failures++;
            receipt.retry_at = this.now() + 60_000 * 5 ** (receipt.failures - 1);
            this.report(
              id,
              'failed',
              [],
              'Subscriber role cleanup could not be verified. Existing uncertain writes will be reconciled; repeated failures require administrator review.',
            );
          }
        }
        guard();
        state.last_run = new Date(this.now()).toISOString();
        state.last_error = null;
        this.persist();
      } catch {
        if (this.state === state) {
          state.last_error =
            'Role cleanup stopped safely. Refresh Stripe billing and review Discord permissions, role order and policy configuration.';
          this.persist();
        }
      }
    };
    this.task = work().finally(() => {
      this.task = null;
    });
    return this.task;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController.abort();
    await this.task?.catch(() => {});
  }
}
