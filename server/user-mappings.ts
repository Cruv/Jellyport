import { randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { nameKey } from './identity.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import type { JellyportApp } from './main.js';
import type { MediaAPI, MediaUser } from './media.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';

export interface UserMapping {
  id: string;
  source_server_url: string;
  source_user_id: string;
  source_username: string;
  target_server_url: string;
  target_user_id: string | null;
  target_username: string;
  discord_user_id: string | null;
  discord_username: string | null;
  revision: string;
}
export interface SaveUserMapping {
  id?: string;
  source_user_id: string;
  source_username: string;
  target_user_id: string | null;
  target_username: string;
  discord_user_id: string | null;
  discord_username: string | null;
}
interface MappingRequest {
  id?: string;
  source_user_id: string;
  target_user_id?: string | null;
  target_username?: string;
  discord_user_id?: string | null;
  discord_username?: string | null;
}

const MAX_MAPPINGS = 10_000;
interface MappingCache {
  records: UserMapping[];
  byId: Map<string, UserMapping>;
  bySource: Map<string, UserMapping>;
  byDiscord: Map<string, UserMapping>;
  byTargetId: Map<string, UserMapping>;
  byTargetName: Map<string, UserMapping>;
}
// Shared across the HTTP route and job service; only mapping writes invalidate this index.
const mappingCaches = new WeakMap<Store, MappingCache>();
const identityKey = (servers: [string, string], id: string) => JSON.stringify([...servers, id]);
const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const nullableIdentifier = { anyOf: [{ type: 'null' }, identifier] };
const nullableDiscordId = {
  anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9]{5,22}$' }],
};
const nullableDiscordName = {
  anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 64 }],
};
const mappingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source_user_id'],
  properties: {
    id: identifier,
    source_user_id: identifier,
    target_user_id: nullableIdentifier,
    target_username: { type: 'string', minLength: 1, maxLength: 64 },
    discord_user_id: nullableDiscordId,
    discord_username: nullableDiscordName,
  },
};

