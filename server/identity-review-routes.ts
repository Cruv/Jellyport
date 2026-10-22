import type { FastifyRequest } from 'fastify';
import type { JellyportApp } from './main.js';
import type { IdentityReview } from './identity-review.js';
import type { IdentityReviewApplyInput } from './identity-review-types.js';

/** Central authentication, origin and CSRF hooks protect every inventory endpoint. */
export function registerIdentityReviewRoutes(
  app: JellyportApp,
  review: IdentityReview,
  authorization: (request: FastifyRequest) => () => void,
): void {
  app.get('/api/identity-review', async () => review.snapshot());
  app.post('/api/identity-review/refresh', async () => review.snapshot(true));
  app.get('/api/identity-review/roles', async () => review.roleSync.recent());
  app.get<{ Params: { task_id: string } }>(
    '/api/identity-review/roles/:task_id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['task_id'],
          properties: { task_id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
        },
      },
    },
    async (request) => review.roleSync.status(request.params.task_id),
  );
  const identifier = { type: 'string', minLength: 1, maxLength: 128 };
  app.post<{ Body: IdentityReviewApplyInput }>(
    '/api/identity-review/apply',
    {
      bodyLimit: 512 * 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'selections'],
          properties: {
            revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            selections: {
              type: 'array',
              minItems: 1,
              maxItems: 250,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['row_id', 'discord_user_id', 'stripe_customer_ids', 'accounts'],
                properties: {
                  row_id: { type: 'string', minLength: 1, maxLength: 300 },
                  discord_user_id: { type: 'string', pattern: '^(?:[1-9][0-9]{0,19})?$' },
                  stripe_customer_ids: {
                    type: 'array',
                    maxItems: 10,
                    uniqueItems: true,
                    items: { type: 'string', pattern: '^cus_[A-Za-z0-9]+$', maxLength: 244 },
                  },
                  accounts: {
                    type: 'array',
                    maxItems: 6,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['kind', 'id', 'slot'],
                      properties: {
                        kind: { type: 'string', enum: ['emby', 'jellyfin'] },
                        id: identifier,
                        slot: { type: 'integer', minimum: 1, maximum: 3 },
                      },
                    },
                  },
                  exception: {
                    anyOf: [
                      { type: 'null' },
                      {
                        type: 'object',
                        additionalProperties: false,
                        required: ['kind', 'note'],
                        properties: {
                          kind: {
                            type: 'string',
                            enum: ['non_media', 'complimentary', 'approved'],
                          },
                          note: { type: 'string', minLength: 1, maxLength: 1000 },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => review.apply(request.body, authorization(request)),
  );
}
