import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { nameKey } from './identity.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import {
  captureRoleParameters,
  validateRoleParameters,
  type RoleParameters,
  type RoleSection,
} from './role-parameters.js';
import type { JellyportApp } from './main.js';
import type { MediaAPI, MediaUser } from './media.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';

export interface AccountRole {
  id: string;
  name: string;
  revision: string;
  server_url: string;
  server_id: string;
  parameters: RoleParameters;
  updated_at: string;
}
export interface RoleAssignment {
  user_id: string;
  username: string;
  role_id: string;
  revision: string;
  applied_revision: string | null;
  applied_sections: Partial<Record<RoleSection, string>>;
  updated_at: string;
  server_url: string;
  server_id: string;
}
export interface SaveAccountRole {
  id?: string;
  revision?: string;
  name: string;
  parameters: RoleParameters;
}
interface ServerScope {
  server_url: string;
  server_id: string;
}
const MAX_ROLES = 100;
const MAX_ASSIGNMENTS = 10_000;
const MAX_BATCH = 100;
const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const revisionSchema = {
  type: 'string',
  pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
};
const roleIdSchema = revisionSchema;
const userIdsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_BATCH,
  uniqueItems: true,
  items: identifier,
};
const emptyQuery = { type: 'object', additionalProperties: false, properties: {} };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function validUsername(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function validServerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return normalizeJellyfinUrl(value) === value;
  } catch {
    return false;
  }
}
function roleName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value.trim()].length > 64 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new ServiceError('Role names must contain 1–64 printable characters.');
  return value.trim();
}
function sameScope(value: ServerScope, scope: ServerScope): boolean {
  return value.server_url === scope.server_url && value.server_id === scope.server_id;
}
function assignmentId(scope: ServerScope, userId: string): string {
  // User identities and server names remain inside encrypted records.
  return createHash('sha256')
    .update(JSON.stringify([scope.server_url, scope.server_id, userId]))
    .digest('hex');
}
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
}

/** Saved snapshots are independent of their import account and scoped to a bound Jellyfin server. */
export class AccountRoles {
  constructor(
    readonly store: Store,
    readonly demo = false,
  ) {}

