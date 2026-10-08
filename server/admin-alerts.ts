import { randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import { adminAlertReceiptId, type AdminAlertSource, type Store } from './store.js';
import type { Settings } from './types.js';

const DELIVERY_ERROR =
  'Private admin notifications could not be delivered. Check the bot connection, administrator access, and Discord privacy settings.';
const SCOPE_ERROR =
  'Private admin notifications are paused because the linked Discord or Jellyfin server changed. Enable them again from Discord.';
interface AlertScope {
  guild_id: string;
  server_url: string;
  server_id: string | null;
}
interface AlertConfiguration {
  scope: AlertScope;
  generation: string;
  user_id: string;
  username: string;
  last_sent_at: string | null;
  last_error: string | null;
  failures: number;
  next_attempt_at: number;
}
export interface AdminAlertStatus {
  enabled: boolean;
  recipient_username: string | null;
  recipient_id: string | null;
  revision: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  pending_count: number;
}
export interface AdminAlertRecipient {
  guild_id: string;
  user_id: string;
  username: string;
}
export type AdminAlertSend = (
  userId: string,
  content: string,
  stillCurrent: () => boolean,
) => Promise<void>;

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) < 2n ** 64n;
}
function sameScope(left: AlertScope, right: AlertScope | null): boolean {
  return (
    !!right &&
    left.guild_id === right.guild_id &&
    left.server_url === right.server_url &&
    left.server_id === right.server_id
  );
}
function summary(sources: AdminAlertSource[]): string {
  const count = (kind: string, status: string) =>
    sources.filter((source) => source.kind === kind && source.status === status).length;
  const lines = ['Jellyport private admin update'];
  const labels = [
    ['completed', 'completed'],
    ['partial', 'need review'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['cancelled', 'cancelled'],
  ];
  const jobs = labels
    .map(([status, label]) => [count('job', status!), label] as const)
    .filter(([total]) => total > 0)
    .map(([total, label]) => `${total} ${label}`);
  if (jobs.length) lines.push(`Account jobs: ${jobs.join(', ')}.`);
  const pending = count('subscription', 'pending');
  const failed = count('subscription', 'failed');
  if (pending) lines.push(`Subscription events awaiting review: ${pending}.`);
  if (failed) lines.push(`Subscription actions that failed: ${failed}.`);
  lines.push('Open Jellyport to review the details.');
  return lines.join('\n');
}

/** Private, opt-in digests. Discord authorization is checked by the sending adapter. */
export class AdminAlerts {
  private flushing = false;
  constructor(readonly store: Store) {}

  private scope(settings: Settings): AlertScope | null {
    if (
      !settings.discord_enabled ||
      !snowflake(settings.discord_guild_id) ||
      !settings.jellyfin_url
    )
      return null;
    const server_url = normalizeJellyfinUrl(settings.jellyfin_url);
    const auth = this.store.authState();
    if (auth?.kind === 'pending') return null;
    if (auth?.kind === 'configured' && normalizeJellyfinUrl(auth.serverUrl) !== server_url)
      return null;
    return {
      guild_id: settings.discord_guild_id,
      server_url,
      server_id: auth?.kind === 'configured' ? auth.serverId : null,
    };
  }
  private configuration(): AlertConfiguration | null {
    const value = this.store.adminAlertConfig<AlertConfiguration>();
    if (!value) return null;
    if (
      !value.scope ||
      !snowflake(value.scope.guild_id) ||
      typeof value.scope.server_url !== 'string' ||
      normalizeJellyfinUrl(value.scope.server_url) !== value.scope.server_url ||
      !(value.scope.server_id === null || typeof value.scope.server_id === 'string') ||
      typeof value.generation !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.generation) ||
      !snowflake(value.user_id) ||
      typeof value.username !== 'string' ||
      value.username.length < 1 ||
      value.username.length > 64 ||
      /\p{C}/u.test(value.username) ||
      !(value.last_sent_at === null || typeof value.last_sent_at === 'string') ||
      !(value.last_error === null || value.last_error === DELIVERY_ERROR) ||
      !Number.isSafeInteger(value.failures) ||
      value.failures < 0 ||
      value.failures > 5 ||
      !Number.isFinite(value.next_attempt_at) ||
      value.next_attempt_at < 0
    )
      throw new ServiceError('The saved private notification configuration is invalid.');
    return value;
  }
  status(settings: Settings): AdminAlertStatus {
    const value = this.configuration();
    const enabled = !!value && sameScope(value.scope, this.scope(settings));
    return {
      enabled,
      recipient_username: enabled ? value!.username : null,
      recipient_id: enabled ? value!.user_id : null,
      revision: value?.generation ?? null,
      last_sent_at: enabled ? value!.last_sent_at : null,
      last_error: enabled ? value!.last_error : value ? SCOPE_ERROR : null,
      pending_count: enabled ? this.store.pendingAdminAlertCount(value!.generation) : 0,
    };
  }
  /** Call only after fresh admin authorization and successful private test delivery. */
  enable(recipient: AdminAlertRecipient, settings: Settings): AdminAlertStatus {
    const scope = this.scope(settings);
    if (
      !scope ||
      !sameScope(scope, this.scope(this.store.settings())) ||
      recipient.guild_id !== scope.guild_id ||
      !snowflake(recipient.user_id) ||
      typeof recipient.username !== 'string' ||
      !recipient.username.trim() ||
      recipient.username.length > 64 ||
      /\p{C}/u.test(recipient.username)
    )
      throw new ServiceError(
        'Verify the administrator and linked server before enabling private notifications.',
      );
    const existing = this.configuration();
    if (existing && sameScope(existing.scope, scope) && existing.user_id === recipient.user_id) {
      this.store.saveAdminAlertConfig({
        ...existing,
        username: recipient.username,
        last_error: null,
        failures: 0,
        next_attempt_at: 0,
      });
      return this.status(settings);
    }
    const value: AlertConfiguration = {
      scope,
      generation: randomUUID(),
      user_id: recipient.user_id,
      username: recipient.username,
      last_sent_at: null,
      last_error: null,
      failures: 0,
      next_attempt_at: 0,
    };
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.clearAdminAlerts();
      this.store.baselineAdminAlerts(value.generation);
      this.store.saveAdminAlertConfig(value);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return this.status(settings);
  }
  disable(userId?: string, expectedRevision?: string): void {
    const value = this.configuration();
    if (expectedRevision !== undefined && expectedRevision !== (value?.generation ?? ''))
      throw new ServiceError(
        'The private notification recipient changed. Reload before disabling alerts.',
      );
    if (userId !== undefined && value && value.user_id !== userId)
      throw new ServiceError(
        'Only the selected notification administrator can disable these alerts from Discord.',
      );
    this.store.clearAdminAlerts();
  }
  async flush(settings: Settings, send: AdminAlertSend): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const value = this.configuration();
      if (!value || !sameScope(value.scope, this.scope(settings))) return;
      const stillCurrent = () => {
        const current = this.configuration();
        return (
          current?.generation === value.generation &&
          current.user_id === value.user_id &&
          sameScope(value.scope, this.scope(this.store.settings()))
        );
      };
      if (!stillCurrent() || value.next_attempt_at > Date.now()) return;
      const sources = this.store.pendingAdminAlertSources(value.generation);
      if (!sources.length) return;
      try {
        await send(value.user_id, summary(sources), stillCurrent);
      } catch {
        if (!stillCurrent()) return;
        const current = this.configuration()!;
        const failures = Math.min(current.failures + 1, 5);
        this.store.saveAdminAlertConfig({
          ...current,
          failures,
          last_error: DELIVERY_ERROR,
          next_attempt_at: Date.now() + (failures === 1 ? 60_000 : 300_000),
        });
        return;
      }
      if (!stillCurrent()) return;
      const current = this.configuration()!;
      const sent = new Date().toISOString();
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const source of sources)
          this.store.saveAdminAlertReceipt(adminAlertReceiptId(value.generation, source), {
            delivered_at: sent,
          });
        this.store.saveAdminAlertConfig({
          ...current,
          last_sent_at: sent,
          last_error: null,
          failures: 0,
          next_attempt_at: 0,
        });
        this.store.db.exec('COMMIT');
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.flushing = false;
    }
  }
}
