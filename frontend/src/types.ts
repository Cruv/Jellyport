export type Page =
  'overview' | 'migrate' | 'mappings' | 'accounts' | 'subscriptions' | 'activity' | 'settings';
export interface Session {
  authenticated: boolean;
  csrf_token: string;
  demo: boolean;
  setup_required: boolean;
  setup_connected: boolean;
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
  username?: string;
  source_username?: string;
  mapping_id?: string;
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
export interface Job {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  results?: JobResult[];
  error?: string;
  progress?: number | { processed?: number; completed?: number; current?: number; total?: number };
}
export interface Overview {
  counts: { emby_users?: number; jellyfin_users?: number; jobs?: number };
  connections: Connections;
  recent_jobs: Job[];
  pending_subscriptions?: number;
}
export interface PreviewUser {
  source_user_id: string;
  username: string;
  source_username?: string;
  mapping_id?: string | null;
  mapping_revision?: string | null;
  discord_user_id?: string | null;
  discord_username?: string | null;
  warnings?: string[];
  target_exists: boolean;
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
  };
  unmatched?: ItemIssue[];
  ambiguous?: ItemIssue[];
}
export interface Preview {
  users: PreviewUser[];
}
export interface SubscriptionEvent {
  id: string;
  username?: string;
  discord_user_id?: string;
  action: string;
  status: string;
  created_at: string;
  source?: string;
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
  auto_provision: boolean;
  auto_disable: boolean;
  disable_on_cancel: boolean;
  bot_invite_url: string;
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
