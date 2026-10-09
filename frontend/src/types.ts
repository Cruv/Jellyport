export type Page =
  | 'overview'
  | 'users'
  | 'migrate'
  | 'mappings'
  | 'roles'
  | 'accounts'
  | 'memberships'
  | 'subscriptions'
  | 'activity'
  | 'settings';
export interface Session {
  authenticated: boolean;
  csrf_token: string;
  demo: boolean;
  setup_required: boolean;
  setup_connected: boolean;
  secure_cookie?: boolean;
  setup_server_url?: string;
  user?: { id: string; name: string };
}
export interface SetupConnection {
  session: Session;
  server: { url: string };
  templates: MediaUser[];
  defaults: { template_user_id: string; jellyfin_public_url: string };
}
export interface MediaUser {
  Id: string;
  Name: string;
  Policy?: { IsDisabled?: boolean; IsAdministrator?: boolean };
}
export interface Users {
  emby: MediaUser[];
  jellyfin: MediaUser[];
  errors?: Record<string, string>;
}
export interface UserMapping {
  id: string;
  source_user_id: string;
  source_username: string;
  target_user_id: string | null;
  target_username: string;
  discord_user_id: string | null;
  discord_username: string | null;
  membership_slot?: number;
  revision: string;
  source_server_url?: string;
  target_server_url?: string;
}
export interface DiscordMember {
  id: string;
  username: string;
  display_name: string | null;
  nickname: string | null;
  membership_active: boolean | null;
}
export interface MembershipTier {
  id: string;
  name: string;
  plan_name: string;
  account_limit: number;
}
export const defaultMembershipTiers: MembershipTier[] = [
  { id: 'sloop', name: 'Sloop', plan_name: 'Sloop Crewman Plan', account_limit: 1 },
  { id: 'brigantine', name: 'Brigantine', plan_name: 'Brigantine Crewman Plan', account_limit: 2 },
  { id: 'galleon', name: 'Galleon', plan_name: 'Galleon Crewman Plan', account_limit: 3 },
];
export interface MembershipLink {
  discord_user_id: string;
  username: string;
  remote_id: string;
  membership_slot: number;
  disabled_by_jellyport: number;
  pending_disabled: number | null;
}
export interface Membership {
  access_mode?: 'subscription' | 'complimentary';
  discord_user_id: string;
  base_username: string;
  tier_id: string;
  account_limit: number;
  revision: string;
  active?: boolean;
  links: MembershipLink[];
}
export type RoleSection = 'policy' | 'configuration' | 'display';
export interface RoleParameters {
  policy: Record<string, unknown>;
  configuration: Record<string, unknown>;
  display: Record<string, unknown> | null;
}
export interface AccountRole {
  id: string;
  name: string;
  revision: string;
  server_url: string;
  server_id: string;
  parameters: RoleParameters;
  updated_at: string;
}
export interface RoleAssignment {
  user_id: string;
  username: string;
  role_id: string;
  revision: string;
  applied_revision: string | null;
  applied_sections?: Partial<Record<RoleSection, string>>;
  updated_at: string;
  server_url?: string;
  server_id?: string;
}
export interface Connection {
  connected?: boolean;
  configured?: boolean;
  enabled?: boolean;
  name?: string;
  version?: string;
  error?: string;
}
export type Connections = Record<'emby' | 'jellyfin' | 'discord', Connection>;
export interface ItemIssue {
  Id?: string;
  Name?: string;
  name?: string;
  title?: string;
  Type?: string;
  source?: { Name?: string };
  candidate_ids?: string[];
}
export interface JobResult {
  source_catalog?: { captured_at: string; items: number };
  source_snapshot?: SourceSnapshotMetadata;
  username?: string;
  source_username?: string;
  mapping_id?: string;
  role_id?: string;
  role_name?: string;
  role_sections?: RoleSection[];
  warnings?: string[];
  data?: MigrationDetails;
  status: string;
  created?: boolean;
  matched?: number;
  applied?: number;
  already_played?: number;
  unmatched?: number;
  ambiguous?: number;
  unmatched_items?: ItemIssue[];
  ambiguous_items?: ItemIssue[];
  discord_delivery?: string | { status?: string };
  delivery_error?: string;
  error?: string;
}
export interface MigrationDetails {
  items_updated: number;
  favorites: number;
  resume_positions: number;
  play_counts: number;
  last_played_dates: number;
  ratings: number;
  preferences: string[];
  avatar: boolean;
  playlists_created: number;
  playlists_existing: number;
  playlist_items_added: number;
  playlist_items_skipped: number;
  playlist_duplicates_skipped: number;
  failed_items: number;
  history_dates_missing: number;
  warnings: string[];
}
export interface JobProgress {
  processed?: number;
  completed?: number;
  current?: number;
  total?: number;
  current_user?: string;
  phase?:
    | 'reading_source'
    | 'preparing_account'
    | 'reading_target'
    | 'transferring_history'
    | 'transferring_playlists'
    | 'delivering_credentials';
  items_processed?: number;
  items_total?: number;
  items_updated?: number;
}
export type MigrationScope = 'complete' | 'watched_only';
export interface SourceSnapshotMetadata {
  source_type?: 'sqlite_online_backup';
  schema?: string;
  id: string;
  source_server_url: string;
  source_server_id: string;
  source_server_version: string;
  source_user_id: string;
  source_username: string;
  scope: MigrationScope;
  started_at: string;
  finished_at: string;
  expires_at: string;
  items: number;
  playlists: number;
  playlist_entries: number;
  bytes: number;
  avatar: boolean;
}
export interface SourceSnapshotConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  time_zone: string;
  scope: MigrationScope;
  revision: string;
}
export interface SourceSnapshotStatus {
  available?: boolean;
  capture_method?: 'sqlite_online_backup';
  config: SourceSnapshotConfig;
  running: boolean;
  last_attempt_at: string | null;
  last_finished_at: string | null;
  last_error: string | null;
  users_total: number;
  users_processed: number;
  users_succeeded: number;
  users_failed: number;
  snapshots: number;
  encrypted_bytes: number;
  records: SourceSnapshotMetadata[];
}
export interface Job {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  updated_at?: string;
  results?: JobResult[];
  error?: string;
  progress?: number | JobProgress;
  migration_scope?: MigrationScope;
  cancel_requested?: boolean;
}
export interface Overview {
  counts: { emby_users?: number; jellyfin_users?: number; jobs?: number };
  connections: Connections;
  recent_jobs: Job[];
  pending_subscriptions?: number;
}
export interface PreviewUser {
  source_snapshot?: SourceSnapshotMetadata;
  source_user_id: string;
  username: string;
  source_username?: string;
  mapping_id?: string | null;
  mapping_revision?: string | null;
  discord_user_id?: string | null;
  discord_username?: string | null;
  warnings?: string[];
  target_exists: boolean;
  history_deferred?: boolean;
  stats: {
    source_played?: number;
    matched?: number;
    unmatched?: number;
    ambiguous?: number;
    already_played?: number;
    source_items?: number;
    source_favorites?: number;
    source_resume?: number;
    source_playlists?: number;
  } | null;
  unmatched?: ItemIssue[];
  ambiguous?: ItemIssue[];
}
export interface Preview {
  users: PreviewUser[];
  migration_scope?: MigrationScope;
  source_snapshot_ids?: Record<string, string>;
}
export interface PreviewTask {
  id: string;
  status: 'running' | 'ready' | 'failed';
  progress: { processed: number; total: number };
  preview?: Preview;
  error?: string;
}
export interface SubscriptionEvent {
  id: string;
  username?: string;
  discord_user_id?: string;
  action: string;
  status: string;
  created_at: string;
  source?: string;
  detail?: string;
  tier_id?: string;
  account_limit?: number;
  error?: string;
  job_id?: string;
}
export interface Recovery {
  username: string;
  eligible: boolean;
  reason: string;
  target_user_id?: string;
}
export interface Credential {
  username: string;
  password: string;
  server_url?: string;
}
export interface Settings {
  emby_url: string;
  emby_api_key_set: boolean;
  jellyfin_url: string;
  jellyfin_api_key_set: boolean;
  jellyfin_auth_managed: boolean;
  jellyfin_public_url: string;
  template_user_id: string;
  default_role_id?: string;
  path_mappings: { source: string; target: string }[];
  discord_enabled: boolean;
  discord_bot_token_set: boolean;
  discord_guild_id: string;
  discord_admin_role_id: string;
  discord_member_role_id: string;
  discord_application_id: string;
  discord_subscription_channel_id: string;
  discord_subscription_bot_id: string;
  discord_message_events: boolean;
  discord_role_events: boolean;
  discord_emby_role_id?: string;
  discord_jellyfin_role_id?: string;
  discord_auto_role_sync?: boolean;
  discord_emby_only_role?: boolean;
  auto_provision: boolean;
  auto_disable: boolean;
  disable_on_cancel: boolean;
  membership_tiers?: MembershipTier[];
  bot_invite_url: string;
  bot_organization_invite_url?: string;
}
export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}
export type Api = <T>(path: string, options?: ApiOptions) => Promise<T>;
export type Notify = (message: string, error?: boolean) => void;
export const activeJob = (job: Job) => ['queued', 'running'].includes(job.status);
export const num = (value?: number) => Number(value || 0).toLocaleString();
export const date = (value?: string) => {
  if (!value) return '—';
  const result = new Date(value);
  return Number.isNaN(result.getTime())
    ? '—'
    : result.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
};
export const safeUrl = (value?: string) => {
  try {
    const url = new URL(value || '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

export interface DirectoryAccount {
  id: string;
  name: string;
  disabled: boolean;
  protected: boolean;
  profile?: {
    family: boolean;
    owner_name: string;
    notes: string;
    revision: string;
  } | null;
}
export interface DirectoryUser {
  id: string;
  emby: DirectoryAccount[];
  jellyfin: DirectoryAccount[];
  discord_user_id: string | null;
  discord_username: string | null;
  access_mode: 'subscription' | 'complimentary' | 'standalone' | 'unlinked';
  account_limit: number | null;
  protected: boolean;
  family?: boolean;
  requires_review?: boolean;
}
export interface DiscordTagRole {
  id: string;
  name: string;
  manageable: boolean;
}
export interface DiscordTagPreview {
  token: string;
  changes: Array<{ discord_user_id: string; username: string; add: string[]; remove: string[] }>;
  unchanged: number;
  unlinked: number;
  unavailable?: number;
}
