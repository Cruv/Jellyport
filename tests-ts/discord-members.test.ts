import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotError } from '../server/bot.js';
import { createApp, type JellyportApp } from '../server/main.js';
import type { BotAdapter } from '../server/service.js';
import type { DiscordMemberSearchResult } from '../server/discord-members.js';

const apps: JellyportApp[] = [];
const directories: string[] = [];
const result: DiscordMemberSearchResult = {
  members: [
    {
      id: '123456789012345678',
      username: 'actual.username',
      display_name: 'Display name',
      nickname: 'Server nickname',
      membership_active: true,
    },
  ],
  truncated: false,
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-discord-members-'));
  directories.push(directory);
  const app = await createApp({ demo: true, dataDir: directory });
  apps.push(app);
  const bot = {
    status: () => ({ connected: true }),
    recipientIdentity: async (id: string) => ({ id, username: 'actual.username' }),
    validateRecipient: async () => {},
    sendCredentials: async () => {},
    membershipActive: async () => true,
    activeMembers: async () => [],
    searchMembers: vi.fn<NonNullable<BotAdapter['searchMembers']>>(async () =>
      structuredClone(result),
    ),
  } satisfies BotAdapter;
  app.jellyport.service.bot = bot;
  const anonymous = await app.inject('/api/session');
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
      'x-csrf-token': anonymous.json().csrf_token,
    },
    payload: { username: 'admin', password: 'demo-jellyport' },
  });
  expect(login.statusCode).toBe(200);
  const headers = { cookie: `jellyport_session=${login.cookies[0]!.value}` };
  return { app, bot, headers };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('authenticated Discord member lookup route', () => {
  it('returns only the identity picker fields to an authenticated administrator', async () => {
    const { app, bot, headers } = await fixture();
    bot.searchMembers.mockResolvedValue({
      ...result,
      members: [
        Object.assign(
          { ...result.members[0]! },
          { email: 'private@example.test', roles: ['secret'], token: 'private-token' },
        ),
      ],
    });
    const response = await app.inject({ url: '/api/discord/members?query=actual', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toMatch(/private|secret|roles|token|email/);
    expect(bot.searchMembers).toHaveBeenCalledWith('actual');
  });

  it('requires an authenticated session before querying any member data', async () => {
    const { app, bot } = await fixture();
    const response = await app.inject('/api/discord/members?query=actual');
    expect(response.statusCode).toBe(401);
    expect(bot.searchMembers).not.toHaveBeenCalled();
    expect(response.body).not.toContain('actual.username');
  });

  it.each([
    '/api/discord/members',
    '/api/discord/members?query=a',
    `/api/discord/members?query=${'x'.repeat(65)}`,
    '/api/discord/members?query=actual&guild_id=other-server',
  ])('rejects invalid lookup parameters before Discord access (%s)', async (url) => {
    const { app, bot, headers } = await fixture();
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(422);
    expect(bot.searchMembers).not.toHaveBeenCalled();
  });

  it('rejects requests from another origin despite a valid administrator cookie', async () => {
    const { app, bot, headers } = await fixture();
    const response = await app.inject({
      url: '/api/discord/members?query=actual',
      headers: { ...headers, origin: 'https://attacker.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(bot.searchMembers).not.toHaveBeenCalled();
  });

  it('fails clearly when member lookup is unavailable on the bot adapter', async () => {
    const { app, headers } = await fixture();
    app.jellyport.service.bot = null;
    const response = await app.inject({ url: '/api/discord/members?query=actual', headers });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain('Connect the Discord bot');
  });

  it('preserves safe bot guidance and strips unexpected SDK error details', async () => {
    const { app, bot, headers } = await fixture();
    bot.searchMembers.mockRejectedValueOnce(
      new BotError('The configured Discord server is unavailable to the bot.'),
    );
    const safe = await app.inject({ url: '/api/discord/members?query=actual', headers });
    expect(safe.statusCode).toBe(400);
    expect(safe.json().detail).toContain('configured Discord server');
    bot.searchMembers.mockRejectedValueOnce(
      new Error('Authorization: Bot private-token, user private-data'),
    );
    const unexpected = await app.inject({ url: '/api/discord/members?query=actual', headers });
    expect(unexpected.statusCode).toBe(400);
    expect(unexpected.body).not.toMatch(/private|Authorization|token/);
    expect(unexpected.json().detail).toContain('Check bot access');
  });

  it('bounds adapter results to 25 and marks truncation', async () => {
    const { app, bot, headers } = await fixture();
    bot.searchMembers.mockResolvedValue({
      members: Array.from({ length: 26 }, (_, index) => ({
        ...result.members[0]!,
        id: String(index + 10),
      })),
      truncated: false,
    });
    const response = await app.inject({ url: '/api/discord/members?query=actual', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().members).toHaveLength(25);
    expect(response.json().truncated).toBe(true);
  });

  it('limits repeated member searches per address and returns a retry interval', async () => {
    const { app, bot, headers } = await fixture();
    for (let index = 0; index < 60; index++) {
      const response = await app.inject({ url: '/api/discord/members?query=actual', headers });
      expect(response.statusCode).toBe(200);
    }
    const response = await app.inject({ url: '/api/discord/members?query=actual', headers });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(bot.searchMembers).toHaveBeenCalledTimes(60);
  });
});
