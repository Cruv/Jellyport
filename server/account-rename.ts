import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ServiceError } from './errors.js';
import { nameKey } from './identity.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import type { AccountRoles } from './account-roles.js';
import { AccountProfiles } from './account-profiles.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';
import type { UserMappings } from './user-mappings.js';

export interface RenameInput {
  user_id: string;
  old_username: string;
  username: string;
  configuration_hash: string;
  server_id: string;
}
export interface RenamePin extends RenameInput {
  server_url: string;
  status: 'uncertain';
  revision: string;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function username(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function recordId(serverUrl: string, serverId: string, userId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([serverUrl, serverId, userId]))
    .digest('hex');
}
function validInput(input: RenameInput): void {
  if (
    !input ||
    !identifier(input.user_id) ||
    !identifier(input.server_id) ||
    !username(input.old_username) ||
    !username(input.username) ||
    input.username !== input.username.trim() ||
    /[\\/<>]/.test(input.username) ||
    !/^[a-f0-9]{64}$/.test(input.configuration_hash)
  )
    throw new ServiceError('The account rename contains invalid identity fields.');
}

/** Pins an uncertain remote rename before POST, then reconciles local identity atomically. */
export class AccountRenames {
  constructor(
    readonly store: Store,
    readonly mappings: UserMappings,
    readonly roles: AccountRoles,
  ) {}

  private scope(settings: Settings, serverId?: string): { server_url: string; server_id: string } {
    const auth = this.store.authState();
    const current = this.store.settings();
    const url = normalizeJellyfinUrl(settings.jellyfin_url);
    if (
      auth?.kind !== 'configured' ||
      normalizeJellyfinUrl(auth.serverUrl) !== url ||
      normalizeJellyfinUrl(current.jellyfin_url) !== url ||
      current.jellyfin_api_key !== settings.jellyfin_api_key ||
      current.template_user_id !== settings.template_user_id ||
      (serverId !== undefined && auth.serverId !== serverId)
    )
      throw new ServiceError('The Jellyfin server changed. Reload the account before renaming it.');
    return { server_url: url, server_id: auth.serverId };
  }

  get(userId: string, settings: Settings): RenamePin | null {
    if (!identifier(userId)) throw new ServiceError('The account rename identity is invalid.');
    const scope = this.scope(settings);
    const pin = this.store.accountRenameRecord<RenamePin>(
      recordId(scope.server_url, scope.server_id, userId),
    );
    if (!pin) return null;
    validInput(pin);
    if (
      pin.server_url !== scope.server_url ||
      pin.server_id !== scope.server_id ||
      pin.user_id !== userId ||
      pin.status !== 'uncertain' ||
      !identifier(pin.revision)
    )
      throw new ServiceError('The saved account rename identity is invalid.');
    return pin;
  }

  private assertAvailable(input: RenameInput, settings: Settings): void {
    const scope = this.scope(settings, input.server_id);
    const oldKey = nameKey(input.old_username),
      newKey = nameKey(input.username);
    const original = this.store.account(input.old_username);
    const destination = this.store.account(input.username);
    if (
      (original && original.remote_id !== input.user_id) ||
      (destination && destination.remote_id !== input.user_id)
    )
      throw new ServiceError('An existing account creation record conflicts with this rename.');
    for (const link of this.store.links()) {
      if (
        link.remote_id === input.user_id &&
        ![input.old_username, input.username].includes(link.username)
      )
        throw new ServiceError('The account identity link changed. Review it before renaming.');
      if (link.remote_id !== input.user_id && nameKey(link.username) === newKey)
        throw new ServiceError('Another identity link already uses this account name.');
    }
    const mappings = this.mappings.list(settings);
    if (
      mappings.some((mapping) =>
        mapping.target_user_id === input.user_id
          ? ![input.old_username, input.username].includes(mapping.target_username)
          : nameKey(mapping.target_username) === newKey,
      )
    )
      throw new ServiceError('A conflicting user mapping prevents this account rename.');
    const assignment = this.roles.getAssignment(input.user_id, settings);
    if (assignment && ![input.old_username, input.username].includes(assignment.username))
      throw new ServiceError(
        'The role assignment changed. Review it before renaming this account.',
      );
    const corroborated =
      mappings.some(
        (mapping) =>
          mapping.target_user_id === input.user_id &&
          [input.old_username, input.username].includes(mapping.target_username),
      ) ||
      Boolean(assignment) ||
      Boolean(new AccountProfiles(this.store).get('jellyfin', input.user_id, settings));
    const assertBinding = (
      kind: 'account' | 'link',
      key: string,
      recordUsername: string,
      remoteId: string | null,
    ) => {
      const binding = this.store.accountIdentityBinding(kind, key);
      if (
        binding &&
        (binding.server_url !== scope.server_url ||
          binding.server_id !== scope.server_id ||
          binding.remote_id !== remoteId ||
          binding.username !== recordUsername)
      )
        throw new ServiceError(
          'An account record is bound to a different Jellyfin server or identity. Inspect the saved account records before renaming.',
        );
      if (!binding && !corroborated)
        throw new ServiceError(
          'This legacy account record has no verified binding to the current Jellyfin server. Verify and save its user mapping before renaming.',
        );
    };
    if (original) assertBinding('account', oldKey, original.username, original.remote_id);
    if (destination && newKey !== oldKey)
      assertBinding('account', newKey, destination.username, destination.remote_id);
    const link = this.store.linkForRemote(input.user_id);
    if (link) assertBinding('link', link.remote_id, link.username, link.remote_id);
    // Credentials are one-time owner data. Do not silently delete or rewrite the
    // captured message/password merely to make a rename succeed.
    // Captured messages may use the public sign-in URL instead of the internal
    // service URL. The old table has no stable server ID, so protect every live
    // credential record for either name rather than infer ownership from a URL.
    for (const row of this.store.db
      .prepare('SELECT username FROM credentials WHERE expires>?')
      .iterate(Date.now() / 1000)) {
      if (![oldKey, newKey].includes(nameKey(String(row.username)))) continue;
      throw new ServiceError(
        'Reveal the pending account credentials before renaming this account.',
      );
    }
  }