  private scope(settings: Settings): ServerScope | null {
    if (!settings.jellyfin_url) return null;
    const url = normalizeJellyfinUrl(settings.jellyfin_url);
    const auth = this.store.authState();
    if (auth?.kind === 'configured' && normalizeJellyfinUrl(auth.serverUrl) === url)
      return { server_url: url, server_id: auth.serverId };
    if (this.demo && !auth) return { server_url: url, server_id: 'demo-jellyfin' };
    return null;
  }
  private requiredScope(settings: Settings): ServerScope {
    const scope = this.scope(settings);
    if (!scope)
      throw new ServiceError('Connect and authenticate the Jellyfin server before managing roles.');
    const current = this.scope(this.store.settings());
    if (!current || !sameScope(scope, current))
      throw new ServiceError(
        'The Jellyfin server configuration changed. Reload roles and try again.',
      );
    return scope;
  }
  private roleRecords(): AccountRole[] {
    const count = this.store.db.prepare('SELECT COUNT(*) AS count FROM account_roles').get()?.count;
    if (typeof count !== 'number' || count > MAX_ROLES)
      throw new ServiceError('Too many saved account roles.');
    return this.store.accountRoleRecords<AccountRole>().map(({ id, value }) => {
      if (
        !UUID.test(value.id) ||
        id !== value.id ||
        !UUID.test(value.revision) ||
        !validIdentifier(value.server_id) ||
        !validServerUrl(value.server_url) ||
        !isTimestamp(value.updated_at)
      )
        throw new Error('Invalid encrypted account role.');
      roleName(value.name);
      validateRoleParameters(value.parameters);
      return {
        id: value.id,
        name: value.name,
        revision: value.revision,
        server_url: value.server_url,
        server_id: value.server_id,
        parameters: structuredClone(value.parameters),
        updated_at: value.updated_at,
      };
    });
  }
  private assignmentRecords(): RoleAssignment[] {
    const count = this.store.db
      .prepare('SELECT COUNT(*) AS count FROM account_role_assignments')
      .get()?.count;
    if (typeof count !== 'number' || count > MAX_ASSIGNMENTS)
      throw new ServiceError('Too many saved role assignments.');
    return this.store.accountRoleAssignmentRecords<RoleAssignment>().map(({ id, value }) => {
      if (
        !validIdentifier(value.user_id) ||
        !validUsername(value.username) ||
        !UUID.test(value.role_id) ||
        !UUID.test(value.revision) ||
        (value.applied_revision !== null && !UUID.test(value.applied_revision)) ||
        !validIdentifier(value.server_id) ||
        !validServerUrl(value.server_url) ||
        !isTimestamp(value.updated_at) ||
        id !== assignmentId(value, value.user_id)
      )
        throw new Error('Invalid encrypted role assignment.');
      const appliedSections = value.applied_sections ?? {};
      if (
        !appliedSections ||
        typeof appliedSections !== 'object' ||
        Array.isArray(appliedSections) ||
        Object.entries(appliedSections).some(
          ([section, revision]) =>
            !['policy', 'configuration', 'display'].includes(section) ||
            typeof revision !== 'string' ||
            !UUID.test(revision),
        )
      )
        throw new Error('Invalid encrypted role application state.');
      return {
        user_id: value.user_id,
        username: value.username,
        role_id: value.role_id,
        revision: value.revision,
        applied_revision: value.applied_revision,
        applied_sections: structuredClone(appliedSections),
        updated_at: value.updated_at,
        server_url: value.server_url,
        server_id: value.server_id,
      };
    });
  }
  list(settings: Settings): AccountRole[] {
    const scope = this.scope(settings);
    return scope
      ? structuredClone(
          this.roleRecords()
            .filter((role) => sameScope(role, scope))
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        )
      : [];
  }
  assignments(settings: Settings): RoleAssignment[] {
    const scope = this.scope(settings);
    return scope
      ? structuredClone(
          this.assignmentRecords()
            .filter((assignment) => sameScope(assignment, scope))
            .sort(
              (a, b) => a.username.localeCompare(b.username) || a.user_id.localeCompare(b.user_id),
            ),
        )
      : [];
  }
  get(id: string, settings: Settings): AccountRole | null {
    return this.list(settings).find((role) => role.id === id) ?? null;
  }
  getAssignment(userId: string, settings: Settings): RoleAssignment | null {
    return this.assignments(settings).find((assignment) => assignment.user_id === userId) ?? null;
  }
  private transaction<T>(callback: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  save(input: SaveAccountRole, settings: Settings): AccountRole {
    const name = roleName(input.name);
    validateRoleParameters(input.parameters);
    if (
      (input.id !== undefined && !UUID.test(input.id)) ||
      (input.revision !== undefined && !UUID.test(input.revision)) ||
      (!input.id && input.revision)
    )
      throw new ServiceError('The role identifier or revision is invalid.');
    return this.transaction(() => {
      const scope = this.requiredScope(settings);
      const all = this.roleRecords();
      const active = all.filter((role) => sameScope(role, scope));
      const existing = active.find((role) => role.id === input.id);
      if (input.id && (!existing || input.revision !== existing.revision))
        throw new ServiceError('This role changed or no longer exists. Reload it before saving.');
      if (!existing && all.length >= MAX_ROLES)
        throw new ServiceError('Jellyport supports up to 100 saved roles.');
      if (active.some((role) => role.id !== existing?.id && nameKey(role.name) === nameKey(name)))
        throw new ServiceError('A role with this name already exists. Choose a different name.');
      const role: AccountRole = {
        id: existing?.id ?? randomUUID(),
        name,
        revision: randomUUID(),
        ...scope,
        parameters: structuredClone(input.parameters),
        updated_at: new Date().toISOString(),
      };
      this.store.saveAccountRoleRecord(role.id, role);
      return structuredClone(role);
    });
  }
  remove(id: string, revision: string, settings: Settings): void {
    this.transaction(() => {
      this.requiredScope(settings);
      const role = this.get(id, settings);
      if (!role || role.revision !== revision)
        throw new ServiceError('This role changed or no longer exists. Reload it before deleting.');
      if (this.store.settings().default_role_id === id)
        throw new ServiceError('Choose a different default role before deleting this role.');
      if (this.assignments(settings).some((assignment) => assignment.role_id === id))
        throw new ServiceError('Unassign this role from its users before deleting it.');
      this.store.deleteAccountRoleRecord(id);
    });
  }
  assign(
    roleId: string,
    roleRevision: string,
    users: Array<Pick<MediaUser, 'Id' | 'Name'>>,
    settings: Settings,
  ): RoleAssignment[] {
    if (
      !users.length ||
      users.length > MAX_BATCH ||
      new Set(users.map((user) => user.Id)).size !== users.length ||
      users.some(
        (user) =>
          !validIdentifier(user.Id) ||
          !validUsername(user.Name) ||
          user.Id === settings.template_user_id,
      )
    )
      throw new ServiceError(
        'Choose up to 100 distinct Jellyfin accounts other than the template.',
      );
    return this.transaction(() => {
      const scope = this.requiredScope(settings);
      if (users.some((user) => user.Id === this.store.settings().template_user_id))
        throw new ServiceError(
          'The template account changed. Reload users before assigning roles.',
        );
      const role = this.get(roleId, settings);
      if (!role || role.revision !== roleRevision)
        throw new ServiceError(
          'This role changed or no longer exists. Reload it before assigning users.',
        );
      const all = this.assignmentRecords();
      const existing = new Map(
        all
          .filter((assignment) => sameScope(assignment, scope))
          .map((assignment) => [assignment.user_id, assignment]),
      );
      if (all.length + users.filter((user) => !existing.has(user.Id)).length > MAX_ASSIGNMENTS)
        throw new ServiceError('Too many saved role assignments.');
      return users.map((user) => {
        const previous = existing.get(user.Id);
        if (previous?.role_id === role.id && previous.username === user.Name)
          return structuredClone(previous);
        const assignment: RoleAssignment = {
          user_id: user.Id,
          username: user.Name,
          role_id: role.id,
          revision: randomUUID(),
          applied_revision: previous?.role_id === role.id ? previous.applied_revision : null,
          applied_sections: previous?.role_id === role.id ? previous.applied_sections : {},
          updated_at: new Date().toISOString(),
          ...scope,
        };
        this.store.saveAccountRoleAssignmentRecord(assignmentId(scope, user.Id), assignment);
        return structuredClone(assignment);
      });
    });
  }
  unassign(userIds: string[], settings: Settings): void {
    if (
      !userIds.length ||
      userIds.length > MAX_BATCH ||
      new Set(userIds).size !== userIds.length ||
      userIds.some((id) => !validIdentifier(id))
    )
      throw new ServiceError('Choose up to 100 distinct Jellyfin users.');
    this.transaction(() => {
      const scope = this.requiredScope(settings);
      for (const userId of userIds)
        this.store.deleteAccountRoleAssignmentRecord(assignmentId(scope, userId));
    });
  }
  markApplied(
    userId: string,
    roleId: string,
    roleRevision: string,
    assignmentRevision: string,
    settings: Settings,
    sections: RoleSection[],
  ): RoleAssignment {
    if (
      !sections.length ||
      new Set(sections).size !== sections.length ||
      sections.some((section) => !['policy', 'configuration', 'display'].includes(section))
    )
      throw new ServiceError('Choose one or more distinct role parameter sections.');
    return this.transaction(() => {
      const scope = this.requiredScope(settings);
      const role = this.get(roleId, settings);
      const assignment = this.getAssignment(userId, settings);
      if (
        !role ||
        role.revision !== roleRevision ||
        !assignment ||
        assignment.role_id !== roleId ||
        assignment.revision !== assignmentRevision
      )
        throw new ServiceError(
          'This role or assignment changed during the update. Review the account before retrying.',
        );
      if (sections.includes('display') && role.parameters.display === null)
        throw new ServiceError('This role does not contain Home screen preferences.');
      const appliedSections = { ...assignment.applied_sections };
      for (const section of sections) appliedSections[section] = roleRevision;
      const complete =
        appliedSections.policy === roleRevision &&
        appliedSections.configuration === roleRevision &&
        (role.parameters.display === null || appliedSections.display === roleRevision);
      const updated = {
        ...assignment,
        applied_revision: complete ? roleRevision : null,
        applied_sections: appliedSections,
        updated_at: new Date().toISOString(),
      };
      this.store.saveAccountRoleAssignmentRecord(assignmentId(scope, userId), updated);
      return updated;
    });
  }
}

function assertCurrentSettings(store: Store, settings: Settings, authId: string): void {
  const current = store.settings();
  const auth = store.authState();
  if (
    normalizeJellyfinUrl(current.jellyfin_url) !== normalizeJellyfinUrl(settings.jellyfin_url) ||
    current.template_user_id !== settings.template_user_id ||
    current.jellyfin_api_key !== settings.jellyfin_api_key ||
    auth?.kind !== 'configured' ||
    auth.serverId !== authId ||
    normalizeJellyfinUrl(auth.serverUrl) !== normalizeJellyfinUrl(settings.jellyfin_url)
  )
    throw new ServiceError(
      'The Jellyfin server configuration changed. Reload roles and try again.',
    );
}
async function verifyServer(client: MediaAPI, store: Store, settings: Settings): Promise<string> {
  const auth = store.authState();
  if (
    auth?.kind !== 'configured' ||
    normalizeJellyfinUrl(auth.serverUrl) !== normalizeJellyfinUrl(settings.jellyfin_url)
  )
    throw new ServiceError('Connect and authenticate the Jellyfin server before managing roles.');
  const info = await client.systemInfo();
  if (info.Id !== auth.serverId)
    throw new ServiceError(
      'Jellyfin returned a different server. Reconnect the intended server before managing roles.',
    );
  return auth.serverId;
}

/** All routes use the application's central administrator authentication and CSRF hooks. */
export function registerAccountRoleRoutes(app: JellyportApp): void {
  const { store, service } = app.jellyport;
  const roles = new AccountRoles(store, service.demo);
  app.get('/api/account-roles', { schema: { querystring: emptyQuery } }, async () => {
    const settings = store.settings();
    return { roles: roles.list(settings), assignments: roles.assignments(settings) };
  });
  app.post<{ Body: { user_id: string } }>(
    '/api/account-roles/import',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['user_id'],
          properties: { user_id: identifier },
        },
      },
    },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo roles are read-only.');
      const settings = store.settings();
      const client = service.client(settings, 'jellyfin');
      try {
        const serverId = await verifyServer(client, store, settings);
        const user = await client.user(request.body.user_id);
        if (
          user.Id !== request.body.user_id ||
          user.Policy?.IsAdministrator !== false ||
          user.Policy?.IsDisabled !== false
        )
          throw new ServiceError(
            'Choose an enabled non-administrator Jellyfin account as the role source.',
          );
        let display = null;
        let unavailable = false;
        if (client.displayPreferences) {
          try {
            display = await client.displayPreferences(user.Id);
          } catch {
            unavailable = true;
          }
        }
        const result = captureRoleParameters(user, display);
        if (unavailable)
          result.warnings.push(
            'Home screen preferences could not be read. Permissions and account preferences were imported.',
          );
        assertCurrentSettings(store, settings, serverId);
        return result;
      } finally {
        await client.close();
      }
    },
  );
  app.post<{ Body: SaveAccountRole }>(
    '/api/account-roles',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'parameters'],
          properties: {
            id: roleIdSchema,
            revision: revisionSchema,
            name: { type: 'string', minLength: 1, maxLength: 128 },
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['policy', 'configuration', 'display'],
              properties: {
                policy: { type: 'object' },
                configuration: { type: 'object' },
                display: { anyOf: [{ type: 'object' }, { type: 'null' }] },
              },
            },
          },
        },
      },
    },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo roles are read-only.');
      return roles.save(request.body, store.settings());
    },
  );
  app.delete<{ Params: { id: string }; Body: { revision: string } }>(
    '/api/account-roles/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: roleIdSchema },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision'],
          properties: { revision: revisionSchema },
        },
      },
    },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo roles are read-only.');
      roles.remove(request.params.id, request.body.revision, store.settings());
      return { deleted: true };
    },
  );
  app.post<{ Body: { role_id: string; role_revision: string; user_ids: string[] } }>(
    '/api/account-roles/assign',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role_id', 'role_revision', 'user_ids'],
          properties: {
            role_id: roleIdSchema,
            role_revision: revisionSchema,
            user_ids: userIdsSchema,
          },
        },
      },
    },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo roles are read-only.');
      const settings = store.settings();
      const input = request.body;
      const role = roles.get(input.role_id, settings);
      if (!role || role.revision !== input.role_revision)
        throw new ServiceError(
          'This role changed or no longer exists. Reload it before assigning users.',
        );
      const client = service.client(settings, 'jellyfin');
      try {
        const serverId = await verifyServer(client, store, settings);
        const users: MediaUser[] = [];
        for (const id of input.user_ids) {
          const user = await client.user(id);
          if (
            user.Id !== id ||
            user.Policy?.IsAdministrator !== false ||
            id === settings.template_user_id
          )
            throw new ServiceError(
              'Choose non-administrator Jellyfin users other than the template.',
            );
          users.push(user);
        }
        assertCurrentSettings(store, settings, serverId);
        return { assignments: roles.assign(input.role_id, input.role_revision, users, settings) };
      } finally {
        await client.close();
      }
    },
  );
  app.post<{ Body: { user_ids: string[] } }>(
    '/api/account-roles/unassign',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['user_ids'],
          properties: { user_ids: userIdsSchema },
        },
      },
    },
    async (request) => {
      if (service.demo) throw new ServiceError('Demo roles are read-only.');
      roles.unassign(request.body.user_ids, store.settings());
      return { unassigned: true };
    },
  );
}
