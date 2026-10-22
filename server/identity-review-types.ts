/** Administrator-only identity suggestions. No suggestion grants ownership until reviewed. */
export type IdentityMediaKind = 'emby' | 'jellyfin';
export interface IdentityDiscordMember {
  id: string;
  username: string;
  display_name?: string;
  nickname?: string;
  roles: string[];
}
export interface IdentityRoster {
  members: IdentityDiscordMember[];
  complete: boolean;
  fetched_at: string;
}
export interface IdentityAccount {
  kind: IdentityMediaKind;
  id: string;
  name: string;
  disabled: boolean;
  family: boolean;
  administrator: boolean;
  owner_discord_id: string | null;
  slot: number | null;
  ownership_conflict?: boolean;
}
export interface IdentityAccountSuggestion {
  account: IdentityAccount;
  reason: string;
  reliable: boolean;
}
export interface IdentityBillingCustomer {
  id: string;
  name: string | null;
  email: string | null;
  linked_discord_id: string | null;
  proposed_discord_id: string | null;
  statuses: string[];
  tier_id: string | null;
  active_subscription: boolean;
  identity_conflict?: boolean;
}
export type IdentityGap =
  | 'active_subscription_no_media'
  | 'active_subscription_no_discord'
  | 'media_without_active_subscription'
  | 'media_without_discord'
  | 'discord_without_active_subscription'
  | 'discord_without_media'
  | 'unlinked_media'
  | 'unlinked_billing'
  | 'disabled_media'
  | 'identity_conflict'
  | 'billing_unknown';
export interface IdentityException {
  kind: 'non_media' | 'complimentary' | 'approved';
  note: string;
  approved_at: string;
}
export interface IdentityReviewRow {
  id: string;
  member: IdentityDiscordMember | null;
  member_candidates: IdentityDiscordMember[];
  customers: IdentityBillingCustomer[];
  confirmed_accounts: IdentityAccount[];
  suggestions: IdentityAccountSuggestion[];
  gaps: IdentityGap[];
  exception: IdentityException | null;
  reliable: boolean;
  conflict: string | null;
}
export interface IdentitySourceStatus {
  available: boolean;
  complete: boolean;
  updated_at: string | null;
  error?: string;
}
export interface IdentityReviewSnapshot {
  revision: string;
  generated_at: string;
  expires_at: string;
  sources: Record<'discord' | 'emby' | 'jellyfin' | 'stripe', IdentitySourceStatus>;
  rows: IdentityReviewRow[];
  accounts: IdentityAccount[];
  summary: {
    members: number;
    unlinked_accounts: number;
    suggestions: number;
    gaps: number;
    acknowledged: number;
  };
}
export interface IdentityApproval {
  row_id: string;
  discord_user_id: string;
  stripe_customer_ids: string[];
  accounts: Array<{ kind: IdentityMediaKind; id: string; slot: number }>;
  /** Omit to preserve an existing exception; null removes only the review annotation. */
  exception?: { kind: IdentityException['kind']; note: string } | null;
}
export interface IdentityReviewApplyInput {
  revision: string;
  selections: IdentityApproval[];
}
export interface IdentityReviewApplyResult {
  approved: number;
  roles: {
    status: 'updated' | 'queued' | 'pending' | 'not_configured' | 'not_requested' | 'failed';
    task_id?: string;
    updated: number;
    failed: number;
    message?: string;
  };
  warnings: string[];
}
