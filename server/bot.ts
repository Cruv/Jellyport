import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Guild,
  type GuildMember,
  type Message,
  type PartialGuildMember,
} from 'discord.js';
import type { Settings as AppSettings } from './types.js';
import type { Job, SubscriptionInput } from './service.js';
import type { MediaUser } from './media.js';
import type { UserMapping } from './user-mappings.js';
import type { DiscordMemberSearchResult, DiscordMemberSummary } from './discord-members.js';

export class BotError extends Error {}

/** The bot only calls these service operations; Discord never owns account state. */
export interface BotService {
  createAccount(username: string, discordId?: string): Promise<Job>;
  migrateUsers(ids: string[], recipients?: Record<string, string>): Promise<Job>;
  embyUsers(): Promise<MediaUser[]>;
  resolveDiscordMapping?(discordId: string): UserMapping | null;
  getJob(id: string): Job | null | undefined;
  recordSubscription(event: SubscriptionInput & { guild_id?: string }): Promise<unknown>;
  reconcileMemberships?(): Promise<unknown>;
}

type Settings = Partial<AppSettings>;
type Identity = { id: string; username: string };
type Authorization = { administrator: boolean; roleIds: Iterable<unknown>; adminRoleId?: unknown };
type Eligibility = { bot: boolean; roleIds: Iterable<unknown>; memberRoleId?: unknown };

export function snowflake(value: unknown): string | null {
  // Discord IDs cannot pass through JS numbers once they exceed the safe integer range.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    return null;
  const text = String(value);
  if (!/^[0-9]{1,20}$/.test(text)) return null;
  const number = BigInt(text);
  return number > 0n && number < 2n ** 64n ? String(number) : null;
}

export function commandAuthorized(
  guildId: unknown,
  configuredGuildId: unknown,
  options: Authorization,
): boolean {
  const configured = snowflake(configuredGuildId);
  if (!configured || snowflake(guildId) !== configured) return false;
  const role = snowflake(options.adminRoleId);
  return (
    options.administrator || (!!role && [...options.roleIds].some((id) => snowflake(id) === role))
  );
}

export function recipientEligible(
  guildId: unknown,
  configuredGuildId: unknown,
  options: Eligibility,
): boolean {
  const configured = snowflake(configuredGuildId);
  if (options.bot || !configured || snowflake(guildId) !== configured) return false;
  if (options.memberRoleId == null || options.memberRoleId === '') return true;
  const role = snowflake(options.memberRoleId);
  return !!role && [...options.roleIds].some((id) => snowflake(id) === role);
}

const recipientPattern = '(?<recipient><@!?[0-9]{1,20}>|@?[A-Za-z0-9_.]{1,32})';
const subscribed = new RegExp(
  '^Good[ \\t]+news[ \\t]+captain![ \\t]+' +
    recipientPattern +
    '[ \\t]+just[ \\t]+subscribed[ \\t]+to[ \\t]+(?<plan>[^\\r\\n!]{1,100})![ \\t]*$',
  'i',
);
const cancelled = new RegExp(
  '^Bad[ \\t]+news[ \\t]+captain![ \\t]+' +
    recipientPattern +
    '[ \\t]+just[ \\t]+cancel(?:led|ed)[ \\t]+their[ \\t]+subscription\\.[ \\t]*$',
  'i',
);

export function parseSubscriptionMessage(content: unknown): {
  action: 'subscribe' | 'cancel';
  discord_user_id: string | null;
  username: string | null;
  detail: string;
} | null {
  if (typeof content !== 'string' || content.length > 300 || /[\r\n]/.test(content)) return null;
  let match = subscribed.exec(content.trim());
  let action: 'subscribe' | 'cancel' = 'subscribe';
  if (!match) {
    match = cancelled.exec(content.trim());
    action = 'cancel';
  }
  if (!match?.groups) return null;
  const recipient = match.groups.recipient!;
  const mention = /^<@!?([0-9]{1,20})>$/.exec(recipient);
  const id = mention ? snowflake(mention[1]) : null;
  if (mention && !id) return null;
  return {
    action,
    discord_user_id: id,
    username: mention ? null : recipient.replace(/^@/, ''),
    detail:
      action === 'subscribe'
        ? match.groups.plan!.trim()
        : 'Cancellation announcement; paid access may remain active.',
  };
}

