import { createHash } from 'node:crypto';
import { templatePolicy, type Service } from './service.js';
import type { MediaAPI, MediaUser } from './media.js';
import { ServiceError } from './errors.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';

export type WorkflowAction =
  | 'create_account'
  | 'migrate'
  | 'migrate_saved'
  | 'account_roles'
  | 'account_mappings'
  | 'discord_roles'
  | 'identity_review'
  | 'account_access_emby'
  | 'account_access_jellyfin';
export interface WorkflowBlocker {
  code: string;
  message: string;
  route: { page: 'settings' | 'roles'; tab?: string; subtab?: string };
}
export interface WorkflowReadinessSnapshot {
  checked_at: string;
  actions: Record<
    WorkflowAction,
    { ready: boolean; blockers: WorkflowBlocker[]; warnings: string[] }
  >;
  sources: Record<'emby' | 'jellyfin', { configured: boolean; available: boolean }>;
}

/** Shared short-lived metadata preflight. Never enumerates media or changes identities. */
export class WorkflowReadiness {
  private cached?: { key: string; until: number; value: WorkflowReadinessSnapshot };
  private building?: { key: string; task: Promise<WorkflowReadinessSnapshot> };
  private clients = new Set<MediaAPI>();
  private closed = false;
  constructor(private readonly service: Service) {}

