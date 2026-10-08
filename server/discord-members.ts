import { BotError } from './bot.js';
import { ServiceError } from './errors.js';
import { WindowLimiter } from './security.js';
import type { JellyportApp } from './main.js';

/** Only fields needed to choose an identity; SDK objects never cross the HTTP boundary. */
export interface DiscordMemberSummary {
  id: string;
  username: string;
  display_name: string | null;
  nickname: string | null;
  membership_active: boolean;
}
export interface DiscordMemberSearchResult {
  members: DiscordMemberSummary[];
  truncated: boolean;
}

/** Register before ready(); the application's central hook authenticates every search. */
export function registerDiscordMemberRoutes(app: JellyportApp): void {
  const searches = new WindowLimiter(60, 60_000);
  app.addHook('onClose', async () => searches.clear());
  app.get<{ Querystring: { query: string } }>(
    '/api/discord/members',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: { query: { type: 'string', minLength: 2, maxLength: 64 } },
        },
      },
    },
    async (request, reply): Promise<DiscordMemberSearchResult> => {
      if (!searches.allow(request.ip)) {
        reply.header('Retry-After', '60');
        throw Object.assign(new Error('Too many Discord searches. Wait a minute and try again.'), {
          statusCode: 429,
        });
      }
      const bot = app.jellyport.service.bot;
      if (!bot?.searchMembers)
        throw new ServiceError('Connect the Discord bot before searching server members.');
      try {
        const result = await bot.searchMembers(request.query.query);
        // Explicitly project the public DTO even when an adapter is used in development.
        return {
          members: result.members.slice(0, 25).map((member) => ({
            id: member.id,
            username: member.username,
            display_name: member.display_name,
            nickname: member.nickname,
            membership_active: member.membership_active,
          })),
          truncated: result.truncated || result.members.length > 25,
        };
      } catch (error) {
        if (error instanceof BotError) throw new ServiceError(error.message);
        throw new ServiceError(
          'Discord members could not be searched. Check bot access and try again.',
        );
      }
    },
  );
}
