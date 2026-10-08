import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';

export type AccountProfileKind = 'emby' | 'jellyfin';
export interface AccountProfileInput {
  kind: AccountProfileKind;
  user_id: string;
  family: boolean;
  owner_name: string;
  notes: string;
}
/** Administrator-only annotations; account identity and notes are encrypted at rest. */
export interface AccountProfile extends AccountProfileInput {
  revision: string;
}
interface AccountProfileScope {
  server_url: string;
  jellyfin_server_url: string;
  jellyfin_server_id?: string;
}
interface StoredAccountProfile extends AccountProfile, AccountProfileScope {}

const MAX_PROFILES = 20_000;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const NOTE_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    [...value].length <= maximum &&
    !CONTROLS.test(value)
  );
}
function kind(value: unknown): value is AccountProfileKind {
  return value === 'emby' || value === 'jellyfin';
}
function normalizeInput(input: AccountProfileInput): AccountProfileInput {
  if (
    !input ||
    !kind(input.kind) ||
    !text(input.user_id, 128) ||
    typeof input.family !== 'boolean' ||
    typeof input.owner_name !== 'string' ||
    [...input.owner_name].length > 120 ||
    CONTROLS.test(input.owner_name) ||
    typeof input.notes !== 'string' ||
    [...input.notes].length > 2000 ||
    NOTE_CONTROLS.test(input.notes)
  )
    throw new ServiceError('The account profile contains invalid fields.');
  return {
    kind: input.kind,
    user_id: input.user_id,
    family: input.family,
    owner_name: input.owner_name.trim(),
    notes: input.notes.trim(),
  };
}
function scope(
  store: Store,
  accountKind: AccountProfileKind,
  settings: Settings,
): AccountProfileScope | null {
  const mediaUrl = accountKind === 'emby' ? settings.emby_url : settings.jellyfin_url;
  if (!mediaUrl || !settings.jellyfin_url) return null;
  const server_url = normalizeJellyfinUrl(mediaUrl);
  const jellyfin_server_url = normalizeJellyfinUrl(settings.jellyfin_url);
  const auth = store.authState();
  if (auth?.kind === 'configured') {
    if (normalizeJellyfinUrl(auth.serverUrl) !== jellyfin_server_url) return null;
    return { server_url, jellyfin_server_url, jellyfin_server_id: auth.serverId };
  }
  return { server_url, jellyfin_server_url };
}
function recordId(value: AccountProfileScope & { kind: AccountProfileKind; user_id: string }) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.kind,
        value.server_url,
        value.jellyfin_server_url,
        value.jellyfin_server_id ?? null,
        value.user_id,
      ]),
    )
    .digest('hex');
}
function sameScope(value: StoredAccountProfile, current: AccountProfileScope): boolean {
  return (
    value.server_url === current.server_url &&
    value.jellyfin_server_url === current.jellyfin_server_url &&
    value.jellyfin_server_id === current.jellyfin_server_id
  );
}
function publicProfile(value: StoredAccountProfile): AccountProfile {
  return {
    kind: value.kind,
    user_id: value.user_id,
    family: value.family,
    owner_name: value.owner_name,
    notes: value.notes,
    revision: value.revision,
  };
}

/** Profiles are pinned to selected media IDs. Usernames never establish ownership. */
export class AccountProfiles {
  constructor(readonly store: Store) {}

  private record(id: string, value: StoredAccountProfile): StoredAccountProfile {
    const input = normalizeInput(value);
    if (
      !text(value.revision, 128) ||
      value.owner_name !== input.owner_name ||
      value.notes !== input.notes ||
      !text(value.server_url, 2048) ||
      normalizeJellyfinUrl(value.server_url) !== value.server_url ||
      !text(value.jellyfin_server_url, 2048) ||
      normalizeJellyfinUrl(value.jellyfin_server_url) !== value.jellyfin_server_url ||
      (value.kind === 'jellyfin' && value.server_url !== value.jellyfin_server_url) ||
      (value.jellyfin_server_id !== undefined && !text(value.jellyfin_server_id, 256)) ||
      recordId(value) !== id
    )
      throw new ServiceError('The saved account profile contains invalid identity fields.');
    return {
      ...input,
      revision: value.revision,
      server_url: value.server_url,
      jellyfin_server_url: value.jellyfin_server_url,
      ...(value.jellyfin_server_id ? { jellyfin_server_id: value.jellyfin_server_id } : {}),
    };
  }
  private records(): StoredAccountProfile[] {
    const records = this.store.accountProfileRecords<StoredAccountProfile>();
    if (records.length > MAX_PROFILES) throw new ServiceError('Too many saved account profiles.');
    return records.map(({ id, value }) => this.record(id, value));
  }
  get(accountKind: AccountProfileKind, userId: string, settings: Settings): AccountProfile | null {
    if (!kind(accountKind) || !text(userId, 128))
      throw new ServiceError('The account profile contains invalid identity fields.');
    const current = scope(this.store, accountKind, settings);
    if (!current) return null;
    const id = recordId({ ...current, kind: accountKind, user_id: userId });
    const value = this.store.accountProfileRecord<StoredAccountProfile>(id);
    return value ? publicProfile(this.record(id, value)) : null;
  }
  list(settings: Settings): AccountProfile[] {
    const scopes = {
      emby: scope(this.store, 'emby', settings),
      jellyfin: scope(this.store, 'jellyfin', settings),
    };
    if (!scopes.emby && !scopes.jellyfin) return [];
    return this.records()
      .filter((value) => scopes[value.kind] && sameScope(value, scopes[value.kind]!))
      .map(publicProfile)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.user_id.localeCompare(b.user_id));
  }
  save(value: AccountProfileInput, settings: Settings, expectedRevision?: string): AccountProfile {
    const input = normalizeInput(value);
    if (expectedRevision !== undefined && expectedRevision !== '' && !text(expectedRevision, 128))
      throw new ServiceError('The account profile revision is invalid.');
    const current = scope(this.store, input.kind, settings);
    if (!current)
      throw new ServiceError('Configure the selected media server before saving a profile.');
    const id = recordId({ ...current, kind: input.kind, user_id: input.user_id });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const records = this.records();
      const existing = records.find(
        (record) =>
          record.kind === input.kind &&
          record.user_id === input.user_id &&
          sameScope(record, current),
      );
      // An empty revision pins the initial absence, so two editors cannot overwrite a first save.
      if (expectedRevision !== undefined && (existing?.revision ?? '') !== expectedRevision)
        throw new ServiceError('The account profile changed. Reload it before retrying.');
      if (!existing && records.length >= MAX_PROFILES)
        throw new ServiceError('Too many saved account profiles.');
      if (
        existing &&
        existing.family === input.family &&
        existing.owner_name === input.owner_name &&
        existing.notes === input.notes
      ) {
        this.store.db.exec('COMMIT');
        return publicProfile(existing);
      }
      const saved: StoredAccountProfile = { ...input, ...current, revision: randomUUID() };
      this.store.saveAccountProfileRecord(id, saved);
      this.store.db.exec('COMMIT');
      return publicProfile(saved);
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