  async snapshot(refresh = false): Promise<WorkflowReadinessSnapshot> {
    if (this.closed) throw new ServiceError('Workflow checks are stopping.');
    const settings = this.service.store.settings();
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          settings,
          this.service.store.authState(),
          this.service.roles.list(settings),
          this.service.bot?.status(),
        ]),
      )
      .digest('hex');
    if (!refresh && this.cached?.key === key && this.cached.until > Date.now())
      return structuredClone(this.cached.value);
    if (this.building?.key === key) return structuredClone(await this.building.task);
    const task = this.build();
    this.building = { key, task };
    try {
      const value = await task;
      this.cached = { key, until: Date.now() + 10_000, value };
      return structuredClone(value);
    } finally {
      if (this.building?.task === task) this.building = undefined;
    }
  }

  private async build(): Promise<WorkflowReadinessSnapshot> {
    const settings = this.service.store.settings();
    const settingsKey = JSON.stringify(settings);
    const auth = this.service.store.authState();
    const probe = async (kind: 'emby' | 'jellyfin') => {
      const configured = !!settings[`${kind}_url`] && !!settings[`${kind}_api_key`];
      if (!configured) return { configured, available: false, id: '', users: [] as MediaUser[] };
      const client = this.service.client(settings, kind);
      this.clients.add(client);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      try {
        const value = await Promise.race([
          (async () => {
            const info = await client.systemInfo();
            if (!active || this.closed) throw new Error('canceled');
            if (
              typeof info.Id !== 'string' ||
              !info.Id ||
              (kind === 'jellyfin' &&
                auth?.kind === 'configured' &&
                (info.Id !== auth.serverId ||
                  normalizeJellyfinUrl(settings.jellyfin_url) !==
                    normalizeJellyfinUrl(auth.serverUrl)))
            )
              throw new Error('identity');
            const users = await client.users();
            if (users.length > 10_000) throw new Error('limit');
            return { id: info.Id, users };
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              active = false;
              void client.close();
              reject(new Error('timeout'));
            }, 8_000);
          }),
        ]);
        return { configured, available: true, ...value };
      } catch {
        return { configured, available: false, id: '', users: [] as MediaUser[] };
      } finally {
        active = false;
        if (timer) clearTimeout(timer);
        this.clients.delete(client);
        await client.close();
      }
    };
    const [emby, jellyfin] = await Promise.all([probe('emby'), probe('jellyfin')]);
    const source = { emby, jellyfin };
    const server = (kind: 'emby' | 'jellyfin'): WorkflowBlocker[] =>
      source[kind].available
        ? []
        : [
            {
              code: `${kind}_connection`,
              message: `${kind === 'emby' ? 'Emby' : 'Jellyfin'} ${source[kind].configured ? 'could not be verified. Check its connection before continuing.' : 'needs its server URL and API key.'}`,
              route: { page: 'settings', tab: 'media', subtab: kind },
            },
          ];
    const defaults: WorkflowBlocker[] = [];
    if (jellyfin.available) {
      let valid = false;
      if (settings.default_role_id) {
        const role = this.service.roles.get(settings.default_role_id, settings);
        valid = !!role && role.server_id === jellyfin.id;
      } else {
        const template = jellyfin.users.find((user) => user.Id === settings.template_user_id);
        try {
          if (template) {
            templatePolicy(template);
            valid = true;
          }
        } catch {
          /* Guard before the form, not during its final save. */
        }
      }
      if (!valid)
        defaults.push({
          code: 'account_defaults',
          message: 'Choose a valid default account role or an enabled Jellyfin template.',
          route: { page: 'settings', tab: 'accounts', subtab: 'permissions' },
        });
    }
    const bot = this.service.bot;
    const connected = settings.discord_enabled && bot?.status().connected === true;
    const discord: WorkflowBlocker[] = connected
      ? []
      : [
          {
            code: 'discord_connection',
            message: 'Connect the Discord bot before managing Discord identities or roles.',
            route: { page: 'settings', tab: 'discord', subtab: 'connection' },
          },
        ];
    const tags: WorkflowBlocker[] = [];
    const selectedRoles = [settings.discord_emby_role_id, settings.discord_jellyfin_role_id].filter(
      (id): id is string => !!id,
    );
    if (!selectedRoles.length)
      tags.push({
        code: 'organization_roles',
        message: 'Choose the informational Emby and Jellyfin roles before previewing role updates.',
        route: { page: 'settings', tab: 'discord', subtab: 'connection' },
      });
    else if (connected) {
      try {
        let roleTimer: ReturnType<typeof setTimeout> | undefined;
        const roles = await Promise.race([
          bot?.listTagRoles?.(),
          new Promise<never>((_, reject) => {
            roleTimer = setTimeout(() => reject(new Error('timeout')), 2_000);
          }),
        ]).finally(() => {
          if (roleTimer) clearTimeout(roleTimer);
        });
        if (
          !roles?.can_manage_roles ||
          selectedRoles.some((id) => !roles.roles.some((role) => role.id === id && role.manageable))
        )
          throw new Error('roles');
      } catch {
        tags.push({
          code: 'organization_permissions',
          message:
            'The bot needs Manage Roles and a higher role than the selected organization roles.',
          route: { page: 'settings', tab: 'discord', subtab: 'connection' },
        });
      }
    }
    const matching: WorkflowBlocker[] = [];
    try {
      this.service.destinationSnapshots.queuedSelection(settings);
    } catch {
      matching.push({
        code: 'matching_catalog',
        message: 'Import a current Jellyfin matching catalog before migrating.',
        route: { page: 'settings', tab: 'history', subtab: 'jellyfin' },
      });
    }
    const action = (blockers: WorkflowBlocker[], warnings: string[] = []) => ({
      ready: blockers.length === 0,
      blockers,
      warnings,
    });
    if (this.closed || settingsKey !== JSON.stringify(this.service.store.settings()))
      throw new ServiceError('Configuration changed while checking requirements. Check again.');
    return {
      checked_at: new Date().toISOString(),
      sources: {
        emby: { configured: emby.configured, available: emby.available },
        jellyfin: { configured: jellyfin.configured, available: jellyfin.available },
      },
      actions: {
        create_account: action([...server('jellyfin'), ...defaults]),
        migrate: action([...server('emby'), ...server('jellyfin'), ...defaults, ...matching]),
        migrate_saved: action(
          [...server('emby'), ...server('jellyfin'), ...defaults, ...matching],
          ['Saved history coverage and freshness are checked before the migration wizard opens.'],
        ),
        account_roles: action(server('jellyfin')),
        account_mappings: action([...server('emby'), ...server('jellyfin')]),
        discord_roles: action([
          ...discord,
          ...tags,
          ...server('jellyfin'),
          ...(emby.configured ? server('emby') : []),
        ]),
        identity_review: action(discord),
        account_access_emby: action([
          ...server('emby'),
          ...(auth?.kind === 'configured' ? server('jellyfin') : []),
        ]),
        account_access_jellyfin: action(server('jellyfin')),
      },
    };
  }

  async close() {
    this.closed = true;
    this.cached = undefined;
    await Promise.allSettled([...this.clients].map((client) => client.close()));
  }
}
