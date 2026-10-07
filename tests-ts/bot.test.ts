import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type ClientOptions,
  type GuildMember,
  type Message,
} from 'discord.js';
import {
  BotError,
  BotManager,
  botCommand,
  botIntents,
  commandAuthorized,
  credentialMessage,
  jobStatusMessage,
  parseSubscriptionMessage,
  recipientEligible,
  snowflake,
  type BotService,
} from '../server/bot.js';
import type { Settings } from '../server/types.js';

function member(
  id = '22',
  username = 'jlogan35',
  options: { roles?: string[]; admin?: boolean; bot?: boolean; guildId?: string } = {},
) {
  return {
    id,
    partial: false,
    user: { id, username, bot: options.bot ?? false },
    displayName: 'Display alias',
    nickname: 'Display alias',
    guild: { id: options.guildId ?? '123' },
    roles: {
      cache: new Collection((options.roles ?? ['55']).map((role) => [role, { id: role }] as const)),
    },
    permissions: { has: vi.fn(() => options.admin ?? false) },
    send: vi.fn(async () => ({})),
  };
}

function interaction(guildId: string | null = '123') {
  const request = {
    guildId,
    user: { id: '11' },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async (_options: unknown) => {
      request.deferred = true;
      return {};
    }),
    followUp: vi.fn(async (_options: unknown) => ({})),
    reply: vi.fn(async (_options: unknown) => ({})),
  };
  return request;
}

function asInteraction(value: ReturnType<typeof interaction>) {
  return value as unknown as ChatInputCommandInteraction;
}
function asMember(value: ReturnType<typeof member>) {
  return value as unknown as GuildMember;
}

function subscriptionMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: '1000',
    guild: { id: '123' },
    channelId: '700',
    author: { id: '800', bot: true },
    webhookId: null,
    content: 'Good news captain! <@22> just subscribed to Sloop Crewman Plan!',
    createdAt: new Date('2026-10-07T00:00:00Z'),
    ...overrides,
  } as unknown as Message;
}

const managers: BotManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
});

async function fixture(extra: Partial<Settings> = {}) {
  const service = {
    createAccount: vi.fn(async () => ({
      id: 'job_1',
      status: 'queued',
      password: 'NEVER-IN-CHANNEL',
    })),
    migrateUsers: vi.fn(async () => ({ id: 'job_2', status: 'queued' })),
    embyUsers: vi.fn(async () => [{ Id: 'emby_1', Name: 'jlogan35' }]),
    getJob: vi.fn(() => ({
      id: 'job_1',
      status: 'running',
      processed: 1,
      total: 2,
      password: 'SECRET',
    })),
    recordSubscription: vi.fn(async (_event: Record<string, unknown>) => ({})),
    reconcileMemberships: vi.fn(async () => {}),
  };
  const admin = member('11', 'server_admin', { roles: ['99'] });
  const recipient = member();
  const guild = {
    id: '123',
    available: true,
    members: {
      fetch: vi.fn(async (options: { user: string; force: boolean; cache: boolean }) =>
        options.user === '11' ? admin : recipient,
      ),
      list: vi.fn(async (_options: unknown) => new Collection([['22', recipient]])),
    },
    commands: { set: vi.fn(async (_commands: unknown) => new Collection()) },
  };
  const client = Object.assign(new EventEmitter(), {
    ready: true,
    isReady: vi.fn(() => client.ready),
    guilds: { cache: new Collection([['123', guild]]) },
    login: vi.fn(async (_token: string) => 'token'),
    destroy: vi.fn(async () => {
      client.ready = false;
    }),
  });
  const factory = vi.fn((_options: ClientOptions) => client as unknown as Client);
  const manager = new BotManager(service as unknown as BotService, { clientFactory: factory });
  managers.push(manager);
  const settings: Partial<Settings> = {
    discord_enabled: true,
    discord_bot_token: 'example-token',
    discord_guild_id: '123',
    discord_admin_role_id: '99',
    discord_member_role_id: '55',
    jellyfin_public_url: 'https://jellyfin.example.test',
    ...extra,
  };
  await manager.restart(settings);
  return { service, admin, recipient, guild, client, manager, settings, factory };
}

