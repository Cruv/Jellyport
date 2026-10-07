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
  path_mappings: PathMapping[];
  discord_enabled: boolean;
  discord_bot_token: string;
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
}
export const DEFAULT_SETTINGS: Settings = {
  emby_url: '',
  emby_api_key: '',
  jellyfin_url: '',
  jellyfin_api_key: '',
  jellyfin_public_url: '',
  template_user_id: '',
  path_mappings: [],
  discord_enabled: false,
  discord_bot_token: '',
  discord_guild_id: '',
  discord_admin_role_id: '',
  discord_member_role_id: '',
  discord_application_id: '',
  discord_subscription_channel_id: '',
  discord_subscription_bot_id: '',
  discord_message_events: false,
  discord_role_events: false,
  auto_provision: false,
  auto_disable: false,
  disable_on_cancel: false,
};
