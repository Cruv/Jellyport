import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ServiceError } from './errors.js';
import { DEFAULT_MEMBERSHIP_TIERS, validateMembershipTiers } from './memberships.js';
import type { Service } from './service.js';
import type { StripeIntegration } from './stripe-integration.js';
import type { Settings } from './types.js';
import { WorkflowReviews } from './workflow-reviews.js';

type Proposal = Pick<
  Settings,
  'discord_guild_id' | 'discord_member_role_id' | 'new_subscriber_source' | 'membership_tiers'
>;
type Account = {
  kind: 'emby' | 'jellyfin';
  id: string | null;
  username: string;
  slot: number;
};
export type Household = {
  discord_user_id: string;
  username: string;
  tier_id: string | null;
  slots: number;
  proposed_slots: number | null;
  customers: number;
  authority_state: ReturnType<Service['discordAuthorityState']>;
  accounts: Account[];
};
const scope = (settings: Settings): Proposal => ({
  discord_guild_id: settings.discord_guild_id,
  discord_member_role_id: settings.discord_member_role_id,
  new_subscriber_source: settings.new_subscriber_source,
  membership_tiers: settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS,
});
const fields = [
  'discord_guild_id',
  'discord_member_role_id',
  'new_subscriber_source',
  'membership_tiers',
];
const memberId = '^[0-9]{5,22}$';
const reviewToken = { type: 'string', minLength: 1, maxLength: 128 };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class DiscordAuthorityReviews {
  private readonly cutovers = new WorkflowReviews<true>();
  private readonly householdReviews = new WorkflowReviews<string>();
  constructor(
    readonly service: Service,
    readonly stripe: StripeIntegration,
  ) {}

  attentionCount(): number {
    return this.households(this.service.store.settings()).filter(
      (row) => row.authority_state !== 'current',
    ).length;
  }

  households(settings: Settings, only?: ReadonlySet<string>): Household[] {
    const rows = new Map<string, Household>();
    const get = (id: string, username: string) => {
      let row = rows.get(id);
      if (!row) {
        row = {
          discord_user_id: id,
          username,
          tier_id: null,
          slots: 0,
          proposed_slots: null,
          authority_state: this.service.discordAuthorityState(id, settings),
          customers: 0,
          accounts: [],
        };
        rows.set(id, row);
      }
      return row;
    };
    const addAccount = (id: string, account: Account) => {
      const row = get(id, account.username);
      if (
        !row.accounts.some(
          (existing) =>
            existing.kind === account.kind &&
            existing.id === account.id &&
            (account.id !== null || existing.username === account.username),
        )
      )
        row.accounts.push(account);
    };
    for (const member of this.service.memberships.list(settings)) {
      if (only && !only.has(member.discord_user_id)) continue;
      const row = get(member.discord_user_id, member.base_username);
      row.tier_id = member.tier_id;
      row.slots = member.account_limit;
    }
    for (const link of this.service.store.links()) {
      if (only && !only.has(link.discord_user_id)) continue;
      const row = get(link.discord_user_id, link.username);
      if (!row.tier_id) row.slots = Math.max(row.slots, link.membership_slot);
      addAccount(link.discord_user_id, {
        kind: 'jellyfin',
        id: link.remote_id,
        username: link.username,
        slot: link.membership_slot,
      });
    }
    for (const owner of this.service.mediaOwnerships.list(settings)) {
      if (only && !only.has(owner.discord_user_id)) continue;
      addAccount(owner.discord_user_id, {
        kind: owner.kind,
        id: owner.account_id,
        username: owner.username,
        slot: owner.slot,
      });
    }
    for (const mapping of this.service.mappings.list(settings)) {
      if (!mapping.discord_user_id || (only && !only.has(mapping.discord_user_id))) continue;
      const slot = mapping.membership_slot ?? 1;
      addAccount(mapping.discord_user_id, {
        kind: 'emby',
        id: mapping.source_user_id,
        username: mapping.source_username,
        slot,
      });
      addAccount(mapping.discord_user_id, {
        kind: 'jellyfin',
        id: mapping.target_user_id,
        username: mapping.target_username,
        slot,
      });
    }
    for (const customer of this.stripe.approvedCustomerOwners()) {
      if (only && !only.has(customer.discord_user_id)) continue;
      get(customer.discord_user_id, customer.username).customers++;
    }
    return [...rows.values()].sort((a, b) => a.discord_user_id.localeCompare(b.discord_user_id));
  }

  private plan(previous: Settings, next: Settings) {
    const current = scope(previous),
      proposed = scope(next);
    const authorityChanged =
      current.discord_guild_id !== proposed.discord_guild_id ||
      current.discord_member_role_id !== proposed.discord_member_role_id ||
      current.new_subscriber_source !== proposed.new_subscriber_source;
    const tiers = new Map(proposed.membership_tiers?.map((tier) => [tier.id, tier]));
    const affectedTiers = new Set(
      (current.membership_tiers ?? [])
        .filter((tier) => {
          const after = tiers.get(tier.id);
          return (
            !after ||
            tier.account_limit !== after.account_limit ||
            tier.plan_name !== after.plan_name
          );
        })
        .map((tier) => tier.id),
    );
    const affected =
      authorityChanged || affectedTiers.size
        ? this.households(previous).filter(
            (row) => authorityChanged || (row.tier_id && affectedTiers.has(row.tier_id)),
          )
        : [];
    for (const row of affected)
      row.proposed_slots =
        row.tier_id === 'complimentary'
          ? row.slots
          : (tiers.get(row.tier_id ?? '')?.account_limit ?? null);
    return { current, proposed, affected };
  }

  assertCutover(previous: Settings, next: Settings, token: unknown, owner: string): void {
    const plan = this.plan(previous, next);
    if (!plan.affected.length) return;
    if (typeof token !== 'string')
      throw new ServiceError(
        'Review the affected households and accounts before saving this authority or tier change.',
      );
    this.cutovers.take(owner, digest(plan), token);
  }

  register(app: FastifyInstance, owner: (request: FastifyRequest) => string): void {
    app.post<{ Body: Partial<Proposal> }>(
      '/api/discord/authority/review',
      {
        schema: { body: { type: 'object' } },
      },
      async (request) => {
        if (Object.keys(request.body).some((field) => !fields.includes(field)))
          throw new ServiceError(
            'Choose the Discord authority, billing source or membership tiers to review.',
          );
        const current = this.service.store.settings();
        const next = { ...current, ...request.body };
        for (const id of [next.discord_guild_id, next.discord_member_role_id])
          if (typeof id !== 'string' || (id && !/^[0-9]{5,22}$/.test(id)))
            throw new ServiceError('Enter valid Discord server and subscriber role IDs.');
        if (
          !['stripe', 'trusted_messages'].includes(next.new_subscriber_source ?? 'trusted_messages')
        )
          throw new ServiceError('Choose a supported billing source.');
        if (next.membership_tiers !== undefined) validateMembershipTiers(next.membership_tiers);
        const plan = this.plan(current, next);
        return { ...plan, ...this.cutovers.save(owner(request), digest(plan), true) };
      },
    );
    app.get('/api/discord/authority/households', async () => ({
      households: this.households(this.service.store.settings()).filter(
        (row) => row.authority_state !== 'current',
      ),
    }));
    app.post<{ Params: { id: string } }>(
      '/api/discord/authority/households/:id/review',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', pattern: memberId } },
          },
        },
      },
      async (request) => {
        const review = await this.service.reviewDiscordAuthorityMember(request.params.id);
        return {
          ...review.summary,
          ...this.householdReviews.save(owner(request), request.params.id, review.signature),
        };
      },
    );
    app.post<{ Params: { id: string }; Body: { review_token: string } }>(
      '/api/discord/authority/households/:id/approve',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', pattern: memberId } },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['review_token'],
            properties: { review_token: reviewToken },
          },
        },
      },
      async (request) => {
        const session = owner(request);
        const review = this.householdReviews.take(
          session,
          request.params.id,
          request.body.review_token,
        );
        return this.service.approveDiscordAuthorityMember(request.params.id, review, () => {
          if (owner(request) !== session)
            throw new ServiceError('Sign in again to approve Discord authority.');
        });
      },
    );
  }
}
