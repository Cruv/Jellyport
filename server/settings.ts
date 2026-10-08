import { ServiceError } from './errors.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';
import { validateMembershipTiers } from './memberships.js';
export const SECRET_FIELDS = ['emby_api_key', 'jellyfin_api_key', 'discord_bot_token'] as const;
const snowflake = /^[0-9]{5,22}$/;
const control = /[\x00-\x1f]/;

export function validateSettings(input: unknown): asserts input is Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ServiceError('Settings must be an object.');
  const settings = input as Record<string, unknown>;
  if (Object.keys(settings).some((key) => !Object.hasOwn(DEFAULT_SETTINGS, key)))
    throw new ServiceError('Unknown setting supplied.');
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    const value = settings[key];
    if (typeof defaultValue === 'boolean' && typeof value !== 'boolean')
      throw new ServiceError(`${key} must be a boolean.`);
    if (typeof defaultValue === 'string' && (typeof value !== 'string' || value.length > 4096))
      throw new ServiceError(`${key} must be a string of at most 4096 characters.`);
    if (typeof value === 'string' && control.test(value))
      throw new ServiceError('Settings cannot contain control characters.');
  }
  for (const key of ['emby_url', 'jellyfin_url', 'jellyfin_public_url']) {
    if (!settings[key]) continue;
    try {
      const url = new URL(settings[key] as string);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ServiceError(
        'Server URLs must use http:// or https:// without embedded credentials, query strings or fragments.',
      );
    }
  }
  for (const key of [
    'discord_guild_id',
    'discord_admin_role_id',
    'discord_member_role_id',
    'discord_application_id',
    'discord_subscription_channel_id',
    'discord_subscription_bot_id',
  ]) {
    if (settings[key] && !snowflake.test(settings[key] as string))
      throw new ServiceError(`${key} must be a Discord numeric ID.`);
  }
  const mappings = settings.path_mappings;
  validateMembershipTiers(
    settings.membership_tiers === undefined
      ? DEFAULT_SETTINGS.membership_tiers
      : settings.membership_tiers,
  );
  if (!Array.isArray(mappings) || mappings.length > 20)
    throw new ServiceError('Provide at most 20 path mappings.');
  for (const item of mappings) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'source,target' ||
      !Object.values(item).every(
        (value) =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length < 1024 &&
          !control.test(value),
      )
    )
      throw new ServiceError('Each path mapping needs nonempty source and target prefixes.');
  }
  if (settings.discord_enabled && (!settings.discord_bot_token || !settings.discord_guild_id))
    throw new ServiceError('To enable Discord, supply the bot token and server ID.');
  if (
    settings.discord_message_events &&
    (!settings.discord_subscription_channel_id || !settings.discord_subscription_bot_id)
  )
    throw new ServiceError(
      'MEE6 message events require the trusted bot ID and subscription channel ID.',
    );
  if (settings.discord_role_events && !settings.discord_member_role_id)
    throw new ServiceError('Membership role events require an active subscriber role ID.');
  if (
    (settings.auto_provision || settings.auto_disable) &&
    (!settings.discord_enabled ||
      !(settings.discord_message_events || settings.discord_role_events))
  )
    throw new ServiceError(
      'Automation requires a connected Discord configuration and a message or role event source.',
    );
}