function credentialText(value: string, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /\p{C}/u.test(value)) {
    throw new BotError('Credentials could not be formatted for delivery.');
  }
  return escapeMarkdown(value, {
    maskedLink: true,
    heading: true,
    bulletedList: true,
    numberedList: true,
  });
}

export function credentialMessage(username: string, password: string, serverUrl: string): string {
  let valid = false;
  try {
    const url = new URL(serverUrl);
    valid =
      typeof serverUrl === 'string' &&
      /^https?:\/\//i.test(serverUrl) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      serverUrl.length <= 1000 &&
      !/[\s<>\p{C}]/u.test(serverUrl);
  } catch {
    /* Fixed public error below. */
  }
  if (!valid)
    throw new BotError('Configure a valid public Jellyfin URL before sending credentials.');
  const message =
    'Your Jellyfin account is ready.\n\n' +
    `Server: <${serverUrl}>\nUsername: ${credentialText(username, 256)}\nPassword: ${credentialText(password, 512)}\n\n` +
    'Keep these credentials private. You can change your password in Jellyfin.';
  if (message.length > 1900) throw new BotError('Credentials could not be formatted for delivery.');
  return message;
}

export function jobStatusMessage(value: object): string {
  const job = value as Record<string, unknown>;
  const id = String(job.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
    return 'Job accepted. Check its progress in the Jellyport web page.';
  const proposed = job.status ?? job.state ?? 'queued';
  const state = [
    'queued',
    'running',
    'completed',
    'partial',
    'failed',
    'cancelled',
    'interrupted',
  ].includes(String(proposed))
    ? String(proposed)
    : 'unknown';
  let message = `Job \`${id}\`: ${state}.`;
  const progress =
    job.progress && typeof job.progress === 'object'
      ? (job.progress as Record<string, unknown>)
      : job;
  const { processed, total } = progress;
  if (
    typeof processed === 'number' &&
    typeof total === 'number' &&
    Number.isSafeInteger(processed) &&
    Number.isSafeInteger(total) &&
    processed >= 0 &&
    processed <= total
  ) {
    message += ` ${processed}/${total} users processed.`;
  }
  return message;
}

export function botIntents(settings: Settings): GatewayIntentBits[] {
  const intents = [GatewayIntentBits.Guilds];
  if (settings.discord_message_events) {
    intents.push(
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    );
  } else if (settings.discord_role_events) intents.push(GatewayIntentBits.GuildMembers);
  return intents;
}

export function botCommand() {
  return new SlashCommandBuilder()
    .setName('jellyport')
    .setDescription('Create Jellyfin accounts and migrate Emby users')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((command) =>
      command
        .setName('create')
        .setDescription('Create an account and privately send its credentials')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Current server member receiving the credentials')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('username')
            .setDescription("Optional confirmation of the recipient's Discord username"),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('migrate')
        .setDescription('Migrate an Emby user and privately send new account credentials')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Current server member receiving the credentials')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('emby_username').setDescription('Exact Emby username'),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('status')
        .setDescription('Check the progress of a Jellyport job')
        .addStringOption((option) =>
          option.setName('job_id').setDescription('Jellyport job ID').setRequired(true),
        ),
    );
}

class Stopped extends Error {}

/** Abort our wait without leaving a continuation that can queue work after shutdown. */
async function bounded<T>(
  promise: PromiseLike<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Stopped();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(false, new Error('Timed out')), milliseconds);
    const aborted = () => finish(false, new Stopped());
    function finish(success: boolean, value: unknown) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (success) resolve(value as T);
      else reject(value);
    }
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(true, value),
      (error) => finish(false, error),
    );
  });
}

