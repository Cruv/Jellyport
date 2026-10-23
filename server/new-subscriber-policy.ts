import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Settings } from './types.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import { ServiceError } from './errors.js';

export interface NewSubscriberActivation {
  enabled_at: string;
  revision: string;
}
interface ActivationRecord extends NewSubscriberActivation {
  scope: string;
}

/** The cutoff is private server state, never a timestamp supplied by a browser.
 * Saving the switch must not turn a backlog or a returning member into a signup. */
export class NewSubscriberPolicy {
  constructor(readonly store: Store) {}
  private scope(settings: Settings): string {
    const auth = this.store.authState();
    return createHash('sha256')
      .update(
        JSON.stringify([
          settings.discord_guild_id,
          settings.emby_url ? normalizeJellyfinUrl(settings.emby_url) : '',
          settings.jellyfin_url ? normalizeJellyfinUrl(settings.jellyfin_url) : '',
          auth?.kind === 'configured' ? auth.serverId : null,
          settings.new_subscriber_source ?? 'trusted_messages',
        ]),
      )
      .digest('hex');
  }
  private read(): ActivationRecord | null {
    const row = this.store.db
      .prepare('SELECT encrypted FROM new_subscriber_policy WHERE id=1')
      .get();
    if (!row) return null;
    const value = this.store.decrypt<ActivationRecord>(row.encrypted as Uint8Array);
    if (
      !value ||
      typeof value.scope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.scope) ||
      typeof value.revision !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.revision) ||
      typeof value.enabled_at !== 'string' ||
      !Number.isFinite(Date.parse(value.enabled_at)) ||
      new Date(value.enabled_at).toISOString() !== value.enabled_at
    )
      throw new ServiceError('The new-subscriber policy could not be verified. Save it again.');
    return value;
  }
  activation(settings: Settings): NewSubscriberActivation | null {
    if (!settings.auto_create_new_subscribers) return null;
    const value = this.read();
    return value?.scope === this.scope(settings)
      ? { enabled_at: value.enabled_at, revision: value.revision }
      : null;
  }
  assertActive(settings: Settings, revision: string): void {
    const current = this.store.settings();
    if (
      !settings.auto_provision ||
      !current.auto_provision ||
      this.activation(settings)?.revision !== revision ||
      this.activation(current)?.revision !== revision
    )
      throw new ServiceError(
        'The new-subscriber policy changed. Review the member before retrying.',
      );
  }
  /** Called synchronously inside the settings SAVEPOINT. Ordinary saves and
   * restarts retain the cutoff; re-enabling or changing server scope starts anew. */
  capture(previous: Settings, settings: Settings): void {
    if (!settings.auto_create_new_subscribers) {
      this.store.db.prepare('DELETE FROM new_subscriber_policy WHERE id=1').run();
      return;
    }
    const existing = previous.auto_create_new_subscribers ? this.read() : null;
    const scope = this.scope(settings);
    if (existing?.scope === scope) return;
    this.store.db
      .prepare('INSERT OR REPLACE INTO new_subscriber_policy (id,encrypted) VALUES (1,?)')
      .run(
        this.store.encrypt({
          scope,
          enabled_at: new Date().toISOString(),
          revision: randomUUID(),
        } satisfies ActivationRecord),
      );
  }
}
