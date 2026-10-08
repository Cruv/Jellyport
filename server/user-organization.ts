import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import type { Service, BotAdapter } from './service.js';
import type { Settings } from './types.js';

interface AccountSummary {
  id: string;
  name: string;
  disabled: boolean;
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
    if (settings.jellyfin_url && settings.jellyfin_api_key) {
      const client = this.service.client(settings, 'jellyfin');
      try {
        const info = await client.systemInfo();
        const auth = this.service.store.authState();
        if (auth?.kind === 'configured' && info.Id !== auth.serverId)
          throw new ServiceError(
            'The paired Jellyfin server changed. Organization roles were preserved.',
          );
      } finally {
        await client.close();
      }
    }
    if (JSON.stringify(settings) !== JSON.stringify(this.service.store.settings()))
      throw new ServiceError('Configuration changed. Refresh the user directory.');
    return { settings, users };
  }
  async directory(): Promise<{ users: DirectoryUser[] }> {
    const { settings, users } = await this.catalog();
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
      row[kind].push({ id: user.Id, name: user.Name, disabled: user.Policy?.IsDisabled === true });
      row.protected ||=
        user.Policy?.IsAdministrator !== false ||
        (kind === 'jellyfin' && user.Id === settings.template_user_id);
      (kind === 'emby' ? usedEmby : usedJellyfin).add(user.Id);
    };
    for (const member of memberships) getRow(member.discord_user_id, '');
    for (const mapping of mappings) {
      const source = users.emby.find(
        (user) => user.Id === mapping.source_user_id && user.Name === mapping.source_username,
      );
      const target = users.jellyfin.find(
        (user) => user.Id === mapping.target_user_id && user.Name === mapping.target_username,
      );
      if (!source && !target) continue;
      const row = getRow(mapping.discord_user_id, `mapping:${mapping.id}`);
      if (mapping.discord_username) row.discord_username = mapping.discord_username;
      if (source) add(row, 'emby', source);
      if (target) add(row, 'jellyfin', target);
    }
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