export class BotManager {
  readonly service: BotService;
  private settings: Settings = {};
  private client: Client | null = null;
  private error: string | null = null;
  private lifecycle: AbortController | null = null;
  private loginTask: Promise<void> | null = null;
  private readonly callbacks = new Map<Promise<void>, AbortController>();
  private readonly eventContext = new AsyncLocalStorage<AbortSignal>();
  private changing: Promise<void> = Promise.resolve();
  private reconciling = false;
  private registered = false;
  private readonly clientFactory: (options: ClientOptions) => Client;

  constructor(
    service: BotService,
    options: { clientFactory?: (options: ClientOptions) => Client } = {},
  ) {
    this.service = service;
    this.clientFactory = options.clientFactory ?? ((settings) => new Client(settings));
  }

  status() {
    return {
      enabled: !!this.settings.discord_enabled,
      connected: !!this.client?.isReady(),
      error: this.error,
    };
  }

  restart(settings: Settings): Promise<void> {
    const operation = this.changing.then(async () => {
      await this.stopUnlocked();
      this.settings = { ...settings };
      this.error = null;
      const token = settings.discord_bot_token;
      if (!settings.discord_enabled) return;
      if (typeof token !== 'string' || !token.trim() || !snowflake(settings.discord_guild_id)) {
        this.error = 'Configure a Discord bot token and valid server ID.';
        return;
      }
      for (const field of ['discord_admin_role_id', 'discord_member_role_id'] as const) {
        if (settings[field] != null && settings[field] !== '' && !snowflake(settings[field])) {
          this.error = 'Configure valid Discord role IDs.';
          return;
        }
      }
      if (
        settings.discord_message_events &&
        (['discord_subscription_channel_id', 'discord_subscription_bot_id'] as const).some(
          (field) => !snowflake(settings[field]),
        )
      ) {
        this.error = 'Configure the trusted subscription channel and MEE6 bot IDs.';
        return;
      }
      if (settings.discord_role_events && !snowflake(settings.discord_member_role_id)) {
        this.error = 'Configure a membership role before enabling role events.';
        return;
      }
      const client = this.clientFactory({
        intents: botIntents(settings),
        allowedMentions: { parse: [], repliedUser: false },
        rest: { timeout: 20_000 },
      });
      this.client = client;
      this.lifecycle = new AbortController();
      this.registered = false;
      this.bindEvents(client);
      this.loginTask = this.run(client, token, this.lifecycle.signal);
    });
    this.changing = operation.catch(() => {});
    return operation;
  }

  stop(): Promise<void> {
    const operation = this.changing.then(() => this.stopUnlocked());
    this.changing = operation.catch(() => {});
    return operation;
  }

  private async stopUnlocked(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.lifecycle?.abort();
    this.lifecycle = null;
    for (const controller of this.callbacks.values()) controller.abort();
    // Finish callbacks already inside service operations before the caller closes SQLite.
    await Promise.allSettled([...this.callbacks.keys()]);
    if (client) {
      client.removeAllListeners();
      try {
        await bounded(Promise.resolve(client.destroy()), 10_000);
      } catch {
        /* No secret-bearing errors. */
      }
    }
    await this.loginTask;
    this.loginTask = null;
    this.reconciling = false;
  }

  private async run(client: Client, token: string, signal: AbortSignal): Promise<void> {
    try {
      await bounded(client.login(token), 30_000, signal);
    } catch {
      if (this.client === client) {
        this.error = 'Discord connection failed. Check the bot token, server ID, and installation.';
        try {
          await client.destroy();
        } catch {
          /* Fixed error only. */
        }
      }
    }
  }

