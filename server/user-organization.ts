import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import type { Service, BotAdapter } from './service.js';
import type { Settings } from './types.js';
import type { AccountProfile } from './account-profiles.js';
import type { MediaAPI, MediaKind, MediaUser } from './media.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';

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
export interface DirectorySourceStatus {
  configured: boolean;
  available: boolean;
  error?: string;
}
export interface DirectorySnapshot {
  users: DirectoryUser[];
  complete: boolean;
  sources: Record<MediaKind, DirectorySourceStatus>;
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
  nextOwner?: string;
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
  private automaticCursor = { scope: '', after: '' };
  constructor(readonly service: Service) {}
  private bot(): BotAdapter {
    const bot = this.service.bot;
    if (!bot?.listTagRoles || !bot.memberTagState || !bot.updateTagRoles)
      throw new ServiceError('Connect the Discord bot before organizing member roles.');
    return bot;
  }
  private async catalog(requireComplete: boolean) {
    const settings = this.service.store.settings();
    const users: Record<MediaKind, MediaUser[]> = { emby: [], jellyfin: [] };
    const servers: Partial<Record<MediaKind, string>> = {};
    const sources = {} as Record<MediaKind, DirectorySourceStatus>;
    await Promise.all(
      (['emby', 'jellyfin'] as const).map(async (kind) => {
        const configured = Boolean(settings[`${kind}_url`] && settings[`${kind}_api_key`]);
        const source: DirectorySourceStatus = { configured, available: false };
        sources[kind] = source;
        if (!configured) return;
        let client: MediaAPI | undefined;
        try {
          client = this.service.client(settings, kind);
          const accounts = await client.users();
          if (
            accounts.length > 10_000 ||
            new Set(accounts.map((account) => account.Id)).size !== accounts.length ||
            accounts.some(
              (account) =>
                typeof account.Id !== 'string' ||
                !account.Id ||
                typeof account.Name !== 'string' ||
                !account.Name,
            )
          )
            throw new Error('Unverified account list');
          const info = await client.systemInfo();
          const auth = this.service.store.authState();
          if (
            kind === 'jellyfin' &&
            auth?.kind === 'configured' &&
            (info.Id !== auth.serverId ||
              normalizeJellyfinUrl(settings.jellyfin_url) !== normalizeJellyfinUrl(auth.serverUrl))
          ) {
            source.error =
              'The paired Jellyfin server changed. Restore its connection before managing those accounts.';
            return;
          }
          if (typeof info.Id !== 'string' || !info.Id) throw new Error('Unverified server');
          users[kind] = accounts;
          servers[kind] = info.Id;
          source.available = true;
        } catch {
          source.error = `Unable to read and verify ${kind === 'emby' ? 'Emby' : 'Jellyfin'} accounts. Check its connection in Settings.`;
        } finally {
          await client?.close().catch(() => {});
        }
      }),
    );
    if (JSON.stringify(settings) !== JSON.stringify(this.service.store.settings()))
      throw new ServiceError('Configuration changed. Refresh the user directory.');
    const complete = Object.values(sources).every(
      (source) => !source.configured || source.available,
    );
    // Viewing a healthy server must not depend on the other one. A role plan
    // still needs complete evidence before deciding any remote access tag is absent.
    if (requireComplete && !complete) {
      const failure = Object.values(sources).find((source) => source.error)?.error;
      throw new ServiceError(
        `${failure ?? 'A media server could not be queried.'} Organization roles were preserved.`,
      );
    }
    return { settings, users, servers, sources, complete };
  }
  async directory(requireComplete = false): Promise<DirectorySnapshot> {
    const { settings, users, servers, sources, complete } = await this.catalog(requireComplete);
    const memberships = this.service.memberships.list(settings);
    const byOwner = new Map(memberships.map((member) => [member.discord_user_id, member]));
    const mappings = this.service.mappings.list(settings);
    const rows: DirectoryUser[] = [];
    const byRow = new Map<string, DirectoryUser>();
    const accounts = {
      emby: new Map(users.emby.map((user) => [user.Id, user])),
      jellyfin: new Map(users.jellyfin.map((user) => [user.Id, user])),
    };
    const targetNames = new Map<string, typeof users.jellyfin>();
    const sourceNameCounts = new Map<string, number>();
    for (const user of users.jellyfin) {
      const named = targetNames.get(user.Name);
      if (named) named.push(user);
      else targetNames.set(user.Name, [user]);
    }
    for (const user of users.emby)
      sourceNameCounts.set(user.Name, (sourceNameCounts.get(user.Name) ?? 0) + 1);
    const usedEmby = new Set<string>(),
      usedJellyfin = new Set<string>();
    const getRow = (discordId: string | null, key: string): DirectoryUser => {
      const rowId = discordId ? `discord:${discordId}` : key;
      let row = byRow.get(rowId);
      if (!row) {
        const membership = discordId ? byOwner.get(discordId) : undefined;
        row = {
          id: rowId,
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
        byRow.set(rowId, row);
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
      const account = accounts[ownership.kind].get(ownership.account_id);
      if (account) add(getRow(ownership.discord_user_id, ''), ownership.kind, account);
    }
    const addMapping = (mapping: (typeof mappings)[number], unassignedOnly = false) => {
      const matchedSource = accounts.emby.get(mapping.source_user_id);
      const matchedTarget = mapping.target_user_id
        ? accounts.jellyfin.get(mapping.target_user_id)
        : undefined;
      const source =
        matchedSource?.Name === mapping.source_username &&
        (!unassignedOnly || !usedEmby.has(matchedSource.Id))
          ? matchedSource
          : undefined;
      const target =
        matchedTarget &&
        matchedTarget.Name === mapping.target_username &&
        (!unassignedOnly || !usedJellyfin.has(matchedTarget.Id))
          ? matchedTarget
          : undefined;
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
        !byOwner.has(link.discord_user_id)
      )
        continue;
      const target = accounts.jellyfin.get(link.remote_id);
      if (target?.Name === link.username) add(getRow(link.discord_user_id, ''), 'jellyfin', target);
    }
    // Standalone mappings may predate confirmed ownership. Keep only their
    // unassigned sides, without borrowing the other account's Discord owner.
    for (const mapping of mappings) if (!mapping.discord_user_id) addMapping(mapping, true);
    // A matching name is a display aid only. It never establishes Discord ownership.
    for (const source of users.emby) {
      if (usedEmby.has(source.Id)) continue;
      const row = getRow(null, `emby:${source.Id}`);
      add(row, 'emby', source);
      if (sourceNameCounts.get(source.Name) !== 1) continue;
      const targets =
        targetNames.get(source.Name)?.filter((target) => !usedJellyfin.has(target.Id)) ?? [];
      if (targets.length === 1) add(row, 'jellyfin', targets[0]!);
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
      sources,
      complete,
    };
  }
  async listTagRoles() {
    return this.bot().listTagRoles!();
  }
  private async validatedTagRoles(settings: Settings): Promise<string[]> {
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
    return selected;
  }
  private async plan(after?: string): Promise<TagPlan> {
    const settings = this.service.store.settings();
    const selected = await this.validatedTagRoles(settings);
    const bot = this.bot();
    const directory = await this.directory(true);
    const linked = directory.users.filter((user) => user.discord_user_id);
    if (after === undefined && linked.length > 1000)
      throw new ServiceError(
        'Role organization is limited to 1,000 linked Discord members per review.',
      );
    const limit = 16;
    const pending =
      after === undefined
        ? linked
        : linked
            .filter((user) => user.discord_user_id! > after)
            .sort((a, b) => (a.discord_user_id! < b.discord_user_id! ? -1 : 1));
    const selectedOwners = after === undefined ? pending : pending.slice(0, limit);
    const changes: TagChange[] = [];
    let unchanged = 0,
      unavailable = 0;
    for (let start = 0; start < selectedOwners.length; start += 10) {
      const batch = await Promise.all(
        selectedOwners.slice(start, start + 10).map(async (row) => {
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
      ...(after !== undefined
        ? { nextOwner: pending.length > limit ? selectedOwners.at(-1)!.discord_user_id! : '' }
        : {}),
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
      if (fingerprint({ settings, directory: await this.directory(true) }) !== plan.fingerprint)
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
  /** Identity approvals synchronize only the reviewed owners and exact account IDs. */
  async syncOwners(ownerIds: string[], authorize: () => void = () => {}) {
    if (this.service.demo) throw new ServiceError('Demo organization is read-only.');
    if (this.applying) throw new ServiceError('Wait for the current Discord role update.');
    this.applying = true;
    try {
      const settings = this.service.store.settings();
      const store = this.service.store;
      const serverContext = fingerprint([settings, store.authState()]);
      const bot = this.bot();
      authorize();
      const selected = await this.validatedTagRoles(settings);
      let updated = 0,
        failed = 0;
      const readLocal = (owner: string) => ({
        member: this.service.memberships.get(owner, settings),
        ownerRecords: this.service.mediaOwnerships.forOwner(owner, settings),
        mappings: this.service.mappings.getAllForDiscord(owner, settings),
        links: store.linksForMember(owner),
      });
      const assertConnection = () => {
        authorize();
        if (serverContext !== fingerprint([store.settings(), store.authState()]))
          throw new ServiceError('Configuration changed. Review remaining role updates.');
      };
      for (const owner of new Set(ownerIds)) {
        try {
          assertConnection();
          const records = readLocal(owner);
          const signature = fingerprint(records);
          const accounts = new Map<
            string,
            { kind: MediaKind; id: string; username: string; server?: string }
          >();
          const add = (kind: MediaKind, id: string, username: string, server?: string) => {
            const key = JSON.stringify([kind, id]);
            const previous = accounts.get(key);
            if (
              previous &&
              (previous.username !== username ||
                (server && previous.server && previous.server !== server))
            )
              throw new ServiceError('A media account identity conflicts. Review its owner.');
            accounts.set(key, { kind, id, username, server: server ?? previous?.server });
          };
          for (const record of records.ownerRecords)
            add(record.kind, record.account_id, record.username, record.server_id);
          for (const mapping of records.mappings) {
            add('emby', mapping.source_user_id, mapping.source_username);
            if (mapping.target_user_id)
              add('jellyfin', mapping.target_user_id, mapping.target_username);
          }
          if (records.member || !this.service.memberships.hasOtherScope(owner, settings))
            for (const link of records.links) add('jellyfin', link.remote_id, link.username);
          if (!records.member && !accounts.size) continue;
          const member = await bot.memberTagState!(owner);
          if (!member) continue;
          if (member.id !== owner) throw new ServiceError('Discord returned a different member.');
          const identified = new Map<string, string>();
          const guard = () => {
            assertConnection();
            if (signature !== fingerprint(readLocal(owner)))
              throw new ServiceError('Ownership changed. Refresh remaining role updates.');
            for (const [key, { kind, id, username }] of accounts) {
              const server = identified.get(key);
              if (!server) continue;
              const known = this.service.mediaOwnerships.get(kind, server, id, settings);
              const mapping =
                kind === 'emby'
                  ? this.service.mappings.getForSource(id, settings)
                  : this.service.mappings.getForTarget(id, username, settings);
              const link = kind === 'jellyfin' ? store.linkForRemote(id) : null;
              if (
                (known && known.discord_user_id !== owner) ||
                (link && link.discord_user_id !== owner) ||
                (mapping?.discord_user_id &&
                  mapping.discord_user_id !== owner &&
                  (kind === 'emby' || mapping.target_user_id === id))
              )
                throw new ServiceError('A media account belongs to a different verified owner.');
            }
          };
          const kinds = new Set<MediaKind>();
          for (const kind of ['emby', 'jellyfin'] as const) {
            if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`]) continue;
            const client = this.service.client(settings, kind);
            try {
              const info = await client.systemInfo();
              const auth = store.authState();
              if (
                typeof info.Id !== 'string' ||
                !info.Id ||
                (kind === 'jellyfin' &&
                  auth?.kind === 'configured' &&
                  (info.Id !== auth.serverId ||
                    normalizeJellyfinUrl(settings.jellyfin_url) !==
                      normalizeJellyfinUrl(auth.serverUrl)))
              )
                throw new ServiceError('A media server changed. Review remaining role updates.');
              for (const [key, account] of accounts) {
                if (account.kind !== kind) continue;
                const actual = await client.user(account.id);
                if (
                  (account.server && account.server !== info.Id) ||
                  actual.Id !== account.id ||
                  actual.Name !== account.username
                )
                  throw new ServiceError(
                    'A media account changed. Refresh remaining role updates.',
                  );
                kinds.add(kind);
                identified.set(key, info.Id);
              }
            } finally {
              await client.close();
            }
          }
          if (identified.size !== accounts.size)
            throw new ServiceError('A media account could not be verified. Roles were preserved.');
          const desired = new Set([
            ...(kinds.has('jellyfin') ? [settings.discord_jellyfin_role_id] : []),
            ...(kinds.has('emby') && (!kinds.has('jellyfin') || !settings.discord_emby_only_role)
              ? [settings.discord_emby_role_id]
              : []),
          ]);
          const addRoles = selected.filter(
            (role) => desired.has(role) && !member.roles.includes(role),
          );
          const removeRoles = selected.filter(
            (role) => !desired.has(role) && member.roles.includes(role),
          );
          guard();
          if (addRoles.length || removeRoles.length) {
            await bot.updateTagRoles!(owner, addRoles, removeRoles, guard);
            updated++;
          }
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
      const scope = fingerprint([
        settings.discord_guild_id,
        settings.discord_emby_role_id,
        settings.discord_jellyfin_role_id,
        settings.emby_url,
        settings.jellyfin_url,
        this.service.store.authState(),
      ]);
      if (this.automaticCursor.scope !== scope) this.automaticCursor = { scope, after: '' };
      const plan = await this.plan(this.automaticCursor.after);
      this.automaticCursor.after = plan.nextOwner ?? '';
      await this.write(plan, settings);
    } finally {
      this.applying = false;
    }
  }
}
