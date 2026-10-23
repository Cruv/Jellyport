import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import type { Service, BotAdapter } from './service.js';
import type { Settings } from './types.js';
import type { AccountProfile } from './account-profiles.js';

interface AccountSummary {
  id: string;
  name: string;
  disabled: boolean;
  protected: boolean;
  profile: AccountProfile | null;
}
export interface DirectoryUser {
  id: string;
  emby: AccountSummary[];
  jellyfin: AccountSummary[];
  discord_user_id: string | null;
  discord_username: string | null;
  access_mode: 'subscription' | 'complimentary' | 'standalone' | 'unlinked';
  account_limit: number | null;
  protected: boolean;
  family: boolean;
  requires_review: boolean;
}
interface TagChange {
  discord_user_id: string;
  username: string;
  add: string[];
  remove: string[];
}
interface TagPlan {
  changes: TagChange[];
  unchanged: number;
  unlinked: number;
  unavailable: number;
  fingerprint: string;
}
interface Review {
  plan: TagPlan;
  expires: number;
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Informational Discord tags never grant a subscription or change a media account. */
export class UserOrganization {
  private reviews = new Map<string, Review>();
  private applying = false;
  constructor(readonly service: Service) {}
  private bot(): BotAdapter {
    const bot = this.service.bot;
    if (!bot?.listTagRoles || !bot.memberTagState || !bot.updateTagRoles)
      throw new ServiceError('Connect the Discord bot before organizing member roles.');
    return bot;
  }
  private async catalog() {
    const settings = this.service.store.settings();
    const users = await this.service.users();
    if (Object.keys(users.errors).length)
      throw new ServiceError(
        'A media server could not be queried. Refresh after restoring the connection; organization roles were preserved.',
      );
    const servers: Partial<Record<'emby' | 'jellyfin', string>> = {};
    for (const kind of ['emby', 'jellyfin'] as const) {
      if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`]) continue;
      const client = this.service.client(settings, kind);
      try {
        const info = await client.systemInfo();
        const auth = this.service.store.authState();
        if (kind === 'jellyfin' && auth?.kind === 'configured' && info.Id !== auth.serverId)
          throw new ServiceError(
            'The paired Jellyfin server changed. Organization roles were preserved.',
          );
        if (typeof info.Id !== 'string' || !info.Id)
          throw new ServiceError(
            'The media server identity could not be verified. Roles were preserved.',
          );
        servers[kind] = info.Id;
      } finally {
        await client.close();
      }
    }
    if (JSON.stringify(settings) !== JSON.stringify(this.service.store.settings()))
      throw new ServiceError('Configuration changed. Refresh the user directory.');
    return { settings, users, servers };
  }
  async directory(): Promise<{ users: DirectoryUser[] }> {
    const { settings, users, servers } = await this.catalog();
    const memberships = this.service.memberships.list(settings);
    const mappings = this.service.mappings.list(settings);
    const rows: DirectoryUser[] = [];
    const usedEmby = new Set<string>(),
      usedJellyfin = new Set<string>();
    const getRow = (discordId: string | null, key: string): DirectoryUser => {
      let row = rows.find((item) =>
        discordId ? item.discord_user_id === discordId : item.id === key,
      );
      if (!row) {
        const membership = memberships.find((item) => item.discord_user_id === discordId);
        row = {
          id: discordId ? `discord:${discordId}` : key,
          emby: [],
          jellyfin: [],
          discord_user_id: discordId,
          discord_username: membership?.base_username ?? null,
          access_mode: discordId ? (membership?.access_mode ?? 'subscription') : 'standalone',
          account_limit: membership?.account_limit ?? (discordId ? 1 : null),
          protected: false,
          family: false,
          requires_review: false,
        };
        rows.push(row);
      }
      return row;
    };
    const add = (
      row: DirectoryUser,
      kind: 'emby' | 'jellyfin',
      user: (typeof users.emby)[number],
    ) => {
      if (row[kind].some((item) => item.id === user.Id)) return;
      const profile = this.service.profiles.get(kind, user.Id, settings);
      const protectedAccount =
        user.Policy?.IsAdministrator !== false ||
        (kind === 'jellyfin' && user.Id === settings.template_user_id);
      row[kind].push({
        id: user.Id,
        name: user.Name,
        disabled: user.Policy?.IsDisabled === true,
        protected: protectedAccount,
        profile,
      });
      row.protected ||= protectedAccount;
      row.family ||= profile?.family === true;
      row.requires_review ||= !row.discord_user_id && !profile?.family && !protectedAccount;
      (kind === 'emby' ? usedEmby : usedJellyfin).add(user.Id);
    };
    for (const member of memberships) getRow(member.discord_user_id, '');
    for (const ownership of this.service.mediaOwnerships.list(settings, servers)) {
      const account = users[ownership.kind].find((user) => user.Id === ownership.account_id);
      if (account) add(getRow(ownership.discord_user_id, ''), ownership.kind, account);
    }
    const addMapping = (mapping: (typeof mappings)[number], unassignedOnly = false) => {
      const source = users.emby.find(
        (user) =>
          user.Id === mapping.source_user_id &&
          user.Name === mapping.source_username &&
          (!unassignedOnly || !usedEmby.has(user.Id)),
      );
      const target = users.jellyfin.find(
        (user) =>
          user.Id === mapping.target_user_id &&
          user.Name === mapping.target_username &&
          (!unassignedOnly || !usedJellyfin.has(user.Id)),
      );
      if (!source && !target) return;
      const row = getRow(mapping.discord_user_id, `mapping:${mapping.id}`);
      if (mapping.discord_username) row.discord_username = mapping.discord_username;
      if (source) add(row, 'emby', source);
      if (target) add(row, 'jellyfin', target);
    };
    for (const mapping of mappings) if (mapping.discord_user_id) addMapping(mapping);
    for (const link of this.service.store.links()) {
      if (
        this.service.memberships.hasOtherScope(link.discord_user_id, settings) &&
        !memberships.some((member) => member.discord_user_id === link.discord_user_id)
      )
        continue;
      const target = users.jellyfin.find(
        (user) => user.Id === link.remote_id && user.Name === link.username,
      );
      if (target) add(getRow(link.discord_user_id, ''), 'jellyfin', target);
    }
    // Standalone mappings may predate confirmed ownership. Keep only their
    // unassigned sides, without borrowing the other account's Discord owner.
    for (const mapping of mappings) if (!mapping.discord_user_id) addMapping(mapping, true);
    // A matching name is a display aid only. It never establishes Discord ownership.
    for (const source of users.emby) {
      if (usedEmby.has(source.Id)) continue;
      const row = getRow(null, `emby:${source.Id}`);
      add(row, 'emby', source);
      const targets = users.jellyfin.filter(
        (target) => !usedJellyfin.has(target.Id) && target.Name === source.Name,
      );
      if (
        targets.length === 1 &&
        users.emby.filter((user) => user.Name === source.Name).length === 1
      )
        add(row, 'jellyfin', targets[0]!);
    }
    for (const target of users.jellyfin)
      if (!usedJellyfin.has(target.Id))
        add(getRow(null, `jellyfin:${target.Id}`), 'jellyfin', target);
    const assigned = new Map<string, string>();
    for (const row of rows)
      if (row.discord_user_id) {
        for (const kind of ['emby', 'jellyfin'] as const)
          for (const account of row[kind]) {
            const key = `${kind}:${account.id}`,
              owner = assigned.get(key);
            if (owner && owner !== row.discord_user_id)
              throw new ServiceError(
                'Conflicting media account owners require review. Discord roles were preserved.',
              );
            assigned.set(key, row.discord_user_id);
          }
      }
    return {
      users: rows.sort((a, b) =>
        (a.discord_username ?? a.jellyfin[0]?.name ?? a.emby[0]?.name ?? a.id).localeCompare(
          b.discord_username ?? b.jellyfin[0]?.name ?? b.emby[0]?.name ?? b.id,
        ),
      ),
    };
  }
  async listTagRoles() {
    return this.bot().listTagRoles!();
  }
  private async plan(): Promise<TagPlan> {
    const settings = this.service.store.settings();
    const selected = [settings.discord_emby_role_id, settings.discord_jellyfin_role_id].filter(
      (id): id is string => Boolean(id),
    );
    if (!selected.length)
      throw new ServiceError('Choose organization roles before previewing changes.');
    if (
      !settings.jellyfin_url ||
      !settings.jellyfin_api_key ||
      (settings.discord_emby_role_id && (!settings.emby_url || !settings.emby_api_key))
    )
      throw new ServiceError(
        'Configure the media servers and their API keys before organizing roles. Existing roles were preserved.',
      );
    const bot = this.bot(),
      available = await bot.listTagRoles!();
    if (
      !available.can_manage_roles ||
      selected.some((id) => !available.roles.some((role) => role.id === id && role.manageable))
    )
      throw new ServiceError(
        'Use informational roles below the bot’s highest role, distinct from subscriber and administrator roles. The bot needs Manage Roles.',
      );
    if (new Set(selected).size !== selected.length)
      throw new ServiceError('Choose different Emby and Jellyfin organization roles.');
    const directory = await this.directory();
    const linked = directory.users.filter((user) => user.discord_user_id);
    if (linked.length > 1000)
      throw new ServiceError(
        'Role organization is limited to 1,000 linked Discord members per review.',
      );
    const changes: TagChange[] = [];
    let unchanged = 0,
      unavailable = 0;
    for (let start = 0; start < linked.length; start += 10) {
      const batch = await Promise.all(
        linked.slice(start, start + 10).map(async (row) => {
          const member = await bot.memberTagState!(row.discord_user_id!);
          if (member === null) return null; // Confirmed guild departure, not an API failure.
          if (member.id !== row.discord_user_id)
            throw new ServiceError('Discord returned a different member. No roles were changed.');
          const hasJellyfin = row.jellyfin.length > 0,
            hasEmby = row.emby.length > 0;
          const desired = new Set([
            ...(hasJellyfin && settings.discord_jellyfin_role_id
              ? [settings.discord_jellyfin_role_id]
              : []),
            ...(hasEmby &&
            (settings.discord_emby_only_role !== true || !hasJellyfin) &&
            settings.discord_emby_role_id
              ? [settings.discord_emby_role_id]
              : []),
          ]);
          return {
            discord_user_id: member.id,
            username: member.username,
            add: selected.filter((id) => desired.has(id) && !member.roles.includes(id)),
            remove: selected.filter((id) => !desired.has(id) && member.roles.includes(id)),
          };
        }),
      );
      for (const entry of batch) {
        if (entry === null) {
          unavailable++;
          continue;
        }
        if (entry.add.length || entry.remove.length) changes.push(entry);
        else unchanged++;
      }
    }
    if (JSON.stringify(settings) !== JSON.stringify(this.service.store.settings()))
      throw new ServiceError('Configuration changed. Preview organization again.');
    return {
      changes,
      unchanged,
      unlinked: directory.users.filter((user) => !user.discord_user_id).length,
      unavailable,
      fingerprint: fingerprint({ settings, directory }),
    };
  }
  async preview() {
    if (this.service.demo) throw new ServiceError('Demo organization is read-only.');
    const plan = await this.plan();
    for (const [key, review] of this.reviews)
      if (review.expires <= Date.now()) this.reviews.delete(key);
    if (this.reviews.size >= 20) this.reviews.delete(this.reviews.keys().next().value!);
    const token = randomUUID();
    this.reviews.set(token, { plan, expires: Date.now() + 300_000 });
    const { fingerprint: _, ...result } = plan;
    return { token, ...result };
  }
  private async write(plan: TagPlan, settings: Settings) {
    let updated = 0,
      failed = 0;
    const bot = this.bot();
    for (const change of plan.changes) {
      if (JSON.stringify(settings) !== JSON.stringify(this.service.store.settings()))
        throw new ServiceError(
          'Configuration changed. Preview remaining organization changes again.',
        );
      // A review is not authority to act on associations edited while a prior
      // Discord request was in flight. Fresh server/catalog failures abort here.
      if (fingerprint({ settings, directory: await this.directory() }) !== plan.fingerprint)
        throw new ServiceError(
          'Accounts or identity mappings changed. Preview remaining organization changes again.',
        );
      try {
        await bot.updateTagRoles!(change.discord_user_id, change.add, change.remove);
        updated++;
      } catch {
        failed++;
      }
    }
    return { updated, failed };
  }
  async apply(token: string) {
    if (this.service.demo) throw new ServiceError('Demo organization is read-only.');
    if (this.applying) throw new ServiceError('Wait for the current role update to finish.');
    const review = this.reviews.get(token);
    this.reviews.delete(token);
    if (!review || review.expires <= Date.now())
      throw new ServiceError('The role review expired. Preview changes again.');
    this.applying = true;
    try {
      const settings = this.service.store.settings();
      const current = await this.plan();
      if (JSON.stringify(current) !== JSON.stringify(review.plan))
        throw new ServiceError(
          'Accounts, mappings, or Discord roles changed. Preview the current changes again.',
        );
      return await this.write(current, settings);
    } finally {
      this.applying = false;
    }
  }
  /** Identity approvals synchronize only the reviewed owners. The full user lists
   * are read once per plan, and subsequent checks target the owner's exact IDs.
   * This keeps bulk linking from repeatedly enumerating every server account. */
  async syncOwners(ownerIds: string[], authorize: () => void = () => {}) {
    if (this.service.demo) throw new ServiceError('Demo organization is read-only.');
    if (this.applying) throw new ServiceError('Wait for the current Discord role update.');
    this.applying = true;
    try {
      const settings = this.service.store.settings();
      const plan = await this.plan();
      const directory = await this.directory();
      if (fingerprint({ settings, directory }) !== plan.fingerprint)
        throw new ServiceError('Ownership changed. Refresh the role review.');
      const desired = new Set(ownerIds);
      const localState = () => {
        const hash = createHash('sha256').update(
          JSON.stringify([
            this.service.store.settings(),
            this.service.store.authState(),
            this.service.store.links(),
          ]),
        );
        for (const table of [
          'media_ownership',
          'user_mappings',
          'memberships',
          'account_profiles',
        ]) {
          for (const row of this.service.store.db
            .prepare(`SELECT id,encrypted FROM ${table} ORDER BY id`)
            .iterate()) {
            const bytes = row.encrypted as Uint8Array;
            hash.update(JSON.stringify([table, row.id, bytes.byteLength])).update(bytes);
          }
        }
        return hash.digest('hex');
      };
      const before = localState();
      let updated = 0,
        failed = 0;
      for (const change of plan.changes) {
        if (!desired.has(change.discord_user_id)) continue;
        authorize();
        if (before !== localState())
          throw new ServiceError('Ownership changed. Refresh remaining role updates.');
        const row = directory.users.find(
          (item) => item.discord_user_id === change.discord_user_id,
        )!;
        for (const kind of ['emby', 'jellyfin'] as const) {
          if (!row[kind].length) continue;
          const client = this.service.client(settings, kind);
          try {
            for (const account of row[kind]) {
              const actual = await client.user(account.id);
              if (actual.Id !== account.id || actual.Name !== account.name)
                throw new ServiceError('A media account changed. Refresh remaining role updates.');
            }
          } finally {
            await client.close();
          }
        }
        authorize();
        if (before !== localState())
          throw new ServiceError('Ownership changed. Refresh remaining role updates.');
        try {
          await this.bot().updateTagRoles!(change.discord_user_id, change.add, change.remove);
          updated++;
        } catch {
          failed++;
        }
      }
      return { updated, failed };
    } finally {
      this.applying = false;
    }
  }
  async reconcile() {
    const settings = this.service.store.settings();
    if (this.service.demo || !settings.discord_auto_role_sync || this.applying) return;
    this.applying = true;
    try {
      await this.write(await this.plan(), settings);
    } finally {
      this.applying = false;
    }
  }
}
