import type { Service } from './service.js';
import type { StripeIntegration } from './stripe-integration.js';
import type { MediaKind } from './media.js';

interface HouseholdAccount {
  kind: MediaKind;
  account_id: string;
  username: string;
  slot: number;
  identity: 'confirmed' | 'mapped' | 'linked';
  access: 'owner_managed' | 'pending' | 'disabled_by_jellyport' | null;
}

export function householdTimeline(service: Service, stripe: StripeIntegration, discordId: string) {
  const { store, memberships, mappings, mediaOwnerships } = service;
  const settings = store.settings();
  const membership = memberships.get(discordId, settings);
  const approved = mediaOwnerships.forOwner(discordId, settings);
  const accountMappings = mappings.getAllForDiscord(discordId, settings);
  const links =
    membership || !memberships.hasOtherScope(discordId, settings)
      ? store.linksForMember(discordId)
      : [];
  const billing = stripe.householdEvidence(discordId);
  const authority = service.discordAuthorityState(discordId, settings);
  const accounts = new Map<string, HouseholdAccount>();
  const key = (kind: MediaKind, id: string) => `${kind}:${id}`;
  for (const account of approved) {
    accounts.set(key(account.kind, account.account_id), {
      kind: account.kind,
      account_id: account.account_id,
      username: account.username,
      slot: account.slot,
      identity: 'confirmed',
      access: null,
    });
  }
  const addMapping = (kind: MediaKind, id: string, username: string, slot: number) => {
    if (!accounts.has(key(kind, id)))
      accounts.set(key(kind, id), {
        kind,
        account_id: id,
        username,
        slot,
        identity: 'mapped',
        access: null,
      });
  };
  for (const mapping of accountMappings) {
    addMapping(
      'emby',
      mapping.source_user_id,
      mapping.source_username,
      mapping.membership_slot ?? 1,
    );
    if (mapping.target_user_id)
      addMapping(
        'jellyfin',
        mapping.target_user_id,
        mapping.target_username,
        mapping.membership_slot ?? 1,
      );
  }
  for (const link of links) {
    const accountKey = key('jellyfin', link.remote_id);
    const existing = accounts.get(accountKey);
    accounts.set(accountKey, {
      kind: 'jellyfin',
      account_id: link.remote_id,
      username: link.username,
      slot: link.membership_slot,
      identity: existing?.identity ?? 'linked',
      access:
        link.pending_disabled !== null
          ? 'pending'
          : link.disabled_by_jellyport
            ? 'disabled_by_jellyport'
            : 'owner_managed',
    });
  }
  const events = store.subscriptionsForMember(discordId, undefined, 50);
  const linkedOperations = new Set(events.map((event) => event.job_id));
  const milestones = [
    ...approved.map((account) => ({
      key: `${account.kind}:${account.account_id}`,
      type: 'ownership' as const,
      at: account.approved_at,
      kind: account.kind,
      username: account.username,
      slot: account.slot,
    })),
    ...events.map((event) => ({
      key: event.id,
      type: 'subscription' as const,
      at: event.created_at,
      action: event.action,
      status: event.stripe_expiry_deferred ? 'deferred' : event.status,
      source: event.source ?? null,
      job_id: event.report_cleared ? undefined : event.job_id,
      invoice: event.stripe_entitlement
        ? {
            paid_through: event.stripe_entitlement.paid_through,
            observed_at: event.stripe_entitlement.observed_at,
            tier_id: event.stripe_entitlement.tier_id,
          }
        : undefined,
    })),
    ...store
      .householdJobSummaries(discordId)
      .filter((job) => !linkedOperations.has(job.id))
      .map((job) => ({
        key: job.id,
        type: 'membership' as const,
        at: job.finished_at ?? job.created_at,
        status: job.outcome_status,
        job_id: job.id,
      })),
    ...store.householdAccessChanges(discordId, settings).map((change) => ({
      key: change.id,
      type: 'access' as const,
      at: change.at,
      kind: change.kind,
      username: change.username,
      disabled: change.disabled,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 50);
  return {
    discord_user_id: discordId,
    username:
      membership?.base_username ??
      accountMappings[0]?.discord_username ??
      billing.username ??
      links[0]?.username ??
      null,
    authority,
    membership: membership
      ? {
          access_mode: membership.access_mode,
          active: membership.active !== false,
          tier:
            settings.membership_tiers?.find((tier) => tier.id === membership.tier_id)?.name ??
            membership.tier_id,
          account_limit: membership.account_limit,
          provision_jellyfin: membership.provision_jellyfin !== false,
        }
      : null,
    accounts: [...accounts.values()].sort(
      (a, b) => a.slot - b.slot || a.kind.localeCompare(b.kind),
    ),
    stripe: {
      customer_count: billing.customer_count,
      last_sync: billing.last_sync,
      complete: billing.complete,
      subscriptions: billing.subscriptions,
      invoice: authority === 'current' ? billing.invoice : null,
    },
    milestones,
  };
}

export type HouseholdTimeline = ReturnType<typeof householdTimeline>;
