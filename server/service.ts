import { randomInt, randomUUID } from 'node:crypto';
import { MediaError, ServiceError } from './errors.js';
import { caseFold, matchItems, type MatchPlan } from './matching.js';
import {
  isObject,
  MediaClient,
  type ClientFactory,
  type JsonObject,
  type MediaAPI,
  type MediaItem,
  type MediaKind,
  type MediaUser,
} from './media.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';

export { ServiceError } from './errors.js';
export interface JobRequest {
  username?: string;
  source_user_id?: string;
  discord_user_id?: string | null;
  recover_target_id?: string;
}
export interface JobStats {
  source_played: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  already_played: number;
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
}
export interface ServiceOptions {
  clientFactory?: ClientFactory;
  demo?: boolean;
}
interface PreviewUser {
  source_user_id: string;
  username: string;
  target_user_id: string | null;
  target_exists: boolean;
  stats: JobStats;
  unmatched: MediaItem[];
  ambiguous: MatchPlan['ambiguous'];
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
  constructor(
    readonly store: Store,
    options: ServiceOptions = {},
  ) {
    this.clientFactory =
      options.clientFactory ?? ((url, key, kind) => new MediaClient(url, key, kind));
    this.demo = options.demo ?? false;
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
  ): [MatchPlan, JobStats] {
    const played = source.filter((item) => item.UserData?.Played === true);
    const plan = matchItems(played, target, settings.path_mappings);
    return [
      plan,
      {
        source_played: played.length,
        matched: plan.matches.length,
        unmatched: plan.unmatched.length,
        ambiguous: plan.ambiguous.length,
        already_played: plan.matches.filter((match) => match.target.UserData?.Played).length,
      },
    ];
  }
  async preview(sourceUserIds: string[]): Promise<{ users: PreviewUser[]; mode: 'merge' }> {
    const settings = this.store.settings();
    return this.withClient(settings, 'emby', (emby) =>
      this.withClient(settings, 'jellyfin', async (jellyfin) => {
        const template = await this.template(jellyfin, settings),
          targets = await jellyfin.users();
        const users: PreviewUser[] = [];
        for (const sourceId of sourceUserIds) {
          const sourceUser = await emby.user(sourceId),
            username = validateUsername(sourceUser.Name),
            target = this.target(targets, username);
          if (target && (target.Id === template.Id || target.Policy?.IsAdministrator))
            throw new ServiceError(
              'A migration cannot target your template user or a Jellyfin administrator.',
            );
          const source = await emby.items(sourceId);
          let targetItems = await jellyfin.items(target?.Id ?? template.Id);
          if (!target)
            targetItems = targetItems.map((item) => ({ ...item, UserData: { Played: false } }));
          const [plan, stats] = this.plan(source, targetItems, settings);
          users.push({
            source_user_id: sourceId,
            username,
            target_user_id: target?.Id ?? null,
            target_exists: Boolean(target),
            stats,
            unmatched: plan.unmatched,
            ambiguous: plan.ambiguous,
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
  async recoveryInfo(
    username: string,
  ): Promise<{
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
    if (discordUserId) {
      await this.validateRecipients([discordUserId]);
      if ((await this.requireBot().recipientIdentity(discordUserId)).username !== username)
        throw new ServiceError(
          "Use the recipient's Discord username when recovering and linking an account.",
        );
    }
    return this.queue('recover', [
      { username, discord_user_id: discordUserId, recover_target_id: targetUserId },
    ]);
  }
  async migrateUsers(
    sourceUserIds: string[],
    discordRecipients: Record<string, string> = {},
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
    await this.validateRecipients(Object.values(discordRecipients));
    const settings = this.store.settings();
    this.requireServer(settings, 'emby');
    this.requireServer(settings, 'jellyfin');
    return this.queue(
      'migrate',
      sourceUserIds.map((id) => ({ source_user_id: id, discord_user_id: discordRecipients[id] })),
    );
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
  ): Promise<[MediaUser, boolean, string | null]> {
    let target = this.target(await jellyfin.users(), username);
    const local = this.store.account(username);
    if (target?.Id === template.Id)
      throw new ServiceError('The template account cannot be a destination account.');
    if (target?.Policy?.IsAdministrator)
      throw new ServiceError('A Jellyfin administrator cannot be a destination account.');
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
      await jellyfin.setPassword(target.Id, password);
    }
    if (target) {
      if (recoverTargetId) {
        /* Explicit inspected recovery already reset this tracked account. */
      } else if (local && local.remote_id === target.Id && local.status === 'provisioning') {
        password = this.store.accountPassword(local) ?? generatePassword();
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
    await jellyfin.setPolicy(target.Id, templatePolicy(template));
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
    let sourceItems: MediaItem[] | null = null,
      username: string;
    if (request.source_user_id) {
      const source = await this.withClient(settings, 'emby', async (emby) => ({
        user: await emby.user(request.source_user_id!),
        items: await emby.items(request.source_user_id),
      }));
      username = validateUsername(source.user.Name);
      sourceItems = source.items;
    } else username = validateUsername(request.username ?? '');
    const recipient = request.discord_user_id;
    if (recipient) {
      const identity = await this.requireBot().recipientIdentity(recipient),
        link = this.store.link(recipient);
      if (link && link.username !== username)
        throw new ServiceError(
          'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
        );
      if (!link && username !== identity.username)
        throw new ServiceError(
          "The Emby username must match this recipient's Discord username when first linking an account.",
        );
      const currentTarget = this.target(await jellyfin.users(), username);
      const existing = currentTarget ? this.store.linkForRemote(currentTarget.Id) : null;
      if (existing && existing.discord_user_id !== recipient)
        throw new ServiceError('This Jellyfin account is already linked to another Discord user.');
    }
    const result: JobResult = {
      username,
      status: 'running',
      created: false,
      applied: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      already_played: 0,
      discord_delivery: 'not_requested',
    };
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
      );
      Object.assign(result, { created, target_user_id: target.Id });
      if (recipient) {
        const existing = this.store.linkForRemote(target.Id);
        if (existing && existing.discord_user_id !== recipient)
          throw new ServiceError(
            'This Jellyfin account is already linked to another Discord user.',
          );
        const previous = this.store.link(recipient);
        this.store.saveLink(
          recipient,
          username,
          target.Id,
          Boolean(previous?.disabled_by_jellyport),
        );
      }
      const publicUrl = settings.jellyfin_public_url || settings.jellyfin_url;
      if (password) {
        this.store.saveCredentials(job.id, username, password, publicUrl);
        this.store.saveAccount(username, target.Id, 'ready');
      }
      if (sourceItems !== null) {
        const [plan, stats] = this.plan(sourceItems, await jellyfin.items(target.Id), settings);
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
        for (const match of plan.matches) {
          this.checkStopped();
          if (!match.target.UserData?.Played) {
            await jellyfin.markPlayed(target.Id, match.target.Id);
            result.applied = (result.applied ?? 0) + 1;
            if (result.applied % 20 === 0) this.save(job);
          }
        }
      }
      if (recipient && password)
        try {
          await this.requireBot().validateRecipient(recipient);
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
        result.unmatched || result.ambiguous || result.discord_delivery === 'failed'
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