describe('Discord authorization and identity', () => {
  it.each([
    ['123', '123', true, [], undefined, true],
    ['123', '123', false, ['99'], '99', true],
    ['123', '123', false, ['55'], '99', false],
    [null, '123', true, ['99'], '99', false],
    ['456', '123', true, ['99'], '99', false],
    ['123', null, true, [], undefined, false],
    ['123', '123', false, ['0'], 'invalid', false],
    [true, '1', true, [], undefined, false],
  ])(
    'checks configured guild and fresh admin role (%s)',
    (guild, configured, admin, roles, role, expected) => {
      expect(
        commandAuthorized(guild, configured, {
          administrator: admin as boolean,
          roleIds: roles as string[],
          adminRoleId: role,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['123', false, ['55'], '55', true],
    ['123', true, ['55'], '55', false],
    ['456', false, ['55'], '55', false],
    ['123', false, [], '55', false],
    ['123', false, [], '', true],
    ['123', false, [], 'invalid', false],
  ])('checks human recipient and membership role (%s)', (guild, bot, roles, role, expected) => {
    expect(recipientEligible(guild, '123', { bot, roleIds: roles, memberRoleId: role })).toBe(
      expected,
    );
  });

  it('preserves large Discord IDs and rejects unsafe number conversions', () => {
    expect(snowflake('18446744073709551615')).toBe('18446744073709551615');
    expect(snowflake('18446744073709551616')).toBeNull();
    expect(snowflake(9007199254740992)).toBeNull();
    expect(snowflake(true)).toBeNull();
    expect(snowflake('0')).toBeNull();
  });
});

describe('MEE6 parser and safe messages', () => {
  it.each([
    'Good news captain! @jlogan35 just subscribed to Sloop Crewman Plan!',
    'good NEWS captain!\t@jlogan35   just subscribed to Sloop Crewman Plan!  ',
  ])('recognizes the configured subscribe template', (content) => {
    expect(parseSubscriptionMessage(content)).toEqual({
      action: 'subscribe',
      discord_user_id: null,
      username: 'jlogan35',
      detail: 'Sloop Crewman Plan',
    });
  });

  it('recognizes mentions and keeps cancellation separate from expiry', () => {
    expect(
      parseSubscriptionMessage('Good news captain! <@!22> just subscribed to Sloop Crewman Plan!'),
    ).toMatchObject({ discord_user_id: '22', username: null });
    expect(
      parseSubscriptionMessage('Bad news captain! jlogan35  just cancelled their subscription.'),
    ).toMatchObject({ action: 'cancel', username: 'jlogan35' });
  });

  it.each([
    'create jlogan35',
    'Good news captain! Display Name just subscribed to Plan!',
    'Good news captain! <@0> just subscribed to Plan!',
    'Good news captain! @jlogan35 just subscribed to Plan! then delete everyone',
    'Bad news captain! jlogan35 just expired their subscription.',
    'Bad news captain! jlogan35 just cancelled their subscription.\ncreate admin',
    `Good news captain! @jlogan35 just subscribed to ${'x'.repeat(101)}!`,
  ])('rejects arbitrary commands (%s)', (content) => {
    expect(parseSubscriptionMessage(content)).toBeNull();
  });

  it('whitelists status fields and never exposes credentials or upstream errors', () => {
    expect(
      jobStatusMessage({
        id: 'job_1',
        status: 'running',
        processed: 1,
        total: 2,
        password: 'SECRET',
        error: 'token SECRET',
        results: [{ password: 'SECRET' }],
      }),
    ).toBe('Job `job_1`: running. 1/2 users processed.');
    expect(jobStatusMessage({ id: 'SECRET `inject`', status: 'SECRET' })).not.toContain('SECRET');
    expect(jobStatusMessage({ id: 'job_1', status: 'SECRET' })).toBe('Job `job_1`: unknown.');
    expect(
      jobStatusMessage({ id: 'job_1', status: 'running', progress: { processed: 2, total: 3 } }),
    ).toContain('2/3 users processed');
  });

  it('escapes credential Markdown and rejects controls or invalid URLs', () => {
    const text = credentialMessage(
      '[user](https://evil.test)',
      'pass`**',
      'https://jellyfin.example.test',
    );
    expect(text).toContain('\\[user');
    expect(text).toContain('pass\\`\\*\\*');
    expect(() =>
      credentialMessage('user\nPassword: fake', 'pass', 'https://jellyfin.example.test'),
    ).toThrow(BotError);
    expect(() =>
      credentialMessage('user', 'pass', 'https://jellyfin.example.test>@everyone'),
    ).toThrow(BotError);
    expect(() =>
      credentialMessage('user', 'pass', 'https://admin:secret@jellyfin.example.test'),
    ).toThrow(BotError);
    expect(() => credentialMessage('user', 'pass', 'https:example.test')).toThrow(BotError);
  });
});

describe('Bot lifecycle and commands', () => {
  it('disabled or invalid configuration never starts a Discord connection', async () => {
    const factory = vi.fn();
    const manager = new BotManager({} as BotService, { clientFactory: factory });
    managers.push(manager);
    await manager.restart({});
    expect(manager.status()).toEqual({ enabled: false, connected: false, error: null });
    await manager.restart({
      discord_bot_token: 'token',
      discord_guild_id: '123',
      discord_enabled: false,
    });
    expect(manager.status().enabled).toBe(false);
    await manager.restart({
      discord_bot_token: 'token',
      discord_guild_id: 'invalid',
      discord_enabled: true,
    });
    expect(manager.status().error).toBeTruthy();
    await manager.restart({
      discord_bot_token: 'token',
      discord_guild_id: '123',
      discord_message_events: true,
      discord_enabled: true,
    });
    expect(manager.status().error).toContain('trusted');
    expect(factory).not.toHaveBeenCalled();
  });

  it('privileged intents are opt-in and guild commands default to administrator visibility', () => {
    expect(botIntents({})).toEqual([GatewayIntentBits.Guilds]);
    expect(botIntents({ discord_message_events: true })).toContain(GatewayIntentBits.GuildMembers);
    expect(botIntents({ discord_message_events: true })).toContain(
      GatewayIntentBits.MessageContent,
    );
    expect(botIntents({ discord_role_events: true })).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ]);
    expect(botIntents({ discord_message_events: true })).not.toContain(
      GatewayIntentBits.DirectMessages,
    );
    const command = botCommand().toJSON();
    expect(command.dm_permission).toBe(false);
    expect(command.default_member_permissions).toBe(String(PermissionFlagsBits.Administrator));
    expect(command.options?.map((option) => option.name)).toEqual(['create', 'migrate', 'status']);
  });

  it.each([
    ['create', null],
    ['migrate', null],
    ['status', null],
    ['create', '456'],
    ['migrate', '456'],
    ['status', '456'],
  ])('rejects %s outside the configured guild', async (command, guildId) => {
    const { manager, service, guild } = await fixture();
    const request = interaction(guildId);
    if (command === 'create') await manager.handleCreate(asInteraction(request), { id: '22' });
    if (command === 'migrate') await manager.handleMigrate(asInteraction(request), { id: '22' });
    if (command === 'status') await manager.handleStatus(asInteraction(request), 'job_1');
    expect(service.createAccount).not.toHaveBeenCalled();
    expect(service.migrateUsers).not.toHaveBeenCalled();
    expect(service.getJob).not.toHaveBeenCalled();
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(request.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(request.followUp.mock.calls[0]![0]).toMatchObject({
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    });
  });

  it.each(['create', 'migrate', 'status'])(
    'checks fresh runtime permissions for %s',
    async (command) => {
      const { manager, service, guild } = await fixture();
      guild.members.fetch.mockResolvedValue(member('11', 'admin', { roles: [] }));
      const request = interaction();
      if (command === 'create') await manager.handleCreate(asInteraction(request), { id: '22' });
      if (command === 'migrate') await manager.handleMigrate(asInteraction(request), { id: '22' });
      if (command === 'status') await manager.handleStatus(asInteraction(request), 'job_1');
      expect(request.followUp.mock.calls[0]![0]).toMatchObject({
        content: expect.stringContaining('requires'),
      });
      expect(service.createAccount).not.toHaveBeenCalled();
      expect(service.migrateUsers).not.toHaveBeenCalled();
      expect(service.getJob).not.toHaveBeenCalled();
    },
  );

  it('creates for the current username, never the alias, and redacts job results', async () => {
    const { manager, service, guild } = await fixture();
    const request = interaction();
    await manager.handleCreate(asInteraction(request), { id: '22' });
    expect(service.createAccount).toHaveBeenCalledWith('jlogan35', '22');
    expect(guild.members.fetch).toHaveBeenCalledWith({ user: '22', force: true, cache: false });
    expect(JSON.stringify(request.followUp.mock.calls)).not.toContain('NEVER-IN-CHANNEL');
    expect(request.followUp.mock.calls[0]![0]).toMatchObject({
      allowedMentions: { parse: [], repliedUser: false },
    });
    const mismatch = interaction();
    await manager.handleCreate(asInteraction(mismatch), { id: '22' }, 'Display alias');
    expect(service.createAccount).toHaveBeenCalledTimes(1);
    expect(mismatch.followUp.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining('must match'),
    });
  });

  it('migrates only an exact unique source name to the verified recipient', async () => {
    const { manager, service } = await fixture();
    await manager.handleMigrate(asInteraction(interaction()), { id: '22' });
    expect(service.migrateUsers).toHaveBeenCalledWith(['emby_1'], { emby_1: '22' });
    await manager.handleMigrate(asInteraction(interaction()), { id: '22' }, 'JLOGAN35');
    expect(service.migrateUsers).toHaveBeenCalledTimes(1);
  });

  it('redacts upstream exceptions and status secrets', async () => {
    const { manager, service } = await fixture();
    service.createAccount.mockRejectedValue(new Error('password SECRET token SECRET'));
    const request = interaction();
    await manager.handleCreate(asInteraction(request), { id: '22' });
    expect(JSON.stringify(request.followUp.mock.calls)).not.toContain('SECRET');
    const status = interaction();
    await manager.handleStatus(asInteraction(status), 'job_1');
    expect(status.followUp.mock.calls[0]![0]).toMatchObject({
      content: 'Job `job_1`: running. 1/2 users processed.',
    });
  });

  it('registers commands only once and reconciles membership after reconnect', async () => {
    const { manager, service, client, guild } = await fixture({ discord_role_events: true });
    await manager.handleReady(client as unknown as Client);
    await manager.handleReady(client as unknown as Client);
    expect(service.reconcileMemberships).toHaveBeenCalledTimes(2);
    expect(guild.commands.set).toHaveBeenCalledTimes(1);
    expect(guild.commands.set.mock.calls[0]![0]).toEqual([botCommand().toJSON()]);
  });

  it('redacts gateway error details', async () => {
    const { manager, client } = await fixture();
    client.emit(Events.Error, new Error('private-token'));
    expect(manager.status().error).toBe('A Discord event could not be processed.');
    expect(manager.status().error).not.toContain('private-token');
  });

  it('connection failures never expose token or library request details', async () => {
    const client = Object.assign(new EventEmitter(), {
      isReady: () => false,
      login: vi.fn(async () => {
        throw new Error('secret-token');
      }),
      destroy: vi.fn(async () => {}),
    });
    const manager = new BotManager({} as BotService, {
      clientFactory: () => client as unknown as Client,
    });
    managers.push(manager);
    await manager.restart({
      discord_enabled: true,
      discord_bot_token: 'secret-token',
      discord_guild_id: '123',
    });
    await vi.waitFor(() => expect(manager.status().error).toContain('Discord connection failed'));
    expect(manager.status().error).not.toContain('secret-token');
    expect(client.destroy).toHaveBeenCalled();
  });

  it('ignores events from stale clients', async () => {
    const { manager } = await fixture();
    const callback = vi.fn(async () => {});
    await manager.dispatchEvent({} as Client, callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('shutdown aborts pending member verification before a slash command can queue a job', async () => {
    const { manager, client, guild, service } = await fixture();
    let resolveFetch!: (value: ReturnType<typeof member>) => void;
    guild.members.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const request = interaction();
    const task = manager.dispatchEvent(client as unknown as Client, () =>
      manager.handleCreate(asInteraction(request), { id: '22' }),
    );
    await vi.waitFor(() => expect(guild.members.fetch).toHaveBeenCalled());
    await manager.stop();
    await task;
    resolveFetch(member('11', 'admin', { roles: ['99'] }));
    await Promise.resolve();
    expect(service.createAccount).not.toHaveBeenCalled();
    expect(request.followUp).not.toHaveBeenCalled();
  });

  it('shutdown drains callbacks already recording state before returning', async () => {
    const { manager, client, service } = await fixture({ discord_role_events: true });
    let finish!: () => void;
    service.recordSubscription.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    const task = manager.dispatchEvent(client as unknown as Client, () =>
      manager.handleMemberRemove(asMember(member())),
    );
    await vi.waitFor(() => expect(service.recordSubscription).toHaveBeenCalled());
    let stopped = false;
    const stop = manager.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    await task;
    expect(stopped).toBe(true);
  });
});

describe('Private credential delivery and membership', () => {
  it('fetches membership again at delivery and rejects removed roles', async () => {
    const { manager, guild, recipient } = await fixture();
    await manager.validateRecipient('22');
    const removed = member('22', 'jlogan35', { roles: [] });
    guild.members.fetch.mockResolvedValue(removed);
    await expect(
      manager.sendCredentials('22', 'jlogan35', 'SECRET', 'https://jellyfin.example.test'),
    ).rejects.toThrow('membership role');
    expect(recipient.send).not.toHaveBeenCalled();
    expect(removed.send).not.toHaveBeenCalled();
  });

  it('DMs only the chosen verified member with mentions and embeds disabled', async () => {
    const { manager, recipient, admin } = await fixture();
    await manager.sendCredentials(
      '22',
      'jlogan35',
      'private-password',
      'https://jellyfin.example.test',
    );
    expect(recipient.send).toHaveBeenCalledWith({
      content: expect.stringContaining('Password: private-password'),
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds,
    });
    expect(admin.send).not.toHaveBeenCalled();
  });

  it('uses fixed delivery errors and rejects offline delivery', async () => {
    const { manager, recipient, client } = await fixture();
    recipient.send.mockRejectedValue(new Error('private-password secret-token'));
    await expect(
      manager.sendCredentials(
        '22',
        'jlogan35',
        'private-password',
        'https://jellyfin.example.test',
      ),
    ).rejects.toThrow('could not deliver');
    try {
      await manager.sendCredentials(
        '22',
        'jlogan35',
        'private-password',
        'https://jellyfin.example.test',
      );
    } catch (error) {
      expect(String(error)).not.toMatch(/private-password|secret-token/);
    }
    client.ready = false;
    await expect(
      manager.sendCredentials(
        '22',
        'jlogan35',
        'private-password',
        'https://jellyfin.example.test',
      ),
    ).rejects.toThrow('offline');
  });

  it('distinguishes missing memberships from unknown status on API failure', async () => {
    const { manager, guild, client } = await fixture();
    expect(await manager.membershipActive('22')).toBe(true);
    guild.members.fetch.mockResolvedValue(member('22', 'user', { roles: [] }));
    expect(await manager.membershipActive('22')).toBe(false);
    guild.members.fetch.mockRejectedValue({ code: 10007, status: 404 });
    expect(await manager.membershipActive('22')).toBe(false);
    guild.members.fetch.mockRejectedValue(new Error('private-token'));
    expect(await manager.membershipActive('22')).toBeNull();
    client.ready = false;
    expect(await manager.membershipActive('22')).toBeNull();
  });

  it('scans membership only when opted in and filters bots, guilds and roles', async () => {
    const { manager, guild, settings } = await fixture();
    expect(await manager.activeMembers()).toBeNull();
    expect(guild.members.list).not.toHaveBeenCalled();
    const records = [
      member(),
      member('23', 'no-role', { roles: [] }),
      member('24', 'bot', { bot: true }),
      member('25', 'other-guild', { guildId: '456' }),
    ];
    const enabled = await fixture({ discord_role_events: true });
    enabled.guild.members.list.mockResolvedValue(
      new Collection(records.map((item) => [item.id, item])),
    );
    expect(await enabled.manager.activeMembers()).toEqual([{ id: '22', username: 'jlogan35' }]);
  });

  it('returns unknown instead of a partial membership list after pagination failure', async () => {
    const { manager, guild } = await fixture({ discord_role_events: true });
    const page = new Collection(
      Array.from({ length: 1000 }, (_, index) => {
        const item = member(String(index + 1000), `user${index}`);
        return [item.id, item] as const;
      }),
    );
    guild.members.list.mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('secret-token'));
    expect(await manager.activeMembers()).toBeNull();
    expect(guild.members.list.mock.calls[1]![0]).toEqual({ limit: 1000, after: '1999' });
  });
});

describe('Trusted subscription sources', () => {
  const sourceSettings = {
    discord_message_events: true,
    discord_subscription_channel_id: '700',
    discord_subscription_bot_id: '800',
  };

  it.each([
    { guild: null },
    { guild: { id: '456' } },
    { channelId: '701' },
    { author: { id: '801', bot: true } },
    { author: { id: '800', bot: false } },
    { webhookId: '900' },
    { content: 'create user' },
    { content: '', embeds: [{ description: 'Good news captain! <@22> just subscribed to Plan!' }] },
  ])('ignores untrusted sources and embeds', async (overrides) => {
    const { manager, service } = await fixture(sourceSettings);
    await manager.handleSubscriptionMessage(subscriptionMessage(overrides));
    expect(service.recordSubscription).not.toHaveBeenCalled();
    expect(service.createAccount).not.toHaveBeenCalled();
  });

  it('requires opt-in and resolves the fresh authoritative Discord username', async () => {
    const { manager, service } = await fixture();
    await manager.handleSubscriptionMessage(subscriptionMessage());
    expect(service.recordSubscription).not.toHaveBeenCalled();
    const enabled = await fixture(sourceSettings);
    await enabled.manager.handleSubscriptionMessage(subscriptionMessage());
    expect(enabled.service.recordSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1000',
        discord_user_id: '22',
        username: 'jlogan35',
        action: 'subscribe',
        source: 'mee6_message',
      }),
    );
    expect(enabled.service.createAccount).not.toHaveBeenCalled();
    expect(enabled.service.migrateUsers).not.toHaveBeenCalled();
  });

  it.each([
    [['jlogan35'], '22'],
    [['other-user'], null],
    [['jlogan35', 'jlogan35'], null],
  ] as const)('resolves a plain username only when exact and unique', async (names, id) => {
    const { manager, guild, service } = await fixture(sourceSettings);
    const records = names.map((name, index) => member(String(index + 22), name));
    guild.members.list.mockResolvedValue(new Collection(records.map((item) => [item.id, item])));
    await manager.handleSubscriptionMessage(
      subscriptionMessage({
        content: 'Bad news captain! jlogan35 just cancelled their subscription.',
      }),
    );
    expect(service.recordSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ discord_user_id: id, action: 'cancel', username: 'jlogan35' }),
    );
  });

  it('keeps unresolvable mentions as review-only events without leaking errors', async () => {
    const { manager, guild, service } = await fixture(sourceSettings);
    guild.members.fetch.mockRejectedValue(new Error('private-token'));
    await manager.handleSubscriptionMessage(subscriptionMessage());
    expect(service.recordSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ discord_user_id: null }),
    );
    expect(JSON.stringify(service.recordSubscription.mock.calls)).not.toContain('private-token');
  });

  it('emits opt-in role transitions and departures, ignoring unchanged or foreign roles', async () => {
    const { manager, service } = await fixture();
    await manager.handleMemberUpdate(
      asMember(member('22', 'user', { roles: [] })),
      asMember(member()),
    );
    expect(service.recordSubscription).not.toHaveBeenCalled();
    const enabled = await fixture({ discord_role_events: true });
    const before = asMember(member('22', 'jlogan35', { roles: [] })),
      after = asMember(member());
    await enabled.manager.handleMemberUpdate(before, after);
    expect(enabled.service.recordSubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'subscribe',
        discord_user_id: '22',
        source: 'discord_role',
      }),
    );
    await enabled.manager.handleMemberUpdate(after, before);
    expect(enabled.service.recordSubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'expire' }),
    );
    await enabled.manager.handleMemberUpdate(after, after);
    await enabled.manager.handleMemberUpdate(
      before,
      asMember(member('22', 'user', { guildId: '456' })),
    );
    expect(enabled.service.recordSubscription).toHaveBeenCalledTimes(2);
    await enabled.manager.handleMemberRemove(after);
    expect(enabled.service.recordSubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'expire', detail: 'Member left the Discord server.' }),
    );
  });

  it('shutdown prevents pending subscription resolution from recording events later', async () => {
    const { manager, guild, service, client } = await fixture(sourceSettings);
    let resolve!: (value: ReturnType<typeof member>) => void;
    guild.members.fetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const task = manager.dispatchEvent(client as unknown as Client, () =>
      manager.handleSubscriptionMessage(subscriptionMessage()),
    );
    await vi.waitFor(() => expect(guild.members.fetch).toHaveBeenCalled());
    await manager.stop();
    await task;
    resolve(member());
    await Promise.resolve();
    expect(service.recordSubscription).not.toHaveBeenCalled();
  });
});
