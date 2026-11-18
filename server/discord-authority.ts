import { createHash } from 'node:crypto';
import type { Settings } from './types.js';

export const DISCORD_DISCOVERY_PAGE_SIZE = 50;

export function discordAuthority(settings: Partial<Settings>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([settings.discord_guild_id ?? '', settings.discord_member_role_id ?? '']),
    )
    .digest('hex');
}

export type DiscordAuthorityState = 'current' | 'legacy' | 'held';

export function discordAuthorityState(
  settings: Settings,
  bindings: Array<string | null | undefined>,
): DiscordAuthorityState {
  const current = discordAuthority(settings);
  if (bindings.some((binding) => binding && binding !== current)) return 'held';
  if (bindings.some((binding) => !binding)) return 'legacy';
  return 'current';
}