function serverPair(settings: Settings): [string, string] | null {
  if (!settings.emby_url || !settings.jellyfin_url) return null;
  return [normalizeJellyfinUrl(settings.emby_url), normalizeJellyfinUrl(settings.jellyfin_url)];
}
function sameServers(mapping: UserMapping, servers: [string, string]): boolean {
  return mapping.source_server_url === servers[0] && mapping.target_server_url === servers[1];
}
function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
export function validateMappingUsername(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    throw new ServiceError(
      'New Jellyfin usernames must be 1–64 letters, numbers, periods, underscores, or hyphens and start with a letter or number.',
    );
  return value;
}
export function validateExistingMappingUsername(value: string): string {
  if (!value || [...value].length > 64 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ServiceError('Existing Jellyfin usernames must be 1–64 printable characters.');
  return value;
}
function validateInput(input: SaveUserMapping): void {
  if (
    (input.id !== undefined && !validIdentifier(input.id)) ||
    !validIdentifier(input.source_user_id) ||
    typeof input.source_username !== 'string' ||
    !input.source_username ||
    (input.target_user_id !== null && !validIdentifier(input.target_user_id)) ||
    typeof input.target_username !== 'string' ||
    !input.target_username ||
    [...input.target_username].length > 64 ||
    /[\u0000-\u001f\u007f]/.test(input.target_username) ||
    (input.discord_user_id !== null && !/^[0-9]{5,22}$/.test(input.discord_user_id)) ||
    (input.discord_username !== null &&
      (typeof input.discord_username !== 'string' ||
        !input.discord_username ||
        [...input.discord_username].length > 64 ||
        /[\u0000-\u001f\u007f]/.test(input.discord_username)))
  )
    throw new ServiceError('The user mapping contains invalid identity fields.');
  if (input.target_user_id === null) validateMappingUsername(input.target_username);
}

/** Explicit administrator decisions, encrypted at rest and scoped to both server URLs. */
export class UserMappings {
  constructor(readonly store: Store) {}

  private all(): UserMapping[] {
    const cached = mappingCaches.get(this.store);
    if (cached) return cached.records;
    const rows = this.store.db.prepare('SELECT id,encrypted FROM user_mappings').all();
    if (rows.length > MAX_MAPPINGS) throw new ServiceError('Too many saved user mappings.');
    const records = rows.map((row) => {
      const value = this.store.decrypt<UserMapping>(row.encrypted as Uint8Array);
      validateInput(value);
      if (value.id !== row.id || !validIdentifier(value.revision))
        throw new Error('Invalid encrypted mapping.');
      // Select fields explicitly so future private metadata cannot leak through this DTO.
      return {
        id: value.id,
        source_server_url: value.source_server_url,
        source_user_id: value.source_user_id,
        source_username: value.source_username,
        target_server_url: value.target_server_url,
        target_user_id: value.target_user_id,
        target_username: value.target_username,
        discord_user_id: value.discord_user_id,
        discord_username: value.discord_username,
        revision: value.revision,
      };
    });
    const cache: MappingCache = {
      records,
      byId: new Map(),
      bySource: new Map(),
      byDiscord: new Map(),
      byTargetId: new Map(),
      byTargetName: new Map(),
    };
    for (const mapping of records) {
      cache.byId.set(mapping.id, mapping);
      const servers: [string, string] = [mapping.source_server_url, mapping.target_server_url];
      const key = identityKey(servers, mapping.source_user_id);
      if (cache.bySource.has(key)) throw new Error('Conflicting encrypted user mappings.');
      cache.bySource.set(key, mapping);
      const targetNameKey = identityKey(servers, nameKey(mapping.target_username));
      if (cache.byTargetName.has(targetNameKey))
        throw new Error('Conflicting encrypted destination mappings.');
      cache.byTargetName.set(targetNameKey, mapping);
      if (mapping.target_user_id) {
        const targetIdKey = identityKey(servers, mapping.target_user_id);
        if (cache.byTargetId.has(targetIdKey))
          throw new Error('Conflicting encrypted destination mappings.');
        cache.byTargetId.set(targetIdKey, mapping);
      }
      if (mapping.discord_user_id) {
        const discordKey = identityKey(servers, mapping.discord_user_id);
        if (cache.byDiscord.has(discordKey))
          throw new Error('Conflicting encrypted Discord mappings.');
        cache.byDiscord.set(discordKey, mapping);
      }
    }
    mappingCaches.set(this.store, cache);
    return records;
  }
  list(settings: Settings): UserMapping[] {
    const servers = serverPair(settings);
    if (!servers) return [];
    return structuredClone(
      this.all()
        .filter((mapping) => sameServers(mapping, servers))
        .sort(
          (a, b) => a.target_username.localeCompare(b.target_username) || a.id.localeCompare(b.id),
        ),
    );
  }
  get(id: string, settings: Settings): UserMapping | null {
    const servers = serverPair(settings);
    if (!servers) return null;
    this.all();
    const mapping = mappingCaches.get(this.store)!.byId.get(id);
    return mapping && sameServers(mapping, servers) ? structuredClone(mapping) : null;
  }
  getForSource(sourceUserId: string, settings: Settings): UserMapping | null {
    const servers = serverPair(settings);
    if (!servers) return null;
    this.all();
    const mapping = mappingCaches.get(this.store)!.bySource.get(identityKey(servers, sourceUserId));
    return mapping ? structuredClone(mapping) : null;
  }
  getForDiscord(discordUserId: string, settings: Settings): UserMapping | null {
    const servers = serverPair(settings);
    if (!servers) return null;
    this.all();
    const mapping = mappingCaches
      .get(this.store)!
      .byDiscord.get(identityKey(servers, discordUserId));
    return mapping ? structuredClone(mapping) : null;
  }
  getForTarget(
    targetId: string | null,
    targetName: string,
    settings: Settings,
  ): UserMapping | null {
    const servers = serverPair(settings);
    if (!servers) return null;
    this.all();
    const cache = mappingCaches.get(this.store)!;
    const byId = targetId ? cache.byTargetId.get(identityKey(servers, targetId)) : undefined;
    const byName = cache.byTargetName.get(identityKey(servers, nameKey(targetName)));
    if (byId && byName && byId.id !== byName.id)
      throw new ServiceError('Conflicting destination mappings require administrator review.');
    const mapping = byId ?? byName;
    return mapping ? structuredClone(mapping) : null;
  }
  private checkLinks(mapping: SaveUserMapping): void {
    if (!mapping.discord_user_id) return;
    const byDiscord = this.store.link(mapping.discord_user_id);
    const byTarget = mapping.target_user_id
      ? this.store.linkForRemote(mapping.target_user_id)
      : null;
    if (
      (byDiscord &&
        (byDiscord.remote_id !== mapping.target_user_id ||
          byDiscord.username !== mapping.target_username)) ||
      (byTarget && byTarget.discord_user_id !== mapping.discord_user_id)
    )
      throw new ServiceError(
        'This Discord identity or Jellyfin account already has a different identity link. Existing ownership was preserved.',
      );
  }
  save(input: SaveUserMapping, settings: Settings, expectedRevision?: string): UserMapping {
    validateInput(input);
    const servers = serverPair(settings);
    if (!servers)
      throw new ServiceError('Configure both media servers before creating user mappings.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const all = this.all();
      const active = all.filter((mapping) => sameServers(mapping, servers));
      if (input.id && !active.some((mapping) => mapping.id === input.id))
        throw new ServiceError('This user mapping no longer exists for the configured servers.');
      if (
        expectedRevision &&
        active.find((mapping) => mapping.id === input.id)?.revision !== expectedRevision
      )
        throw new ServiceError(
          'The user mapping changed. Review it before retrying the migration.',
        );
      if (!input.id && all.length >= MAX_MAPPINGS)
        throw new ServiceError('Too many saved user mappings.');
      for (const mapping of active) {
        if (mapping.id === input.id) continue;
        if (mapping.source_user_id === input.source_user_id)
          throw new ServiceError('This Emby user already has a saved mapping. Edit that mapping.');
        if (
          (input.target_user_id && mapping.target_user_id === input.target_user_id) ||
          nameKey(mapping.target_username) === nameKey(input.target_username)
        )
          throw new ServiceError(
            'This Jellyfin account or username is already mapped to another Emby user.',
          );
        if (input.discord_user_id && mapping.discord_user_id === input.discord_user_id)
          throw new ServiceError('This Discord user is already mapped to another Emby user.');
      }
      this.checkLinks(input);
      const mapping: UserMapping = {
        id: input.id ?? randomUUID(),
        source_server_url: servers[0],
        source_user_id: input.source_user_id,
        source_username: input.source_username,
        target_server_url: servers[1],
        target_user_id: input.target_user_id,
        target_username: input.target_username,
        discord_user_id: input.discord_user_id,
        discord_username: input.discord_username,
        revision: randomUUID(),
      };
      this.store.db
        .prepare('INSERT OR REPLACE INTO user_mappings (id,encrypted) VALUES (?,?)')
        .run(mapping.id, this.store.encrypt(mapping));
      this.store.db.exec('COMMIT');
      mappingCaches.delete(this.store);
      return mapping;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Pin a newly created account so later name reuse cannot redirect a mapping. */
  bindTarget(
    id: string,
    expectedRevision: string,
    targetId: string,
    settings: Settings,
  ): UserMapping {
    const mapping = this.get(id, settings);
    if (!mapping || mapping.revision !== expectedRevision)
      throw new ServiceError('The user mapping changed. Review it before retrying the migration.');
    if (mapping.target_user_id && mapping.target_user_id !== targetId)
      throw new ServiceError(
        'The mapped Jellyfin account changed. Existing ownership was preserved.',
      );
    if (mapping.target_user_id === targetId) return mapping;
    return this.save({ ...mapping, target_user_id: targetId }, settings, expectedRevision);
  }
  delete(id: string, settings: Settings): void {
    const mapping = this.get(id, settings);
    if (!mapping)
      throw new ServiceError('This user mapping no longer exists for the configured servers.');
    this.store.db.prepare('DELETE FROM user_mappings WHERE id=?').run(mapping.id);
    mappingCaches.delete(this.store);
  }
}

function eligibleTarget(target: MediaUser, templateId: string): boolean {
  return (
    target.Id !== templateId &&
    target.Policy?.IsAdministrator === false &&
    target.Policy?.IsDisabled === false
  );
}
function assertCurrentSettings(store: Store, settings: Settings): void {
  const current = store.settings();
  if (
    JSON.stringify(serverPair(current)) !== JSON.stringify(serverPair(settings)) ||
    current.template_user_id !== settings.template_user_id
  )
    throw new ServiceError('Server configuration changed. Reload the mapping and try again.');
}

/** Register before app.ready(); the app's central authentication and CSRF hooks protect these routes. */
export function registerUserMappingRoutes(app: JellyportApp): void {
  const { store, service } = app.jellyport;
  const mappings = new UserMappings(store);
  app.get('/api/user-mappings', async () => ({ mappings: mappings.list(store.settings()) }));
  app.post<{ Body: MappingRequest }>(
    '/api/user-mappings',
    { schema: { body: mappingSchema } },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo user mappings are read-only.');
      const settings = store.settings();
      const input = request.body;
      const emby = service.client(settings, 'emby');
      let jellyfin: MediaAPI | undefined;
      try {
        jellyfin = service.client(settings, 'jellyfin');
        const source = await emby.user(input.source_user_id);
        if (source.Id !== input.source_user_id)
          throw new ServiceError('Emby returned a different user. Reload the user list.');
        let targetId: string | null = input.target_user_id ?? null;
        let targetName: string;
        if (targetId) {
          const target = await jellyfin.user(targetId);
          if (target.Id !== targetId || !eligibleTarget(target, settings.template_user_id))
            throw new ServiceError(
              'Choose an enabled Jellyfin user other than an administrator or your template.',
            );
          if (input.target_username !== undefined && input.target_username !== target.Name)
            throw new ServiceError(
              'Selecting an existing Jellyfin account preserves its current username.',
            );
          targetName = target.Name;
          validateExistingMappingUsername(targetName);
        } else {
          targetName = validateMappingUsername(input.target_username ?? '');
          const users = await jellyfin.users();
          if (users.some((target) => nameKey(target.Name) === nameKey(targetName)))
            throw new ServiceError(
              'That Jellyfin username already exists. Select its existing account explicitly.',
            );
        }
        const discordId = input.discord_user_id ?? null;
        let discordName = input.discord_username ?? null;
        if (discordId) {
          if (!service.bot)
            throw new ServiceError('Connect the Discord bot before mapping a Discord user ID.');
          let identity: { id?: string; username: string };
          try {
            identity = await service.bot.recipientIdentity(discordId, false);
          } catch {
            throw new ServiceError(
              'The Discord identity could not be verified. Check bot access and server membership.',
            );
          }
          if ((identity.id && identity.id !== discordId) || !identity.username)
            throw new ServiceError('Discord returned a different identity. Reload and try again.');
          if (discordName !== null && discordName !== identity.username)
            throw new ServiceError(
              'The Discord username must match the verified username for that user ID.',
            );
          discordName = identity.username;
        }
        assertCurrentSettings(store, settings);
        return mappings.save(
          {
            ...(input.id ? { id: input.id } : {}),
            source_user_id: source.Id,
            source_username: source.Name,
            target_user_id: targetId,
            target_username: targetName,
            discord_user_id: discordId,
            discord_username: discordName,
          },
          settings,
        );
      } finally {
        await Promise.allSettled([emby.close(), ...(jellyfin ? [jellyfin.close()] : [])]);
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/user-mappings/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: identifier },
        },
      },
    },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo user mappings are read-only.');
      mappings.delete(request.params.id, store.settings());
      return { deleted: true };
    },
  );
}
