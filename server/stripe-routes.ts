import type { JellyportApp } from './main.js';
import type { StripeIntegration } from './stripe-integration.js';
import { ServiceError } from './errors.js';

/** Uses the central administrator/CSRF hooks. Billing details never have a public route. */
export function registerStripeRoutes(
  app: JellyportApp,
  stripe: StripeIntegration,
  demo: boolean,
): void {
  const writable = () => {
    if (demo) throw new ServiceError('Stripe connections cannot be changed in demo mode.');
  };
  const revision = { type: 'string', minLength: 1, maxLength: 128 };
  app.get('/api/stripe/status', async () => stripe.status());
  app.get('/api/stripe/subscriptions', async () => ({
    subscriptions: stripe.subscriptions(),
    revision: stripe.status().revision,
  }));
  app.post<{ Body: Parameters<StripeIntegration['configure']>[0] }>(
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
            expected_revision: revision,
            price_tiers: {
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
            },
          },
        },
      },
    },
    async (request) => {
      writable();
      return stripe.configure(request.body);
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