  prepare(input: RenameInput, settings: Settings): RenamePin {
    validInput(input);
    const scope = this.scope(settings, input.server_id);
    this.store.db.exec('SAVEPOINT jellyport_prepare_rename');
    try {
      if (this.get(input.user_id, settings))
        throw new ServiceError(
          'An earlier rename outcome is uncertain. Inspect the account before retrying.',
        );
      this.assertAvailable(input, settings);
      const pin: RenamePin = { ...input, ...scope, status: 'uncertain', revision: randomUUID() };
      this.store.saveAccountRenameRecord(
        recordId(scope.server_url, scope.server_id, input.user_id),
        pin,
      );
      this.store.db.exec('RELEASE jellyport_prepare_rename');
      return structuredClone(pin);
    } catch (error) {
      this.store.db.exec('ROLLBACK TO jellyport_prepare_rename; RELEASE jellyport_prepare_rename');
      throw error;
    }
  }

  commit(
    pin: RenamePin,
    settings: Settings,
  ): { user_id: string; username: string; previous_username: string } {
    validInput(pin);
    this.store.db.exec('SAVEPOINT jellyport_commit_rename');
    try {
      if (!isDeepStrictEqual(this.get(pin.user_id, settings), pin))
        throw new ServiceError('The saved rename changed. Inspect the account before retrying.');
      this.assertAvailable(pin, settings);
      this.mappings.renameTarget(pin.user_id, pin.old_username, pin.username, settings);
      this.roles.renameAssignment(pin.user_id, pin.old_username, pin.username, settings);
      this.store.db
        .prepare('UPDATE links SET username=? WHERE remote_id=? AND username=?')
        .run(pin.username, pin.user_id, pin.old_username);
      if (this.store.linkForRemote(pin.user_id))
        this.store.saveAccountIdentityBinding('link', pin.user_id, pin.user_id, pin.username);
      const originalAccount = this.store.account(pin.old_username);
      this.store.db
        .prepare('UPDATE accounts SET name_key=?,username=? WHERE remote_id=? AND name_key=?')
        .run(nameKey(pin.username), pin.username, pin.user_id, nameKey(pin.old_username));
      if (originalAccount) {
        this.store.deleteAccountIdentityBinding('account', nameKey(pin.old_username));
        this.store.saveAccountIdentityBinding(
          'account',
          nameKey(pin.username),
          pin.user_id,
          pin.username,
        );
      }
      this.store.deleteAccountRenameRecord(recordId(pin.server_url, pin.server_id, pin.user_id));
      this.store.db.exec('RELEASE jellyport_commit_rename');
      return { user_id: pin.user_id, username: pin.username, previous_username: pin.old_username };
    } catch (error) {
      this.store.db.exec('ROLLBACK TO jellyport_commit_rename; RELEASE jellyport_commit_rename');
      throw error;
    } finally {
      // A rolled-back write must not leave the shared mapping index pointing at
      // data that existed only inside this transaction.
      this.mappings.invalidateCache();
    }
  }
}
