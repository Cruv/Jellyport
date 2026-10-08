import { randomInt, randomUUID } from 'node:crypto';
import { MediaError, ServiceError } from './errors.js';
import { caseFold, type MatchPlan } from './matching.js';
import {
  UserMappings,
  validateExistingMappingUsername,
  type UserMapping,
} from './user-mappings.js';
import {
  readMigrationSource,
  statePlan,
  migrateItemState,
  migratePlaylists,
  migrationDetails,
  migrationWarning,
  portableConfiguration,
  type MigrationDetails,
  type SourceSnapshot,
} from './migration.js';
import {
  isObject,
  MediaClient,
  type ClientFactory,
  type JsonObject,
  type MediaAPI,
  type MediaItem,
  type MediaKind,
  type MediaUser,
  type MediaUserImage,
} from './media.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';
import type { DiscordMemberSearchResult } from './discord-members.js';
import { AccountRoles, type AccountRole, type RoleAssignment } from './account-roles.js';
import { mergeRoleSection, type RoleSection } from './role-parameters.js';
import {
  Memberships,
  DEFAULT_MEMBERSHIP_TIERS,
  membershipUsername,
  resolveMembershipTier,
  validateMembershipSlot,
  type MembershipAccessMode,
  type Membership,
} from './memberships.js';
import type { Link } from './store.js';
import { AccountProfiles, type AccountProfileInput } from './account-profiles.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';

export { ServiceError } from './errors.js';
export interface JobRequest {
  username?: string;
  source_user_id?: string;
  discord_user_id?: string | null;
  recover_target_id?: string;
  mapping_id?: string;
  mapping_revision?: string;
  role_id?: string;
  role_revision?: string;
  role_assignment_revision?: string;
  target_user_id?: string;
  role_sections?: RoleSection[];
  default_role_revision?: string;
  membership_slot?: number;
  membership_revision?: string;
  access_disabled?: boolean;
}
export interface JobStats {
  source_played: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  already_played: number;
  source_items: number;
  source_favorites: number;
  source_resume: number;
  source_playlists: number;
}
export interface JobResult extends Partial<JobStats> {
  username: string;
  status: string;
  created?: boolean;
  applied?: number;
  target_user_id?: string;
  discord_delivery?: string;
  delivery_error?: string;
  error?: string;
  source_username?: string;
  mapping_id?: string;
  role_id?: string;
  role_name?: string;
  role_sections?: RoleSection[];
  warnings?: string[];
  data?: MigrationDetails;
  unmatched_items?: Array<{ name: string; type: string; id: string }>;
  ambiguous_items?: Array<{ name: string; id: string; candidate_ids: string[] }>;
}
export interface Job {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  progress: { processed: number; total: number };
  results: JobResult[];
  error?: string;
  membership_discord_user_id?: string;
}
export interface SubscriptionEvent {
  id: string;
  action: 'subscribe' | 'cancel' | 'expire';
  status: string;
  created_at: string;
  username?: string | null;
  discord_user_id?: string | null;
  source?: string | null;
  detail?: string | null;
  emitted_at?: string | null;
  error?: string | null;
  result?: string;
  job_id?: string;
  tier_id?: string;
  account_limit?: number;
}
export interface SubscriptionInput {
  id: string;
  action: 'subscribe' | 'cancel' | 'expire';
  username?: string | null;
  discord_user_id?: string | null;
  source?: string | null;
  detail?: string | null;
  emitted_at?: string | null;
}
export interface BotAdapter {
  status(): Record<string, unknown>;
  recipientIdentity(
    id: string,
    requireMembership?: boolean,
  ): Promise<{ id?: string; username: string }>;
  validateRecipient(id: string, requireMembership?: boolean): Promise<unknown>;
  sendCredentials(
    id: string,
    username: string,
    password: string,
    url: string,
    requireMembership?: boolean,
  ): Promise<void>;
  listTagRoles?(): Promise<{
    roles: Array<{ id: string; name: string; manageable: boolean }>;
    can_manage_roles: boolean;
  }>;
  memberTagState?(id: string): Promise<{ id: string; username: string; roles: string[] } | null>;
  updateTagRoles?(id: string, add: string[], remove: string[]): Promise<void>;
  membershipActive(id: string): Promise<boolean | null>;
  activeMembers(): Promise<Array<{ id: string; username: string }> | null>;
  searchMembers?(query: string): Promise<DiscordMemberSearchResult>;
}
export interface ServiceOptions {
  clientFactory?: ClientFactory;
  demo?: boolean;
}
interface ProvisioningDefaults extends MediaUser {
  accountRole?: AccountRole;
}
interface PreviewUser {
  source_user_id: string;
  source_username: string;
  username: string;
  target_user_id: string | null;
  target_exists: boolean;
  stats: JobStats;
  unmatched: MediaItem[];
  ambiguous: MatchPlan['ambiguous'];
  mapping_id: string | null;
  mapping_revision: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  warnings: string[];
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
class StoppedError extends Error {}
export function now(): string {
  return new Date().toISOString();
}
export function generatePassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower = 'abcdefghijklmnopqrstuvwxyz',
    digits = '0123456789',
    symbols = '!@#%+_-';
  const all = upper + lower + digits + symbols;
  const choose = (values: string) => values[randomInt(values.length)]!;
  const chars = [choose(upper), choose(lower), choose(digits), choose(symbols)];
  for (let i = 0; i < 20; i++) chars.push(choose(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const other = randomInt(i + 1);
    [chars[i], chars[other]] = [chars[other]!, chars[i]!];
  }
  return chars.join('');
}
export function validateUsername(username: string): string {
  if (
    !username ||
    username !== username.trim() ||
    [...username].length > 64 ||
    /[\u0000-\u001f\\/<>]/.test(username)
  )
    throw new ServiceError(
      'Use a username of 1–64 characters without leading/trailing spaces, control characters, slashes or angle brackets.',
    );
  return username;
}
export function templatePolicy(template: MediaUser | { Policy?: JsonObject }): JsonObject {
  if (!isObject(template.Policy))
    throw new ServiceError('Choose an enabled, non-administrator Jellyfin template user.');
  const policy = structuredClone(template.Policy ?? {});
  if (!Object.keys(policy).length || policy.IsAdministrator || policy.IsDisabled)
    throw new ServiceError('Choose an enabled, non-administrator Jellyfin template user.');
  delete policy.InvalidLoginAttemptCount;
  delete policy.FailedLoginAttempts;
  return policy;
}

/** Account jobs and subscription actions share a mutation lock released between users. */
export class Service {
  bot: BotAdapter | null = null;
  clientFactory: ClientFactory;
  readonly jobTasks = new Map<string, Promise<void>>();
  private readonly mutationMutex = new Mutex();
  private readonly subscriptionMutex = new Mutex();
  private readonly clients = new Set<MediaAPI>();
  private stopping = false;
  readonly demo: boolean;
  readonly mappings: UserMappings;
  readonly roles: AccountRoles;
  readonly memberships: Memberships;
  readonly profiles: AccountProfiles;
  private readonly membershipMutex = new Mutex();
  constructor(
    readonly store: Store,
    options: ServiceOptions = {},
  ) {
    this.clientFactory =
      options.clientFactory ?? ((url, key, kind) => new MediaClient(url, key, kind));
    this.demo = options.demo ?? false;
    this.mappings = new UserMappings(store);
    this.roles = new AccountRoles(store, this.demo);
    this.memberships = new Memberships(store);
    this.profiles = new AccountProfiles(store);
  }
  resolveDiscordMapping(discordId: string): UserMapping | null {
    return this.mappings.getForDiscord(discordId, this.store.settings());
  }
  resolveDiscordMappings(discordId: string): UserMapping[] {
    return this.mappings.getAllForDiscord(discordId, this.store.settings());
  }

