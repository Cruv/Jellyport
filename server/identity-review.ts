import { createHash } from 'node:crypto';
import { ServiceError } from './errors.js';
import { nameKey } from './identity.js';
import type { Service } from './service.js';
import type { StripeIntegration, StripeSubscriptionReview } from './stripe-integration.js';
import type { UserOrganization } from './user-organization.js';
import type { MediaOwnership } from './media-ownership.js';
import { IdentityRoleSync } from './identity-role-sync.js';
import { membershipUsername } from './memberships.js';
import { parseAccountUsername } from './account-naming.js';
import type {
  IdentityAccount,
  IdentityBillingCustomer,
  IdentityDiscordMember,
  IdentityMediaKind,
  IdentityReviewApplyInput,
  IdentityReviewApplyResult,
  IdentityReviewRow,
  IdentityReviewSnapshot,
  IdentityRoster,
} from './identity-review-types.js';

const kinds = ['emby', 'jellyfin'] as const;
const ttl = 5 * 60_000;
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (kind: IdentityMediaKind, id: string) => `${kind}:${id}`;
const usableId = (id: unknown): id is string =>
  typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) && BigInt(id) < 2n ** 64n;
interface Discovery {
  snapshot: IdentityReviewSnapshot;
  settingsHash: string;
  stripeRevision: string;
  servers: Partial<Record<IdentityMediaKind, string>>;
  ownersHash: string;
}