  private bindEvents(client: Client): void {
    const dispatch = (callback: () => Promise<void>) => {
      void this.dispatchEvent(client, callback);
    };
    client.on(Events.ClientReady, () => dispatch(() => this.handleReady(client)));
    client.on(Events.ShardResume, () => dispatch(() => this.handleReady(client)));
    client.on(Events.MessageCreate, (message) =>
      dispatch(() => this.handleSubscriptionMessage(message)),
    );
    client.on(Events.GuildMemberUpdate, (before, after) =>
      dispatch(() => this.handleMemberUpdate(before, after)),
    );
    client.on(Events.GuildMemberRemove, (member) =>
      dispatch(() => this.handleMemberRemove(member)),
    );
    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'jellyport') return;
      dispatch(async () => {
        const command = interaction.options.getSubcommand();
        if (command === 'create')
          await this.handleCreate(
            interaction,
            interaction.options.getUser('user', true),
            interaction.options.getString('username'),
          );
        if (command === 'migrate')
          await this.handleMigrate(
            interaction,
            interaction.options.getUser('user', true),
            interaction.options.getString('emby_username'),
          );
        if (command === 'status')
          await this.handleStatus(interaction, interaction.options.getString('job_id', true));
      });
    });
    client.on(Events.Error, () => {
      if (this.client === client) this.error = 'A Discord event could not be processed.';
    });
    client.on(Events.ShardError, () => {
      if (this.client === client) this.error = 'A Discord event could not be processed.';
    });
  }

  async dispatchEvent(client: Client, callback: () => Promise<void>): Promise<void> {
    if (this.client !== client) return;
    const controller = new AbortController();
    // Start on the next microtask so the task is registered before any callback can finish.
    const task = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted || this.client !== client) return;
        return this.eventContext.run(controller.signal, callback);
      })
      .catch((error) => {
        if (!(error instanceof Stopped) && this.client === client)
          this.error = 'A Discord event could not be processed.';
      });
    this.callbacks.set(task, controller);
    try {
      await task;
    } finally {
      this.callbacks.delete(task);
    }
  }

  private checkActive(): void {
    if (this.eventContext.getStore()?.aborted) throw new Stopped();
  }

  private wait<T>(
    promise: PromiseLike<T>,
    milliseconds: number,
    deadline?: AbortSignal,
  ): Promise<T> {
    const signals = [this.eventContext.getStore(), this.lifecycle?.signal, deadline].filter(
      (signal): signal is AbortSignal => !!signal,
    );
    return bounded(promise, milliseconds, signals.length ? AbortSignal.any(signals) : undefined);
  }

  async handleReady(client: Client): Promise<void> {
    if (this.client !== client) return;
    this.error = null;
    try {
      if (!this.registered) {
        await this.wait(this.guild().commands.set([botCommand().toJSON()]), 20_000);
        this.checkActive();
        this.registered = true;
      }
      if (
        this.settings.discord_role_events &&
        this.service.reconcileMemberships &&
        !this.reconciling
      ) {
        this.reconciling = true;
        try {
          await this.service.reconcileMemberships();
        } finally {
          this.reconciling = false;
        }
      }
    } catch (error) {
      if (error instanceof Stopped) throw error;
      if (this.client === client)
        this.error =
          'Membership reconciliation or command registration could not complete. Check the Jellyport web page.';
    }
  }

  private guild(): Guild {
    this.checkActive();
    if (!this.client?.isReady())
      throw new BotError(
        'The Discord bot is offline. Connect it before searching members or delivering account credentials.',
      );
    const id = snowflake(this.settings.discord_guild_id);
    const guild = id ? this.client.guilds.cache.get(id) : undefined;
    if (!guild || !guild.available)
      throw new BotError('The configured Discord server is unavailable to the bot.');
    return guild;
  }

  private async fetchMember(userId: unknown): Promise<GuildMember> {
    const guild = this.guild();
    const client = this.client;
    const id = snowflake(userId);
    if (!id) throw new BotError('Select a valid Discord server member.');
    try {
      // force bypasses the cached roles; cache:false avoids changing the gateway snapshot.
      const member = await this.wait(
        guild.members.fetch({ user: id, force: true, cache: false }),
        20_000,
      );
      this.checkActive();
      if (this.client !== client) throw new Stopped();
      return member;
    } catch (error) {
      if (error instanceof Stopped) throw error;
      if (isMissingMember(error))
        throw new BotError('The recipient is no longer a member of the configured Discord server.');
      throw new BotError(
        'Discord membership could not be verified. Check bot access and the configured server.',
      );
    }
  }

  async recipientIdentity(userId: string, requireMembership = true): Promise<Identity> {
    const member = await this.fetchMember(userId);
    if (
      !recipientEligible(member.guild.id, this.settings.discord_guild_id, {
        bot: member.user.bot,
        roleIds: member.roles.cache.keys(),
        memberRoleId: requireMembership ? this.settings.discord_member_role_id : undefined,
      })
    )
      throw new BotError(
        'The recipient must be a human server member with the configured membership role.',
      );
    return { id: member.id, username: member.user.username };
  }

  async resolveUsername(userId: string): Promise<string> {
    return (await this.recipientIdentity(userId)).username;
  }
  async validateRecipient(userId: string, requireMembership = true): Promise<void> {
    await this.recipientIdentity(userId, requireMembership);
  }

  async searchMembers(query: string): Promise<DiscordMemberSearchResult> {
    const normalized = typeof query === 'string' ? query.trim().replace(/^@/, '') : '';
    if (normalized.length < 2 || normalized.length > 64 || /\p{C}/u.test(normalized))
      throw new BotError('Enter 2–64 characters from a Discord username or server nickname.');
    const guild = this.guild();
    const client = this.client;
    try {
      // Search is a fresh, bounded REST query, without enumerating the full guild or
      // requiring the privileged gateway members intent used by role reconciliation.
      const candidates = [
        ...(
          await this.wait(
            guild.members.search({ query: normalized, limit: 26, cache: false }),
            20_000,
          )
        ).values(),
      ];
      this.checkActive();
      if (this.client !== client) throw new Stopped();
      const summaries = new Map<string, DiscordMemberSummary>();
      for (const member of candidates) {
        const id = snowflake(member.id);
        if (
          !id ||
          snowflake(member.user.id) !== id ||
          typeof member.user.bot !== 'boolean' ||
          member.partial ||
          !recipientEligible(member.guild.id, this.settings.discord_guild_id, {
            bot: member.user.bot,
            roleIds: member.roles.cache.keys(),
          }) ||
          typeof member.user.username !== 'string' ||
          !member.user.username ||
          member.user.username.length > 32 ||
          /\p{C}/u.test(member.user.username)
        )
          continue;
        if (summaries.has(id)) continue;
        const label = (value: unknown): string | null =>
          typeof value === 'string' &&
          value.length > 0 &&
          [...value].length <= 64 &&
          !/\p{C}/u.test(value)
            ? value
            : null;
        summaries.set(id, {
          id,
          username: member.user.username,
          display_name: label(member.user.globalName),
          nickname: label(member.nickname),
          membership_active: recipientEligible(member.guild.id, this.settings.discord_guild_id, {
            bot: member.user.bot,
            roleIds: member.roles.cache.keys(),
            memberRoleId: this.settings.discord_member_role_id,
          }),
        });
      }
      const members = [...summaries.values()].sort(
        (left, right) =>
          Number(right.username === normalized) - Number(left.username === normalized) ||
          left.username.localeCompare(right.username) ||
          left.id.localeCompare(right.id),
      );
      return { members: members.slice(0, 25), truncated: candidates.length > 25 };
    } catch (error) {
      if (error instanceof Stopped)
        throw new BotError(
          'The Discord connection changed. Search again after the bot reconnects.',
        );
      throw new BotError(
        'Discord members could not be searched. Check that the bot is installed in the configured server and has access. If Discord requires it, enable Server Members Intent in the Discord Developer Portal.',
      );
    }
  }

  async membershipActive(userId: string): Promise<boolean | null> {
    try {
      const guild = this.guild();
      const client = this.client;
      const id = snowflake(userId);
      if (!id) return null;
      const member = await this.wait(
        guild.members.fetch({ user: id, force: true, cache: false }),
        20_000,
      );
      if (client !== this.client) return null;
      return recipientEligible(member.guild.id, this.settings.discord_guild_id, {
        bot: member.user.bot,
        roleIds: member.roles.cache.keys(),
        memberRoleId: this.settings.discord_member_role_id,
      });
    } catch (error) {
      return isMissingMember(error) ? false : null;
    }
  }

  private async listMembers(deadline: AbortSignal): Promise<GuildMember[]> {
    const guild = this.guild();
    const client = this.client;
    const result: GuildMember[] = [];
    let after: string | undefined;
    // REST pagination is fresh; gateway fetch() can return stale member/role snapshots.
    for (;;) {
      const page = await this.wait(
        guild.members.list({ limit: 1000, ...(after ? { after } : {}) }),
        20_000,
        deadline,
      );
      this.checkActive();
      if (client !== this.client) throw new Stopped();
      result.push(...page.values());
      if (page.size < 1000) return result;
      const ids = [...page.keys()].map((id) => snowflake(id));
      if (ids.some((id) => !id)) throw new Error('Invalid membership page');
      let last = '0';
      for (const id of ids) if (id && BigInt(id) > BigInt(last)) last = id;
      if (after && BigInt(last) <= BigInt(after)) throw new Error('Invalid membership page');
      after = last;
    }
  }

  async activeMembers(): Promise<Identity[] | null> {
    const role = snowflake(this.settings.discord_member_role_id);
    if (!this.settings.discord_role_events || !role) return null;
    try {
      const members = await this.listMembers(AbortSignal.timeout(30_000));
      return members
        .filter((member) =>
          recipientEligible(member.guild.id, this.settings.discord_guild_id, {
            bot: member.user.bot,
            roleIds: member.roles.cache.keys(),
            memberRoleId: role,
          }),
        )
        .map((member) => ({ id: member.id, username: member.user.username }));
    } catch {
      return null;
    }
  }

  async matchingUsername(username: string): Promise<Identity | null> {
    const result = await this.searchMembers(username);
    // Nicknames may collide with usernames, and a truncated prefix query is
    // incomplete. Only a unique complete match to the actual username is safe.
    if (result.truncated) return null;
    const matches = result.members.filter((member) => member.username === username);
    return matches.length === 1 ? { id: matches[0]!.id, username: matches[0]!.username } : null;
  }

  async sendCredentials(
    userId: string,
    username: string,
    password: string,
    serverUrl: string,
  ): Promise<void> {
    const member = await this.fetchMember(userId);
    if (
      !recipientEligible(member.guild.id, this.settings.discord_guild_id, {
        bot: member.user.bot,
        roleIds: member.roles.cache.keys(),
        memberRoleId: this.settings.discord_member_role_id,
      })
    )
      throw new BotError(
        'The recipient must be a human server member with the configured membership role.',
      );
    const content = credentialMessage(
      username,
      password,
      serverUrl || String(this.settings.jellyfin_public_url ?? ''),
    );
    this.checkActive();
    try {
      await this.wait(
        member.send({
          content,
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressEmbeds,
        }),
        20_000,
      );
    } catch (error) {
      if (error instanceof Stopped) throw error;
      throw new BotError(
        'Discord could not deliver the message. Ask the user to allow direct messages, then retry delivery.',
      );
    }
  }

  async deliver(
    userId: string,
    username: string,
    password: string,
    serverUrl: string,
  ): Promise<void> {
    return this.sendCredentials(userId, username, password, serverUrl);
  }

  private async prepare(interaction: ChatInputCommandInteraction): Promise<void> {
    this.checkActive();
    await this.wait(interaction.deferReply({ flags: MessageFlags.Ephemeral }), 20_000);
    this.checkActive();
    if (
      !interaction.guildId ||
      snowflake(interaction.guildId) !== snowflake(this.settings.discord_guild_id)
    ) {
      throw new BotError('This command is restricted to the configured Discord server.');
    }
    const member = await this.fetchMember(interaction.user.id);
    if (
      member.user.bot ||
      !commandAuthorized(member.guild.id, this.settings.discord_guild_id, {
        administrator: member.permissions.has(PermissionFlagsBits.Administrator),
        roleIds: member.roles.cache.keys(),
        adminRoleId: this.settings.discord_admin_role_id,
      })
    )
      throw new BotError(
        'This command requires server Administrator permission or the configured admin role.',
      );
  }

  private async reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    this.checkActive();
    try {
      const options = {
        content,
        allowedMentions: { parse: [] as never[], repliedUser: false },
        flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
      };
      if (interaction.deferred || interaction.replied)
        await this.wait(interaction.followUp(options), 20_000);
      else await this.wait(interaction.reply(options), 20_000);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      this.error = 'A Discord command response could not be delivered.';
    }
  }

  async handleCreate(
    interaction: ChatInputCommandInteraction,
    user: { id: string },
    username?: string | null,
  ): Promise<void> {
    let message: string;
    try {
      await this.prepare(interaction);
      const identity = await this.recipientIdentity(user.id);
      const mapping = this.service.resolveDiscordMapping?.(identity.id);
      if (mapping?.discord_user_id === identity.id)
        throw new BotError(
          'This member has a verified Emby migration mapping. Use /jellyport migrate to preserve their data and use the approved Jellyfin destination.',
        );
      if (username != null && username !== identity.username)
        throw new BotError(
          "New account usernames must match the recipient's current Discord username.",
        );
      this.checkActive();
      const job = await this.service.createAccount(identity.username, identity.id);
      this.checkActive();
      message = jobStatusMessage(job) + ' Use /jellyport status to check progress.';
    } catch (error) {
      if (error instanceof Stopped) throw error;
      message =
        error instanceof BotError
          ? error.message
          : 'Account creation could not be queued. Check the Jellyport web page.';
    }
    await this.reply(interaction, message);
  }

  async handleMigrate(
    interaction: ChatInputCommandInteraction,
    user: { id: string },
    embyUsername?: string | null,
  ): Promise<void> {
    let message: string;
    try {
      await this.prepare(interaction);
      const identity = await this.recipientIdentity(user.id);
      const proposedMapping = this.service.resolveDiscordMapping?.(identity.id);
      // A saved display label is not an identity. Only an exact verified Discord ID may
      // select a source whose name differs from the live member's username.
      const mapping = proposedMapping?.discord_user_id === identity.id ? proposedMapping : null;
      const users = await this.service.embyUsers();
      this.checkActive();
      const matches = users.filter((item) =>
        mapping && embyUsername == null
          ? item.Id === mapping.source_user_id
          : item.Name === (embyUsername ?? identity.username),
      );
      if (matches.length !== 1 || !matches[0]!.Id)
        throw new BotError(
          'No unique Emby user matches that exact username. Check the Emby user list in the web page.',
        );
      const id = String(matches[0]!.Id);
      if (mapping && id !== mapping.source_user_id)
        throw new BotError(
          "That Emby account differs from this member's verified mapping. Review User mappings in the web page before migrating.",
        );
      const job = await this.service.migrateUsers([id], { [id]: identity.id });
      this.checkActive();
      message = jobStatusMessage(job) + ' Use /jellyport status to check progress.';
    } catch (error) {
      if (error instanceof Stopped) throw error;
      message =
        error instanceof BotError
          ? error.message
          : 'Migration could not be queued. Check the Jellyport web page.';
    }
    await this.reply(interaction, message);
  }

  async handleStatus(interaction: ChatInputCommandInteraction, jobId: string): Promise<void> {
    let message: string;
    try {
      await this.prepare(interaction);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId))
        throw new BotError('Enter a valid Jellyport job ID.');
      const job = this.service.getJob(jobId);
      if (!job) throw new BotError('That Jellyport job could not be found.');
      message = jobStatusMessage(job);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      message =
        error instanceof BotError
          ? error.message
          : 'Job status could not be read. Check the Jellyport web page.';
    }
    await this.reply(interaction, message);
  }

  async handleSubscriptionMessage(message: Message): Promise<void> {
    const settings = this.settings;
    if (
      !settings.discord_message_events ||
      !message.guild ||
      snowflake(message.guild.id) !== snowflake(settings.discord_guild_id) ||
      snowflake(message.channelId) !== snowflake(settings.discord_subscription_channel_id) ||
      !message.author.bot ||
      snowflake(message.author.id) !== snowflake(settings.discord_subscription_bot_id) ||
      message.webhookId != null
    )
      return;
    const parsed = parseSubscriptionMessage(message.content);
    if (!parsed) return;
    let identity: Identity | null = null;
    try {
      if (parsed.discord_user_id)
        identity = await this.recipientIdentity(String(parsed.discord_user_id), false);
      else if (parsed.username) identity = await this.matchingUsername(String(parsed.username));
    } catch (error) {
      if (error instanceof Stopped) throw error;
    }
    this.checkActive();
    try {
      await this.service.recordSubscription({
        ...parsed,
        id: message.id,
        guild_id: message.guild.id,
        discord_user_id: identity?.id ?? null,
        username: identity?.username ?? parsed.username,
        source: 'mee6_message',
        emitted_at: message.createdAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof Stopped) throw error;
      this.error = 'A subscription event could not be recorded. Check the Jellyport web page.';
    }
  }

  async handleMemberUpdate(
    before: GuildMember | PartialGuildMember,
    after: GuildMember,
  ): Promise<void> {
    const settings = this.settings;
    const role = snowflake(settings.discord_member_role_id);
    if (
      !settings.discord_role_events ||
      !role ||
      after.user.bot ||
      before.partial ||
      before.id !== after.id ||
      before.guild.id !== after.guild.id ||
      snowflake(after.guild.id) !== snowflake(settings.discord_guild_id)
    )
      return;
    const hadRole = before.roles.cache.has(role),
      hasRole = after.roles.cache.has(role);
    if (hadRole === hasRole) return;
    this.checkActive();
    try {
      await this.service.recordSubscription({
        id: randomUUID(),
        guild_id: after.guild.id,
        discord_user_id: after.id,
        username: after.user.username,
        action: hasRole ? 'subscribe' : 'expire',
        source: 'discord_role',
        detail: hasRole ? 'Membership role added.' : 'Membership role removed.',
        emitted_at: new Date().toISOString(),
      });
    } catch {
      this.error = 'A membership role event could not be recorded. Check the Jellyport web page.';
    }
  }

  async handleMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    if (
      !this.settings.discord_role_events ||
      member.user.bot ||
      snowflake(member.guild.id) !== snowflake(this.settings.discord_guild_id)
    )
      return;
    this.checkActive();
    try {
      await this.service.recordSubscription({
        id: randomUUID(),
        guild_id: member.guild.id,
        discord_user_id: member.id,
        username: member.user.username,
        action: 'expire',
        source: 'discord_role',
        detail: 'Member left the Discord server.',
        emitted_at: new Date().toISOString(),
      });
    } catch {
      this.error = 'A membership departure could not be recorded. Check the Jellyport web page.';
    }
  }
}

function isMissingMember(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const object = error as { code?: unknown; status?: unknown };
  return object.code === 10007 || object.status === 404;
}