  client(settings: Settings, kind: MediaKind): MediaAPI {
    this.requireServer(settings, kind);
    return this.clientFactory(settings[`${kind}_url`], settings[`${kind}_api_key`], kind);
  }
  private requireServer(settings: Settings, kind: MediaKind): void {
    if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`])
      throw new ServiceError(
        `Configure the ${kind === 'emby' ? 'Emby' : 'Jellyfin'} server URL and API key in Settings first.`,
      );
  }
  private async withClient<T>(
    settings: Settings,
    kind: MediaKind,
    action: (client: MediaAPI) => Promise<T>,
  ): Promise<T> {
    const client = this.client(settings, kind);
    this.clients.add(client);
    try {
      return await action(client);
    } finally {
      this.clients.delete(client);
      await client.close();
    }
  }
  async start(): Promise<void> {
    this.stopping = false;
    for (const { job, requests, settings } of this.store.queuedJobs())
      this.schedule(job, requests, settings);
  }
  async users(): Promise<{
    emby: MediaUser[];
    jellyfin: MediaUser[];
    errors: Record<string, string>;
  }> {
    const settings = this.store.settings();
    const fetchUsers = async (kind: MediaKind): Promise<[MediaUser[], string | null]> => {
      if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`]) return [[], null];
      try {
        return [await this.withClient(settings, kind, (client) => client.users()), null];
      } catch (error) {
        if (error instanceof MediaError || error instanceof ServiceError)
          return [[], error.message];
        throw error;
      }
    };
    const [emby, jellyfin] = await Promise.all([fetchUsers('emby'), fetchUsers('jellyfin')]);
    const errors: Record<string, string> = {};
    if (emby[1]) errors.emby = emby[1];
    if (jellyfin[1]) errors.jellyfin = jellyfin[1];
    return { emby: emby[0], jellyfin: jellyfin[0], errors };
  }
  async embyUsers(): Promise<MediaUser[]> {
    return this.withClient(this.store.settings(), 'emby', (client) => client.users());
  }
  async connections(): Promise<Record<string, unknown>> {
    const settings = this.store.settings();
    const check = async (kind: MediaKind): Promise<Record<string, unknown>> => {
      const configured = Boolean(settings[`${kind}_url`] && settings[`${kind}_api_key`]);
      const result: Record<string, unknown> = { configured, connected: false };
      if (configured)
        try {
          const info = await this.withClient(settings, kind, async (client) => {
            const info = await client.systemInfo();
            await client.users();
            return info;
          });
          Object.assign(result, {
            connected: true,
            name: info.ServerName ?? kind,
            version: info.Version ?? '',
          });
        } catch (error) {
          if (!(error instanceof MediaError || error instanceof ServiceError)) throw error;
          result.error = `Unable to authenticate to ${kind === 'emby' ? 'Emby' : 'Jellyfin'}. Check URL, API key and network access.`;
        }
      return result;
    };
    const [emby, jellyfin] = await Promise.all([check('emby'), check('jellyfin')]);
    return { emby, jellyfin, discord: this.bot?.status() ?? { enabled: false, connected: false } };
  }
  private async template(client: MediaAPI, settings: Settings): Promise<ProvisioningDefaults> {
    if (settings.default_role_id) {
      const role = this.roles.get(settings.default_role_id, settings);
      if (!role)
        throw new ServiceError(
          'The default account role is unavailable. Choose it again in Settings.',
        );
      await this.requireRoleServer(client, role);
      return {
        Id: '',
        Name: role.name,
        Policy: structuredClone(role.parameters.policy),
        Configuration: structuredClone(role.parameters.configuration),
        accountRole: role,
      };
    }
    if (!settings.template_user_id)
      throw new ServiceError(
        'Select a default account role or Jellyfin template user in Settings first.',
      );
    const template = await client.user(settings.template_user_id);
    templatePolicy(template);
    return template;
  }
  private target(users: MediaUser[], username: string): MediaUser | null {
    const matches = users.filter((user) => caseFold(user.Name) === caseFold(username));
    if (matches.length > 1)
      throw new ServiceError(
        'Multiple Jellyfin accounts match this username. Resolve the duplicate before continuing.',
      );
    const target = matches[0] ?? null;
    if (target && target.Name !== username)
      throw new ServiceError(
        'A Jellyfin username differs only by letter case. Resolve it first so usernames can match exactly.',
      );
    return target;
  }
  private plan(
    source: MediaItem[],
    target: MediaItem[],
    settings: Settings,
    sourcePlaylists = 0,
  ): [MatchPlan, JobStats] {
    const playable = new Set([
      'Movie',
      'Episode',
      'Audio',
      'MusicVideo',
      'Video',
      'Book',
      'AudioBook',
      'Trailer',
    ]);
    const played = source.filter(
      (item) => playable.has(item.Type ?? '') && item.UserData?.Played === true,
    );
    const plan = statePlan(source, target, settings);
    return [
      plan,
      {
        source_played: played.length,
        matched: plan.matches.length,
        unmatched: plan.unmatched.length,
        ambiguous: plan.ambiguous.length,
        already_played: plan.matches.filter(
          (match) =>
            match.source.UserData?.Played === true && match.target.UserData?.Played === true,
        ).length,
        source_items: plan.matches.length + plan.unmatched.length + plan.ambiguous.length,
        source_favorites: source.filter((item) => item.UserData?.IsFavorite === true).length,
        source_resume: source.filter(
          (item) =>
            playable.has(item.Type ?? '') &&
            typeof item.UserData?.PlaybackPositionTicks === 'number' &&
            Number.isSafeInteger(item.UserData.PlaybackPositionTicks) &&
            item.UserData.PlaybackPositionTicks > 0,
        ).length,
        source_playlists: sourcePlaylists,
      },
    ];
  }
  private mappedTarget(
    users: MediaUser[],
    mapping: UserMapping | null,
    username: string,
    settings: Settings,
    recoverTargetId?: string,
  ): MediaUser | null {
    if (!mapping?.target_user_id) {
      const target = this.target(users, username);
      this.assertDestinationMapping(mapping, target?.Id ?? null, username, settings);
      if (mapping && target) {
        const local = this.store.account(username);
        const explicitRecovery =
          recoverTargetId === target.Id &&
          local &&
          ['uncertain', 'provisioning'].includes(local.status) &&
          (!local.remote_id || local.remote_id === target.Id);
        if (
          !explicitRecovery &&
          (local?.remote_id !== target.Id || local.status !== 'provisioning')
        )
          throw new ServiceError(
            'The mapped new username now exists. Select the existing Jellyfin account explicitly before migrating.',
          );
      }
      return target;
    }
    const target = users.find((user) => user.Id === mapping.target_user_id);
    this.assertDestinationMapping(
      mapping,
      target?.Id ?? mapping.target_user_id,
      username,
      settings,
    );
    if (!target || target.Name !== mapping.target_username)
      throw new ServiceError(
        'The mapped Jellyfin account was removed or renamed. Review its mapping.',
      );
    if (
      target.Policy?.IsAdministrator !== false ||
      (target.Policy?.IsDisabled !== false && recoverTargetId !== target.Id)
    )
      throw new ServiceError(
        'The mapped Jellyfin account is disabled or its permissions changed. Review it before migrating.',
      );
    return target;
  }
  private assertDestinationMapping(
    mapping: UserMapping | null,
    targetId: string | null,
    username: string,
    settings: Settings,
  ): void {
    const owner = this.mappings.getForTarget(targetId, username, settings);
    if (owner && owner.id !== mapping?.id)
      throw new ServiceError(
        'This Jellyfin account or username is reserved by another approved Emby mapping. Use that mapping instead.',
      );
  }
  private requestMapping(request: JobRequest, settings: Settings): UserMapping | null {
    if (!request.source_user_id) return null;
    const mapping = this.mappings.getForSource(request.source_user_id, settings);
    if (request.mapping_id || request.mapping_revision) {
      if (
        !mapping ||
        mapping.id !== request.mapping_id ||
        mapping.revision !== request.mapping_revision
      )
        throw new ServiceError(
          'The user mapping changed after this job was queued. Review a new preview before migrating.',
        );
      return mapping;
    }
    if (mapping)
      throw new ServiceError(
        'A user mapping was added after this job was queued. Review a new preview before migrating.',
      );
    return null;
  }
  private assertMapping(
    mapping: UserMapping | null,
    sourceId: string | undefined,
    settings: Settings,
  ): void {
    if (!sourceId) return;
    const current = this.mappings.getForSource(sourceId, settings);
    if (
      mapping
        ? current?.id !== mapping.id || current.revision !== mapping.revision
        : current !== null
    )
      throw new ServiceError('The user mapping changed. Review a new preview before migrating.');
  }
  async preview(sourceUserIds: string[]): Promise<{ users: PreviewUser[]; mode: 'merge' }> {
    const settings = this.store.settings();
    return this.withClient(settings, 'emby', (emby) =>
      this.withClient(settings, 'jellyfin', async (jellyfin) => {
        const template = await this.template(jellyfin, settings),
          targets = await jellyfin.users();
        const users: PreviewUser[] = [];
        for (const sourceId of sourceUserIds) {
          const source = await readMigrationSource(emby, sourceId);
          if (source.user.Id !== sourceId)
            throw new ServiceError(
              'Emby returned a different source account. Reload the user list.',
            );
          const mapping = this.mappings.getForSource(sourceId, settings);
          if (mapping && source.user.Name !== mapping.source_username)
            throw new ServiceError('The mapped Emby account was renamed. Review its mapping.');
          const username = mapping?.target_user_id
              ? validateExistingMappingUsername(mapping.target_username)
              : validateUsername(mapping?.target_username ?? source.user.Name),
            target = this.mappedTarget(targets, mapping, username, settings);
          if (
            target &&
            (target.Id === template.Id ||
              target.Id === settings.template_user_id ||
              target.Policy?.IsAdministrator)
          )
            throw new ServiceError(
              'A migration cannot target your template user or a Jellyfin administrator.',
            );
          if (target?.Policy?.IsDisabled)
            throw new ServiceError(
              'A disabled Jellyfin account cannot be a migration destination.',
            );
          let targetItems = await (jellyfin.migrationItems
            ? jellyfin.migrationItems(target?.Id || template.Id || undefined)
            : jellyfin.items(target?.Id || template.Id || undefined));
          if (!target)
            targetItems = targetItems.map((item) => ({ ...item, UserData: { Played: false } }));
          const [plan, stats] = this.plan(
            source.items,
            targetItems,
            settings,
            source.playlists.length,
          );
          const warnings = [
            ...source.warnings,
            ...source.playlists.flatMap((entry) => (entry.error ? [entry.error] : [])),
            ...(!target && template.accountRole
              ? [
                  'This preview uses the server catalog. The new account’s role may limit library access; final matches are checked using that account.',
                ]
              : []),
          ];
          this.assertMapping(mapping, sourceId, settings);
          users.push({
            source_user_id: sourceId,
            source_username: source.user.Name,
            username,
            target_user_id: target?.Id ?? null,
            target_exists: Boolean(target),
            stats,
            unmatched: plan.unmatched.map((item) => ({
              Id: item.Id,
              Name: item.Name,
              Type: item.Type,
            })),
            ambiguous: plan.ambiguous.map((entry) => ({
              source: { Id: entry.source.Id, Name: entry.source.Name, Type: entry.source.Type },
              candidates: entry.candidates.map((item) => ({
                Id: item.Id,
                Name: item.Name,
                Type: item.Type,
              })),
            })),
            mapping_id: mapping?.id ?? null,
            mapping_revision: mapping?.revision ?? null,
            discord_user_id: mapping?.discord_user_id ?? null,
            discord_username: mapping?.discord_username ?? null,
            warnings,
          });
        }
        return { users, mode: 'merge' };
      }),
    );
  }
  private requireBot(): BotAdapter {
    if (!this.bot)
      throw new ServiceError('Enable and connect the Discord bot before selecting a recipient.');
    return this.bot;
  }
  recipientRequiresSubscription(discordId: string): boolean {
    return this.memberships.get(discordId, this.store.settings())?.access_mode !== 'complimentary';
  }
  private async recipientIdentity(discordId: string) {
    return this.requireBot().recipientIdentity(
      discordId,
      this.recipientRequiresSubscription(discordId),
    );
  }
  private async validateRecipients(recipients: Iterable<string>): Promise<void> {
    for (const recipient of new Set(recipients)) {
      const bot = this.requireBot();
      try {
        await bot.validateRecipient(
          String(recipient),
          this.recipientRequiresSubscription(String(recipient)),
        );
      } catch {
        throw new ServiceError(
          'Discord recipient is unavailable or does not have the required membership role.',
        );
      }
    }
  }
  async createAccount(username: string, discordUserId?: string | null): Promise<Job> {
    validateUsername(username);
    this.assertDestinationMapping(null, null, username, this.store.settings());
    if (discordUserId && this.resolveDiscordMapping(discordUserId))
      throw new ServiceError(
        'This Discord user has an approved Emby mapping. Use migration to preserve their existing data.',
      );
    if (discordUserId) {
      await this.validateRecipients([discordUserId]);
      const identity = await this.recipientIdentity(discordUserId);
      if (username !== identity.username)
        throw new ServiceError(
          "Use the recipient's Discord username, not their server nickname or display name.",
        );
    }
    this.requireServer(this.store.settings(), 'jellyfin');
    const member = discordUserId
      ? this.memberships.get(discordUserId, this.store.settings())
      : null;
    if (member?.active === false)
      throw new ServiceError(
        'This membership is inactive. Review and activate its tier before creating an account.',
      );
    return this.queue('create', [
      {
        username,
        discord_user_id: discordUserId,
        ...(member ? { membership_slot: 1, membership_revision: member.revision } : {}),
      },
    ]);
  }
  listMemberships(): Array<Membership & { links: Link[] }> {
    const settings = this.store.settings();
    const records = this.memberships.list(settings);
    const known = new Set(records.map((member) => member.discord_user_id));
    // Older single-account installations need no manual database reset or relinking.
    for (const link of this.store.links()) {
      if (known.has(link.discord_user_id)) continue;
      known.add(link.discord_user_id);
      if (this.memberships.hasOtherScope(link.discord_user_id, settings)) continue;
      const primary = this.store.link(link.discord_user_id) ?? link;
      records.push({
        discord_user_id: link.discord_user_id,
        server_url: settings.jellyfin_url,
        base_username: primary.username,
        tier_id: 'sloop',
        access_mode: 'subscription',
        account_limit: 1,
        active: !Boolean(primary.disabled_by_jellyport),
        revision: '',
      });
    }
    return records.map((member) => ({
      ...member,
      links: this.store.linksForMember(member.discord_user_id),
    }));
  }
  private assertManageableAccount(
    target: MediaUser,
    targetId: string,
    settings: Settings,
    kind: MediaKind,
  ): void {
    if (
      target.Id !== targetId ||
      target.Policy?.IsAdministrator !== false ||
      typeof target.Policy.IsDisabled !== 'boolean' ||
      (kind === 'jellyfin' &&
        (targetId === settings.template_user_id ||
          targetId === this.store.settings().template_user_id))
    )
      throw new ServiceError('Administrator, template, or unverified accounts cannot be changed.');
  }
  private async confirmPairedServer(settings: Settings): Promise<void> {
    const auth = this.store.authState();
    if (auth?.kind === 'configured') {
      if (normalizeJellyfinUrl(settings.jellyfin_url) !== normalizeJellyfinUrl(auth.serverUrl))
        throw new ServiceError(
          'Restore the paired Jellyfin configuration before changing an account.',
        );
      await this.withClient(settings, 'jellyfin', async (client) => {
        if ((await client.systemInfo()).Id !== auth.serverId)
          throw new ServiceError('The paired Jellyfin server changed. No account was modified.');
      });
    }
  }
  /** Only a manual, selected-ID edit can establish a Family exemption. */
  async saveAccountProfile(input: AccountProfileInput & { expected_revision?: string }) {
    if (this.demo) throw new ServiceError('Demo account profiles are read-only.');
    return this.mutationMutex.run(async () => {
      this.checkStopped();
      const settings = this.store.settings();
      await this.confirmPairedServer(settings);
      return this.withClient(settings, input.kind, async (client) => {
        const target = await client.user(input.user_id);
        if (target.Id !== input.user_id)
          throw new ServiceError('The selected media account changed. Refresh and try again.');
        if (input.family) this.assertManageableAccount(target, input.user_id, settings, input.kind);
        if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
          throw new ServiceError('Configuration changed. Refresh and try again.');
        return this.profiles.save(input, settings, input.expected_revision);
      });
    });
  }
  /** Explicit administrator access change, separate from subscription automation. */
  async setAccountAccess(input: {
    kind: MediaKind;
    user_id: string;
    disabled: boolean;
    expected_username: string;
    expected_profile_revision: string;
  }) {
    if (this.demo) throw new ServiceError('Demo account access is read-only.');
    if (typeof input.disabled !== 'boolean')
      throw new ServiceError('Choose the account access state.');
    return this.mutationMutex.run(async () => {
      this.checkStopped();
      const settings = this.store.settings();
      await this.confirmPairedServer(settings);
      return this.withClient(settings, input.kind, async (client) => {
        const target = await client.user(input.user_id);
        this.assertManageableAccount(target, input.user_id, settings, input.kind);
        if (
          target.Name !== input.expected_username ||
          (this.profiles.get(input.kind, input.user_id, this.store.settings())?.revision ?? '') !==
            input.expected_profile_revision ||
          JSON.stringify(settings) !== JSON.stringify(this.store.settings())
        )
          throw new ServiceError(
            'The account, owner notes, or configuration changed. Review access again.',
          );
        const policy = structuredClone(target.Policy!);
        policy.IsDisabled = input.disabled;
        this.checkStopped();
        if (target.Policy!.IsDisabled !== input.disabled) await client.setPolicy(target.Id, policy);
        const confirmed = await client.user(target.Id);
        this.assertManageableAccount(confirmed, input.user_id, settings, input.kind);
        if (
          confirmed.Name !== input.expected_username ||
          confirmed.Policy!.IsDisabled !== input.disabled ||
          JSON.stringify(settings) !== JSON.stringify(this.store.settings()) ||
          (this.profiles.get(input.kind, input.user_id, this.store.settings())?.revision ?? '') !==
            input.expected_profile_revision
        )
          throw new ServiceError('Account access could not be confirmed. Refresh before retrying.');
        if (input.kind === 'jellyfin') {
          const link = this.store.linkForRemote(input.user_id);
          // An explicit administrator action is not a billing-owned disable.
          if (link)
            this.store.saveLink(
              link.discord_user_id,
              link.username,
              link.remote_id,
              false,
              link.membership_slot,
            );
        }
        return { kind: input.kind, user_id: input.user_id, disabled: input.disabled };
      });
    });
  }
  /** Save an administrator's access decision without touching media accounts. */
  async setMembershipAccess(input: {
    discord_user_id: string;
    access_mode: MembershipAccessMode;
    account_limit?: number;
    tier_id?: string;
    expected_revision?: string;
  }): Promise<Membership> {
    if (this.demo) throw new ServiceError('Demo memberships are read-only.');
    return this.membershipMutex.run(() =>
      this.mutationMutex.run(async () => {
        const settings = this.store.settings();
        const previous = this.memberships.get(input.discord_user_id, settings);
        if (!previous && this.memberships.hasOtherScope(input.discord_user_id, settings))
          throw new ServiceError(
            'Restore the original paired server before changing this membership.',
          );
        if (input.expected_revision !== undefined && previous?.revision !== input.expected_revision)
          throw new ServiceError('The membership changed. Review it before retrying.');
        if (!['subscription', 'complimentary'].includes(input.access_mode))
          throw new ServiceError('Choose subscription or complimentary access.');
        const tier =
          input.access_mode === 'complimentary'
            ? {
                id: 'complimentary',
                account_limit: validateMembershipSlot(
                  input.account_limit ?? previous?.account_limit ?? 1,
                ),
              }
            : (settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS).find(
                (t) => t.id === (input.tier_id ?? previous?.tier_id),
              );
        if (!tier) throw new ServiceError('Choose a configured subscription tier.');
        const identity = previous
          ? null
          : await this.requireBot().recipientIdentity(input.discord_user_id, false);
        if (identity?.id && identity.id !== input.discord_user_id)
          throw new ServiceError('Discord returned a different member. Reload and try again.');
        if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
          throw new ServiceError('Configuration changed. Review and try again.');
        return this.memberships.save(
          {
            discord_user_id: input.discord_user_id,
            base_username:
              previous?.base_username ??
              this.store.link(input.discord_user_id)?.username ??
              this.mappings.getForDiscord(input.discord_user_id, settings)?.target_username ??
              identity!.username,
            access_mode: input.access_mode,
            tier_id: tier.id,
            account_limit: tier.account_limit,
            active: input.access_mode === 'complimentary' ? true : (previous?.active ?? true),
            ...(input.access_mode === 'subscription' && previous?.inactive_reason
              ? { inactive_reason: previous.inactive_reason }
              : {}),
          },
          settings,
          previous?.revision,
        );
      }),
    );
  }
  /** Explicitly adopt a selected account; never infer ownership from its username. */
  async linkExistingAccount(discordId: string, targetId: string, slot = 1): Promise<Link> {
    if (this.demo) throw new ServiceError('Demo account links are read-only.');
    validateMembershipSlot(slot);
    return this.membershipMutex.run(() =>
      this.mutationMutex.run(async () => {
        const settings = this.store.settings();
        const member = this.memberships.get(discordId, settings);
        if (!member && this.memberships.hasOtherScope(discordId, settings))
          throw new ServiceError('Restore the original paired server before linking this member.');
        if (slot > (member?.account_limit ?? 1) || member?.active === false)
          throw new ServiceError('Save an active access policy with this account allowance first.');
        await this.validateRecipients([discordId]);
        return this.withClient(settings, 'jellyfin', async (client) => {
          const info = await client.systemInfo();
          const auth = this.store.authState();
          if (auth?.kind === 'configured' && info.Id !== auth.serverId)
            throw new ServiceError('The paired Jellyfin server changed. No identity was linked.');
          const target = await client.user(targetId);
          if (
            target.Id !== targetId ||
            target.Policy?.IsAdministrator !== false ||
            typeof target.Policy.IsDisabled !== 'boolean' ||
            targetId === settings.template_user_id
          )
            throw new ServiceError(
              'Administrator, template, or unverified accounts cannot be linked.',
            );
          const previous = this.store.link(discordId, slot);
          const owner = this.store.linkForRemote(targetId);
          const mapping = this.mappings.getForTarget(targetId, target.Name, settings);
          const slotMapping = this.mappings.getForDiscord(discordId, settings, slot);
          if (
            (previous && (previous.remote_id !== targetId || previous.username !== target.Name)) ||
            (owner && (owner.discord_user_id !== discordId || owner.membership_slot !== slot)) ||
            (mapping &&
              (mapping.discord_user_id !== discordId ||
                (mapping.membership_slot ?? 1) !== slot ||
                mapping.target_user_id !== targetId)) ||
            (slotMapping &&
              (slotMapping.target_user_id !== targetId ||
                slotMapping.target_username !== target.Name))
          )
            throw new ServiceError(
              'This account or slot is reserved by another identity link or mapping. Review it first.',
            );
          if (
            JSON.stringify(settings) !== JSON.stringify(this.store.settings()) ||
            member?.revision !== this.memberships.get(discordId, settings)?.revision
          )
            throw new ServiceError('Configuration or access changed. Review and try again.');
          if (previous) return previous;
          this.store.saveLink(discordId, target.Name, targetId, false, slot);
          return this.store.link(discordId, slot)!;
        });
      }),
    );
  }
  private assertMembershipRequest(request: JobRequest, settings: Settings): Membership | null {
    if (!request.membership_revision) return null;
    const member = request.discord_user_id
      ? this.memberships.get(request.discord_user_id, this.store.settings())
      : null;
    if (
      !member ||
      !member.active ||
      member.revision !== request.membership_revision ||
      this.store.settings().jellyfin_url !== settings.jellyfin_url ||
      !Number.isInteger(request.membership_slot) ||
      request.membership_slot! < 1 ||
      request.membership_slot! > 3 ||
      (request.access_disabled === undefined && request.membership_slot! > member.account_limit) ||
      (request.access_disabled !== undefined &&
        request.access_disabled !== request.membership_slot! > member.account_limit)
    )
      throw new ServiceError('The membership changed. Review its current tier before retrying.');
    return member;
  }
  /** Provision the entire allowance; each slot keeps its own pinned target and access state. */
  async provisionMembership(
    discordId: string,
    tierId?: string,
    expectedRevision?: string,
    review?: { account_limit: number; usernames: string[] },
  ): Promise<Job> {
    if (this.demo) throw new ServiceError('Demo memberships are read-only.');
    return this.membershipMutex.run(() =>
      this.mutationMutex.run(async () => {
        await this.validateRecipients([discordId]);
        const identity = await this.recipientIdentity(discordId);
        if (identity.id && identity.id !== discordId)
          throw new ServiceError('Discord returned a different member. Reload and try again.');
        const settings = this.store.settings();
        const existing = this.memberships.get(discordId, settings);
        if (!existing && this.memberships.hasOtherScope(discordId, settings))
          throw new ServiceError(
            'This member belongs to a different paired server configuration. Restore the original server URL before managing its accounts.',
          );
        if (expectedRevision !== undefined && expectedRevision !== existing?.revision)
          throw new ServiceError(
            'The membership changed. Review its current tier before retrying.',
          );
        if (
          this.store
            .jobs()
            .some(
              (job) =>
                job.membership_discord_user_id === discordId &&
                ['queued', 'running'].includes(job.status),
            )
        )
          throw new ServiceError('Wait for this member’s current account job to finish.');
        const tiers = settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS;
        const selectedTier =
          tierId ??
          existing?.tier_id ??
          tiers.find((entry) => entry.id === 'sloop' && entry.account_limit === 1)?.id ??
          tiers.find((entry) => entry.account_limit === 1)?.id;
        if (existing?.access_mode === 'complimentary' && tierId && tierId !== 'complimentary')
          throw new ServiceError(
            'This member has complimentary access. Change the access policy explicitly before assigning a paid tier.',
          );
        const tier =
          existing?.access_mode === 'complimentary'
            ? { id: 'complimentary', account_limit: existing.account_limit }
            : tiers.find((entry) => entry.id === selectedTier);
        if (!tier) throw new ServiceError('Choose a configured membership tier.');
        if (review && review.account_limit !== tier.account_limit)
          throw new ServiceError(
            'The tier definition changed. Review the current account allowance before retrying.',
          );
        const mappings = this.mappings.getAllForDiscord(discordId, settings);
        const primaryMapping = mappings.find((entry) => (entry.membership_slot ?? 1) === 1);
        const primaryLink = this.store.link(discordId);
        const baseUsername =
          existing?.base_username ??
          primaryLink?.username ??
          primaryMapping?.target_username ??
          identity.username;
        const links = this.store.linksForMember(discordId);
        const requests: JobRequest[] = [];
        const needsNewSlot = Array.from(
          { length: tier.account_limit },
          (_, index) => index + 1,
        ).some((slot) => !links.some((link) => link.membership_slot === slot));
        const sources =
          needsNewSlot && settings.emby_url && settings.emby_api_key ? await this.embyUsers() : [];
        await this.withClient(settings, 'jellyfin', async (jellyfin) => {
          const info = await jellyfin.systemInfo();
          const auth = this.store.authState();
          if (auth?.kind === 'configured' && info.Id !== auth.serverId)
            throw new ServiceError(
              'The paired Jellyfin server changed. No accounts were modified.',
            );
          const targets = await jellyfin.users();
          for (let slot = 1; slot <= 3; slot++) {
            const link = links.find((entry) => entry.membership_slot === slot);
            const mapping = mappings.find((entry) => (entry.membership_slot ?? 1) === slot);
            if (link) {
              const target = targets.find((entry) => entry.Id === link.remote_id);
              this.assertLinkedTarget(target, link, settings);
              if (
                mapping &&
                (mapping.target_username !== link.username ||
                  (mapping.target_user_id && mapping.target_user_id !== link.remote_id))
              )
                throw new ServiceError(
                  'An account link conflicts with its approved mapping. Review it first.',
                );
              requests.push({
                username: link.username,
                discord_user_id: discordId,
                target_user_id: link.remote_id,
                membership_slot: slot,
                access_disabled: slot > tier.account_limit,
              });
              continue;
            }
            if (slot > tier.account_limit) continue;
            const username = mapping?.target_username ?? membershipUsername(baseUsername, slot);
            if (mapping?.target_user_id) validateExistingMappingUsername(username);
            else validateUsername(username);
            const target = this.mappedTarget(targets, mapping ?? null, username, settings);
            if (target && !mapping?.target_user_id) {
              const local = this.store.account(username);
              if (local?.remote_id !== target.Id || local.status !== 'provisioning')
                throw new ServiceError(
                  `The username ${username} already exists without an approved identity link. Link it through an admin-approved migration or user mapping before provisioning.`,
                );
            }
            if (
              target &&
              (target.Policy?.IsAdministrator !== false ||
                target.Policy?.IsDisabled !== false ||
                target.Id === settings.template_user_id)
            )
              throw new ServiceError(
                'A membership cannot use a disabled, administrator, or template account.',
              );
            const owner = target ? this.store.linkForRemote(target.Id) : null;
            if (owner && (owner.discord_user_id !== discordId || owner.membership_slot !== slot))
              throw new ServiceError(
                'This Jellyfin account already belongs to another member or slot.',
              );
            const matchingSources = mapping
              ? sources.filter((source) => source.Id === mapping.source_user_id)
              : sources.filter((source) => source.Name === username);
            if (matchingSources.length > 1)
              throw new ServiceError(
                'More than one Emby account matches a membership slot. Create a mapping.',
              );
            if (
              mapping &&
              (!matchingSources[0] || matchingSources[0].Name !== mapping.source_username)
            )
              throw new ServiceError(
                'A mapped Emby account was removed or renamed. Review its mapping.',
              );
            requests.push({
              username,
              discord_user_id: discordId,
              membership_slot: slot,
              ...(matchingSources[0] ? { source_user_id: matchingSources[0].Id } : {}),
              ...(mapping ? { mapping_id: mapping.id, mapping_revision: mapping.revision } : {}),
            });
          }
          if (requests.some((request) => request.access_disabled === undefined))
            await this.template(jellyfin, settings);
        });
        if (
          review &&
          JSON.stringify(
            requests
              .filter((request) => request.membership_slot! <= tier.account_limit)
              .map((request) => request.username),
          ) !== JSON.stringify(review.usernames)
        )
          throw new ServiceError(
            'The account names or mappings changed. Review the current membership before retrying.',
          );
        if (
          JSON.stringify(this.store.settings()) !== JSON.stringify(settings) ||
          this.memberships.get(discordId, settings)?.revision !== existing?.revision
        )
          throw new ServiceError('Configuration or membership changed. Review and try again.');
        for (const mapping of mappings)
          if (this.mappings.get(mapping.id, settings)?.revision !== mapping.revision)
            throw new ServiceError('A user mapping changed. Review and try again.');
        const member = this.memberships.save(
          {
            discord_user_id: discordId,
            base_username: baseUsername,
            tier_id: tier.id,
            access_mode: existing?.access_mode ?? 'subscription',
            account_limit: tier.account_limit,
            active: true,
          },
          settings,
          existing?.revision,
        );
        return this.queue(
          'membership',
          requests.map((request) => ({
            ...request,
            membership_revision: member.revision,
          })),
        );
      }),
    );
  }
  private assertLinkedTarget(
    target: MediaUser | undefined,
    link: Link,
    settings: Settings,
  ): asserts target is MediaUser {
    if (
      !target ||
      target.Id !== link.remote_id ||
      target.Name !== link.username ||
      target.Policy?.IsAdministrator !== false ||
      typeof target.Policy.IsDisabled !== 'boolean' ||
      target.Id === settings.template_user_id ||
      target.Id === this.store.settings().template_user_id
    )
      throw new ServiceError('A linked account changed or is protected. Review it manually.');
  }
  private async updateLinkedAccess(
    jellyfin: MediaAPI,
    settings: Settings,
    memberId: string,
    slot: number,
    disabled: boolean,
    guard: () => void = () => {},
  ): Promise<boolean> {
    let link = this.store.link(memberId, slot);
    if (!link) throw new ServiceError('The membership account link no longer exists.');
    const target = await jellyfin.user(link.remote_id);
    const auth = this.store.authState();
    if (auth?.kind === 'configured' && (await jellyfin.systemInfo()).Id !== auth.serverId)
      throw new ServiceError('The paired Jellyfin server changed. No account access was modified.');
    guard();
    this.assertLinkedTarget(target, link, settings);
    // Family is a per-account manual decision. Never reconcile pending billing
    // flags or change access automatically for this selected target ID.
    if (this.profiles.get('jellyfin', target.Id, this.store.settings())?.family) return false;
    const policy = structuredClone(target.Policy!);
    const isDisabled = policy.IsDisabled === true;
    if (link.pending_disabled !== null && isDisabled === Boolean(link.pending_disabled)) {
      this.store.saveLink(memberId, link.username, link.remote_id, isDisabled, slot);
      link = this.store.link(memberId, slot)!;
    }
    if (disabled && !isDisabled) {
      policy.IsDisabled = true;
      guard();
      await this.setAccess(jellyfin, target.Id, policy, memberId, true, slot);
      this.store.saveLink(memberId, link.username, target.Id, true, slot);
    } else if (!disabled && isDisabled && link.disabled_by_jellyport) {
      policy.IsDisabled = false;
      guard();
      await this.setAccess(jellyfin, target.Id, policy, memberId, false, slot);
      this.store.saveLink(memberId, link.username, target.Id, false, slot);
    } else if (!isDisabled) {
      this.store.saveLink(memberId, link.username, target.Id, false, slot);
    }
    return disabled || !isDisabled || Boolean(link.disabled_by_jellyport);
  }
  async recoveryInfo(username: string): Promise<{
    username: string;
    target_exists: boolean;
    target_user_id: string | null;
    eligible: boolean;
    reason: string;
  }> {
    validateUsername(username);
    const local = this.store.account(username),
      settings = this.store.settings();
    const target = await this.withClient(settings, 'jellyfin', async (jellyfin) =>
      this.target(await jellyfin.users(), username),
    );
    const eligible = Boolean(
      local &&
      ['uncertain', 'provisioning'].includes(local.status) &&
      target &&
      (!local.remote_id || local.remote_id === target.Id) &&
      target.Id !== settings.template_user_id &&
      !target.Policy?.IsAdministrator,
    );
    return {
      username,
      target_exists: Boolean(target),
      target_user_id: target?.Id ?? null,
      eligible,
      reason: eligible
        ? 'Inspect this Jellyfin account. Recovery will reset its password and apply your account defaults; watch history is preserved.'
        : 'Recovery is available only for an incomplete Jellyport creation with an existing, unprotected Jellyfin account.',
    };
  }
  async recoverAccount(
    username: string,
    targetUserId: string,
    discordUserId?: string | null,
  ): Promise<Job> {
    const info = await this.recoveryInfo(username);
    if (!info.eligible || info.target_user_id !== targetUserId)
      throw new ServiceError(
        'The inspected recovery target is no longer eligible. Refresh its details before proceeding.',
      );
    const mapping = this.mappings.getForTarget(targetUserId, username, this.store.settings());
    let slot = mapping?.membership_slot ?? 1;
    let member: Membership | null = null;
    if (discordUserId) {
      await this.validateRecipients([discordUserId]);
      member = this.memberships.get(discordUserId, this.store.settings());
      const link = this.store.linkForRemote(targetUserId);
      if (link && link.discord_user_id !== discordUserId)
        throw new ServiceError('This Jellyfin account already belongs to another Discord user.');
      if (link) slot = link.membership_slot;
      else if (mapping?.discord_user_id !== discordUserId && member) {
        const derivedSlot = [1, 2, 3].find(
          (candidate) => username === membershipUsername(member!.base_username, candidate),
        );
        if (derivedSlot) slot = derivedSlot;
      }
      const householdName =
        member?.active &&
        slot <= member.account_limit &&
        username === membershipUsername(member.base_username, slot);
      if (
        (await this.recipientIdentity(discordUserId)).username !== username &&
        mapping?.discord_user_id !== discordUserId &&
        !householdName &&
        !link
      )
        throw new ServiceError(
          "Use the recipient's Discord username when recovering and linking an account.",
        );
      if (member && (!member.active || slot > member.account_limit))
        throw new ServiceError('The active membership does not permit this account slot.');
    }
    return this.queue('recover', [
      {
        username,
        discord_user_id: discordUserId,
        recover_target_id: targetUserId,
        membership_slot: slot,
        ...(member ? { membership_revision: member.revision } : {}),
        ...(mapping
          ? {
              source_user_id: mapping.source_user_id,
              mapping_id: mapping.id,
              mapping_revision: mapping.revision,
            }
          : {}),
      },
    ]);
  }
  async migrateUsers(
    sourceUserIds: string[],
    discordRecipients: Record<string, string> = {},
    expectedMappingRevisions?: Record<string, string | null>,
  ): Promise<Job> {
    if (
      !sourceUserIds.length ||
      sourceUserIds.length > 100 ||
      new Set(sourceUserIds).size !== sourceUserIds.length
    )
      throw new ServiceError('Select 1–100 distinct Emby users.');
    if (Object.keys(discordRecipients).some((id) => !sourceUserIds.includes(id)))
      throw new ServiceError('A Discord recipient must belong to a selected source user.');
    if (
      expectedMappingRevisions &&
      (Object.keys(expectedMappingRevisions).length !== sourceUserIds.length ||
        Object.keys(expectedMappingRevisions).some((id) => !sourceUserIds.includes(id)) ||
        sourceUserIds.some((id) => !Object.hasOwn(expectedMappingRevisions, id)))
    )
      throw new ServiceError('Mapping revisions must cover exactly the selected Emby users.');
    const settings = this.store.settings();
    this.requireServer(settings, 'emby');
    this.requireServer(settings, 'jellyfin');
    const recipientSlots = new Set<string>();
    const requests = sourceUserIds.map((id): JobRequest => {
      const mapping = this.mappings.getForSource(id, settings);
      if (expectedMappingRevisions && expectedMappingRevisions[id] !== (mapping?.revision ?? null))
        throw new ServiceError(
          'The user mapping changed after preview. Review a new preview before migrating.',
        );
      const recipient = Object.hasOwn(discordRecipients, id) ? discordRecipients[id] : undefined;
      const slot = mapping?.membership_slot ?? 1;
      const member = recipient ? this.memberships.get(recipient, settings) : null;
      if (recipient) {
        const slotKey = `${recipient}:${slot}`;
        if (recipientSlots.has(slotKey))
          throw new ServiceError(
            'Choose a different Discord recipient or approved membership slot for each account.',
          );
        recipientSlots.add(slotKey);
        if (slot > 1) {
          const member = this.memberships.get(recipient, settings);
          if (!member?.active || slot > member.account_limit)
            throw new ServiceError(
              'Assign an active membership tier covering this account slot before migrating.',
            );
        }
      }
      if (recipient && mapping?.discord_user_id && mapping.discord_user_id !== recipient)
        throw new ServiceError(
          'The selected Discord recipient differs from this approved user mapping.',
        );
      return {
        source_user_id: id,
        discord_user_id: recipient,
        membership_slot: slot,
        ...(member ? { membership_revision: member.revision } : {}),
        ...(mapping
          ? {
              username: mapping.target_username,
              mapping_id: mapping.id,
              mapping_revision: mapping.revision,
            }
          : {}),
      };
    });
    await this.validateRecipients(Object.values(discordRecipients));
    return this.queue('migrate', requests);
  }
  private async requireRoleServer(client: MediaAPI, role: AccountRole): Promise<void> {
    const info = await client.systemInfo();
    this.checkStopped();
    if (info.Id !== role.server_id)
      throw new ServiceError(
        'The Jellyfin server identity changed. No role settings were applied.',
      );
  }
  private assertDefaultRole(
    template: ProvisioningDefaults,
    request: JobRequest,
    settings: Settings,
  ): void {
    const role = template.accountRole;
    const current = this.store.settings();
    if ((current.default_role_id || '') !== (settings.default_role_id || ''))
      throw new ServiceError('The default account role changed. Review and start a new job.');
    if (!role) {
      if (request.default_role_revision)
        throw new ServiceError('The default account role changed. Review a new job.');
      return;
    }
    if (
      current.default_role_id !== role.id ||
      settings.default_role_id !== role.id ||
      request.default_role_revision !== role.revision ||
      this.roles.get(role.id, current)?.revision !== role.revision
    )
      throw new ServiceError('The default account role changed. Review and start a new job.');
  }
  private assertRoleUpdate(
    request: JobRequest,
    settings: Settings,
  ): { role: AccountRole; assignment: RoleAssignment } {
    this.checkStopped();
    const current = this.store.settings();
    if (current.jellyfin_url !== settings.jellyfin_url)
      throw new ServiceError('The Jellyfin destination changed. Review this role update.');
    const role = this.roles.get(request.role_id || '', settings);
    const assignment = this.roles.getAssignment(request.target_user_id || '', settings);
    if (
      !role ||
      role.revision !== request.role_revision ||
      !assignment ||
      assignment.role_id !== role.id ||
      assignment.revision !== request.role_assignment_revision ||
      assignment.username !== request.username
    )
      throw new ServiceError(
        'The role or account assignment changed. Review a new update before applying.',
      );
    return { role, assignment };
  }
  private assertRoleTarget(
    user: MediaUser,
    expectedId: string,
    expectedName: string,
    settings: Settings,
  ): void {
    if (
      user.Id !== expectedId ||
      user.Name !== expectedName ||
      user.Policy?.IsAdministrator !== false ||
      user.Policy?.IsDisabled !== false ||
      user.Id === settings.template_user_id ||
      user.Id === this.store.settings().template_user_id
    )
      throw new ServiceError(
        'The Jellyfin account changed or is protected. No further role settings were applied.',
      );
  }
  async applyRole(
    roleId: string,
    roleRevision: string,
    userIds: string[],
    sections: RoleSection[],
  ): Promise<Job> {
    if (
      !userIds.length ||
      userIds.length > 100 ||
      new Set(userIds).size !== userIds.length ||
      userIds.some((id) => typeof id !== 'string' || !id || id.length > 128) ||
      !sections.length ||
      sections.length > 3 ||
      new Set(sections).size !== sections.length ||
      sections.some((section) => !['policy', 'configuration', 'display'].includes(section))
    )
      throw new ServiceError(
        'Select 1–100 distinct assigned accounts and one or more settings groups.',
      );
    const settings = this.store.settings();
    const role = this.roles.get(roleId, settings);
    if (!role || role.revision !== roleRevision)
      throw new ServiceError('This account role changed. Reload it before applying.');
    if (sections.includes('display') && role.parameters.display === null)
      throw new ServiceError('This role has no Home screen preferences.');
    return this.withClient(settings, 'jellyfin', async (client) => {
      await this.requireRoleServer(client, role);
      if (
        sections.includes('display') &&
        (!client.displayPreferences || !client.setDisplayPreferences)
      )
        throw new ServiceError('This Jellyfin client cannot update Home screen preferences.');
      const requests: JobRequest[] = [];
      for (const userId of userIds) {
        const assignment = this.roles.getAssignment(userId, settings);
        if (!assignment || assignment.role_id !== role.id)
          throw new ServiceError(
            'Assign this role to every selected account before applying settings.',
          );
        const user = await client.user(userId);
        this.assertRoleTarget(user, userId, assignment.username, settings);
        const request: JobRequest = {
          username: user.Name,
          target_user_id: user.Id,
          role_id: role.id,
          role_revision: role.revision,
          role_assignment_revision: assignment.revision,
          role_sections: [...sections],
        };
        this.assertRoleUpdate(request, settings);
        requests.push(request);
      }
      for (const request of requests) this.assertRoleUpdate(request, settings);
      return this.queue('role_update', requests);
    });
  }
  private async oneRoleUpdate(
    job: Job,
    request: JobRequest,
    settings: Settings,
    client: MediaAPI,
  ): Promise<void> {
    const result: JobResult = {
      username: request.username || '',
      status: 'running',
      target_user_id: request.target_user_id,
      role_id: request.role_id,
      role_sections: [],
    };
    job.results.push(result);
    this.save(job);
    try {
      const { role } = this.assertRoleUpdate(request, settings);
      result.role_name = role.name;
      if (
        !request.role_sections?.length ||
        request.role_sections.length > 3 ||
        new Set(request.role_sections).size !== request.role_sections.length ||
        request.role_sections.some(
          (section) => !['policy', 'configuration', 'display'].includes(section),
        )
      )
        throw new ServiceError('The queued role update is invalid. Review a new update.');
      for (const section of request.role_sections) {
        await this.requireRoleServer(client, role);
        this.assertRoleUpdate(request, settings);
        const user = await client.user(request.target_user_id!);
        this.assertRoleUpdate(request, settings);
        this.assertRoleTarget(user, request.target_user_id!, request.username!, settings);
        if (section === 'display') {
          if (
            role.parameters.display === null ||
            !client.displayPreferences ||
            !client.setDisplayPreferences
          )
            throw new ServiceError(
              'Home screen preferences are unavailable for this role or server.',
            );
          const current = await client.displayPreferences(user.Id);
          const confirmed = await client.user(user.Id);
          this.assertRoleUpdate(request, settings);
          this.assertRoleTarget(confirmed, user.Id, user.Name, settings);
          await client.setDisplayPreferences(
            user.Id,
            mergeRoleSection('display', current, role.parameters),
          );
        } else if (section === 'policy') {
          await client.setPolicy(user.Id, mergeRoleSection(section, user.Policy!, role.parameters));
        } else {
          await client.setConfiguration(
            user.Id,
            mergeRoleSection(section, user.Configuration ?? {}, role.parameters),
          );
        }
        // A completed remote write remains part of the result even if a local role
        // edit prevents us from stamping the assignment as current afterwards.
        result.role_sections!.push(section);
        this.save(job);
        const { assignment } = this.assertRoleUpdate(request, settings);
        this.roles.markApplied(user.Id, role.id, role.revision, assignment.revision, settings, [
          section,
        ]);
      }
      result.status = 'completed';
    } catch (error) {
      if (error instanceof StoppedError) throw error;
      result.status = 'failed';
      result.error =
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'Role settings could not be fully applied. Review completed groups before retrying.';
    }
    this.save(job);
  }
  private queue(kind: string, requests: JobRequest[]): Job {
    if (this.stopping) throw new ServiceError('The app is stopping. Retry after it restarts.');
    const timestamp = now();
    const job: Job = {
      id: randomUUID().replaceAll('-', ''),
      kind,
      status: 'queued',
      created_at: timestamp,
      updated_at: timestamp,
      progress: { processed: 0, total: requests.length },
      results: [],
      ...(kind === 'membership'
        ? { membership_discord_user_id: requests[0]?.discord_user_id ?? undefined }
        : {}),
    };
    const settings = this.store.settings();
    if (
      kind !== 'role_update' &&
      requests.some((request) => request.access_disabled === undefined) &&
      settings.default_role_id
    ) {
      const role = this.roles.get(settings.default_role_id, settings);
      if (!role)
        throw new ServiceError('The default account role is unavailable. Review Settings.');
      requests = requests.map((request) => ({ ...request, default_role_revision: role.revision }));
    }
    this.store.saveQueuedJob(job, requests, settings);
    this.schedule(job, requests, settings);
    return structuredClone(job);
  }
  private schedule(job: Job, requests: JobRequest[], settings: Settings): void {
    if (this.jobTasks.has(job.id)) return;
    const task = Promise.resolve().then(() => this.run(job, requests, settings));
    this.jobTasks.set(job.id, task);
    void task.finally(() => this.jobTasks.delete(job.id)).catch(() => {});
  }
  getJob(id: string): Job {
    const job = this.store.job(id);
    if (!job) throw new ServiceError('Job not found.');
    return job;
  }
  private save(job: Job): void {
    job.updated_at = now();
    this.store.saveJob(job);
  }
  private async provision(
    jellyfin: MediaAPI,
    settings: Settings,
    template: ProvisioningDefaults,
    username: string,
    allowExisting: boolean,
    recoverTargetId?: string,
    mapping: UserMapping | null = null,
    guard: () => void = () => {},
  ): Promise<[MediaUser, boolean, string | null]> {
    const roleGuard = async () => {
      if (template.accountRole) await this.requireRoleServer(jellyfin, template.accountRole);
      guard();
    };
    let target = this.mappedTarget(
      await jellyfin.users(),
      mapping,
      username,
      settings,
      recoverTargetId,
    );
    guard();
    const local = this.store.account(username);
    if (target?.Id === template.Id || (target && target.Id === settings.template_user_id))
      throw new ServiceError('The template account cannot be a destination account.');
    if (target?.Policy?.IsAdministrator)
      throw new ServiceError('A Jellyfin administrator cannot be a destination account.');
    if (target?.Policy?.IsDisabled && !recoverTargetId)
      throw new ServiceError('A disabled Jellyfin account cannot be a migration destination.');
    if (target && template.accountRole && (recoverTargetId || local?.status === 'provisioning')) {
      await roleGuard();
      const confirmed = await jellyfin.user(target.Id);
      guard();
      this.assertRoleTarget(confirmed, target.Id, username, settings);
      const assignment = this.roles.getAssignment(target.Id, settings);
      if (assignment && assignment.role_id !== template.accountRole.id)
        throw new ServiceError(
          'The account has a different role assignment. Review it before recovering account defaults.',
        );
    }
    let password: string | null = null;
    if (recoverTargetId) {
      if (
        !target ||
        target.Id !== recoverTargetId ||
        !local ||
        !['uncertain', 'provisioning'].includes(local.status) ||
        (local.remote_id && local.remote_id !== target.Id)
      )
        throw new ServiceError(
          'Recovery target changed. Inspect the account again; no password was reset.',
        );
      password = generatePassword();
      this.store.saveAccount(username, target.Id, 'provisioning', password);
      await roleGuard();
      await jellyfin.setPassword(target.Id, password);
    }
    if (target) {
      if (recoverTargetId) {
        /* Explicit inspected recovery already reset this tracked account. */
      } else if (local && local.remote_id === target.Id && local.status === 'provisioning') {
        password = this.store.accountPassword(local) ?? generatePassword();
        await roleGuard();
        await jellyfin.setPassword(target.Id, password);
      } else if (allowExisting) return [target, false, null];
      else
        throw new ServiceError(
          'This Jellyfin username already exists. Its password and permissions were preserved. Use migration to merge watch history.',
        );
    } else {
      if (local?.status === 'uncertain')
        throw new ServiceError(
          'An earlier creation request had an uncertain outcome. Inspect Jellyfin before retrying this username.',
        );
      password = generatePassword();
      this.store.saveAccount(username, null, 'provisioning', password);
      await roleGuard();
      try {
        target = await jellyfin.createUser(username, password);
      } catch (error) {
        if (error instanceof MediaError && [401, 403].includes(error.statusCode ?? 0)) {
          this.store.saveAccount(username, null, 'rejected');
          throw error;
        }
        this.store.saveAccount(username, null, 'uncertain');
        throw new ServiceError(
          'Account creation outcome is uncertain. Inspect Jellyfin before retrying; no password was reset.',
        );
      }
      this.store.saveAccount(username, target.Id, 'provisioning', password);
    }
    guard();
    if (template.accountRole) {
      await roleGuard();
      const live = await jellyfin.user(target.Id);
      guard();
      this.assertRoleTarget(live, target.Id, username, settings);
      await jellyfin.setPolicy(
        target.Id,
        mergeRoleSection('policy', live.Policy ?? {}, template.accountRole.parameters),
      );
      await roleGuard();
      const configured = await jellyfin.user(target.Id);
      guard();
      this.assertRoleTarget(configured, target.Id, username, settings);
      await jellyfin.setConfiguration(
        target.Id,
        mergeRoleSection(
          'configuration',
          configured.Configuration ?? {},
          template.accountRole.parameters,
        ),
      );
    } else {
      await jellyfin.setPolicy(target.Id, templatePolicy(template));
      guard();
      await jellyfin.setConfiguration(target.Id, structuredClone(template.Configuration ?? {}));
    }
    return [target, true, password];
  }
  private async one(
    job: Job,
    request: JobRequest,
    settings: Settings,
    jellyfin: MediaAPI,
    template: ProvisioningDefaults,
  ): Promise<void> {
    let source: SourceSnapshot | null = null;
    let avatar: MediaUserImage | null = null;
    let mapping = this.requestMapping(request, settings);
    let destinationId: string | null = null;
    let username: string;
    const guard = () => {
      this.checkStopped();
      this.assertMembershipRequest(request, settings);
      this.assertDefaultRole(template, request, settings);
      this.assertMapping(mapping, request.source_user_id, settings);
      this.assertDestinationMapping(mapping, destinationId, username, settings);
    };
    if (request.source_user_id) {
      source = await this.withClient(settings, 'emby', (emby) =>
        readMigrationSource(emby, request.source_user_id!),
      );
      if (source.user.Id !== request.source_user_id)
        throw new ServiceError('Emby returned a different source account. Reload the user list.');
      if (mapping && source.user.Name !== mapping.source_username)
        throw new ServiceError('The mapped Emby account was renamed. Review its mapping.');
      username = mapping?.target_user_id
        ? validateExistingMappingUsername(mapping.target_username)
        : validateUsername(mapping?.target_username ?? source.user.Name);
    } else username = validateUsername(request.username ?? '');
    if (
      request.membership_revision &&
      request.username !== undefined &&
      request.username !== username
    )
      throw new ServiceError(
        'The source username changed after membership review. Review its mapping before retrying.',
      );
    guard();
    const currentTarget = this.mappedTarget(
      await jellyfin.users(),
      mapping,
      username,
      settings,
      request.recover_target_id,
    );
    destinationId = currentTarget?.Id ?? null;
    guard();
    const recipient = request.discord_user_id;
    if (recipient) {
      const slot = request.membership_slot ?? mapping?.membership_slot ?? 1;
      const identity = await this.recipientIdentity(recipient),
        link = this.store.link(recipient, slot);
      if (identity.id && identity.id !== recipient)
        throw new ServiceError(
          'Discord returned a different recipient identity. Review the mapping.',
        );
      const memberMapping = this.mappings.getForDiscord(recipient, settings, slot);
      if (memberMapping && memberMapping.id !== mapping?.id)
        throw new ServiceError(
          'This Discord user is approved for a different Emby mapping. Existing ownership was preserved.',
        );
      if (link && (link.username !== username || link.remote_id !== currentTarget?.Id))
        throw new ServiceError(
          'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
        );
      const member = request.membership_revision
        ? this.assertMembershipRequest(request, settings)
        : this.memberships.get(recipient, settings);
      if (slot > 1 && (!member?.active || slot > member.account_limit))
        throw new ServiceError('The membership no longer permits this account slot.');
      const approvedHouseholdName = Boolean(
        request.membership_revision &&
        member &&
        username === membershipUsername(member.base_username, slot),
      );
      if (slot > 1 && !link && mapping?.discord_user_id !== recipient && !approvedHouseholdName)
        throw new ServiceError(
          'Numbered membership accounts require an approved account slot and username.',
        );
      if (
        !link &&
        username !== identity.username &&
        mapping?.discord_user_id !== recipient &&
        !approvedHouseholdName
      )
        throw new ServiceError(
          "The destination username must match this recipient's Discord username or an approved mapping with their verified user ID.",
        );
      const existing = currentTarget ? this.store.linkForRemote(currentTarget.Id) : null;
      if (existing && (existing.discord_user_id !== recipient || existing.membership_slot !== slot))
        throw new ServiceError('This Jellyfin account is already linked to another Discord user.');
    }
    const result: JobResult = {
      username,
      ...(source ? { source_username: source.user.Name } : {}),
      ...(mapping ? { mapping_id: mapping.id } : {}),
      status: 'running',
      created: false,
      applied: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      already_played: 0,
      discord_delivery: 'not_requested',
    };
    if (source) {
      result.data = migrationDetails();
      for (const warning of source.warnings) migrationWarning(result.data, warning);
      // Read optional profile data before creating an account. It never enters persisted jobs.
      if (!currentTarget || this.store.account(username)?.status === 'provisioning')
        await this.withClient(settings, 'emby', async (emby) => {
          if (!emby.userImage) return;
          try {
            avatar = await emby.userImage(source!.user.Id);
          } catch {
            migrationWarning(
              result.data!,
              'The source profile picture could not be read. Other account data can still migrate.',
            );
          }
        });
    }
    guard();
    job.results.push(result);
    this.save(job);
    try {
      const [target, created, password] = await this.provision(
        jellyfin,
        settings,
        template,
        username,
        Boolean(request.source_user_id),
        request.recover_target_id,
        mapping,
        guard,
      );
      Object.assign(result, { created, target_user_id: target.Id });
      destinationId = target.Id;
      const publicUrl = settings.jellyfin_public_url || settings.jellyfin_url;
      if (password) {
        this.store.saveCredentials(job.id, username, password, publicUrl);
        this.store.saveAccount(username, target.Id, 'ready');
      }
      guard();
      if (mapping && !mapping.target_user_id)
        mapping = this.mappings.bindTarget(mapping.id, mapping.revision, target.Id, settings);
      // Recheck the stable identity and protection flags after provisioning, before personal data.
      const liveTarget = await jellyfin.user(target.Id);
      if (
        liveTarget.Id !== target.Id ||
        liveTarget.Name !== username ||
        liveTarget.Id === template.Id ||
        liveTarget.Id === settings.template_user_id ||
        liveTarget.Policy?.IsAdministrator ||
        liveTarget.Policy?.IsDisabled
      )
        throw new ServiceError(
          'The destination account changed or became protected. Review it before retrying.',
        );
      guard();
      if (created && template.accountRole) {
        const role = template.accountRole;
        this.assertRoleTarget(liveTarget, target.Id, username, settings);
        const previous = this.roles.getAssignment(target.Id, settings);
        if (previous && previous.role_id !== role.id)
          throw new ServiceError(
            'The account role was changed during provisioning. Review the account before retrying.',
          );
        const [assignment] = this.roles.assign(role.id, role.revision, [liveTarget], settings);
        const sections: RoleSection[] = ['policy', 'configuration'];
        Object.assign(result, { role_id: role.id, role_name: role.name, role_sections: sections });
        if (role.parameters.display !== null) {
          await this.requireRoleServer(jellyfin, role);
          guard();
          let preferences: JsonObject | undefined;
          try {
            if (!jellyfin.displayPreferences || !jellyfin.setDisplayPreferences)
              throw new ServiceError('Home preferences are unavailable.');
            preferences = await jellyfin.displayPreferences(target.Id);
          } catch (error) {
            if (error instanceof StoppedError) throw error;
            result.warnings = [
              'The account was created, but its Home screen preferences could not be applied. Review the role update before retrying.',
            ];
          }
          if (preferences) {
            guard();
            const confirmed = await jellyfin.user(target.Id);
            guard();
            this.assertRoleTarget(confirmed, target.Id, username, settings);
            try {
              await jellyfin.setDisplayPreferences!(
                target.Id,
                mergeRoleSection('display', preferences, role.parameters),
              );
              sections.push('display');
              this.save(job);
            } catch (error) {
              if (error instanceof StoppedError) throw error;
              result.warnings = [
                'The account was created, but its Home screen preferences could not be applied. Review the role update before retrying.',
              ];
            }
          }
          // Protection and identity errors are fatal; optional Home API failures
          // alone may leave an otherwise usable new account with a warning.
          await this.requireRoleServer(jellyfin, role);
          const confirmed = await jellyfin.user(target.Id);
          this.assertRoleTarget(confirmed, target.Id, username, settings);
        }
        guard();
        this.roles.markApplied(
          target.Id,
          role.id,
          role.revision,
          assignment!.revision,
          settings,
          sections,
        );
      }
      if (recipient) {
        const slot = request.membership_slot ?? mapping?.membership_slot ?? 1;
        const existing = this.store.linkForRemote(target.Id);
        if (
          existing &&
          (existing.discord_user_id !== recipient || existing.membership_slot !== slot)
        )
          throw new ServiceError(
            'This Jellyfin account is already linked to another Discord user.',
          );
        const previous = this.store.link(recipient, slot);
        if (previous && (previous.remote_id !== target.Id || previous.username !== username))
          throw new ServiceError(
            'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
          );
        this.store.saveLink(
          recipient,
          username,
          target.Id,
          Boolean(previous?.disabled_by_jellyport),
          slot,
        );
      }
      if (source && result.data) {
        if (created) {
          if (template.accountRole)
            result.data.preferences = Object.keys(template.accountRole.parameters.configuration);
          const preferences = portableConfiguration(
            source.user.Configuration,
            template.Configuration,
          );
          if (!template.accountRole && preferences.copied.length) {
            guard();
            try {
              await jellyfin.setConfiguration(target.Id, preferences.configuration);
              result.data.preferences = preferences.copied;
            } catch {
              migrationWarning(
                result.data,
                'Playback preferences could not be copied. The template configuration was preserved.',
              );
            }
          }
          if (avatar && jellyfin.setUserImage) {
            guard();
            try {
              await jellyfin.setUserImage(target.Id, avatar);
              result.data.avatar = true;
            } catch {
              migrationWarning(
                result.data,
                'The profile picture could not be copied. Other account data can still migrate.',
              );
            }
          } else if (avatar)
            migrationWarning(result.data, 'This Jellyfin client cannot copy profile pictures.');
        }
        guard();
        const targetItems = await (jellyfin.migrationItems
          ? jellyfin.migrationItems(target.Id)
          : jellyfin.items(target.Id));
        const [plan, stats] = this.plan(
          source.items,
          targetItems,
          settings,
          source.playlists.length,
        );
        Object.assign(result, stats);
        result.unmatched_items = plan.unmatched.map((item) => ({
          name: item.Name ?? '',
          type: item.Type ?? '',
          id: item.Id,
        }));
        result.ambiguous_items = plan.ambiguous.map((item) => ({
          name: item.source.Name ?? '',
          id: item.source.Id,
          candidate_ids: item.candidates.map((candidate) => candidate.Id),
        }));
        this.save(job);
        result.applied = await migrateItemState(jellyfin, target.Id, plan, result.data, guard, () =>
          this.save(job),
        );
        guard();
        await migratePlaylists(
          this.store,
          settings,
          source.user.Id,
          target.Id,
          source.playlists,
          targetItems,
          jellyfin,
          result.data,
          guard,
          () => this.save(job),
        );
        guard();
      }
      if (recipient && password)
        try {
          await this.validateRecipients([recipient]);
          const identity = await this.recipientIdentity(recipient);
          if (
            (identity.id && identity.id !== recipient) ||
            this.store.link(recipient, request.membership_slot ?? mapping?.membership_slot ?? 1)
              ?.remote_id !== target.Id
          )
            throw new ServiceError(
              'The Discord recipient identity changed. Credentials were preserved for administrator review.',
            );
          guard();
          await this.requireBot().sendCredentials(
            recipient,
            username,
            password,
            publicUrl,
            this.recipientRequiresSubscription(recipient),
          );
          result.discord_delivery = 'sent';
          this.store.deleteCredentials(job.id, username);
        } catch {
          result.discord_delivery = 'failed';
          result.delivery_error =
            'Discord delivery failed. Credentials remain available for one-time reveal for 24 hours.';
        }
      else if (recipient) result.discord_delivery = 'skipped_existing_account';
      result.status =
        result.unmatched ||
        result.ambiguous ||
        result.discord_delivery === 'failed' ||
        result.data?.failed_items ||
        result.data?.warnings.length ||
        result.warnings?.length
          ? 'partial'
          : 'completed';
    } catch (error) {
      if (error instanceof StoppedError) throw error;
      result.status = 'failed';
      result.error =
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'This account could not be completed. Review server connectivity and run again; existing passwords are preserved.';
    }
    this.save(job);
  }
  private checkStopped(): void {
    if (this.stopping) throw new StoppedError();
  }
  private async run(job: Job, requests: JobRequest[], settings: Settings): Promise<void> {
    if (this.stopping || !this.store.claimQueuedJob(job.id)) return;
    job.status = 'running';
    this.save(job);
    try {
      await this.withClient(settings, 'jellyfin', async (jellyfin) => {
        const template =
          job.kind === 'role_update' ||
          requests.every((request) => request.access_disabled !== undefined)
            ? null
            : await this.template(jellyfin, settings);
        for (const request of requests) {
          await this.mutationMutex.run(async () => {
            this.checkStopped();
            try {
              if (request.access_disabled !== undefined) {
                const member = this.assertMembershipRequest(request, settings);
                if (!member || !request.discord_user_id || !request.target_user_id)
                  throw new ServiceError('Invalid queued membership action.');
                const link = this.store.link(request.discord_user_id, request.membership_slot);
                if (
                  !link ||
                  link.remote_id !== request.target_user_id ||
                  link.username !== request.username
                )
                  throw new ServiceError('The linked membership account changed. Review it first.');
                const family =
                  this.profiles.get('jellyfin', request.target_user_id, this.store.settings())
                    ?.family === true;
                if (!family) await this.recipientIdentity(request.discord_user_id);
                const available = await this.updateLinkedAccess(
                  jellyfin,
                  settings,
                  request.discord_user_id,
                  request.membership_slot!,
                  request.access_disabled,
                  () => {
                    this.checkStopped();
                    this.assertMembershipRequest(request, settings);
                  },
                );
                job.results.push({
                  username: request.username!,
                  target_user_id: request.target_user_id,
                  status: available ? 'completed' : 'partial',
                  created: false,
                  ...(!available
                    ? {
                        warnings: [
                          this.profiles.get(
                            'jellyfin',
                            request.target_user_id,
                            this.store.settings(),
                          )?.family
                            ? 'Family account access is managed manually. The membership access change was skipped.'
                            : 'This account was disabled outside Jellyport and remains disabled. Review it in Jellyfin.',
                        ],
                      }
                    : {}),
                });
              } else if (job.kind === 'role_update')
                await this.oneRoleUpdate(job, request, settings, jellyfin);
              else await this.one(job, request, settings, jellyfin, template!);
            } catch (error) {
              if (error instanceof StoppedError) throw error;
              if (!(error instanceof MediaError || error instanceof ServiceError)) throw error;
              job.results.push({
                username: request.username ?? request.source_user_id ?? '',
                status: 'failed',
                error: error.message,
              });
            }
            job.progress.processed++;
            this.save(job);
          });
        }
      });
      this.checkStopped();
      const statuses = job.results.map((result) => result.status);
      job.status = statuses.every((status) => status === 'completed')
        ? 'completed'
        : statuses.every((status) => status === 'failed')
          ? 'failed'
          : 'partial';
    } catch (error) {
      if (error instanceof StoppedError || this.stopping) {
        job.status = 'interrupted';
        job.error = 'App stopped during this job. Review results before starting another update.';
      } else {
        job.status = 'failed';
        job.error =
          error instanceof MediaError || error instanceof ServiceError
            ? error.message
            : 'Job failed unexpectedly. Check configuration and server availability.';
      }
    } finally {
      this.save(job);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.clients].map((client) => client.close()));
    await Promise.allSettled([...this.jobTasks.values()]);
  }
  async recordSubscription(incoming: SubscriptionInput): Promise<SubscriptionEvent> {
    const existing = this.store.subscription(String(incoming.id));
    if (existing) return existing;
    if (!['subscribe', 'cancel', 'expire'].includes(incoming.action))
      throw new ServiceError('Unknown subscription action.');
    const event: SubscriptionEvent = {
      id: String(incoming.id),
      action: incoming.action,
      username: incoming.username,
      discord_user_id: incoming.discord_user_id,
      source: incoming.source,
      detail: incoming.detail,
      emitted_at: incoming.emitted_at,
      status: 'pending',
      created_at: now(),
    };
    const settings = this.store.settings();
    if (event.discord_user_id && !this.recipientRequiresSubscription(event.discord_user_id)) {
      event.status = 'ignored';
      event.result =
        'Complimentary access is managed by an administrator; subscription event ignored.';
      this.store.saveSubscription(event);
      return event;
    }
    this.store.saveSubscription(event);
    let automatic =
      event.action === 'subscribe'
        ? settings.auto_provision
        : settings.auto_disable && (event.action === 'expire' || settings.disable_on_cancel);
    if (event.action === 'subscribe') {
      try {
        const tier = this.subscriptionTier(event, settings);
        event.tier_id = tier.id;
        event.account_limit = tier.account_limit;
        if (
          event.discord_user_id &&
          this.isMembershipDowngrade(event.discord_user_id, tier.account_limit, settings) &&
          !settings.auto_disable
        )
          automatic = false;
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        event.error = error.message;
        automatic = false;
      }
      this.store.saveSubscription(event);
    }
    if (automatic && event.discord_user_id)
      try {
        await this.applySubscription(event.id, true);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
      }
    return this.store.subscription(event.id)!;
  }
  async applySubscription(id: string, automatic = false): Promise<SubscriptionEvent> {
    return this.subscriptionMutex.run(async () => {
      const event = this.store.subscription(id);
      if (!event) throw new ServiceError('Subscription event not found.');
      if (['applied', 'ignored', 'processing'].includes(event.status)) return event;
      if (!event.discord_user_id)
        throw new ServiceError(
          'This message could not be resolved to one Discord user ID. Use a manual account action after verifying the member.',
        );
      if (!this.recipientRequiresSubscription(event.discord_user_id)) {
        event.status = 'ignored';
        event.result =
          'Complimentary access is managed by an administrator; subscription event ignored.';
        this.store.saveSubscription(event);
        return event;
      }
      const emitted = Date.parse(event.emitted_at ?? '');
      if (
        Number.isFinite(emitted) &&
        this.store
          .subscriptions()
          .some(
            (previous) =>
              previous.discord_user_id === event.discord_user_id &&
              previous.status === 'applied' &&
              Date.parse(previous.emitted_at ?? '') > emitted,
          )
      ) {
        event.status = 'ignored';
        event.result = 'A newer membership event was already applied; obsolete event ignored.';
        this.store.saveSubscription(event);
        return event;
      }
      event.status = 'processing';
      event.error = null;
      this.store.saveSubscription(event);
      try {
        const memberId = event.discord_user_id;
        const settings = this.store.settings();
        if (
          event.action === 'expire' &&
          ['discord_role', 'role_reconciliation'].includes(event.source ?? '')
        ) {
          const active = await this.requireBot().membershipActive(memberId);
          if (active === null)
            throw new ServiceError('Membership could not be verified. No account was disabled.');
          if (active) {
            event.status = 'ignored';
            event.result =
              'Member currently has the active role; obsolete expiration event ignored.';
            this.store.saveSubscription(event);
            return event;
          }
        }
        if (event.action === 'subscribe') {
          const tier = this.subscriptionTier(event, settings);
          if (
            automatic &&
            (!settings.auto_provision ||
              (this.isMembershipDowngrade(memberId, tier?.account_limit, settings) &&
                !settings.auto_disable))
          )
            throw new ServiceError(
              'This tier change requires administrator review under the current automation settings.',
            );
          event.tier_id = tier.id;
          event.account_limit = tier.account_limit;
          const job = await this.provisionMembership(memberId, tier.id);
          event.job_id = job.id;
          this.store.saveSubscription(event);
          await this.jobTasks.get(job.id);
          const outcome = this.getJob(job.id);
          if (
            ['failed', 'interrupted'].includes(outcome.status) ||
            outcome.results.some((result) => result.status === 'failed')
          )
            throw new ServiceError('Account provisioning failed. Review the linked job.');
          event.result =
            'Membership account allowance applied; existing passwords and history preserved.';
        } else {
          if (
            automatic &&
            (!settings.auto_disable || (event.action === 'cancel' && !settings.disable_on_cancel))
          )
            throw new ServiceError(
              'This access change requires administrator review under the current automation settings.',
            );
          await this.membershipMutex.run(() =>
            this.mutationMutex.run(async () => {
              this.checkStopped();
              const previous = this.memberships.get(memberId, this.store.settings());
              if (previous?.access_mode === 'complimentary') {
                event.status = 'ignored';
                event.result =
                  'Complimentary access is managed by an administrator; subscription event ignored.';
                return;
              }
              if (!previous && this.memberships.hasOtherScope(memberId, this.store.settings()))
                throw new ServiceError(
                  'This member belongs to a different paired server configuration. No account access was modified.',
                );
              const links = this.store.linksForMember(memberId);
              if (!links.length && !previous)
                throw new ServiceError(
                  'This Discord member has no Jellyport identity link. No account was disabled.',
                );
              const primary = this.store.link(memberId) ?? links[0];
              await this.withClient(settings, 'jellyfin', async (jellyfin) => {
                // Capture all slots after an in-flight account mutation finishes.
                for (const link of links)
                  this.assertLinkedTarget(await jellyfin.user(link.remote_id), link, settings);
                const member = this.memberships.save(
                  {
                    discord_user_id: memberId,
                    base_username: previous?.base_username ?? primary!.username,
                    tier_id: previous?.tier_id ?? 'sloop',
                    access_mode: previous?.access_mode ?? 'subscription',
                    account_limit: previous?.account_limit ?? 1,
                    active: false,
                    inactive_reason: event.action as 'cancel' | 'expire',
                  },
                  settings,
                  previous?.revision,
                );
                const guard = () => {
                  this.checkStopped();
                  if (
                    this.memberships.get(memberId, this.store.settings())?.revision !==
                    member.revision
                  )
                    throw new ServiceError(
                      'The membership changed. Review its current access before retrying.',
                    );
                };
                guard();
                for (const link of links)
                  await this.updateLinkedAccess(
                    jellyfin,
                    settings,
                    memberId,
                    link.membership_slot,
                    true,
                    guard,
                  );
              });
            }),
          );
          if (event.status !== 'ignored')
            event.result =
              'Eligible linked account access disabled; manually flagged Family accounts, passwords, and watch history preserved.';
        }
        if (event.status !== 'ignored') event.status = 'applied';
      } catch (error) {
        if (!this.recipientRequiresSubscription(event.discord_user_id)) {
          event.status = 'ignored';
          event.error = null;
          event.result =
            'Complimentary access is managed by an administrator; subscription event ignored.';
          this.store.saveSubscription(event);
          return event;
        }
        event.status = 'failed';
        event.error =
          error instanceof ServiceError || error instanceof MediaError
            ? error.message
            : 'Subscription action failed. Check bot connectivity and account links.';
        this.store.saveSubscription(event);
        throw new ServiceError(event.error);
      }
      this.store.saveSubscription(event);
      return event;
    });
  }
  private subscriptionTier(event: SubscriptionEvent, settings: Settings) {
    const tiers = settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS;
    if (event.source !== 'mee6_message' || !event.detail?.trim()) {
      const previous = event.discord_user_id
        ? this.memberships.get(event.discord_user_id, settings)
        : null;
      const tier = previous
        ? tiers.find((entry) => entry.id === previous.tier_id)
        : (tiers.find((entry) => entry.id === 'sloop' && entry.account_limit === 1) ??
          tiers.find((entry) => entry.account_limit === 1));
      if (!tier)
        throw new ServiceError('Choose a configured membership tier before applying this event.');
      return tier;
    }
    const tier = resolveMembershipTier(event.detail, tiers);
    if (!tier)
      throw new ServiceError(
        'This subscription plan is not configured. Map its exact plan name in Settings and review the event.',
      );
    return tier;
  }
  private isMembershipDowngrade(
    memberId: string,
    limit: number | undefined,
    settings: Settings,
  ): boolean {
    const previous = this.memberships.get(memberId, settings);
    const desired = limit ?? previous?.account_limit ?? 1;
    return (
      desired < (previous?.account_limit ?? 1) ||
      this.store
        .linksForMember(memberId)
        .some((link) => link.membership_slot > desired && !link.disabled_by_jellyport)
    );
  }
  ignoreSubscription(id: string): SubscriptionEvent {
    const event = this.store.subscription(id);
    if (!event) throw new ServiceError('Subscription event not found.');
    if (event.status === 'processing')
      throw new ServiceError('Wait for this subscription action to finish.');
    event.status = 'ignored';
    this.store.saveSubscription(event);
    return event;
  }
  private async setAccess(
    client: MediaAPI,
    remoteId: string,
    policy: JsonObject,
    memberId: string,
    disabled: boolean,
    slot = 1,
  ): Promise<void> {
    this.store.setLinkPending(memberId, disabled, slot);
    try {
      await client.setPolicy(remoteId, policy);
    } catch (error) {
      if (
        error instanceof MediaError &&
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        this.store.setLinkPending(memberId, null, slot);
      throw error;
    }
  }
  async reconcileMemberships(): Promise<void> {
    const settings = this.store.settings();
    if (!settings.discord_role_events || !settings.discord_member_role_id || !this.bot) return;
    const memberIds = new Set(this.store.links().map((link) => link.discord_user_id));
    for (const memberId of memberIds) {
      const links = this.store.linksForMember(memberId);
      const member = this.memberships.get(memberId, settings);
      if (
        member?.access_mode === 'complimentary' ||
        (!member && this.memberships.hasOtherScope(memberId, settings))
      )
        continue;
      const active = await this.bot.membershipActive(memberId);
      if (active === null) continue;
      if (active && member?.active === false && member.inactive_reason === 'cancel') continue;
      const limit = member?.account_limit ?? 1;
      const needsRenewal =
        member?.active === false ||
        links.some(
          (link) =>
            link.membership_slot <= limit &&
            (link.disabled_by_jellyport || link.pending_disabled !== null),
        );
      const needsExpiration = member
        ? member.active !== false
        : links.some((link) => !link.disabled_by_jellyport);
      if ((active && !needsRenewal) || (!active && !needsExpiration)) continue;
      const action = active ? 'subscribe' : 'expire';
      if (
        this.store
          .subscriptions()
          .some(
            (event) =>
              event.source === 'role_reconciliation' &&
              event.discord_user_id === memberId &&
              event.action === action &&
              ['pending', 'processing', 'failed'].includes(event.status),
          )
      )
        continue;
      await this.recordSubscription({
        id: `reconcile-${randomUUID()}`,
        action,
        discord_user_id: memberId,
        username: (this.store.link(memberId) ?? links[0])?.username,
        source: 'role_reconciliation',
        emitted_at: now(),
      });
    }
    if (settings.auto_provision) {
      const members = await this.bot.activeMembers();
      if (members === null) return;
      for (const member of members) {
        const known = this.memberships.get(member.id, settings);
        if (
          known?.access_mode === 'complimentary' ||
          (known?.active === false && known.inactive_reason === 'cancel') ||
          (!known && this.memberships.hasOtherScope(member.id, settings))
        )
          continue;
        if (
          this.store.link(member.id) ||
          this.store
            .subscriptions()
            .some(
              (event) =>
                event.source === 'role_reconciliation' &&
                event.discord_user_id === member.id &&
                event.action === 'subscribe' &&
                event.status !== 'ignored',
            )
        )
          continue;
        await this.recordSubscription({
          id: `reconcile-${randomUUID()}`,
          action: 'subscribe',
          discord_user_id: member.id,
          username: member.username,
          source: 'role_reconciliation',
          emitted_at: now(),
        });
      }
    }
  }
}
