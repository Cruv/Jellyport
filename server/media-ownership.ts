import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { Settings } from './types.js';
import type { IdentityException, IdentityMediaKind } from './identity-review-types.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import { ServiceError } from './errors.js';

export interface MediaOwnership {
  scope: string;
  kind: IdentityMediaKind;
  server_id: string;
  account_id: string;
  username: string;
  discord_user_id: string;
  slot: number;
  approved_at: string;
}
interface ExceptionRecord {
  scope: string;
  row_id: string;
  value: IdentityException;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Reviewed ownership of existing accounts; no creation, billing or migration authority. */
export class MediaOwnerships {
  constructor(readonly store: Store) {}
  scope(settings: Settings): string {
    const auth = this.store.authState();
    return hash([
      settings.discord_guild_id ?? '',
      settings.emby_url ? normalizeJellyfinUrl(settings.emby_url) : '',
      settings.jellyfin_url ? normalizeJellyfinUrl(settings.jellyfin_url) : '',
      auth?.kind === 'configured' ? auth.serverId : null,
    ]);
  }
  list(settings: Settings, servers?: Partial<Record<IdentityMediaKind, string>>): MediaOwnership[] {
    const scope = this.scope(settings);
    const rows = this.store.db.prepare('SELECT encrypted FROM media_ownership').all();
    if (rows.length > 20_000) throw new ServiceError('Too many saved media ownership records.');
    return rows
      .map((row) => this.store.decrypt<MediaOwnership>(row.encrypted as Uint8Array))
      .filter((row) => row.scope === scope && (!servers || servers[row.kind] === row.server_id));
  }
  /** Hot migration guards authenticate only the selected account, without
   * decrypting the complete identity directory for every played-state write. */
  get(
    kind: IdentityMediaKind,
    serverId: string,
    accountId: string,
    settings: Settings,
  ): MediaOwnership | null {
    const scope = this.scope(settings);
    const row = this.store.db
      .prepare('SELECT encrypted FROM media_ownership WHERE id=?')
      .get(hash([scope, kind, serverId, accountId]));
    if (!row) return null;
    const value = this.store.decrypt<MediaOwnership>(row.encrypted as Uint8Array);
    if (
      value.scope !== scope ||
      value.kind !== kind ||
      value.server_id !== serverId ||
      value.account_id !== accountId
    )
      throw new ServiceError('The saved media ownership identity could not be authenticated.');
    return value;
  }
  /** Caller preflights exact IDs/names, scope and all conflicts before opening its transaction. */
  save(records: Omit<MediaOwnership, 'scope' | 'approved_at'>[], settings: Settings): void {
    const scope = this.scope(settings);
    const save = this.store.db.prepare('INSERT OR REPLACE INTO media_ownership VALUES (?,?)');
    for (const record of records) {
      if (
        !['emby', 'jellyfin'].includes(record.kind) ||
        !record.account_id ||
        !record.server_id ||
        !record.username ||
        !/^[1-9][0-9]{0,19}$/.test(record.discord_user_id) ||
        !Number.isInteger(record.slot) ||
        record.slot < 1 ||
        record.slot > 3
      )
        throw new ServiceError('Select a valid existing account, Discord owner and account slot.');
      const value: MediaOwnership = { ...record, scope, approved_at: new Date().toISOString() };
      save.run(
        hash([scope, record.kind, record.server_id, record.account_id]),
        this.store.encrypt(value),
      );
    }
  }
  exceptions(settings: Settings): Map<string, IdentityException> {
    const scope = this.scope(settings);
    const result = new Map<string, IdentityException>();
    const rows = this.store.db.prepare('SELECT encrypted FROM identity_review_exceptions').all();
    if (rows.length > 20_000) throw new ServiceError('Too many saved access review annotations.');
    for (const row of rows) {
      const value = this.store.decrypt<ExceptionRecord>(row.encrypted as Uint8Array);
      if (value.scope === scope) result.set(value.row_id, value.value);
    }
    return result;
  }
  annotate(rowId: string, value: IdentityException | null, settings: Settings): void {
    const scope = this.scope(settings);
    const id = hash([scope, rowId]);
    if (value === null) {
      this.store.db.prepare('DELETE FROM identity_review_exceptions WHERE id=?').run(id);
      return;
    }
    if (
      !['non_media', 'complimentary', 'approved'].includes(value.kind) ||
      typeof value.note !== 'string' ||
      value.note.trim().length < 1 ||
      value.note.length > 1000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.note)
    )
      throw new ServiceError('Choose an exception type and a private note of 1–1,000 characters.');
    this.store.db
      .prepare('INSERT OR REPLACE INTO identity_review_exceptions VALUES (?,?)')
      .run(id, this.store.encrypt({ scope, row_id: rowId, value } satisfies ExceptionRecord));
  }
}
