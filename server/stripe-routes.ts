import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { JellyportApp } from './main.js';
import type {
  StripeIntegration,
  StripeIntegrationConfiguration,
  StripePriceTierImpact,
} from './stripe-integration.js';
import type { DiscordAuthorityReviews, Household } from './discord-authority-routes.js';
import { ServiceError } from './errors.js';
import { WorkflowReviews } from './workflow-reviews.js';
import { discordAuthority } from './discord-authority.js';

export interface StripePriceReview extends Omit<StripePriceTierImpact, 'affected'> {
  affected: Array<Household & { price_ids: string[] }>;
  review_token: string;
  expires_at: string;
}

/** Uses the central administrator/CSRF hooks. Billing details never have a public route. */
export function registerStripeRoutes(
  app: JellyportApp,
  stripe: StripeIntegration,
  demo: boolean,
  authority: DiscordAuthorityReviews,
  reviewOwner: (request: FastifyRequest) => string,
  listCleanupRoles: () => Promise<{
    roles: Array<{ id: string; name: string; manageable: boolean }>;
    can_manage_roles: boolean;
  }>,
): void {
  const writable = () => {
    if (demo) throw new ServiceError('Stripe connections cannot be changed in demo mode.');
  };
  const revision = { type: 'string', minLength: 1, maxLength: 128 };
  const priceTiers = {
    type: 'array',
    maxItems: 100,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['price_id', 'tier_id'],
      properties: {
        price_id: { type: 'string', pattern: '^price_[A-Za-z0-9]+$', maxLength: 128 },
        tier_id: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  };
  const priceReviews = new WorkflowReviews<string>();
  const priceReviewScope = 'stripe-price-change';
  const reviewedImpact = (impact: StripePriceTierImpact) => {
    const { store } = authority.service;
    const settings = store.settings();
    const linkedPrices = new Map(
      impact.affected.map(({ discord_user_id, price_ids }) => [discord_user_id, price_ids]),
    );
    const affected = authority
      .households(settings, new Set(linkedPrices.keys()))
      .map((household) => ({
        ...household,
        accounts: [...household.accounts].sort(
          (a, b) =>
            a.slot - b.slot ||
            a.kind.localeCompare(b.kind) ||
            String(a.id).localeCompare(String(b.id)) ||
            a.username.localeCompare(b.username),
        ),
        price_ids: linkedPrices.get(household.discord_user_id)!,
      }));
    if (affected.length !== linkedPrices.size)
      throw new ServiceError(
        'An affected Stripe household could not be resolved. Review saved ownership first.',
      );
    const plan = { ...impact, affected };
    const memberships = affected.map(
      ({ discord_user_id }) =>
        authority.service.memberships.get(discord_user_id, settings)?.revision ?? null,
    );
    const context = createHash('sha256')
      .update(
        JSON.stringify([
          discordAuthority(settings),
          settings.new_subscriber_source,
          settings.emby_url,
          settings.jellyfin_url,
          store.authState(),
          plan,
          memberships,
        ]),
      )
      .digest('hex');
    return { plan, context };
  };
  app.get('/api/stripe/status', async () => stripe.status());
  app.get('/api/stripe/cleanup-roles', async () => {
    writable();
    return listCleanupRoles();
  });
  app.get('/api/stripe/subscriptions', async () => ({
    subscriptions: stripe.subscriptions(),
    revision: stripe.status().revision,
  }));
  app.post<{
    Body: {
      expected_revision: string;
      price_tiers: NonNullable<StripeIntegrationConfiguration['price_tiers']>;
    };
  }>(
    '/api/stripe/config/price-review',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_revision', 'price_tiers'],
          properties: { expected_revision: revision, price_tiers: priceTiers },
        },
      },
    },
    async (request): Promise<StripePriceReview> => {
      writable();
      const owner = reviewOwner(request);
      const { plan, context } = reviewedImpact(
        stripe.priceTierImpact(request.body.expected_revision, request.body.price_tiers),
      );
      return { ...plan, ...priceReviews.save(owner, priceReviewScope, context) };
    },
  );
  app.post<{ Body: StripeIntegrationConfiguration & { price_review_token?: string } }>(
    '/api/stripe/config',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sync_enabled', 'expected_revision'],
          properties: {
            api_key: { type: 'string', maxLength: 512 },
            sync_enabled: { type: 'boolean' },
            automation_enabled: { type: 'boolean' },
            role_cleanup_enabled: { type: 'boolean' },
            role_cleanup_role_ids: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' },
            },
            expected_revision: revision,
            price_tiers: priceTiers,
            price_review_token: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      writable();
      const { price_review_token: token, ...configuration } = request.body;
      return stripe.configure(configuration, (impact) => {
        if (!token)
          throw new ServiceError(
            'Review the affected households and exact account slots before saving Stripe price changes.',
          );
        const approved = priceReviews.take(reviewOwner(request), priceReviewScope, token);
        if (approved !== reviewedImpact(impact).context)
          throw new ServiceError(
            'The Stripe price review changed. Review the affected households and slots again.',
          );
      });
    },
  );
  app.post('/api/stripe/sync', async (_request, reply) => {
    writable();
    if (!stripe.status().configured)
      throw new ServiceError('Save a restricted Stripe key before syncing.');
    // A bounded shared task outlives the HTTP request, avoiding proxy timeouts.
    void stripe.sync().catch(() => {});
    return reply.code(202).send(stripe.status());
  });
  app.post<{ Body: { expected_revision: string } }>(
    '/api/stripe/disconnect',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_revision'],
          properties: { expected_revision: revision },
        },
      },
    },
    async (request) => {
      writable();
      return stripe.disconnect(request.body);
    },
  );
  app.post<{ Body: { customer_id: string; expected_revision: string } }>(
    '/api/stripe/resolve-candidate',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_id', 'expected_revision'],
          properties: {
            customer_id: { type: 'string', pattern: '^cus_[A-Za-z0-9]+$', maxLength: 128 },
            expected_revision: revision,
          },
        },
      },
    },
    async (request) => {
      writable();
      const identity = await stripe.resolveCandidate(request.body);
      return {
        member: { ...identity, display_name: null, nickname: null, membership_active: null },
      };
    },
  );
  app.post<{ Body: Parameters<StripeIntegration['linkCustomer']>[0] }>(
    '/api/stripe/links',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_id', 'discord_user_id', 'expected_revision'],
          properties: {
            customer_id: { type: 'string', pattern: '^cus_[A-Za-z0-9]+$', maxLength: 128 },
            discord_user_id: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' },
            expected_revision: revision,
          },
        },
      },
    },
    async (request) => {
      writable();
      return stripe.linkCustomer(request.body);
    },
  );
  app.delete<{ Params: { customer_id: string }; Body: { expected_revision: string } }>(
    '/api/stripe/links/:customer_id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['customer_id'],
          properties: {
            customer_id: { type: 'string', pattern: '^cus_[A-Za-z0-9]+$', maxLength: 128 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_revision'],
          properties: { expected_revision: revision },
        },
      },
    },
    async (request) => {
      writable();
      return stripe.unlinkCustomer({ ...request.body, customer_id: request.params.customer_id });
    },
  );
}
