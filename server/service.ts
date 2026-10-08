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

export { ServiceError } from './errors.js';
export interface JobRequest {
  username?: string;
  source_user_id?: string;
  discord_user_id?: string | null;
  recover_target_id?: string;
  mapping_id?: string;
  mapping_revision?: string;
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
  sendCredentials(id: string, username: string, password: string, url: string): Promise<void>;
  membershipActive(id: string): Promise<boolean | null>;
  activeMembers(): Promise<Array<{ id: string; username: string }> | null>;
  searchMembers?(query: string): Promise<DiscordMemberSearchResult>;
}
export interface ServiceOptions {
  clientFactory?: ClientFactory;
  demo?: boolean;
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
  constructor(
    readonly store: Store,
    options: ServiceOptions = {},
  ) {
    this.clientFactory =
      options.clientFactory ?? ((url, key, kind) => new MediaClient(url, key, kind));
    this.demo = options.demo ?? false;
    this.mappings = new UserMappings(store);
  }
  resolveDiscordMapping(discordId: string): UserMapping | null {
    return this.mappings.getForDiscord(discordId, this.store.settings());
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
  private async template(client: MediaAPI, settings: Settings): Promise<MediaUser> {
    if (!settings.template_user_id)
      throw new ServiceError('Select your Jellyfin template user in Settings first.');
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
          if (target && (target.Id === template.Id || target.Policy?.IsAdministrator))
            throw new ServiceError(
              'A migration cannot target your template user or a Jellyfin administrator.',
            );
          if (target?.Policy?.IsDisabled)
            throw new ServiceError(
              'A disabled Jellyfin account cannot be a migration destination.',
            );
          let targetItems = await (jellyfin.migrationItems
            ? jellyfin.migrationItems(target?.Id ?? template.Id)
            : jellyfin.items(target?.Id ?? template.Id));
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
  private async validateRecipients(recipients: Iterable<string>): Promise<void> {
    for (const recipient of new Set(recipients)) {
      const bot = this.requireBot();
      try {
        await bot.validateRecipient(String(recipient));
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
      const identity = await this.requireBot().recipientIdentity(discordUserId);
      if (username !== identity.username)
        throw new ServiceError(
          "Use the recipient's Discord username, not their server nickname or display name.",
        );
    }
    this.requireServer(this.store.settings(), 'jellyfin');
    return this.queue('create', [{ username, discord_user_id: discordUserId }]);
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
        ? 'Inspect this Jellyfin account. Recovery will reset its password and apply your template; watch history is preserved.'
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
    if (discordUserId) {
      await this.validateRecipients([discordUserId]);
      if (
        (await this.requireBot().recipientIdentity(discordUserId)).username !== username &&
        mapping?.discord_user_id !== discordUserId
      )
        throw new ServiceError(
          "Use the recipient's Discord username when recovering and linking an account.",
        );
    }
    return this.queue('recover', [
      {
        username,
        discord_user_id: discordUserId,
        recover_target_id: targetUserId,
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
    if (new Set(Object.values(discordRecipients)).size !== Object.keys(discordRecipients).length)
      throw new ServiceError('Choose a different Discord recipient for each account.');
    if (
      expectedMappingRevisions &&
      (Object.keys(expectedMappingRevisions).length !== sourceUserIds.length ||
        Object.keys(expectedMappingRevisions).some((id) => !sourceUserIds.includes(id)) ||
        sourceUserIds.some((id) => !Object.hasOwn(expectedMappingRevisions, id)))
    )
      throw new ServiceError('Mapping revisions must cover exactly the selected Emby users.');
    await this.validateRecipients(Object.values(discordRecipients));
    const settings = this.store.settings();
    this.requireServer(settings, 'emby');
    this.requireServer(settings, 'jellyfin');
    const requests = sourceUserIds.map((id): JobRequest => {
      const mapping = this.mappings.getForSource(id, settings);
      if (expectedMappingRevisions && expectedMappingRevisions[id] !== (mapping?.revision ?? null))
        throw new ServiceError(
          'The user mapping changed after preview. Review a new preview before migrating.',
        );
      const recipient = Object.hasOwn(discordRecipients, id) ? discordRecipients[id] : undefined;
      if (recipient && mapping?.discord_user_id && mapping.discord_user_id !== recipient)
        throw new ServiceError(
          'The selected Discord recipient differs from this approved user mapping.',
        );
      return {
        source_user_id: id,
        discord_user_id: recipient,
        ...(mapping
          ? {
              username: mapping.target_username,
              mapping_id: mapping.id,
              mapping_revision: mapping.revision,
            }
          : {}),
      };
    });
    return this.queue('migrate', requests);
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
    };
    const settings = this.store.settings();
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
    template: MediaUser,
    username: string,
    allowExisting: boolean,
    recoverTargetId?: string,
    mapping: UserMapping | null = null,
    guard: () => void = () => {},
  ): Promise<[MediaUser, boolean, string | null]> {
    let target = this.mappedTarget(
      await jellyfin.users(),
      mapping,
      username,
      settings,
      recoverTargetId,
    );
    guard();
    const local = this.store.account(username);
    if (target?.Id === template.Id)
      throw new ServiceError('The template account cannot be a destination account.');
    if (target?.Policy?.IsAdministrator)
      throw new ServiceError('A Jellyfin administrator cannot be a destination account.');
    if (target?.Policy?.IsDisabled && !recoverTargetId)
      throw new ServiceError('A disabled Jellyfin account cannot be a migration destination.');
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
      guard();
      await jellyfin.setPassword(target.Id, password);
    }
    if (target) {
      if (recoverTargetId) {
        /* Explicit inspected recovery already reset this tracked account. */
      } else if (local && local.remote_id === target.Id && local.status === 'provisioning') {
        password = this.store.accountPassword(local) ?? generatePassword();
        guard();
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
      guard();
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
    await jellyfin.setPolicy(target.Id, templatePolicy(template));
    guard();
    await jellyfin.setConfiguration(target.Id, structuredClone(template.Configuration ?? {}));
    return [target, true, password];
  }
  private async one(
    job: Job,
    request: JobRequest,
    settings: Settings,
    jellyfin: MediaAPI,
    template: MediaUser,
  ): Promise<void> {
    let source: SourceSnapshot | null = null;
    let avatar: MediaUserImage | null = null;
    let mapping = this.requestMapping(request, settings);
    let destinationId: string | null = null;
    let username: string;
    const guard = () => {
      this.checkStopped();
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
      const identity = await this.requireBot().recipientIdentity(recipient),
        link = this.store.link(recipient);
      if (identity.id && identity.id !== recipient)
        throw new ServiceError(
          'Discord returned a different recipient identity. Review the mapping.',
        );
      const memberMapping = this.mappings.getForDiscord(recipient, settings);
      if (memberMapping && memberMapping.id !== mapping?.id)
        throw new ServiceError(
          'This Discord user is approved for a different Emby mapping. Existing ownership was preserved.',
        );
      if (link && (link.username !== username || link.remote_id !== currentTarget?.Id))
        throw new ServiceError(
          'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
        );
      if (!link && username !== identity.username && mapping?.discord_user_id !== recipient)
        throw new ServiceError(
          "The destination username must match this recipient's Discord username or an approved mapping with their verified user ID.",
        );
      const existing = currentTarget ? this.store.linkForRemote(currentTarget.Id) : null;
      if (existing && existing.discord_user_id !== recipient)
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
        liveTarget.Policy?.IsAdministrator ||
        liveTarget.Policy?.IsDisabled
      )
        throw new ServiceError(
          'The destination account changed or became protected. Review it before retrying.',
        );
      guard();
      if (recipient) {
        const existing = this.store.linkForRemote(target.Id);
        if (existing && existing.discord_user_id !== recipient)
          throw new ServiceError(
            'This Jellyfin account is already linked to another Discord user.',
          );
        const previous = this.store.link(recipient);
        if (previous && (previous.remote_id !== target.Id || previous.username !== username))
          throw new ServiceError(
            'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
          );
        this.store.saveLink(
          recipient,
          username,
          target.Id,
          Boolean(previous?.disabled_by_jellyport),
        );
      }
      if (source && result.data) {
        if (created) {
          const preferences = portableConfiguration(
            source.user.Configuration,
            template.Configuration,
          );
          if (preferences.copied.length) {
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
          await this.requireBot().validateRecipient(recipient);
          const identity = await this.requireBot().recipientIdentity(recipient);
          if (
            (identity.id && identity.id !== recipient) ||
            this.store.link(recipient)?.remote_id !== target.Id
          )
            throw new ServiceError(
              'The Discord recipient identity changed. Credentials were preserved for administrator review.',
            );
          guard();
          await this.requireBot().sendCredentials(recipient, username, password, publicUrl);
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
        result.data?.warnings.length
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
        const template = await this.template(jellyfin, settings);
        for (const request of requests) {
          await this.mutationMutex.run(async () => {
            this.checkStopped();
            try {
              await this.one(job, request, settings, jellyfin, template);
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
        job.error =
          'App stopped during this job. Review results before resuming watch-state merging.';
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
    this.store.saveSubscription(event);
    const settings = this.store.settings();
    const automatic =
      event.action === 'subscribe'
        ? settings.auto_provision
        : settings.auto_disable && (event.action === 'expire' || settings.disable_on_cancel);
    if (automatic && event.discord_user_id)
      try {
        await this.applySubscription(event.id, true);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
      }
    return this.store.subscription(event.id)!;
  }
  async applySubscription(id: string, _automatic = false): Promise<SubscriptionEvent> {
    return this.subscriptionMutex.run(async () => {
      const event = this.store.subscription(id);
      if (!event) throw new ServiceError('Subscription event not found.');
      if (['applied', 'ignored', 'processing'].includes(event.status)) return event;
      if (!event.discord_user_id)
        throw new ServiceError(
          'This message could not be resolved to one Discord user ID. Use a manual account action after verifying the member.',
        );
      event.status = 'processing';
      event.error = null;
      this.store.saveSubscription(event);
      try {
        const memberId = event.discord_user_id,
          settings = this.store.settings();
        let link = this.store.link(memberId);
        const identity =
          event.action === 'subscribe' ? await this.requireBot().recipientIdentity(memberId) : null;
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
        if (event.action === 'subscribe' && !link) {
          const mapping = this.mappings.getForDiscord(memberId, settings);
          if (mapping) {
            const job = await this.migrateUsers([mapping.source_user_id], {
              [mapping.source_user_id]: memberId,
            });
            event.job_id = job.id;
            this.store.saveSubscription(event);
            await this.jobTasks.get(job.id);
            if (['failed', 'interrupted'].includes(this.getJob(job.id).status))
              throw new ServiceError('Mapped account migration failed. Review the linked job.');
          } else {
            const username = identity!.username;
            const target = await this.withClient(settings, 'jellyfin', async (jellyfin) =>
              this.target(await jellyfin.users(), username),
            );
            if (target)
              throw new ServiceError(
                'A Jellyfin account already exists without a Discord identity link. Link it through an admin-approved migration first.',
              );
            const sources =
              settings.emby_url && settings.emby_api_key
                ? (await this.embyUsers()).filter((user) => user.Name === username)
                : [];
            if (sources.length > 1)
              throw new ServiceError('More than one Emby account matches this username.');
            const job = sources.length
              ? await this.migrateUsers([sources[0]!.Id], { [sources[0]!.Id]: memberId })
              : await this.createAccount(username, memberId);
            event.job_id = job.id;
            this.store.saveSubscription(event);
            await this.jobTasks.get(job.id);
            if (['failed', 'interrupted'].includes(this.getJob(job.id).status))
              throw new ServiceError('Account provisioning failed. Review the linked job.');
          }
        } else {
          if (!link)
            throw new ServiceError(
              'This Discord member has no Jellyport identity link. No account was disabled.',
            );
          await this.mutationMutex.run(() =>
            this.withClient(settings, 'jellyfin', async (jellyfin) => {
              this.checkStopped();
              const target = await jellyfin.user(link!.remote_id),
                policy = structuredClone(target.Policy ?? {});
              if (
                !Object.keys(policy).length ||
                policy.IsAdministrator ||
                target.Id === settings.template_user_id ||
                target.Name !== link!.username
              )
                throw new ServiceError(
                  'The linked account changed or is protected. Review it manually.',
                );
              const disabled = Boolean(policy.IsDisabled),
                pending = link!.pending_disabled;
              if (pending !== null && pending !== undefined && disabled === Boolean(pending)) {
                this.store.saveLink(memberId, link!.username, target.Id, disabled);
                link = this.store.link(memberId);
              }
              if (event.action === 'subscribe') {
                if (link!.disabled_by_jellyport && disabled) {
                  policy.IsDisabled = false;
                  await this.setAccess(jellyfin, target.Id, policy, memberId, false);
                  this.store.saveLink(memberId, link!.username, target.Id, false);
                } else if (!disabled)
                  this.store.saveLink(memberId, link!.username, target.Id, false);
              } else if (!disabled) {
                policy.IsDisabled = true;
                await this.setAccess(jellyfin, target.Id, policy, memberId, true);
                this.store.saveLink(memberId, link!.username, target.Id, true);
              }
            }),
          );
          event.result = 'Account access updated; password and watch history preserved.';
        }
        event.status = 'applied';
      } catch (error) {
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
  ): Promise<void> {
    this.store.setLinkPending(memberId, disabled);
    try {
      await client.setPolicy(remoteId, policy);
    } catch (error) {
      if (
        error instanceof MediaError &&
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        this.store.setLinkPending(memberId, null);
      throw error;
    }
  }
  async reconcileMemberships(): Promise<void> {
    const settings = this.store.settings();
    if (!settings.discord_role_events || !settings.discord_member_role_id || !this.bot) return;
    for (const link of this.store.links()) {
      const active = await this.bot.membershipActive(link.discord_user_id);
      if (
        active === null ||
        (active && !link.disabled_by_jellyport) ||
        (!active && link.disabled_by_jellyport)
      )
        continue;
      const action = active ? 'subscribe' : 'expire';
      if (
        this.store
          .subscriptions()
          .some(
            (event) =>
              event.source === 'role_reconciliation' &&
              event.discord_user_id === link.discord_user_id &&
              event.action === action &&
              ['pending', 'processing'].includes(event.status),
          )
      )
        continue;
      await this.recordSubscription({
        id: `reconcile-${randomUUID()}`,
        action,
        discord_user_id: link.discord_user_id,
        username: link.username,
        source: 'role_reconciliation',
        emitted_at: now(),
      });
    }
    if (settings.auto_provision) {
      const members = await this.bot.activeMembers();
      if (members === null) return;
      for (const member of members) {
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
