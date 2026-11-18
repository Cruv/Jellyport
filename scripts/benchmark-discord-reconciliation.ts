import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BotManager } from '../server/bot.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';

if (process.argv.length !== 2) throw new Error('This synthetic benchmark accepts no inputs.');
const directory = mkdtempSync(join(tmpdir(), 'jellyport-discord-reconciliation-benchmark-'));
const store = new Store(directory);
const service = new Service(store);
try {
  const guildId = '100000000';
  const role = '100000001';
  const settings = {
    ...store.settings(),
    jellyfin_url: 'http://synthetic-jellyfin.invalid',
    discord_enabled: true,
    discord_role_events: true,
    discord_guild_id: guildId,
    discord_member_role_id: role,
    auto_provision: true,
  };
  store.saveSettings(settings);
  const linked = 40;
  const memberships = 40;
  const roster = 2500;
  for (let index = 0; index < linked; index++)
    store.saveLink(String(300000000 + index), `linked-${index}`, `target-${index}`);
  for (let index = 0; index < memberships; index++)
    service.memberships.save(
      {
        discord_user_id: String(400000000 + index),
        base_username: `member-${index}`,
        account_limit: 1,
        tier_id: 'sloop',
        provision_jellyfin: false,
      },
      settings,
    );
  let exactReads = 0;
  let rosterReads = 0;
  let rosterRows = 0;
  const member = (id: string, active: boolean) => ({
    id,
    guild: { id: guildId },
    user: { id, username: `synthetic-${id}`, bot: false },
    roles: { cache: active ? new Map([[role, {}]]) : new Map() },
  });
  const guild = {
    available: true,
    members: {
      fetch: async ({ user }: { user: string }) => {
        exactReads++;
        return member(user, true);
      },
      list: async ({ limit, after }: { limit: number; after?: string }) => {
        const start = after ? Number(after) - 500000000 + 1 : 0;
        const size = Math.min(limit, roster - start);
        rosterReads++;
        rosterRows += size;
        return new Map(
          Array.from({ length: size }, (_, index) => {
            const id = String(500000000 + start + index);
            return [id, member(id, false)] as const;
          }),
        );
      },
    },
  };
  // Supply an in-process Discord client so both revisions exercise the real
  // adapter's pagination and eligibility checks without a token or network.
  service.bot = Object.assign(new BotManager(service), {
    settings,
    client: { isReady: () => true, guilds: { cache: new Map([[guildId, guild]]) } },
  });
  const start = performance.now();
  await service.reconcileMemberships();
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      linked,
      memberships,
      roster,
      exact_reads: exactReads,
      roster_reads: rosterReads,
      roster_rows: rosterRows,
      elapsed_ms: Number((performance.now() - start).toFixed(3)),
    }),
  );
} finally {
  await service.stop();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