/** Bounded, account-list-only inventory. Never reads media catalogs or play states. */
export class IdentityReview {
  private cached: Discovery | null = null;
  private building: Promise<Discovery> | null = null;
  private applying = false;
  private closed = false;
  readonly roleSync: IdentityRoleSync;
  constructor(
    readonly service: Service,
    readonly stripe: StripeIntegration,
    readonly organization: UserOrganization,
  ) {
    this.roleSync = new IdentityRoleSync(service, organization);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cached = null;
    await this.roleSync.close();
  }
  private localFingerprint(): string {
    const settings = this.service.store.settings();
    return fingerprint({
      settings,
      auth: this.service.store.authState(),
      owners: this.service.mediaOwnerships.list(settings),
      exceptions: [...this.service.mediaOwnerships.exceptions(settings)],
      mappings: this.service.mappings.list(settings),
      links: this.service.store.links(),
      memberships: this.service.memberships.list(settings),
      profiles: this.service.store.db
        .prepare('SELECT id,encrypted FROM account_profiles ORDER BY id')
        .all(),
    });
  }
  async snapshot(refresh = false): Promise<IdentityReviewSnapshot> {
    if (this.closed) throw new ServiceError('The identity directory is stopping.');
    if (
      !refresh &&
      this.cached &&
      Date.parse(this.cached.snapshot.expires_at) > Date.now() &&
      this.cached.settingsHash === fingerprint(this.service.store.settings()) &&
      this.cached.stripeRevision === this.stripe.status().revision &&
      this.cached.ownersHash === this.localFingerprint()
    )
      return structuredClone(this.cached.snapshot);
    return structuredClone((await this.discover()).snapshot);
  }
  private discover(): Promise<Discovery> {
    if (this.building) return this.building;
    this.building = this.build().finally(() => {
      this.building = null;
    });
    return this.building;
  }
  private async build(): Promise<Discovery> {
    if (this.closed) throw new ServiceError('The identity directory is stopping.');
    const settings = this.service.store.settings();
    const settingsHash = fingerprint(settings),
      ownersHash = this.localFingerprint();
    const stripeStatus = this.stripe.status();
    const generated = new Date().toISOString();
    const sources: IdentityReviewSnapshot['sources'] = {
      discord: { available: false, complete: false, updated_at: null },
      emby: { available: false, complete: false, updated_at: null },
      jellyfin: { available: false, complete: false, updated_at: null },
      stripe: {
        available: stripeStatus.configured,
        complete:
          stripeStatus.configured &&
          !stripeStatus.running &&
          !stripeStatus.last_error &&
          Number.isFinite(Date.parse(stripeStatus.last_sync ?? '')) &&
          Date.now() - Date.parse(stripeStatus.last_sync!) < 24 * 60 * 60_000,
        updated_at: stripeStatus.last_sync,
      },
    };
    if (!sources.stripe.complete)
      sources.stripe.error =
        'Sync Stripe to review current billing gaps. Unavailable billing data is unknown, not unpaid.';
    let roster: IdentityRoster = { members: [], complete: false, fetched_at: generated };
    const rosterTask = (async () => {
      try {
        if (!this.service.bot?.listIdentityMembers) throw new Error('unavailable');
        const result = await this.service.bot.listIdentityMembers();
        if (
          !result.complete ||
          !Array.isArray(result.members) ||
          result.members.length > 10_000 ||
          new Set(result.members.map((member) => member.id)).size !== result.members.length ||
          result.members.some(
            (member) => !usableId(member.id) || !member.username || !Array.isArray(member.roles),
          )
        )
          throw new Error('incomplete');
        roster = result;
        sources.discord = { available: true, complete: true, updated_at: result.fetched_at };
      } catch {
        sources.discord.error =
          'The full Discord member list could not be read. Enable Server Members Intent and trusted message or role watching, then refresh. Missing members are unknown.';
      }
    })();
    const users = await this.service.users().catch(() => ({
      emby: [],
      jellyfin: [],
      errors: { emby: 'Unavailable', jellyfin: 'Unavailable' },
    }));
    const userIndexes = {
      emby: new Map(users.emby.map((account) => [account.Id, account])),
      jellyfin: new Map(users.jellyfin.map((account) => [account.Id, account])),
    };
    const servers: Discovery['servers'] = {};
    await Promise.all(
      kinds.map(async (kind) => {
        if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`]) {
          sources[kind].error = `${kind === 'emby' ? 'Emby' : 'Jellyfin'} is not configured.`;
          return;
        }
        if (users.errors[kind] || users[kind].length > 10_000) {
          sources[kind].error = 'The account list could not be read completely. Access is unknown.';
          return;
        }
        const client = this.service.client(settings, kind);
        try {
          const info = await client.systemInfo();
          const auth = this.service.store.authState();
          if (
            typeof info.Id !== 'string' ||
            !info.Id ||
            (kind === 'jellyfin' && auth?.kind === 'configured' && info.Id !== auth.serverId)
          )
            throw new Error('server_changed');
          servers[kind] = info.Id;
          sources[kind] = { available: true, complete: true, updated_at: generated };
        } catch {
          sources[kind].error =
            'The media server identity could not be verified. Access is unknown.';
        } finally {
          await client.close();
        }
      }),
    );
    await rosterTask;
    if (
      this.closed ||
      settingsHash !== fingerprint(this.service.store.settings()) ||
      ownersHash !== this.localFingerprint() ||
      stripeStatus.revision !== this.stripe.status().revision
    )
      throw new ServiceError('Identity sources changed while loading. Refresh the directory.');
    const ownerByAccount = new Map<string, { id: string; slot: number; conflict?: boolean }>();
    const addOwner = (
      kind: IdentityMediaKind,
      accountId: string,
      username: string,
      owner: string | null,
      slot: number,
    ) => {
      if (!owner || !sources[kind].complete || userIndexes[kind].get(accountId)?.Name !== username)
        return;
      const existing = ownerByAccount.get(key(kind, accountId));
      ownerByAccount.set(key(kind, accountId), {
        id: owner,
        slot,
        ...(existing && (existing.id !== owner || existing.slot !== slot)
          ? { conflict: true }
          : existing?.conflict
            ? { conflict: true }
            : {}),
      });
    };
    for (const item of this.service.mediaOwnerships.list(settings, servers)) {
      const account = userIndexes[item.kind].get(item.account_id);
      if (account)
        addOwner(item.kind, item.account_id, account.Name, item.discord_user_id, item.slot);
    }
    for (const item of this.service.mappings.list(settings)) {
      addOwner(
        'emby',
        item.source_user_id,
        item.source_username,
        item.discord_user_id,
        item.membership_slot ?? 1,
      );
      if (item.target_user_id)
        addOwner(
          'jellyfin',
          item.target_user_id,
          item.target_username,
          item.discord_user_id,
          item.membership_slot ?? 1,
        );
    }
    for (const item of this.service.store.links()) {
      if (this.service.memberships.hasOtherScope(item.discord_user_id, settings)) continue;
      addOwner(
        'jellyfin',
        item.remote_id,
        item.username,
        item.discord_user_id,
        item.membership_slot,
      );
    }
    const accounts: IdentityAccount[] = kinds
      .flatMap((kind) =>
        sources[kind].complete
          ? users[kind].map((account) => {
              const owner = ownerByAccount.get(key(kind, account.Id));
              return {
                kind,
                id: account.Id,
                name: account.Name,
                disabled: account.Policy?.IsDisabled === true,
                family: this.service.profiles.get(kind, account.Id, settings)?.family === true,
                administrator:
                  account.Policy?.IsAdministrator !== false ||
                  (kind === 'jellyfin' && account.Id === settings.template_user_id),
                owner_discord_id: owner?.conflict ? null : (owner?.id ?? null),
                slot: owner?.conflict ? null : (owner?.slot ?? null),
                ...(owner?.conflict ? { ownership_conflict: true } : {}),
              };
            })
          : [],
      )
      .sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)));
    const customers = this.customers(this.stripe.subscriptions());
    const members = new Map(roster.members.map((member) => [member.id, member]));
    const nameMembers = new Map<string, IdentityDiscordMember[]>();
    for (const member of roster.members)
      nameMembers.set(nameKey(member.username), [
        ...(nameMembers.get(nameKey(member.username)) ?? []),
        member,
      ]);
    const exceptions = this.service.mediaOwnerships.exceptions(settings);
    const rows = new Map<string, IdentityReviewRow>();
    const getRow = (id: string, member: IdentityDiscordMember | null = null): IdentityReviewRow => {
      let row = rows.get(id);
      if (!row) {
        row = {
          id,
          member,
          member_candidates: [],
          customers: [],
          confirmed_accounts: [],
          suggestions: [],
          gaps: [],
          exception: exceptions.get(id) ?? null,
          reliable: false,
          conflict: null,
        };
        rows.set(id, row);
      }
      return row;
    };
    for (const member of roster.members) getRow(`discord:${member.id}`, member);
    for (const customer of customers) {
      const candidate = customer.linked_discord_id ?? customer.proposed_discord_id;
      const member = candidate ? members.get(candidate) : undefined;
      const row = candidate
        ? getRow(`discord:${candidate}`, member ?? null)
        : getRow(`stripe:${customer.id}`);
      row.customers.push(customer);
      if (customer.identity_conflict) {
        row.conflict =
          'Stripe identity candidates disagree. Select and verify the correct Discord member.';
        row.gaps.push('identity_conflict');
      }
      if (member) row.member_candidates = [member];
      if (!customer.linked_discord_id) row.gaps.push('unlinked_billing');
      if (
        candidate &&
        !member &&
        sources.discord.complete &&
        sources.stripe.complete &&
        customer.active_subscription
      )
        row.gaps.push('active_subscription_no_discord');
    }
    for (const account of accounts) {
      if (account.owner_discord_id) {
        const member = members.get(account.owner_discord_id) ?? null;
        getRow(`discord:${account.owner_discord_id}`, member).confirmed_accounts.push(account);
      } else {
        const collision = ownerByAccount.get(key(account.kind, account.id))?.conflict;
        const row = getRow(`account:${account.kind}:${account.id}`);
        row.suggestions.push({
          account,
          reason: collision
            ? 'Existing ownership records disagree; resolve the ownership conflict first.'
            : 'Existing media account without a confirmed Discord owner.',
          reliable: false,
        });
        row.gaps.push(collision ? 'identity_conflict' : 'unlinked_media');
        if (collision) row.conflict = 'Existing ownership records disagree.';
      }
    }
    const proposedAccounts = new Set<string>();
    const accountNames = new Map<string, IdentityAccount[]>();
    const legacyNames = new Map<string, IdentityAccount[]>();
    for (const account of accounts) {
      const identity = key(account.kind, nameKey(account.name));
      const group = accountNames.get(identity) ?? [];
      group.push(account);
      accountNames.set(identity, group);
      const parsed = parseAccountUsername(account.name, settings);
      if (parsed && parsed.slot > 1) {
        const alias = `${account.kind}:${nameKey(parsed.base)}:${parsed.slot}`;
        const values = legacyNames.get(alias) ?? [];
        values.push(account);
        legacyNames.set(alias, values);
      }
    }
    for (const member of roster.members) {
      const row = getRow(`discord:${member.id}`, member);
      if ((nameMembers.get(nameKey(member.username))?.length ?? 0) !== 1) {
        row.conflict = 'More than one Discord username has this normalized identity.';
        row.gaps.push('identity_conflict');
        continue;
      }
      for (const kind of kinds)
        for (let slot = 1; slot <= 3; slot++) {
          let expectedName: string;
          try {
            expectedName = nameKey(membershipUsername(member.username, slot, settings));
          } catch {
            continue;
          }
          const matching = [...(accountNames.get(key(kind, expectedName)) ?? [])];
          // Legacy literal formats are suggestions too. They cannot claim a real
          // Discord member's full username as another member's secondary account.
          if (slot > 1)
            for (const account of legacyNames.get(`${kind}:${nameKey(member.username)}:${slot}`) ??
              [])
              if (!matching.some((item) => item.id === account.id)) matching.push(account);
          for (const account of matching) {
            if (
              (slot > 1 || nameKey(account.name) !== nameKey(member.username)) &&
              (nameMembers.get(nameKey(account.name)) ?? []).some(
                (identity) => identity.id !== member.id,
              )
            )
              continue;
            if (account.owner_discord_id === member.id) continue;
            if (account.owner_discord_id || ownerByAccount.get(key(kind, account.id))?.conflict) {
              row.conflict = 'A matching account already has a different confirmed owner.';
              row.gaps.push('identity_conflict');
              continue;
            }
            row.suggestions.push({
              account: { ...account, slot },
              reason:
                slot === 1
                  ? 'Exact Discord username match; administrator approval required.'
                  : `Exact numbered account match for slot ${slot}; administrator approval required.`,
              reliable: matching.length === 1,
            });
            proposedAccounts.add(key(kind, account.id));
          }
        }
      row.reliable =
        !row.conflict &&
        row.suggestions.length > 0 &&
        row.suggestions.every((item) => item.reliable);
    }
    // Suggested accounts appear under the proposed owner, without also counting a
    // second independent unresolved row. They are still unowned until approval.
    for (const account of accounts)
      if (proposedAccounts.has(key(account.kind, account.id)))
        rows.delete(`account:${account.kind}:${account.id}`);
    const memberships = this.service.memberships.list(settings);
    for (const row of rows.values()) {
      const media = row.confirmed_accounts;
      const exempt =
        row.exception !== null ||
        (media.length > 0 && media.every((account) => account.family)) ||
        memberships.some(
          (item) => item.discord_user_id === row.member?.id && item.access_mode === 'complimentary',
        );
      const active = row.customers.some((customer) => customer.active_subscription);
      if (
        active &&
        sources.stripe.complete &&
        sources.emby.complete &&
        sources.jellyfin.complete &&
        !media.some((account) => !account.disabled)
      )
        row.gaps.push('active_subscription_no_media');
      if (media.length && media.every((account) => account.disabled))
        row.gaps.push('disabled_media');
      if (media.length && !row.member && sources.discord.complete)
        row.gaps.push('media_without_discord');
      if (!sources.stripe.complete) row.gaps.push('billing_unknown');
      else if (!exempt && row.member && !active) {
        row.gaps.push('discord_without_active_subscription');
        if (media.some((account) => !account.disabled && !account.family))
          row.gaps.push('media_without_active_subscription');
      }
      if (row.member && sources.emby.complete && sources.jellyfin.complete && !media.length)
        row.gaps.push('discord_without_media');
      row.gaps = [...new Set(row.gaps)];
    }
    const list = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sourcesStable = Object.fromEntries(
      Object.entries(sources).map(([id, value]) => [
        id,
        { available: value.available, complete: value.complete },
      ]),
    );
    const revision = fingerprint({
      settingsHash,
      ownersHash,
      stripeRevision: stripeStatus.revision,
      servers,
      accounts,
      rows: list,
      sources: sourcesStable,
    });
    const snapshot: IdentityReviewSnapshot = {
      revision,
      generated_at: generated,
      expires_at: new Date(Date.now() + ttl).toISOString(),
      sources,
      rows: list,
      accounts,
      summary: {
        members: roster.members.length,
        unlinked_accounts: accounts.filter((account) => !account.owner_discord_id).length,
        suggestions: list.filter((row) => row.reliable).length,
        gaps: list.filter((row) => row.gaps.length && !row.exception).length,
        acknowledged: list.filter((row) => row.exception).length,
      },
    };
    this.cached = {
      snapshot,
      settingsHash,
      ownersHash,
      stripeRevision: stripeStatus.revision,
      servers,
    };
    return this.cached;
  }
  private customers(subscriptions: StripeSubscriptionReview[]): IdentityBillingCustomer[] {
    const groups = new Map<string, StripeSubscriptionReview[]>();
    for (const subscription of subscriptions)
      groups.set(subscription.customer_id, [
        ...(groups.get(subscription.customer_id) ?? []),
        subscription,
      ]);
    return [...groups].map(([id, items]) => {
      const approved = new Set(items.map((item) => item.linked_discord_id).filter(Boolean));
      const proposed = new Set(items.map((item) => item.proposed_discord_id).filter(Boolean));
      const tiers = new Set(items.map((item) => item.tier_id).filter(Boolean));
      return {
        id,
        name: items[0]!.customer_name,
        email: items[0]!.customer_email,
        linked_discord_id: approved.size === 1 ? [...approved][0]! : null,
        proposed_discord_id: proposed.size === 1 ? [...proposed][0]! : null,
        statuses: [...new Set(items.map((item) => item.status))],
        tier_id: tiers.size === 1 ? [...tiers][0]! : null,
        active_subscription: items.some(
          (item) => ['active', 'trialing'].includes(item.status) && !item.pause_collection,
        ),
        identity_conflict:
          approved.size > 1 ||
          proposed.size > 1 ||
          items.some((item) => item.identity_source?.startsWith('Conflicting') === true),
      };
    });
  }
  async apply(
    input: IdentityReviewApplyInput,
    authorize: () => void = () => {},
  ): Promise<IdentityReviewApplyResult> {
    if (this.service.demo) throw new ServiceError('Demo identity approvals are read-only.');
    if (this.closed || this.applying)
      throw new ServiceError('Wait for the current identity approval to finish.');
    if (
      !input ||
      !Array.isArray(input.selections) ||
      !input.selections.length ||
      input.selections.length > 250
    )
      throw new ServiceError('Select between 1 and 250 identity rows.');
    const original = this.cached;
    if (
      !original ||
      original.snapshot.revision !== input.revision ||
      Date.parse(original.snapshot.expires_at) <= Date.now()
    )
      throw new ServiceError(
        'The identity review expired or changed. Refresh and review the latest suggestions.',
      );
    this.applying = true;
    try {
      const current = await this.discover();
      if (current.snapshot.revision !== input.revision)
        throw new ServiceError(
          'Accounts, billing, Discord members or ownership changed. Refresh and review again.',
        );
      authorize();
      const settings = this.service.store.settings(),
        snapshot = current.snapshot;
      const rows = new Map(snapshot.rows.map((row) => [row.id, row]));
      const members = new Map(
        snapshot.rows.flatMap((row) => (row.member ? [[row.member.id, row.member] as const] : [])),
      );
      const accounts = new Map(
        snapshot.accounts.map((account) => [key(account.kind, account.id), account]),
      );
      const customerOwners = new Map(
        snapshot.rows.flatMap((row) =>
          row.customers.map((customer) => [customer.id, customer.linked_discord_id] as const),
        ),
      );
      const ownedSlots = new Map<string, string>();
      for (const account of accounts.values())
        if (account.owner_discord_id && account.slot)
          ownedSlots.set(`${account.owner_discord_id}:${account.kind}:${account.slot}`, account.id);
      const seenRows = new Set<string>(),
        seenAccounts = new Set<string>(),
        seenCustomers = new Set<string>();
      const records: Omit<MediaOwnership, 'scope' | 'approved_at'>[] = [];
      const links: Array<{ customer_id: string; discord_user_id: string; username: string }> = [];
      for (const selection of input.selections) {
        const row = rows.get(selection.row_id);
        if (
          !row ||
          seenRows.has(selection.row_id) ||
          !Array.isArray(selection.accounts) ||
          selection.accounts.length > 6 ||
          !Array.isArray(selection.stripe_customer_ids) ||
          selection.stripe_customer_ids.length > 10
        )
          throw new ServiceError(
            'Select each current identity row once with its reviewed accounts.',
          );
        seenRows.add(selection.row_id);
        const member = members.get(selection.discord_user_id);
        const annotationOnly =
          selection.accounts.length === 0 &&
          selection.stripe_customer_ids.length === 0 &&
          selection.exception !== undefined;
        if (annotationOnly && selection.discord_user_id && !member)
          throw new ServiceError(
            'Select the current Discord owner or leave the annotation independent of Discord.',
          );
        if (!annotationOnly && (!snapshot.sources.discord.complete || !member))
          throw new ServiceError(
            'Refresh the full Discord member list and select a current human member.',
          );
        const correctingCandidate =
          selection.stripe_customer_ids.length > 0 &&
          selection.stripe_customer_ids.every((customerId) =>
            row.customers.some(
              (customer) => customer.id === customerId && !customer.linked_discord_id,
            ),
          );
        if (row.member && member && row.member.id !== member.id && !correctingCandidate)
          throw new ServiceError(
            'An existing Discord identity cannot be reassigned by this review.',
          );
        if (row.conflict?.startsWith('More than one Discord username') && selection.accounts.length)
          throw new ServiceError(
            'Conflicting Discord usernames require a verified identity correction first.',
          );
        for (const customerId of selection.stripe_customer_ids) {
          if (
            !member ||
            !snapshot.sources.stripe.complete ||
            !customerOwners.has(customerId) ||
            seenCustomers.has(customerId) ||
            !row.customers.some((customer) => customer.id === customerId) ||
            (customerOwners.get(customerId) && customerOwners.get(customerId) !== member.id)
          )
            throw new ServiceError(
              'Review each Stripe customer with its current, verified Discord owner.',
            );
          seenCustomers.add(customerId);
          links.push({
            customer_id: customerId,
            discord_user_id: member.id,
            username: member.username,
          });
        }
        for (const selected of selection.accounts) {
          const accountKey = key(selected.kind, selected.id),
            account = accounts.get(accountKey);
          if (account?.ownership_conflict)
            throw new ServiceError(
              'Conflicting media ownership records require review before linking this account.',
            );
          if (
            !member ||
            !account ||
            !snapshot.sources[selected.kind]?.complete ||
            seenAccounts.has(accountKey) ||
            !Number.isInteger(selected.slot) ||
            selected.slot < 1 ||
            selected.slot > 3 ||
            (account.owner_discord_id && account.owner_discord_id !== member.id)
          )
            throw new ServiceError(
              'Select an available existing account and a unique slot between 1 and 3.',
            );
          const slotKey = `${member.id}:${selected.kind}:${selected.slot}`;
          if (ownedSlots.has(slotKey) && ownedSlots.get(slotKey) !== account.id)
            throw new ServiceError(
              'This owner already has another account in that server slot. Review the mapping.',
            );
          ownedSlots.set(slotKey, account.id);
          seenAccounts.add(accountKey);
          records.push({
            kind: account.kind,
            server_id: current.servers[account.kind]!,
            account_id: account.id,
            username: account.name,
            discord_user_id: member.id,
            slot: selected.slot,
          });
        }
      }
      authorize();
      if (
        current.ownersHash !== this.localFingerprint() ||
        current.settingsHash !== fingerprint(this.service.store.settings())
      )
        throw new ServiceError('Ownership or settings changed. Refresh before approving.');
      const ownersToSync = [
        ...new Set(
          input.selections
            .filter(
              (selection) => selection.accounts.length || selection.stripe_customer_ids.length,
            )
            .map((selection) => selection.discord_user_id)
            .filter(Boolean),
        ),
      ];
      const queued = { id: null as string | null };
      this.stripe.commitReviewedIdentities(
        { expected_revision: current.stripeRevision, links },
        () => {
          this.service.mediaOwnerships.save(records, settings);
          for (const selection of input.selections)
            if (selection.exception !== undefined) {
              const annotationOnly =
                !selection.accounts.length && !selection.stripe_customer_ids.length;
              const rowId =
                annotationOnly || !selection.discord_user_id
                  ? selection.row_id
                  : `discord:${selection.discord_user_id}`;
              this.service.mediaOwnerships.annotate(
                rowId,
                selection.exception === null
                  ? null
                  : { ...selection.exception, approved_at: new Date().toISOString() },
                settings,
              );
            }
          if (
            ownersToSync.length &&
            (settings.discord_emby_role_id || settings.discord_jellyfin_role_id)
          )
            queued.id = this.roleSync.enqueue(ownersToSync);
        },
      );
      this.cached = null;
      const result: IdentityReviewApplyResult = {
        approved: input.selections.length,
        roles: { status: 'not_configured', updated: 0, failed: 0 },
        warnings: [],
      };
      if (!ownersToSync.length) result.roles.status = 'not_requested';
      else if (queued.id) {
        result.roles = await this.roleSync.withinBudget(queued.id);
        if (['failed', 'pending'].includes(result.roles.status))
          result.warnings.push(
            result.roles.message ?? 'Ownership is saved; Discord role updates need attention.',
          );
      }
      return result;
    } finally {
      this.applying = false;
    }
  }
}
