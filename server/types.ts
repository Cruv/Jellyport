import { DEFAULT_MEMBERSHIP_TIERS, type MembershipTier } from './memberships.js';

export interface PathMapping {
  source: string;
  target: string;
}
export interface Settings {
  emby_url: string;
  emby_api_key: string;
  jellyfin_url: string;
  jellyfin_api_key: string;
  jellyfin_public_url: string;
  template_user_id: string;
  default_role_id?: string;
  path_mappings: PathMapping[];
  discord_enabled: boolean;
  discord_bot_token: string;
  discord_guild_id: string;
  discord_admin_role_id: string;
  discord_member_role_id: string;
  discord_emby_role_id?: string;
  discord_jellyfin_role_id?: string;
  discord_auto_role_sync?: boolean;
  discord_emby_only_role?: boolean;
  discord_application_id: string;
  discord_subscription_channel_id: string;
  discord_subscription_bot_id: string;
  discord_message_events: boolean;
  discord_role_events: boolean;
  auto_provision: boolean;
  auto_disable: boolean;
  disable_on_cancel: boolean;
  membership_tiers?: MembershipTier[];
}
export const DEFAULT_SETTINGS: Settings = {
  emby_url: '',
  emby_api_key: '',
  jellyfin_url: '',
  jellyfin_api_key: '',
  jellyfin_public_url: '',
  template_user_id: '',
  default_role_id: '',
  path_mappings: [],
  discord_enabled: false,
  discord_bot_token: '',
  discord_guild_id: '',
  discord_admin_role_id: '',
  discord_member_role_id: '',
  discord_emby_role_id: '',
  discord_jellyfin_role_id: '',
  discord_auto_role_sync: false,
  discord_emby_only_role: true,
  discord_application_id: '',
  discord_subscription_channel_id: '',
  discord_subscription_bot_id: '',
  discord_message_events: false,
  discord_role_events: false,
  auto_provision: false,
  auto_disable: false,
  disable_on_cancel: false,
  membership_tiers: structuredClone(DEFAULT_MEMBERSHIP_TIERS),
};

export const DEMO_SETTINGS: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  emby_url: 'http://demo-emby',
  emby_api_key: 'demo',
  jellyfin_url: 'http://demo-jellyfin',
  jellyfin_api_key: 'demo',
  jellyfin_public_url: 'https://jellyfin.example.com',
  template_user_id: 'template',
};
