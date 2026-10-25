import { createHash, randomUUID } from 'node:crypto';
import {
  generatePassword,
  accountCredentialMessage,
  discordCredentialContent,
} from './credentials.js';
import type { BotMessageHistory, BotMessageReceipt } from './bot-messages.js';
import { MediaError, ServiceError } from './errors.js';
import {
  caseFold,
  createMatcher,
  diagnosticProviderIds,
  type AmbiguityPathResolution,
  type AmbiguityReasonCode,
  type MatchPlan,
  type PreparedMatcher,
} from './matching.js';
import {
  UserMappings,
  validateExistingMappingUsername,
  type UserMapping,
} from './user-mappings.js';
import {
  readMigrationSource,
  statePlan,
  migrateItemState,
  migrationDetails,
  migrationWarning,
  type MigrationDetails,
  type MigrationScope,
  type SourceSnapshot,
} from './migration.js';
import {
  isObject,
  MediaClient,
  type ClientFactory,
  type JsonObject,
  type MediaAPI,
  type MediaItem,
  type MediaKind,
  type MediaUser,
  type DestinationReadEvent,
  type CatalogProgress,
} from './media.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';
import type { DiscordMemberSearchResult } from './discord-members.js';
import { AccountRoles, type AccountRole, type RoleAssignment } from './account-roles.js';
import { mergeRoleSection, type RoleSection } from './role-parameters.js';
import {
  Memberships,
  DEFAULT_MEMBERSHIP_TIERS,
  membershipUsername,
  resolveMembershipTier,
  validateMembershipSlot,
  type MembershipAccessMode,
  type Membership,
} from './memberships.js';
import type { Link } from './store.js';
import { AccountProfiles, type AccountProfileInput } from './account-profiles.js';
import { AdminAlerts } from './admin-alerts.js';
import { normalizeJellyfinUrl } from './jellyfin-auth.js';
import { SourceSnapshots, type SnapshotMetadata } from './source-snapshots.js';
import { ImportCoordinator } from './daily-import-schedule.js';
import { DestinationCatalogs } from './destination-catalogs.js';
import type { DestinationCatalogMetadata } from './destination-catalog-files.js';
import {
  captureExpectation,
  evaluateExpectation,
  type VerificationExpectation,
} from './migration-verification.js';
import { MediaWorkload, type MediaWorkloadEvent } from './media-workload.js';
import { MigrationCatalogCache, type MigrationCatalog } from './migration-catalog.js';
import { snapshotHistoryWarnings } from './emby-snapshot-reader.js';
import { validateActivityRetentionDays } from './settings.js';
import {
  accountConfigurationHash,
  cloneParameters,
  newCloneReview,
  validateCloneInput,
  type CloneAccountsInput,
  type ReviewedCloneSource,
  type StoredCloneReview,
} from './account-cloning.js';
import { AccountRenames } from './account-rename.js';
import { MediaOwnerships, type MediaOwnership } from './media-ownership.js';
import { NewSubscriberPolicy } from './new-subscriber-policy.js';
import type { StripeEntitlementFact } from './stripe-entitlements.js';
import { automaticAccountNameCandidates, parseAccountUsername } from './account-naming.js';
import type { IdentityRoster } from './identity-review-types.js';
import {
  JOB_RETENTION_INTERVAL_SECONDS,
  JOB_RETENTION_BATCH_LIMIT,
  type JobRetentionCursor,
  type JobRetentionStatus,
} from './job-retention.js';

export { ServiceError } from './errors.js';
export { generatePassword } from './credentials.js';
export interface ReviewedHistoryTarget {
  target_user_id: string;
  target_username: string;
  server_id: string;
  administrator: boolean;
  template: boolean;
  template_user_id: string;
}
export interface JobRequest {
  stripe_entitlement?: StripeEntitlementFact;
  clone_source?: ReviewedCloneSource;
  clone_profile?: { family: boolean; owner_name: string; notes: string };
  history_only_target?: ReviewedHistoryTarget;
  source_snapshot_id?: string;
  migration_scope?: MigrationScope;
  username?: string;
  source_user_id?: string;
  source_ownership?: { server_id?: string; identity_hash: string | null };
  discord_user_id?: string | null;
  recover_target_id?: string;
  mapping_id?: string;
  mapping_revision?: string;
  role_id?: string;
  role_revision?: string;
  role_assignment_revision?: string;
  target_user_id?: string;
  role_sections?: RoleSection[];
  default_role_revision?: string;
  membership_slot?: number;
  membership_revision?: string;
  /** A future-subscriber policy decision; never grants source-history access. */
  new_subscriber_policy_revision?: string;
  new_subscriber_event_id?: string;
  new_subscriber_emitted_at?: string;
  /** Server-owned authority pin for automatic subscription work after queueing. */
  automatic_subscription_source?: string;
  access_disabled?: boolean;
}
/** Server-owned preview proof. A numbered name is a suggestion until the
 * administrator accepts this exact owner, source identity and account slot. */
export interface ReviewedHouseholdAccount {
  source_username: string;
  discord_user_id: string;
  discord_username: string;
  slot: number;
  server_id: string;
}
export interface JobStats {
  source_played: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  already_played: number;
  source_items: number;
  source_favorites: number;
  source_resume: number;
  source_playlists: number;
}
/** Bounded, display-only media identity; never credentials, user state or write identifiers. */
export interface MigrationItemSummary {
  id: string;
  name: string;
  type?: string;
  series_name?: string;
  season_number?: number;
  episode_number?: number;
  episode_number_end?: number;
  production_year?: number;
  path?: string;
  provider_ids?: Record<string, string>;
  series_provider_ids?: Record<string, string>;
}
export interface MigrationAmbiguitySummary extends MigrationItemSummary {
  candidate_ids: string[];
  candidates?: MigrationItemSummary[];
  candidate_count?: number;
  method?: string;
  reason_codes?: AmbiguityReasonCode[];
  reason?: string;
  path_resolution?: AmbiguityPathResolution;
}
/** Per account, including both result lists; full matching counts remain unbounded by display. */
export const MAX_RESULT_DIAGNOSTIC_BYTES = 1024 * 1024;
export interface JobResult extends Partial<JobStats> {
  cloned_from_user_id?: string;
  cloned_from_username?: string;
  history_only?: true;
  migration_outcome?: {
    version: 1;
    execution: 'verified' | 'needs_review';
    unresolved_source_history: number;
  };
  destination_catalog?: DestinationCatalogMetadata;
  timing?: {
    elapsed_ms: number;
    phase_ms: Record<string, number>;
    checkpoints?: { count: number; total_duration_ms: number; max_duration_ms: number };
  };
  source_catalog?: { captured_at: string; items: number };
  source_snapshot?: SnapshotMetadata;
  username: string;
  status: string;
  created?: boolean;
  applied?: number;
  target_user_id?: string;
  discord_delivery?: string;
  delivery_error?: string;
  error?: string;
  source_username?: string;
  mapping_id?: string;
  role_id?: string;
  role_name?: string;
  role_sections?: RoleSection[];
  warnings?: string[];
  data?: MigrationDetails;
  unmatched_items?: Array<MigrationItemSummary & { type: string }>;
  ambiguous_items?: MigrationAmbiguitySummary[];
}
export interface Job {
  destination_catalog_id?: string;
  elapsed_ms?: number;
  /** Trusted server-side review preparation, excluding time spent reading the review. */
  preview_timing?: {
    preview_id: string;
    started_at: string;
    finished_at: string;
    elapsed_ms: number;
    user_count: number;
  };
  /** Whole review preparation plus whole accepted job; never apportioned between users. */
  workflow_elapsed_ms?: number;
  queue_ms?: number;
  cancel_requested?: boolean;
  source_snapshot_ids?: Record<string, string>;
  id: string;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  progress: {
    processed: number;
    total: number;
    current_user?: string;
    phase?:
      | 'reading_source'
      | 'preparing_account'
      | 'indexing_target'
      | 'reading_target'
      | 'matching'
      | 'transferring_history'
      | 'verifying_history'
      | 'transferring_playlists'
      | 'delivering_credentials';
    items_processed?: number;
    items_total?: number;
    items_updated?: number;
    catalog_pages?: number;
    catalog_items?: number;
    catalog_elapsed_ms?: number;
    catalog_last_page_ms?: number;
    catalog_cache_hit?: boolean;
  };
  results: JobResult[];
  error?: string;
  membership_discord_user_id?: string;
  migration_scope?: MigrationScope;
}
export interface SubscriptionEvent {
  stripe_entitlement?: StripeEntitlementFact;
  id: string;
  action: 'subscribe' | 'cancel' | 'expire';
  status: string;
  created_at: string;
  username?: string | null;
  discord_user_id?: string | null;
  source?: string | null;
  detail?: string | null;
  emitted_at?: string | null;
  error?: string | null;
  result?: string;
  job_id?: string;
  /** The administrator cleared the linked local report; event deduplication is retained. */
  report_cleared?: boolean;
  tier_id?: string;
  account_limit?: number;
}
export const MAX_JOB_HISTORY_CLEANUP = 1000;
export type JobHistoryCleanupSkipReason =
  | 'not_found'
  | 'not_finished'
  | 'active'
  | 'pending_credentials'
  | 'recovery_required'
  | 'subscription_processing';
export interface JobHistoryCleanupResult {
  removed_ids: string[];
  skipped: Array<{ id: string; reason: JobHistoryCleanupSkipReason }>;
}
export interface SubscriptionInput {
  stripe_entitlement?: StripeEntitlementFact;
  id: string;
  action: 'subscribe' | 'cancel' | 'expire';
  username?: string | null;
  discord_user_id?: string | null;
  source?: string | null;
  detail?: string | null;
  emitted_at?: string | null;
}
export interface BotAdapter {
  status(): Record<string, unknown>;
  recipientIdentity(
    id: string,
    requireMembership?: boolean,
  ): Promise<{ id?: string; username: string; joined_at?: string }>;
  validateRecipient(id: string, requireMembership?: boolean): Promise<unknown>;
  sendCredentials(
    id: string,
    username: string,
    password: string,
    url: string,
    requireMembership?: boolean,
    message?: string,
  ): Promise<BotMessageReceipt | void>;
  listTagRoles?(): Promise<{
    roles: Array<{ id: string; name: string; manageable: boolean }>;
    can_manage_roles: boolean;
  }>;
  memberTagState?(id: string): Promise<{ id: string; username: string; roles: string[] } | null>;
  updateTagRoles?(id: string, add: string[], remove: string[]): Promise<void>;
  listSubscriberRoles?(): Promise<{
    roles: Array<{ id: string; name: string; manageable: boolean }>;
    can_manage_roles: boolean;
  }>;
  removeSubscriberRole?(
    id: string,
    roleId: string,
    allowedRoleIds: string[],
    guard: () => void,
  ): Promise<void>;
  membershipActive(id: string): Promise<boolean | null>;
  activeMembers(): Promise<Array<{ id: string; username: string }> | null>;
  searchMembers?(query: string): Promise<DiscordMemberSearchResult>;
  listIdentityMembers?(): Promise<IdentityRoster>;
}
export interface ServiceOptions {
  clientFactory?: ClientFactory;
  demo?: boolean;
  observeMedia?: (event: MediaWorkloadEvent) => void;
  observeDestination?: (event: DestinationWorkloadEvent) => void;
}
export interface DestinationWorkloadEvent extends Omit<DestinationReadEvent, 'event'> {
  event: 'destination_read' | 'destination_cache_hit';
  calls: number;
  pages: number;
  items_total: number;
  cache_hits: number;
  total_duration_ms: number;
}
interface DestinationCatalogContext {
  key?: string;
  value?: MigrationCatalog;
  metadata?: DestinationCatalogMetadata;
  matcher?: PreparedMatcher;
  byId?: Map<string, MediaItem>;
}
interface ProvisioningDefaults extends MediaUser {
  accountRole?: AccountRole;
}
interface MigrationPreviewOptions {
  signal?: AbortSignal;
  progress?: (processed: number, total: number) => void;
  migration_scope?: MigrationScope;
  use_snapshots?: boolean;
}
interface PreviewUser {
  membership_slot?: number;
  owner_basis?: 'mapping' | 'approved' | 'numbered_suggestion';
  owner_search?: string;
  history_only?: true;
  source_snapshot?: SnapshotMetadata;
  source_user_id: string;
  source_username: string;
  username: string;
  target_user_id: string | null;
  target_exists: boolean;
  history_deferred?: boolean;
  stats: JobStats | null;
  unmatched: MediaItem[];
  ambiguous: MatchPlan['ambiguous'];
  mapping_id: string | null;
  mapping_revision: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  warnings: string[];
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new CanceledError());
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
          previous.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
      } else await previous;
    } catch (error) {
      void previous.then(release);
      throw error;
    }
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      release();
    }
  }
}
class StoppedError extends Error {}
class CanceledError extends StoppedError {}
class SourcePreparationError extends ServiceError {}
class DestinationPreparationError extends ServiceError {}
class NewSubscriberOptInRequired extends ServiceError {}
class SubscriptionSourceChanged extends ServiceError {}
interface NewSubscriberGuard {
  stripe_entitlement?: StripeEntitlementFact;
  revision: string;
  emitted_at: string;
  event_id: string;
  enrolled_membership?: Membership;
}
export function now(): string {
  return new Date().toISOString();
}
function migrationScope(value: unknown): MigrationScope {
  // Accept old persisted/API selections without allowing their former broad writes.
  if (value === undefined || value === 'complete' || value === 'watched_only')
    return 'watched_only';
  throw new ServiceError('Only watched-status migration is supported.');
}
export function validateUsername(username: string): string {
  if (
    !username ||
    username !== username.trim() ||
    [...username].length > 64 ||
    /[\u0000-\u001f\\/<>]/.test(username)
  )
    throw new ServiceError(
      'Use a username of 1–64 characters without leading/trailing spaces, control characters, slashes or angle brackets.',
    );
  return username;
}
export function templatePolicy(template: MediaUser | { Policy?: JsonObject }): JsonObject {
  if (!isObject(template.Policy))
    throw new ServiceError('Choose an enabled, non-administrator Jellyfin template user.');
  const policy = structuredClone(template.Policy ?? {});
  if (!Object.keys(policy).length || policy.IsAdministrator || policy.IsDisabled)
    throw new ServiceError('Choose an enabled, non-administrator Jellyfin template user.');
  delete policy.InvalidLoginAttemptCount;
  delete policy.FailedLoginAttempts;
  return policy;
}

/** Display-only preview diagnostics; these shortened IDs never identify migration writes. */
function previewItemSummary(item: MediaItem): MigrationItemSummary {
  const summary: MigrationItemSummary = {
    id: typeof item.Id === 'string' ? item.Id.slice(0, 128) : '',
    name: typeof item.Name === 'string' ? item.Name.slice(0, 512) : '',
  };
  if (typeof item.Type === 'string') summary.type = item.Type.slice(0, 64);
  if (typeof item.SeriesName === 'string') summary.series_name = item.SeriesName.slice(0, 512);
  if (
    typeof item.Path === 'string' &&
    !/[\u0000-\u001f\u007f]/.test(item.Path) &&
    // URLs can embed credentials, signatures and playback tokens. Display only
    // filesystem paths; Windows drive prefixes are not URL schemes.
    (!/^[a-z][a-z0-9+.-]*:/i.test(item.Path.trim()) || /^[a-z]:[\\/]/i.test(item.Path.trim())) &&
    !/^[\\/]{2}[^\\/]*@/.test(item.Path.trim())
  )
    summary.path = item.Path.slice(0, 1024);
  const numeric = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return typeof parsed === 'number' &&
      Number.isSafeInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 1_000_000
      ? parsed
      : undefined;
  };
  const type = summary.type?.toLowerCase();
  if (type === 'episode') {
    summary.season_number = numeric(item.ParentIndexNumber);
    summary.episode_number = numeric(item.IndexNumber);
    summary.episode_number_end = numeric(item.IndexNumberEnd);
  } else if (type === 'season') summary.season_number = numeric(item.IndexNumber);
  const year = numeric(item.ProductionYear);
  if (year !== undefined && year > 0 && year <= 9999) summary.production_year = year;
  const own = diagnosticProviderIds(item, 'ProviderIds');
  const series = diagnosticProviderIds(item, 'SeriesProviderIds');
  if (Object.keys(own).length) summary.provider_ids = own;
  if (Object.keys(series).length) summary.series_provider_ids = series;
  return summary;
}

/** Account jobs and subscription actions share a mutation lock released between users. */
export class Service {
  verifyStripeEntitlement?: (fact: StripeEntitlementFact) => void;
  bot: BotAdapter | null = null;
  clientFactory: ClientFactory;
  readonly jobTasks = new Map<string, Promise<void>>();
  private readonly mutationMutex = new Mutex();
  private readonly migrationMutex = new Mutex();
  private readonly historyMutex = new Mutex();
  private readonly jobControllers = new Map<string, AbortController>();
  private readonly activeJobs = new Map<string, Job>();
  private retentionDays = 0;
  private retentionCursor: JobRetentionCursor | null = null;
  private retentionLastRun: Omit<
    JobRetentionStatus,
    'retention_days' | 'interval_seconds' | 'batch_limit'
  > = {
    last_run_at: null,
    last_removed: 0,
    last_kept: 0,
    error: null,
  };
  private readonly sourceWorkload: MediaWorkload;
  private readonly sourceCatalogs: MigrationCatalogCache;
  private readonly destinationCatalogs: MigrationCatalogCache;
  private readonly destinationCacheHit: (items: number) => void;
  private readonly subscriptionMutex = new Mutex();
  private readonly clients = new Set<MediaAPI>();
  private stopping = false;
  readonly demo: boolean;
  readonly mappings: UserMappings;
  readonly roles: AccountRoles;
  readonly memberships: Memberships;
  readonly mediaOwnerships: MediaOwnerships;
  readonly newSubscriberPolicy: NewSubscriberPolicy;
  readonly profiles: AccountProfiles;
  readonly renames: AccountRenames;
  readonly adminAlerts: AdminAlerts;
  readonly sourceSnapshots: SourceSnapshots;
  readonly destinationSnapshots: DestinationCatalogs;
  private readonly membershipMutex = new Mutex();
  constructor(
    readonly store: Store,
    options: ServiceOptions = {},
  ) {
    this.sourceWorkload = new MediaWorkload({
      observe: options.observeMedia ?? ((event) => console.info(JSON.stringify(event))),
    });
    this.sourceCatalogs = new MigrationCatalogCache({
      hit: (items) => this.sourceWorkload.cacheHit('catalog', items),
    });
    const totals = { calls: 0, pages: 0, items_total: 0, cache_hits: 0, total_duration_ms: 0 };
    const report = (
      event:
        | DestinationReadEvent
        | (Omit<DestinationReadEvent, 'event'> & {
            event: 'destination_cache_hit';
          }),
    ) => {
      try {
        (options.observeDestination ?? ((value) => console.info(JSON.stringify(value))))({
          ...event,
          ...totals,
        });
      } catch {
        // Diagnostics cannot affect migrations or expose upstream response bodies.
      }
    };
    const observeRead = (event: DestinationReadEvent) => {
      totals.calls += event.attempts;
      totals.pages += Number(event.outcome === 'completed');
      totals.items_total += event.items;
      totals.total_duration_ms += event.duration_ms;
      report(event);
    };
    this.destinationCacheHit = (items) => {
      totals.cache_hits++;
      report({
        event: 'destination_cache_hit',
        operation: 'catalog',
        outcome: 'completed',
        items,
        attempts: 0,
        duration_ms: 0,
      });
    };
    this.destinationCatalogs = new MigrationCatalogCache({
      label: 'destination',
      hit: this.destinationCacheHit,
      reuseTtlFromCompletion: true,
    });
    this.clientFactory =
      options.clientFactory ??
      ((url, key, kind) =>
        new MediaClient(url, key, kind, {
          ...(kind === 'emby' ? { workload: this.sourceWorkload } : { observeRead }),
        }));
    this.demo = options.demo ?? false;
    this.mappings = new UserMappings(store);
    this.roles = new AccountRoles(store, this.demo);
    this.memberships = new Memberships(store);
    this.mediaOwnerships = new MediaOwnerships(store);
    this.newSubscriberPolicy = new NewSubscriberPolicy(store);
    this.profiles = new AccountProfiles(store);
    this.renames = new AccountRenames(store, this.mappings, this.roles);
    this.adminAlerts = new AdminAlerts(store);
    const imports = new ImportCoordinator();
    this.sourceSnapshots = new SourceSnapshots(store, {
      demo: this.demo,
      clientFactory: () => this.clientFactory,
      imports,
    });
    this.destinationSnapshots = new DestinationCatalogs(store, {
      demo: this.demo,
      clientFactory: () => this.clientFactory,
      imports,
    });
  }
  resolveDiscordMapping(discordId: string): UserMapping | null {
    return this.mappings.getForDiscord(discordId, this.store.settings());
  }
  resolveDiscordMappings(discordId: string): UserMapping[] {
    return this.mappings.getAllForDiscord(discordId, this.store.settings());
  }

  client(settings: Settings, kind: MediaKind): MediaAPI {
    this.requireServer(settings, kind);
    return this.clientFactory(settings[`${kind}_url`], settings[`${kind}_api_key`], kind);
  }
  private requireServer(settings: Settings, kind: MediaKind): void {
    if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`])
      throw new ServiceError(
        `Configure the ${kind === 'emby' ? 'Emby' : 'Jellyfin'} server URL and API key in Settings first.`,
      );
  }
  private async withClient<T>(
    settings: Settings,
    kind: MediaKind,
    action: (client: MediaAPI) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = this.client(settings, kind);
    this.clients.add(client);
    const cancel = () => {
      void client.close().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      return await action(client);
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.clients.delete(client);
      await client.close();
    }
  }
  async start(): Promise<void> {
    this.stopping = false;
    await this.sourceSnapshots.start();
    await this.destinationSnapshots.start();
    for (const { job, requests, settings } of this.store.queuedJobs())
      this.schedule(job, requests, settings);
  }
  async users(): Promise<{
    emby: MediaUser[];
    jellyfin: MediaUser[];
    errors: Record<string, string>;
  }> {
    const settings = this.store.settings();
    const fetchUsers = async (kind: MediaKind): Promise<[MediaUser[], string | null]> => {
      if (!settings[`${kind}_url`] || !settings[`${kind}_api_key`]) return [[], null];
      try {
        return [await this.withClient(settings, kind, (client) => client.users()), null];
      } catch (error) {
        if (error instanceof MediaError || error instanceof ServiceError)
          return [[], error.message];
        throw error;
      }
    };
    const [emby, jellyfin] = await Promise.all([fetchUsers('emby'), fetchUsers('jellyfin')]);
    const errors: Record<string, string> = {};
    if (emby[1]) errors.emby = emby[1];
    if (jellyfin[1]) errors.jellyfin = jellyfin[1];
    return { emby: emby[0], jellyfin: jellyfin[0], errors };
  }
  async embyUsers(): Promise<MediaUser[]> {
    return this.withClient(this.store.settings(), 'emby', (client) => client.users());
  }
  async connections(): Promise<Record<string, unknown>> {
    const settings = this.store.settings();
    const check = async (kind: MediaKind): Promise<Record<string, unknown>> => {
      const configured = Boolean(settings[`${kind}_url`] && settings[`${kind}_api_key`]);
      const result: Record<string, unknown> = { configured, connected: false };
      if (configured)
        try {
          const info = await this.withClient(settings, kind, async (client) => {
            const info = await client.systemInfo();
            await client.users();
            return info;
          });
          Object.assign(result, {
            connected: true,
            name: info.ServerName ?? kind,
            version: info.Version ?? '',
          });
        } catch (error) {
          if (!(error instanceof MediaError || error instanceof ServiceError)) throw error;
          result.error = `Unable to authenticate to ${kind === 'emby' ? 'Emby' : 'Jellyfin'}. Check URL, API key and network access.`;
        }
      return result;
    };
    const [emby, jellyfin] = await Promise.all([check('emby'), check('jellyfin')]);
    return { emby, jellyfin, discord: this.bot?.status() ?? { enabled: false, connected: false } };
  }
  private async template(client: MediaAPI, settings: Settings): Promise<ProvisioningDefaults> {
    if (settings.default_role_id) {
      const role = this.roles.get(settings.default_role_id, settings);
      if (!role)
        throw new ServiceError(
          'The default account role is unavailable. Choose it again in Settings.',
        );
      await this.requireRoleServer(client, role);
      return {
        Id: '',
        Name: role.name,
        Policy: structuredClone(role.parameters.policy),
        Configuration: structuredClone(role.parameters.configuration),
        accountRole: role,
      };
    }
    if (!settings.template_user_id)
      throw new ServiceError(
        'Select a default account role or Jellyfin template user in Settings first.',
      );
    const template = await client.user(settings.template_user_id);
    templatePolicy(template);
    return template;
  }
  private target(users: MediaUser[], username: string): MediaUser | null {
    const matches = users.filter((user) => caseFold(user.Name) === caseFold(username));
    if (matches.length > 1)
      throw new ServiceError(
        'Multiple Jellyfin accounts match this username. Resolve the duplicate before continuing.',
      );
    const target = matches[0] ?? null;
    if (target && target.Name !== username)
      throw new ServiceError(
        'A Jellyfin username differs only by letter case. Resolve it first so usernames can match exactly.',
      );
    return target;
  }
  private plan(
    source: MediaItem[],
    target: MediaItem[],
    settings: Settings,
    scope: MigrationScope = 'watched_only',
    preparedMatcher?: PreparedMatcher,
  ): [MatchPlan, JobStats] {
    const playable = new Set([
      'Movie',
      'Episode',
      'Audio',
      'MusicVideo',
      'Video',
      'Book',
      'AudioBook',
      'Trailer',
    ]);
    const played = source.filter(
      (item) => playable.has(item.Type ?? '') && item.UserData?.Played === true,
    );
    const plan = statePlan(source, target, settings, scope, preparedMatcher);
    return [
      plan,
      {
        source_played: played.length,
        matched: plan.matches.length,
        unmatched: plan.unmatched.length,
        ambiguous: plan.ambiguous.length,
        already_played: plan.matches.filter(
          (match) =>
            match.source.UserData?.Played === true && match.target.UserData?.Played === true,
        ).length,
        source_items: plan.matches.length + plan.unmatched.length + plan.ambiguous.length,
        source_favorites: 0,
        source_resume: 0,
        source_playlists: 0,
      },
    ];
  }
  private mappedTarget(
    users: MediaUser[],
    mapping: UserMapping | null,
    username: string,
    settings: Settings,
    recoverTargetId?: string,
    allowProtectedHistory = false,
  ): MediaUser | null {
    if (!mapping?.target_user_id) {
      const target = this.target(users, username);
      this.assertDestinationMapping(mapping, target?.Id ?? null, username, settings);
      if (mapping && target) {
        const local = this.store.account(username);
        const explicitRecovery =
          recoverTargetId === target.Id &&
          local &&
          ['uncertain', 'provisioning'].includes(local.status) &&
          (!local.remote_id || local.remote_id === target.Id);
        if (
          !explicitRecovery &&
          (local?.remote_id !== target.Id || local.status !== 'provisioning')
        )
          throw new ServiceError(
            'The mapped new username now exists. Select the existing Jellyfin account explicitly before migrating.',
          );
      }
      return target;
    }
    const target = users.find((user) => user.Id === mapping.target_user_id);
    this.assertDestinationMapping(
      mapping,
      target?.Id ?? mapping.target_user_id,
      username,
      settings,
    );
    if (!target || target.Name !== mapping.target_username)
      throw new ServiceError(
        'The mapped Jellyfin account was removed or renamed. Review its mapping.',
      );
    if (
      (!allowProtectedHistory && target.Policy?.IsAdministrator !== false) ||
      (target.Policy?.IsDisabled !== false && recoverTargetId !== target.Id)
    )
      throw new ServiceError(
        'The mapped Jellyfin account is disabled or its permissions changed. Review it before migrating.',
      );
    return target;
  }
  private assertDestinationMapping(
    mapping: UserMapping | null,
    targetId: string | null,
    username: string,
    settings: Settings,
  ): void {
    const owner = this.mappings.getForTarget(targetId, username, settings);
    if (owner && owner.id !== mapping?.id)
      throw new ServiceError(
        'This Jellyfin account or username is reserved by another approved Emby mapping. Use that mapping instead.',
      );
  }
  private requestMapping(request: JobRequest, settings: Settings): UserMapping | null {
    if (!request.source_user_id) return null;
    const mapping = this.mappings.getForSource(request.source_user_id, settings);
    if (request.mapping_id || request.mapping_revision) {
      if (
        !mapping ||
        mapping.id !== request.mapping_id ||
        mapping.revision !== request.mapping_revision
      )
        throw new ServiceError(
          'The user mapping changed after this job was queued. Review a new preview before migrating.',
        );
      return mapping;
    }
    if (mapping)
      throw new ServiceError(
        'A user mapping was added after this job was queued. Review a new preview before migrating.',
      );
    return null;
  }
  private assertMapping(
    mapping: UserMapping | null,
    sourceId: string | undefined,
    settings: Settings,
  ): void {
    if (!sourceId) return;
    const current = this.mappings.getForSource(sourceId, settings);
    if (
      mapping
        ? current?.id !== mapping.id || current.revision !== mapping.revision
        : current !== null
    )
      throw new ServiceError('The user mapping changed. Review a new preview before migrating.');
  }
  private ownershipHash(value: MediaOwnership | null): string | null {
    // Reapproving the same association does not invalidate queued work merely
    // because its audit timestamp changed. Every identity field remains pinned.
    return value
      ? createHash('sha256')
          .update(
            JSON.stringify([
              value.scope,
              value.kind,
              value.server_id,
              value.account_id,
              value.username,
              value.discord_user_id,
              value.slot,
            ]),
          )
          .digest('hex')
      : null;
  }
  private sourceOwnership(
    request: JobRequest,
    settings: Settings,
    serverId: string,
  ): MediaOwnership | null {
    if (!request.source_user_id) return null;
    const pin = request.source_ownership;
    if (this.mediaOwnerships.scope(settings) !== this.mediaOwnerships.scope(this.store.settings()))
      throw new ServiceError(
        'The identity server configuration changed. Review a new preview before migrating.',
      );
    const current = this.mediaOwnerships.get('emby', serverId, request.source_user_id, settings);
    if (
      (pin?.server_id && pin.server_id !== serverId) ||
      this.ownershipHash(current) !== (pin?.identity_hash ?? null)
    )
      throw new ServiceError(
        'The approved Emby ownership changed after this migration was queued. Review a new preview before migrating.',
      );
    if (
      current &&
      request.discord_user_id &&
      (current.discord_user_id !== request.discord_user_id ||
        current.slot !== (request.membership_slot ?? 1))
    )
      throw new ServiceError(
        'The selected recipient or account slot differs from this Emby account’s approved owner.',
      );
    return current;
  }
  /** A migration's verified IDs may add ownership, never replace an existing
   * owner or consume another account's reserved slot. Call inside the binding
   * SAVEPOINT too, after all remote reads have completed. */
  private migrationIdentityAdditions(
    records: Array<Omit<MediaOwnership, 'scope' | 'approved_at'>>,
    settings: Settings,
  ): Array<Omit<MediaOwnership, 'scope' | 'approved_at'>> {
    const owners = this.mediaOwnerships.list(settings);
    const mappings = this.mappings.list(settings);
    const source = records.find((record) => record.kind === 'emby');
    const additions: typeof records = [];
    for (const record of records) {
      const existing = owners.find(
        (owner) =>
          owner.kind === record.kind &&
          owner.server_id === record.server_id &&
          owner.account_id === record.account_id,
      );
      if (
        existing &&
        (existing.discord_user_id !== record.discord_user_id ||
          existing.slot !== record.slot ||
          existing.username !== record.username)
      )
        throw new ServiceError(
          'This media account has a conflicting approved owner, label, or slot. Review its identity before migrating.',
        );
      if (
        owners.some(
          (owner) =>
            owner.kind === record.kind &&
            owner.server_id === record.server_id &&
            owner.discord_user_id === record.discord_user_id &&
            owner.slot === record.slot &&
            owner.account_id !== record.account_id,
        )
      )
        throw new ServiceError(
          'This owner already has a different approved account in the selected media-server slot. Review its identity before migrating.',
        );
      for (const mapping of mappings) {
        const selectedSource = mapping.source_user_id === source?.account_id;
        const selectedAccount =
          record.kind === 'emby'
            ? mapping.source_user_id === record.account_id
            : mapping.target_user_id === record.account_id ||
              (!mapping.target_user_id &&
                caseFold(mapping.target_username) === caseFold(record.username));
        const sameOwnerSlot =
          mapping.discord_user_id === record.discord_user_id &&
          (mapping.membership_slot ?? 1) === record.slot;
        if (
          (selectedAccount &&
            mapping.discord_user_id &&
            (mapping.discord_user_id !== record.discord_user_id ||
              (mapping.membership_slot ?? 1) !== record.slot)) ||
          (sameOwnerSlot && !selectedSource) ||
          (record.kind === 'jellyfin' && selectedAccount && !selectedSource)
        )
          throw new ServiceError(
            'An approved user mapping conflicts with this migration owner or account slot. Review the mapping before migrating.',
          );
      }
      if (record.kind === 'jellyfin') {
        const targetLink = this.store.linkForRemote(record.account_id);
        const slotLink = this.store.link(record.discord_user_id, record.slot);
        if (
          (targetLink &&
            (targetLink.discord_user_id !== record.discord_user_id ||
              targetLink.membership_slot !== record.slot ||
              targetLink.username !== record.username)) ||
          (slotLink &&
            (slotLink.remote_id !== record.account_id || slotLink.username !== record.username))
        )
          throw new ServiceError(
            'The Jellyfin account link conflicts with this migration owner or slot. Review its identity before migrating.',
          );
      }
      if (!existing) additions.push(record);
    }
    return additions;
  }
  async preview(sourceUserIds: string[], options: MigrationPreviewOptions = {}) {
    return this.previewRead(sourceUserIds, options);
  }
  private async householdSuggestions(
    users: Pick<
      PreviewUser,
      'source_user_id' | 'source_username' | 'history_only' | 'discord_user_id'
    >[],
    settings: Settings,
  ): Promise<Record<string, Omit<ReviewedHouseholdAccount, 'server_id'>>> {
    const numbered = users.filter(
      (user) =>
        !user.history_only &&
        !user.discord_user_id &&
        (parseAccountUsername(user.source_username, settings)?.slot ?? 1) > 1,
    );
    if (!numbered.length || !settings.discord_enabled || !this.bot?.listIdentityMembers) return {};
    let roster: IdentityRoster;
    try {
      roster = await this.bot.listIdentityMembers();
    } catch {
      return {};
    }
    if (!roster.complete) return {};
    const result: Record<string, Omit<ReviewedHouseholdAccount, 'server_id'>> = {};
    const members = new Map(roster.members.map((member) => [member.id, member]));
    const fullNames = new Set(roster.members.map((member) => caseFold(member.username)));
    const byBase = new Map<string, Map<string, IdentityRoster['members'][number]>>();
    const addBase = (base: string, id: string) => {
      const member = members.get(id);
      if (!member) return;
      const key = caseFold(base),
        group = byBase.get(key) ?? new Map();
      group.set(id, member);
      byBase.set(key, group);
    };
    for (const member of roster.members) addBase(member.username, member.id);
    for (const member of this.memberships.list(settings))
      addBase(member.base_username, member.discord_user_id);
    for (const mapping of this.mappings.list(settings))
      if (mapping.discord_user_id && (mapping.membership_slot ?? 1) === 1) {
        const parsed = parseAccountUsername(mapping.source_username, settings);
        addBase(
          parsed?.slot === 1 ? parsed.base : mapping.source_username,
          mapping.discord_user_id,
        );
      }
    for (const user of numbered) {
      // A real Discord username containing a numeric suffix belongs to that
      // identity. Never silently strip it and assign their account to a namesake.
      if (fullNames.has(caseFold(user.source_username))) continue;
      const parsed = parseAccountUsername(user.source_username, settings)!;
      const candidates = [...(byBase.get(caseFold(parsed.base))?.values() ?? [])];
      if (candidates.length !== 1) continue;
      const owner = candidates[0]!;
      result[user.source_user_id] = {
        source_username: user.source_username,
        discord_user_id: owner.id,
        discord_username: owner.username,
        slot: parsed.slot,
      };
    }
    return result;
  }
  private async previewRead(
    sourceUserIds: string[],
    options: MigrationPreviewOptions = {},
  ): Promise<{
    users: PreviewUser[];
    mode: 'merge';
    migration_scope: MigrationScope;
    source_snapshot_ids?: Record<string, string>;
    history_only_targets?: Record<string, ReviewedHistoryTarget>;
    household_targets?: Record<string, ReviewedHouseholdAccount>;
    owner_assignment_sources?: Record<
      string,
      Pick<ReviewedHouseholdAccount, 'source_username' | 'server_id'>
    >;
  }> {
    const scope = migrationScope(options.migration_scope);
    const checkCanceled = () => {
      if (options.signal?.aborted) throw new ServiceError('History matching was canceled.');
    };
    checkCanceled();
    const settings = this.store.settings();
    return this.withClient(settings, 'emby', (emby) =>
      this.withClient(settings, 'jellyfin', async (jellyfin) => {
        const cancel = () => {
          void Promise.allSettled([
            Promise.resolve().then(() => emby.close()),
            Promise.resolve().then(() => jellyfin.close()),
          ]);
        };
        options.signal?.addEventListener('abort', cancel, { once: true });
        try {
          checkCanceled();
          const template = await this.template(jellyfin, settings);
          checkCanceled();
          const targets = await jellyfin.users();
          checkCanceled();
          const users: PreviewUser[] = [];
          const snapshotIds: Record<string, string> = {};
          const historyOnlyTargets: Record<string, ReviewedHistoryTarget> = {};
          let destinationServerId: string | undefined;
          const registeredSources = this.mediaOwnerships
            .list(settings)
            .filter((owner) => owner.kind === 'emby');
          const snapshotInfo =
            options.use_snapshots || registeredSources.length ? await emby.systemInfo() : null;
          if (
            registeredSources.length &&
            (typeof snapshotInfo?.Id !== 'string' || !snapshotInfo.Id)
          )
            throw new ServiceError(
              'The Emby server identity could not be verified for account ownership.',
            );
          if (
            options.use_snapshots &&
            snapshotInfo &&
            (snapshotInfo.Version !== '4.10.1.0' || typeof snapshotInfo.Id !== 'string')
          )
            throw new ServiceError(
              'Database snapshots require the verified Emby 4.10.1.0 connection.',
            );
          let captureId: string | undefined;
          for (const sourceId of sourceUserIds) {
            checkCanceled();
            const sourceUser = await emby.user(sourceId);
            checkCanceled();
            if (sourceUser.Id !== sourceId)
              throw new ServiceError(
                'Emby returned a different source account. Reload the user list.',
              );
            const mapping = this.mappings.getForSource(sourceId, settings);
            if (mapping && sourceUser.Name !== mapping.source_username)
              throw new ServiceError('The mapped Emby account was renamed. Review its mapping.');
            const registeredOwner = registeredSources.find(
              (owner) => owner.account_id === sourceId && owner.server_id === snapshotInfo?.Id,
            );
            if (registeredOwner && registeredOwner.username !== sourceUser.Name)
              throw new ServiceError(
                'The approved Emby account was renamed. Review its ownership before migrating.',
              );
            if (
              registeredOwner &&
              mapping?.discord_user_id &&
              (registeredOwner.discord_user_id !== mapping.discord_user_id ||
                registeredOwner.slot !== mapping.membership_slot)
            )
              throw new ServiceError(
                'The Emby account has conflicting approved ownership and mapping records.',
              );
            const username = mapping?.target_user_id
                ? validateExistingMappingUsername(mapping.target_username)
                : validateUsername(mapping?.target_username ?? sourceUser.Name),
              target = this.mappedTarget(targets, mapping, username, settings, undefined, true);
            if (target?.Policy?.IsDisabled !== false && target)
              throw new ServiceError(
                'A disabled or unverifiable Jellyfin account cannot be a migration destination.',
              );
            const historyOnly = Boolean(
              target &&
              (target.Id === template.Id ||
                target.Id === settings.template_user_id ||
                target.Policy?.IsAdministrator === true),
            );
            const registeredIdentity =
              !mapping?.discord_user_id && !historyOnly && registeredOwner
                ? await this.requireBot().recipientIdentity(registeredOwner.discord_user_id, false)
                : null;
            if (
              registeredIdentity?.id &&
              registeredIdentity.id !== registeredOwner?.discord_user_id
            )
              throw new ServiceError(
                'Discord returned a different approved account owner. Review the identity.',
              );
            if (target && historyOnly) {
              if (typeof target.Policy?.IsAdministrator !== 'boolean')
                throw new ServiceError('The destination account protection could not be verified.');
              if (!destinationServerId) {
                const info = await jellyfin.systemInfo();
                checkCanceled();
                if (typeof info.Id !== 'string' || !info.Id)
                  throw new ServiceError('The Jellyfin server identity could not be verified.');
                destinationServerId = info.Id;
              }
              historyOnlyTargets[sourceId] = {
                target_user_id: target.Id,
                target_username: target.Name,
                server_id: destinationServerId,
                administrator: target.Policy.IsAdministrator,
                template: target.Id === settings.template_user_id || target.Id === template.Id,
                template_user_id: settings.template_user_id,
              };
            }
            // Approval validates identity and pins a suitable generation. It never starts a
            // catalog crawl, decrypts history, or reads playlists on either server.
            let snapshot: SnapshotMetadata | undefined;
            if (options.use_snapshots) {
              if (!snapshotInfo)
                throw new ServiceError(
                  'Saved snapshot identity is unavailable. Review a new preview.',
                );
              const saved = await this.sourceSnapshots.select(
                sourceId,
                settings,
                snapshotInfo.Id as string,
                captureId,
              );
              checkCanceled();
              captureId = saved.id;
              snapshotIds[sourceId] = saved.id;
              snapshot = { ...saved.metadata, source_username: sourceUser.Name };
            }
            this.assertMapping(mapping, sourceId, settings);
            users.push({
              ...(snapshot ? { source_snapshot: snapshot } : {}),
              source_user_id: sourceId,
              source_username: sourceUser.Name,
              username,
              target_user_id: target?.Id ?? null,
              target_exists: Boolean(target),
              ...(historyOnly ? { history_only: true } : {}),
              history_deferred: true,
              stats: null,
              unmatched: [],
              ambiguous: [],
              mapping_id: mapping?.id ?? null,
              mapping_revision: mapping?.revision ?? null,
              discord_user_id: historyOnly
                ? null
                : (mapping?.discord_user_id ??
                  (registeredIdentity ? registeredOwner!.discord_user_id : null)),
              discord_username: historyOnly
                ? null
                : (mapping?.discord_username ?? registeredIdentity?.username ?? null),
              ...(mapping?.discord_user_id
                ? { membership_slot: mapping.membership_slot ?? 1, owner_basis: 'mapping' as const }
                : registeredIdentity
                  ? { membership_slot: registeredOwner!.slot, owner_basis: 'approved' as const }
                  : {}),
              owner_search: sourceUser.Name,
              warnings: [
                snapshot
                  ? 'Saved history is available. Preview checks account identity and backup freshness only. Exact watched-status counts and matching details are deferred until approval; results report unmatched and ambiguous items. Approval uses this backup generation and a shared Jellyfin matching catalog.'
                  : 'Live preview checks account identity only. Played flags and matching details are read after approval; results report unmatched and ambiguous items. Shared matching catalogs are reused during the job, so library changes after collection require another migration.',
                ...(snapshot ? snapshotHistoryWarnings(snapshot.diagnostics) : []),
                ...(historyOnly
                  ? [
                      'History only: this existing protected account receives additive played flags. Password, permissions, roles, ownership and Discord delivery are preserved.',
                    ]
                  : []),
                ...(!target && template.accountRole
                  ? [
                      'The new account’s role may limit library access; final matches are checked using that account.',
                    ]
                  : []),
              ],
            });
            options.progress?.(users.length, sourceUserIds.length);
            checkCanceled();
          }
          const suggestions = await this.householdSuggestions(users, settings);
          checkCanceled();
          const householdTargets: Record<string, ReviewedHouseholdAccount> = {};
          const ownerAssignmentSources: Record<
            string,
            Pick<ReviewedHouseholdAccount, 'source_username' | 'server_id'>
          > = {};
          if (
            Object.keys(suggestions).length ||
            (settings.discord_enabled && users.some((user) => !user.history_only))
          ) {
            const info = snapshotInfo ?? (await emby.systemInfo());
            checkCanceled();
            if (typeof info.Id !== 'string' || !info.Id)
              throw new ServiceError(
                'The Emby server identity could not be verified for account owner review.',
              );
            for (const user of users) {
              if (!user.history_only)
                ownerAssignmentSources[user.source_user_id] = {
                  source_username: user.source_username,
                  server_id: info.Id,
                };
              const suggested = suggestions[user.source_user_id];
              if (!suggested) continue;
              householdTargets[user.source_user_id] = { ...suggested, server_id: info.Id };
              user.discord_user_id = suggested.discord_user_id;
              user.discord_username = suggested.discord_username;
              user.membership_slot = suggested.slot;
              user.owner_basis = 'numbered_suggestion';
              user.warnings.push(
                'Starting this migration confirms the suggested household owner and account slot. All new account credentials go privately to that owner. Existing passwords are preserved.',
              );
            }
          }
          return {
            users,
            mode: 'merge',
            migration_scope: scope,
            ...(Object.keys(householdTargets).length
              ? { household_targets: householdTargets }
              : {}),
            ...(Object.keys(ownerAssignmentSources).length
              ? { owner_assignment_sources: ownerAssignmentSources }
              : {}),
            ...(Object.keys(historyOnlyTargets).length
              ? { history_only_targets: historyOnlyTargets }
              : {}),
            ...(options.use_snapshots ? { source_snapshot_ids: snapshotIds } : {}),
          };
        } catch (error) {
          checkCanceled();
          throw error;
        } finally {
          options.signal?.removeEventListener('abort', cancel);
        }
      }),
    );
  }
  private requireBot(): BotAdapter {
    if (!this.bot)
      throw new ServiceError('Enable and connect the Discord bot before selecting a recipient.');
    return this.bot;
  }
  recipientRequiresSubscription(discordId: string): boolean {
    return this.memberships.get(discordId, this.store.settings())?.access_mode !== 'complimentary';
  }
  /** Subscriber roles affect the whole Discord owner. A Family account on either
   * server therefore protects that owner's roles, even when other slots are paid.
   * Only confirmed IDs/links are considered; names never establish an exemption. */
  subscriberRoleCleanupExempt(discordId: string): boolean {
    const settings = this.store.settings();
    const membership = this.memberships.get(discordId, settings);
    if (membership?.access_mode === 'complimentary') return true;
    // A decision saved against another paired server must not be silently lost.
    if (!membership && this.memberships.hasOtherScope(discordId, settings)) return true;
    const exceptions = this.mediaOwnerships.exceptions(settings);
    if (exceptions.has(`discord:${discordId}`)) return true;
    // A standalone account may have been approved before its Discord owner was
    // linked. Preserve that exact account's annotation after the rows combine.
    const protectedAccount = (kind: 'emby' | 'jellyfin', accountId: string) =>
      exceptions.has(`account:${kind}:${accountId}`) ||
      this.profiles.get(kind, accountId, settings)?.family === true;
    for (const owner of this.mediaOwnerships.list(settings))
      if (owner.discord_user_id === discordId && protectedAccount(owner.kind, owner.account_id))
        return true;
    for (const mapping of this.mappings.list(settings))
      if (
        mapping.discord_user_id === discordId &&
        (protectedAccount('emby', mapping.source_user_id) ||
          (mapping.target_user_id && protectedAccount('jellyfin', mapping.target_user_id)))
      )
        return true;
    for (const link of this.store.links())
      if (link.discord_user_id === discordId && protectedAccount('jellyfin', link.remote_id))
        return true;
    return false;
  }
  recipientRequiresMembershipRole(discordId: string): boolean {
    return (
      this.store.settings().new_subscriber_source !== 'stripe' &&
      this.recipientRequiresSubscription(discordId)
    );
  }
  private async recipientIdentity(discordId: string) {
    return this.requireBot().recipientIdentity(
      discordId,
      this.recipientRequiresMembershipRole(discordId),
    );
  }
  private async validateRecipients(recipients: Iterable<string>): Promise<void> {
    for (const recipient of new Set(recipients)) {
      const bot = this.requireBot();
      try {
        await bot.validateRecipient(
          String(recipient),
          this.recipientRequiresMembershipRole(String(recipient)),
        );
      } catch {
        throw new ServiceError(
          'Discord recipient is unavailable or does not have the required membership role.',
        );
      }
    }
  }
  async createAccount(username: string, discordUserId?: string | null): Promise<Job> {
    validateUsername(username);
    if (
      ['clone_uncertain', 'clone_incomplete'].includes(this.store.account(username)?.status ?? '')
    )
      throw new ServiceError(
        'This account is an incomplete clone. Inspect its identity and restrictions in Jellyfin before continuing, or choose a fresh clone username. Default account recovery cannot replace its restrictions.',
      );
    this.assertDestinationMapping(null, null, username, this.store.settings());
    if (discordUserId && this.resolveDiscordMapping(discordUserId))
      throw new ServiceError(
        'This Discord user has an approved Emby mapping. Use migration to preserve their existing data.',
      );
    if (discordUserId) {
      await this.validateRecipients([discordUserId]);
      const identity = await this.recipientIdentity(discordUserId);
      if (username !== identity.username)
        throw new ServiceError(
          "Use the recipient's Discord username, not their server nickname or display name.",
        );
    }
    this.requireServer(this.store.settings(), 'jellyfin');
    const member = discordUserId
      ? this.memberships.get(discordUserId, this.store.settings())
      : null;
    if (member?.active === false)
      throw new ServiceError(
        'This membership is inactive. Review and activate its tier before creating an account.',
      );
    return this.queue('create', [
      {
        username,
        discord_user_id: discordUserId,
        ...(member ? { membership_slot: 1, membership_revision: member.revision } : {}),
      },
    ]);
  }
  private assertCloneSource(
    user: MediaUser,
    pin: { source_user_id: string; source_username: string },
    settings: Settings,
  ) {
    if (
      user.Id !== pin.source_user_id ||
      user.Name !== pin.source_username ||
      user.Policy?.IsAdministrator !== false ||
      user.Policy.IsDisabled !== false ||
      user.Id === settings.template_user_id ||
      user.Id === this.store.settings().template_user_id
    )
      throw new ServiceError(
        'Choose an enabled, non-administrator Jellyfin account that is not the template. The original account was preserved.',
      );
  }
  private async reviewedCloneSource(
    client: MediaAPI,
    pin: { source_user_id: string; source_username: string },
    settings: Settings,
  ): Promise<ReviewedCloneSource> {
    this.assertConnections(settings);
    const info = await client.systemInfo();
    this.assertConnections(settings);
    const auth = this.store.authState();
    if (
      typeof info.Id !== 'string' ||
      !info.Id ||
      (auth?.kind === 'configured' &&
        (info.Id !== auth.serverId ||
          normalizeJellyfinUrl(settings.jellyfin_url) !== normalizeJellyfinUrl(auth.serverUrl)))
    )
      throw new ServiceError('The paired Jellyfin server identity changed. No account was cloned.');
    const user = await client.user(pin.source_user_id);
    this.assertCloneSource(user, pin, settings);
    let display: JsonObject | null = null;
    if (client.displayPreferences) {
      try {
        display = await client.displayPreferences(user.Id);
      } catch {
        this.checkStopped();
      }
    }
    this.assertConnections(settings);
    const captured = cloneParameters(user, display);
    return {
      server_id: info.Id,
      ...pin,
      parameters: captured.parameters,
      parameters_hash: captured.hash,
      warnings: captured.warnings,
    };
  }
  async reviewCloneAccounts(input: CloneAccountsInput): Promise<StoredCloneReview> {
    if (this.demo) throw new ServiceError('Demo account cloning is read-only.');
    validateCloneInput(input);
    const settings = this.store.settings();
    return this.withClient(settings, 'jellyfin', async (client) => {
      const source = await this.reviewedCloneSource(
        client,
        {
          source_user_id: input.source_user_id,
          source_username: input.expected_source_username,
        },
        settings,
      );
      await this.assertNewCloneNames(
        client,
        input.accounts.map((account) => account.username),
        settings,
      );
      return newCloneReview(input, source);
    });
  }
  private async assertNewCloneNames(client: MediaAPI, names: string[], settings: Settings) {
    const users = await client.users();
    this.assertConnections(settings);
    for (const username of names) {
      validateUsername(username);
      if (users.some((user) => caseFold(user.Name) === caseFold(username)))
        throw new ServiceError(
          'A requested Jellyfin username already exists. Choose a new name; existing accounts were preserved.',
        );
      if (
        this.store.account(username) &&
        ['uncertain', 'provisioning', 'clone_uncertain', 'clone_incomplete'].includes(
          this.store.account(username)!.status,
        )
      )
        throw new ServiceError(
          'A requested username has an unfinished creation. Inspect account recovery before cloning again.',
        );
      this.assertDestinationMapping(null, null, username, settings);
    }
  }
  async cloneAccounts(
    reviewed: StoredCloneReview,
    acceptGuard: () => void = () => {},
  ): Promise<Job> {
    if (this.demo) throw new ServiceError('Demo account cloning is read-only.');
    const input: CloneAccountsInput = {
      source_user_id: reviewed.review.source_user_id,
      expected_source_username: reviewed.review.source_username,
      accounts: reviewed.review.accounts,
    };
    validateCloneInput(input);
    if (
      Date.parse(reviewed.review.expires_at) <= Date.now() ||
      reviewed.source.source_user_id !== input.source_user_id ||
      reviewed.source.source_username !== input.expected_source_username
    )
      throw new ServiceError('This account clone review expired. Prepare a new review.');
    const settings = this.store.settings();
    await this.withClient(settings, 'jellyfin', async (client) => {
      const fresh = await this.reviewedCloneSource(client, reviewed.source, settings);
      if (
        fresh.server_id !== reviewed.source.server_id ||
        fresh.parameters_hash !== reviewed.source.parameters_hash
      )
        throw new ServiceError('The source account settings changed. Prepare a new clone review.');
      await this.assertNewCloneNames(
        client,
        input.accounts.map((account) => account.username),
        settings,
      );
    });
    acceptGuard();
    return this.queue(
      'clone',
      input.accounts.map((account) => ({
        username: account.username,
        clone_source: structuredClone(reviewed.source),
        clone_profile: {
          family: account.family,
          owner_name: account.owner_name ?? '',
          notes: account.notes ?? '',
        },
        migration_scope: 'watched_only',
      })),
    );
  }
  async renameAccount(input: { user_id: string; expected_username: string; username: string }) {
    if (this.demo) throw new ServiceError('Demo account renaming is read-only.');
    validateUsername(input.username);
    if (
      !input.user_id ||
      input.user_id.length > 128 ||
      !input.expected_username ||
      input.expected_username.length > 256
    )
      throw new ServiceError('Choose an existing account and a new username.');
    return this.mutationMutex.run(async () => {
      this.checkStopped();
      const settings = this.store.settings();
      await this.confirmPairedServer(settings);
      return this.withClient(settings, 'jellyfin', async (client) => {
        if (!client.renameUser)
          throw new ServiceError('This Jellyfin integration cannot rename accounts.');
        const info = await client.systemInfo();
        if (typeof info.Id !== 'string' || !info.Id)
          throw new ServiceError('The Jellyfin server identity could not be verified.');
        const target = await client.user(input.user_id);
        this.assertManageableAccount(target, input.user_id, settings, 'jellyfin');
        const pending = this.renames.get(input.user_id, settings);
        if (pending) {
          if (
            pending.old_username !== input.expected_username ||
            pending.username !== input.username ||
            target.Name !== pending.username ||
            !isObject(target.Configuration) ||
            accountConfigurationHash(target.Configuration) !== pending.configuration_hash
          )
            throw new ServiceError(
              'An earlier rename has an uncertain outcome. Inspect this account in Jellyfin before retrying; no rename was repeated.',
            );
          return this.renames.commit(pending, settings);
        }
        if (target.Name !== input.expected_username || !isObject(target.Configuration))
          throw new ServiceError(
            'The account changed or its preferences could not be read. Refresh before renaming.',
          );
        if (target.Name === input.username) throw new ServiceError('Choose a different username.');
        const users = await client.users();
        if (
          users.some(
            (user) => user.Id !== target.Id && caseFold(user.Name) === caseFold(input.username),
          )
        )
          throw new ServiceError(
            'That Jellyfin username already exists. Existing accounts were preserved.',
          );
        this.assertConnections(settings);
        this.checkStopped();
        const pin = this.renames.prepare(
          {
            user_id: target.Id,
            old_username: target.Name,
            username: input.username,
            server_id: info.Id,
            configuration_hash: accountConfigurationHash(target.Configuration),
          },
          settings,
        );
        try {
          await client.renameUser(target.Id, input.username, structuredClone(target.Configuration));
        } catch {
          /* Never replay an uncertain write. Only exact-ID readback can confirm it. */
        }
        let confirmed: MediaUser;
        try {
          confirmed = await client.user(target.Id);
        } catch {
          throw new ServiceError(
            'The rename outcome is uncertain. Inspect this account in Jellyfin before retrying; no password or history was changed.',
          );
        }
        this.assertConnections(settings);
        this.assertManageableAccount(confirmed, target.Id, settings, 'jellyfin');
        if (
          confirmed.Name !== input.username ||
          accountConfigurationHash(confirmed.Configuration) !== pin.configuration_hash
        )
          throw new ServiceError(
            'The rename could not be fully confirmed. Inspect this account in Jellyfin before retrying.',
          );
        return this.renames.commit(pin, settings);
      });
    });
  }
  async renameAccountRecovery(userId: string) {
    if (!userId || userId.length > 128) throw new ServiceError('Choose an existing account.');
    const settings = this.store.settings();
    await this.confirmPairedServer(settings);
    const pin = this.renames.get(userId, settings);
    if (!pin) return { pending: null };
    return this.withClient(settings, 'jellyfin', async (client) => {
      if ((await client.systemInfo()).Id !== pin.server_id)
        throw new ServiceError('The Jellyfin server identity changed. No rename was confirmed.');
      const target = await client.user(userId);
      this.assertManageableAccount(target, userId, settings, 'jellyfin');
      this.assertConnections(settings);
      return {
        pending: {
          user_id: userId,
          expected_username: pin.old_username,
          username: pin.username,
          can_confirm:
            target.Name === pin.username &&
            isObject(target.Configuration) &&
            accountConfigurationHash(target.Configuration) === pin.configuration_hash,
        },
      };
    });
  }
  listMemberships(): Array<Membership & { links: Link[] }> {
    const settings = this.store.settings();
    const records = this.memberships.list(settings);
    const known = new Set(records.map((member) => member.discord_user_id));
    // Older single-account installations need no manual database reset or relinking.
    for (const link of this.store.links()) {
      if (known.has(link.discord_user_id)) continue;
      known.add(link.discord_user_id);
      if (this.memberships.hasOtherScope(link.discord_user_id, settings)) continue;
      const primary = this.store.link(link.discord_user_id) ?? link;
      records.push({
        discord_user_id: link.discord_user_id,
        server_url: settings.jellyfin_url,
        base_username: primary.username,
        tier_id: 'sloop',
        access_mode: 'subscription',
        provision_jellyfin: true,
        account_limit: 1,
        active: !Boolean(primary.disabled_by_jellyport),
        revision: '',
      });
    }
    return records.map((member) => ({
      ...member,
      links: this.store.linksForMember(member.discord_user_id),
    }));
  }
  private assertManageableAccount(
    target: MediaUser,
    targetId: string,
    settings: Settings,
    kind: MediaKind,
  ): void {
    if (
      target.Id !== targetId ||
      target.Policy?.IsAdministrator !== false ||
      typeof target.Policy.IsDisabled !== 'boolean' ||
      (kind === 'jellyfin' &&
        (targetId === settings.template_user_id ||
          targetId === this.store.settings().template_user_id))
    )
      throw new ServiceError('Administrator, template, or unverified accounts cannot be changed.');
  }
  private async confirmPairedServer(settings: Settings): Promise<void> {
    const auth = this.store.authState();
    if (auth?.kind === 'configured') {
      if (normalizeJellyfinUrl(settings.jellyfin_url) !== normalizeJellyfinUrl(auth.serverUrl))
        throw new ServiceError(
          'Restore the paired Jellyfin configuration before changing an account.',
        );
      await this.withClient(settings, 'jellyfin', async (client) => {
        if ((await client.systemInfo()).Id !== auth.serverId)
          throw new ServiceError('The paired Jellyfin server changed. No account was modified.');
      });
    }
  }
  /** Only a manual, selected-ID edit can establish a Family exemption. */
  async saveAccountProfile(input: AccountProfileInput & { expected_revision?: string }) {
    if (this.demo) throw new ServiceError('Demo account profiles are read-only.');
    return this.mutationMutex.run(async () => {
      this.checkStopped();
      const settings = this.store.settings();
      await this.confirmPairedServer(settings);
      return this.withClient(settings, input.kind, async (client) => {
        const target = await client.user(input.user_id);
        if (target.Id !== input.user_id)
          throw new ServiceError('The selected media account changed. Refresh and try again.');
        if (input.family) this.assertManageableAccount(target, input.user_id, settings, input.kind);
        if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
          throw new ServiceError('Configuration changed. Refresh and try again.');
        return this.profiles.save(input, settings, input.expected_revision);
      });
    });
  }
  /** Explicit administrator access change, separate from subscription automation. */
  async setAccountAccess(input: {
    kind: MediaKind;
    user_id: string;
    disabled: boolean;
    expected_username: string;
    expected_profile_revision: string;
  }) {
    if (this.demo) throw new ServiceError('Demo account access is read-only.');
    if (typeof input.disabled !== 'boolean')
      throw new ServiceError('Choose the account access state.');
    return this.mutationMutex.run(async () => {
      this.checkStopped();
      const settings = this.store.settings();
      await this.confirmPairedServer(settings);
      return this.withClient(settings, input.kind, async (client) => {
        const target = await client.user(input.user_id);
        this.assertManageableAccount(target, input.user_id, settings, input.kind);
        if (
          target.Name !== input.expected_username ||
          (this.profiles.get(input.kind, input.user_id, this.store.settings())?.revision ?? '') !==
            input.expected_profile_revision ||
          JSON.stringify(settings) !== JSON.stringify(this.store.settings())
        )
          throw new ServiceError(
            'The account, owner notes, or configuration changed. Review access again.',
          );
        const policy = structuredClone(target.Policy!);
        policy.IsDisabled = input.disabled;
        this.checkStopped();
        if (target.Policy!.IsDisabled !== input.disabled) await client.setPolicy(target.Id, policy);
        const confirmed = await client.user(target.Id);
        this.assertManageableAccount(confirmed, input.user_id, settings, input.kind);
        if (
          confirmed.Name !== input.expected_username ||
          confirmed.Policy!.IsDisabled !== input.disabled ||
          JSON.stringify(settings) !== JSON.stringify(this.store.settings()) ||
          (this.profiles.get(input.kind, input.user_id, this.store.settings())?.revision ?? '') !==
            input.expected_profile_revision
        )
          throw new ServiceError('Account access could not be confirmed. Refresh before retrying.');
        if (input.kind === 'jellyfin') {
          const link = this.store.linkForRemote(input.user_id);
          // An explicit administrator action is not a billing-owned disable.
          if (link)
            this.store.saveLink(
              link.discord_user_id,
              link.username,
              link.remote_id,
              false,
              link.membership_slot,
            );
        }
        return { kind: input.kind, user_id: input.user_id, disabled: input.disabled };
      });
    });
  }
  /** Save an administrator's access decision without touching media accounts. */
  async setMembershipAccess(input: {
    discord_user_id: string;
    access_mode: MembershipAccessMode;
    account_limit?: number;
    tier_id?: string;
    provision_jellyfin?: boolean;
    expected_revision?: string;
  }): Promise<Membership> {
    if (this.demo) throw new ServiceError('Demo memberships are read-only.');
    return this.membershipMutex.run(() =>
      this.mutationMutex.run(async () => {
        const settings = this.store.settings();
        const previous = this.memberships.get(input.discord_user_id, settings);
        if (!previous && this.memberships.hasOtherScope(input.discord_user_id, settings))
          throw new ServiceError(
            'Restore the original paired server before changing this membership.',
          );
        if (input.expected_revision !== undefined && previous?.revision !== input.expected_revision)
          throw new ServiceError('The membership changed. Review it before retrying.');
        if (!['subscription', 'complimentary'].includes(input.access_mode))
          throw new ServiceError('Choose subscription or complimentary access.');
        if (input.provision_jellyfin !== undefined && typeof input.provision_jellyfin !== 'boolean')
          throw new ServiceError(
            'Choose whether this member has opted into Jellyfin provisioning.',
          );
        const tier =
          input.access_mode === 'complimentary'
            ? {
                id: 'complimentary',
                account_limit: validateMembershipSlot(
                  input.account_limit ?? previous?.account_limit ?? 1,
                ),
              }
            : (settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS).find(
                (t) => t.id === (input.tier_id ?? previous?.tier_id),
              );
        if (!tier) throw new ServiceError('Choose a configured subscription tier.');
        const identity = previous
          ? null
          : await this.requireBot().recipientIdentity(input.discord_user_id, false);
        if (identity?.id && identity.id !== input.discord_user_id)
          throw new ServiceError('Discord returned a different member. Reload and try again.');
        if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
          throw new ServiceError('Configuration changed. Review and try again.');
        return this.memberships.save(
          {
            discord_user_id: input.discord_user_id,
            base_username:
              previous?.base_username ??
              this.store.link(input.discord_user_id)?.username ??
              this.mappings.getForDiscord(input.discord_user_id, settings)?.target_username ??
              identity!.username,
            access_mode: input.access_mode,
            provision_jellyfin: input.provision_jellyfin ?? previous?.provision_jellyfin ?? false,
            ...(previous?.new_subscriber_pending && input.provision_jellyfin === undefined
              ? { new_subscriber_pending: true as const }
              : {}),
            tier_id: tier.id,
            account_limit: tier.account_limit,
            active: input.access_mode === 'complimentary' ? true : (previous?.active ?? true),
            ...(input.access_mode === 'subscription' && previous?.inactive_reason
              ? { inactive_reason: previous.inactive_reason }
              : {}),
          },
          settings,
          previous?.revision,
        );
      }),
    );
  }
  /** Explicitly adopt a selected account; never infer ownership from its username. */
  async linkExistingAccount(discordId: string, targetId: string, slot = 1): Promise<Link> {
    if (this.demo) throw new ServiceError('Demo account links are read-only.');
    validateMembershipSlot(slot);
    return this.membershipMutex.run(() =>
      this.mutationMutex.run(async () => {
        const settings = this.store.settings();
        const member = this.memberships.get(discordId, settings);
        if (!member && this.memberships.hasOtherScope(discordId, settings))
          throw new ServiceError('Restore the original paired server before linking this member.');
        if (slot > (member?.account_limit ?? 1) || member?.active === false)
          throw new ServiceError('Save an active access policy with this account allowance first.');
        await this.validateRecipients([discordId]);
        return this.withClient(settings, 'jellyfin', async (client) => {
          const info = await client.systemInfo();
          const auth = this.store.authState();
          if (auth?.kind === 'configured' && info.Id !== auth.serverId)
            throw new ServiceError('The paired Jellyfin server changed. No identity was linked.');
          const target = await client.user(targetId);
          const confirmedOwner = this.mediaOwnerships
            .list(settings, { jellyfin: String(info.Id) })
            .find((item) => item.kind === 'jellyfin' && item.account_id === targetId);
          if (
            confirmedOwner &&
            (confirmedOwner.discord_user_id !== discordId || confirmedOwner.slot !== slot)
          )
            throw new ServiceError(
              'This Jellyfin account already has a different confirmed Discord owner or slot.',
            );
          if (
            target.Id !== targetId ||
            target.Policy?.IsAdministrator !== false ||
            typeof target.Policy.IsDisabled !== 'boolean' ||
            targetId === settings.template_user_id
          )
            throw new ServiceError(
              'Administrator, template, or unverified accounts cannot be linked.',
            );
          const previous = this.store.link(discordId, slot);
          const owner = this.store.linkForRemote(targetId);
          const mapping = this.mappings.getForTarget(targetId, target.Name, settings);
          const slotMapping = this.mappings.getForDiscord(discordId, settings, slot);
          if (
            (previous && (previous.remote_id !== targetId || previous.username !== target.Name)) ||
            (owner && (owner.discord_user_id !== discordId || owner.membership_slot !== slot)) ||
            (mapping &&
              (mapping.discord_user_id !== discordId ||
                (mapping.membership_slot ?? 1) !== slot ||
                mapping.target_user_id !== targetId)) ||
            (slotMapping &&
              (slotMapping.target_user_id !== targetId ||
                slotMapping.target_username !== target.Name))
          )
            throw new ServiceError(
              'This account or slot is reserved by another identity link or mapping. Review it first.',
            );
          if (
            JSON.stringify(settings) !== JSON.stringify(this.store.settings()) ||
            member?.revision !== this.memberships.get(discordId, settings)?.revision
          )
            throw new ServiceError('Configuration or access changed. Review and try again.');
          if (previous) return previous;
          this.store.saveLink(discordId, target.Name, targetId, false, slot);
          return this.store.link(discordId, slot)!;
        });
      }),
    );
  }
  private assertMembershipRequest(request: JobRequest, settings: Settings): Membership | null {
    if (request.automatic_subscription_source !== undefined)
      this.assertAutomaticSubscriptionSource(request.automatic_subscription_source);
    if (request.stripe_entitlement) {
      this.assertStripeEntitlement(request.stripe_entitlement);
      if (request.discord_user_id !== request.stripe_entitlement.discord_user_id)
        throw new ServiceError(
          'The Stripe account owner changed. Review the queued membership action.',
        );
    }
    if (request.new_subscriber_policy_revision) {
      this.newSubscriberPolicy.assertActive(settings, request.new_subscriber_policy_revision);
      const emitted = Date.parse(request.new_subscriber_emitted_at ?? '');
      const event = request.new_subscriber_event_id
        ? this.store.subscription(request.new_subscriber_event_id)
        : null;
      const activation = this.newSubscriberPolicy.activation(settings)!;
      if (
        !event ||
        !['mee6_message', 'stripe'].includes(event.source ?? '') ||
        event.action !== 'subscribe' ||
        event.discord_user_id !== request.discord_user_id ||
        !event.detail?.trim() ||
        event.emitted_at !== request.new_subscriber_emitted_at ||
        !Number.isFinite(emitted) ||
        !Number.isFinite(Date.parse(event.created_at)) ||
        emitted < Date.parse(activation.enabled_at) ||
        Date.parse(event.created_at) < Date.parse(activation.enabled_at) ||
        emitted > Date.now() + 30_000 ||
        (event.source !== 'stripe' && Date.now() - emitted > 10 * 60_000)
      )
        throw new ServiceError('The new-subscriber review expired. Review account provisioning.');
      if (!this.store.settings().auto_provision || request.source_user_id || request.mapping_id)
        throw new ServiceError('The new-subscriber policy changed. Review account provisioning.');
      if (
        request.discord_user_id &&
        (this.mappings.getAllForDiscord(request.discord_user_id, this.store.settings()).length ||
          this.mediaOwnerships
            .list(this.store.settings())
            .some((owner) => owner.discord_user_id === request.discord_user_id) ||
          this.store
            .subscriptions()
            .some(
              (previous) =>
                previous.id !== event.id &&
                previous.discord_user_id === request.discord_user_id &&
                previous.source === 'mee6_message',
            ))
      )
        throw new ServiceError('An existing Emby identity requires an explicit Jellyfin opt-in.');
    }
    if (!request.membership_revision) return null;
    const member = request.discord_user_id
      ? this.memberships.get(request.discord_user_id, this.store.settings())
      : null;
    if (
      !member ||
      !member.active ||
      (request.new_subscriber_policy_revision && !member.provision_jellyfin) ||
      member.revision !== request.membership_revision ||
      this.store.settings().jellyfin_url !== settings.jellyfin_url ||
      !Number.isInteger(request.membership_slot) ||
      request.membership_slot! < 1 ||
      request.membership_slot! > 3 ||
      (request.access_disabled === undefined && request.membership_slot! > member.account_limit) ||
      (request.access_disabled !== undefined &&
        request.access_disabled !== request.membership_slot! > member.account_limit)
    )
      throw new ServiceError('The membership changed. Review its current tier before retrying.');
    return member;
  }
  private newSubscriberGuard(
    event: SubscriptionEvent,
    settings: Settings,
  ): NewSubscriberGuard | null {
    const activation = this.newSubscriberPolicy.activation(settings);
    const emitted = Date.parse(event.emitted_at ?? '');
    const time = Date.now();
    if (event.source === 'stripe') {
      if (
        settings.new_subscriber_source !== 'stripe' ||
        !activation ||
        !event.stripe_entitlement?.is_new
      )
        return null;
      this.assertStripeEntitlement(event.stripe_entitlement);
      if (
        Date.parse(event.stripe_entitlement.created_at) < Date.parse(activation.enabled_at) ||
        Date.parse(event.created_at) < Date.parse(activation.enabled_at)
      )
        return null;
      return {
        revision: activation.revision,
        emitted_at: event.emitted_at!,
        event_id: event.id,
        stripe_entitlement: event.stripe_entitlement,
      };
    }
    if (
      !activation ||
      settings.new_subscriber_source === 'stripe' ||
      event.source !== 'mee6_message' ||
      !event.detail?.trim() ||
      !Number.isFinite(Date.parse(event.created_at)) ||
      Date.parse(event.created_at) < Date.parse(activation.enabled_at) ||
      !Number.isFinite(emitted) ||
      emitted < Date.parse(activation.enabled_at) ||
      emitted > time + 30_000 ||
      time - emitted > 10 * 60_000
    )
      return null;
    return { revision: activation.revision, emitted_at: event.emitted_at!, event_id: event.id };
  }
  /** Existing ownership and administrator opt-ins always outrank the cutover policy. */
  private assertNewSubscriberIdentity(
    discordId: string,
    settings: Settings,
    eventId: string,
  ): void {
    if (
      this.memberships.get(discordId, settings) ||
      this.memberships.hasOtherScope(discordId, settings) ||
      this.store.linksForMember(discordId).length ||
      this.mappings.getAllForDiscord(discordId, settings).length ||
      this.mediaOwnerships.list(settings).some((owner) => owner.discord_user_id === discordId) ||
      this.store
        .subscriptions()
        .some(
          (event) =>
            event.id !== eventId &&
            event.discord_user_id === discordId &&
            event.source === 'mee6_message',
        )
    )
      throw new NewSubscriberOptInRequired(
        'An existing account or access decision requires an explicit Jellyfin opt-in.',
      );
  }
  /** Provision the entire allowance; each slot keeps its own pinned target and access state. */
  async provisionMembership(
    discordId: string,
    tierId?: string,
    expectedRevision?: string,
    review?: { account_limit: number; usernames: string[]; provision_jellyfin?: boolean },
    newSubscriber?: NewSubscriberGuard,
    stripeEntitlement?: StripeEntitlementFact,
    automaticSource?: string,
  ): Promise<Job> {
    if (this.demo) throw new ServiceError('Demo memberships are read-only.');
    return this.membershipMutex.run(() =>
      this.mutationMutex.run(async () => {
        if (automaticSource !== undefined) this.assertAutomaticSubscriptionSource(automaticSource);
        await this.validateRecipients([discordId]);
        const identity = await this.recipientIdentity(discordId);
        if (identity.id && identity.id !== discordId)
          throw new ServiceError('Discord returned a different member. Reload and try again.');
        const settings = this.store.settings();
        if (stripeEntitlement) this.assertStripeEntitlement(stripeEntitlement);
        const existing = this.memberships.get(discordId, settings);
        if (
          existing?.new_subscriber_pending &&
          !newSubscriber &&
          review?.provision_jellyfin !== true
        )
          throw new ServiceError(
            'A previous automatic signup requires an explicit Jellyfin opt-in in Memberships before provisioning can continue.',
          );
        const assertNewPolicy = () => {
          if (automaticSource !== undefined)
            this.assertAutomaticSubscriptionSource(automaticSource);
          if (stripeEntitlement) this.assertStripeEntitlement(stripeEntitlement);
          if (!newSubscriber) return;
          this.newSubscriberPolicy.assertActive(settings, newSubscriber.revision);
          if (
            !this.store.settings().auto_provision ||
            JSON.stringify(settings) !== JSON.stringify(this.store.settings())
          )
            throw new ServiceError(
              'The new-subscriber policy changed. Review account provisioning.',
            );
          this.assertNewSubscriberIdentity(discordId, settings, newSubscriber.event_id);
        };
        assertNewPolicy();
        if (newSubscriber) {
          const activation = this.newSubscriberPolicy.activation(settings)!;
          const joined = Date.parse(identity.joined_at ?? '');
          const emitted = Date.parse(newSubscriber.emitted_at);
          const time = Date.now();
          if (
            (!newSubscriber.stripe_entitlement &&
              (!Number.isFinite(joined) ||
                joined < Date.parse(activation.enabled_at) ||
                joined > time)) ||
            (newSubscriber.stripe_entitlement && identity.id !== discordId) ||
            !Number.isFinite(emitted) ||
            emitted < Date.parse(activation.enabled_at) ||
            emitted > time + 30_000 ||
            (!newSubscriber.stripe_entitlement && time - emitted > 10 * 60_000)
          )
            throw new NewSubscriberOptInRequired(
              'Existing Discord members and older subscription events require an explicit Jellyfin opt-in.',
            );
        }
        if (
          review?.provision_jellyfin !== undefined &&
          typeof review.provision_jellyfin !== 'boolean'
        )
          throw new ServiceError(
            'Choose whether this member has opted into Jellyfin provisioning.',
          );
        if (!existing && this.memberships.hasOtherScope(discordId, settings))
          throw new ServiceError(
            'This member belongs to a different paired server configuration. Restore the original server URL before managing its accounts.',
          );
        if (expectedRevision !== undefined && expectedRevision !== existing?.revision)
          throw new ServiceError(
            'The membership changed. Review its current tier before retrying.',
          );
        if (
          this.store
            .jobs()
            .some(
              (job) =>
                job.membership_discord_user_id === discordId &&
                ['queued', 'running'].includes(job.status),
            )
        )
          throw new ServiceError('Wait for this member’s current account job to finish.');
        const tiers = settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS;
        const selectedTier =
          tierId ??
          existing?.tier_id ??
          tiers.find((entry) => entry.id === 'sloop' && entry.account_limit === 1)?.id ??
          tiers.find((entry) => entry.account_limit === 1)?.id;
        if (existing?.access_mode === 'complimentary' && tierId && tierId !== 'complimentary')
          throw new ServiceError(
            'This member has complimentary access. Change the access policy explicitly before assigning a paid tier.',
          );
        const tier =
          existing?.access_mode === 'complimentary'
            ? { id: 'complimentary', account_limit: existing.account_limit }
            : tiers.find((entry) => entry.id === selectedTier);
        if (!tier) throw new ServiceError('Choose a configured membership tier.');
        if (review && review.account_limit !== tier.account_limit)
          throw new ServiceError(
            'The tier definition changed. Review the current account allowance before retrying.',
          );
        const mappings = this.mappings.getAllForDiscord(discordId, settings);
        const primaryMapping = mappings.find((entry) => (entry.membership_slot ?? 1) === 1);
        const primaryLink = this.store.link(discordId);
        const baseUsername =
          existing?.base_username ??
          (primaryLink
            ? parseAccountUsername(primaryLink.username, settings)?.slot === 1
              ? parseAccountUsername(primaryLink.username, settings)!.base
              : primaryLink.username
            : undefined) ??
          (primaryMapping
            ? parseAccountUsername(primaryMapping.target_username, settings)?.slot === 1
              ? parseAccountUsername(primaryMapping.target_username, settings)!.base
              : primaryMapping.target_username
            : undefined) ??
          identity.username;
        const links = this.store.linksForMember(discordId);
        const allowNewAccounts = review?.provision_jellyfin ?? existing?.provision_jellyfin ?? true;
        if (!allowNewAccounts && !links.length)
          throw new ServiceError(
            'This member has not opted into Jellyfin provisioning. Their membership can be managed without a Jellyfin account.',
          );
        const requests: JobRequest[] = [];
        const needsNewSlot =
          allowNewAccounts &&
          Array.from({ length: tier.account_limit }, (_, index) => index + 1).some(
            (slot) => !links.some((link) => link.membership_slot === slot),
          );
        const sources =
          needsNewSlot && settings.emby_url && settings.emby_api_key ? await this.embyUsers() : [];
        const newSubscriberNames = new Set(
          newSubscriber
            ? [baseUsername, identity.username]
                .flatMap((base) => automaticAccountNameCandidates(base, settings))
                .map(caseFold)
            : [],
        );
        const assertNewSources = (sourceUsers: MediaUser[]) => {
          if (!newSubscriber) return;
          assertNewPolicy();
          if (Boolean(settings.emby_url) !== Boolean(settings.emby_api_key))
            throw new ServiceError(
              'Verify the configured Emby connection before automatic onboarding.',
            );
          if (sourceUsers.some((source) => newSubscriberNames.has(caseFold(source.Name))))
            throw new NewSubscriberOptInRequired(
              'An existing Emby account requires an explicit Jellyfin opt-in.',
            );
          if ([...newSubscriberNames].some((name) => this.store.account(name)))
            throw new NewSubscriberOptInRequired(
              'An existing local account requires administrator review before provisioning.',
            );
        };
        assertNewSources(sources);
        await this.withClient(settings, 'jellyfin', async (jellyfin) => {
          const info = await jellyfin.systemInfo();
          const auth = this.store.authState();
          if (auth?.kind === 'configured' && info.Id !== auth.serverId)
            throw new ServiceError(
              'The paired Jellyfin server changed. No accounts were modified.',
            );
          const targets = await jellyfin.users();
          if (
            newSubscriber &&
            targets.some((target) => newSubscriberNames.has(caseFold(target.Name)))
          )
            throw new NewSubscriberOptInRequired(
              'An existing Jellyfin account requires an explicit identity review.',
            );
          for (let slot = 1; slot <= 3; slot++) {
            const link = links.find((entry) => entry.membership_slot === slot);
            const mapping = mappings.find((entry) => (entry.membership_slot ?? 1) === slot);
            if (link) {
              const target = targets.find((entry) => entry.Id === link.remote_id);
              this.assertLinkedTarget(target, link, settings);
              if (
                mapping &&
                (mapping.target_username !== link.username ||
                  (mapping.target_user_id && mapping.target_user_id !== link.remote_id))
              )
                throw new ServiceError(
                  'An account link conflicts with its approved mapping. Review it first.',
                );
              requests.push({
                username: link.username,
                discord_user_id: discordId,
                target_user_id: link.remote_id,
                membership_slot: slot,
                access_disabled: slot > tier.account_limit,
              });
              continue;
            }
            if (slot > tier.account_limit || !allowNewAccounts) continue;
            const username =
              mapping?.target_username ?? membershipUsername(baseUsername, slot, settings);
            if (mapping?.target_user_id) validateExistingMappingUsername(username);
            else validateUsername(username);
            const target = this.mappedTarget(targets, mapping ?? null, username, settings);
            if (newSubscriber && target)
              throw new NewSubscriberOptInRequired(
                'An existing Jellyfin account requires an explicit identity review.',
              );
            if (target && !mapping?.target_user_id) {
              const local = this.store.account(username);
              if (local?.remote_id !== target.Id || local.status !== 'provisioning')
                throw new ServiceError(
                  `The username ${username} already exists without an approved identity link. Link it through an admin-approved migration or user mapping before provisioning.`,
                );
            }
            if (
              target &&
              (target.Policy?.IsAdministrator !== false ||
                target.Policy?.IsDisabled !== false ||
                target.Id === settings.template_user_id)
            )
              throw new ServiceError(
                'A membership cannot use a disabled, administrator, or template account.',
              );
            const owner = target ? this.store.linkForRemote(target.Id) : null;
            if (owner && (owner.discord_user_id !== discordId || owner.membership_slot !== slot))
              throw new ServiceError(
                'This Jellyfin account already belongs to another member or slot.',
              );
            const matchingSources = mapping
              ? sources.filter((source) => source.Id === mapping.source_user_id)
              : sources.filter((source) => source.Name === username);
            if (matchingSources.length > 1)
              throw new ServiceError(
                'More than one Emby account matches a membership slot. Create a mapping.',
              );
            if (
              mapping &&
              (!matchingSources[0] || matchingSources[0].Name !== mapping.source_username)
            )
              throw new ServiceError(
                'A mapped Emby account was removed or renamed. Review its mapping.',
              );
            requests.push({
              username,
              discord_user_id: discordId,
              membership_slot: slot,
              ...(!newSubscriber && matchingSources[0]
                ? { source_user_id: matchingSources[0].Id }
                : {}),
              ...(mapping ? { mapping_id: mapping.id, mapping_revision: mapping.revision } : {}),
            });
          }
          if (requests.some((request) => request.access_disabled === undefined))
            await this.template(jellyfin, settings);
        });
        if (
          review &&
          JSON.stringify(
            requests
              .filter((request) => request.membership_slot! <= tier.account_limit)
              .map((request) => request.username),
          ) !== JSON.stringify(review.usernames)
        )
          throw new ServiceError(
            'The account names or mappings changed. Review the current membership before retrying.',
          );
        if (
          JSON.stringify(this.store.settings()) !== JSON.stringify(settings) ||
          this.memberships.get(discordId, settings)?.revision !== existing?.revision
        )
          throw new ServiceError('Configuration or membership changed. Review and try again.');
        for (const mapping of mappings)
          if (this.mappings.get(mapping.id, settings)?.revision !== mapping.revision)
            throw new ServiceError('A user mapping changed. Review and try again.');
        if (newSubscriber && settings.emby_url && settings.emby_api_key)
          assertNewSources(await this.withClient(settings, 'emby', (client) => client.users()));
        assertNewPolicy();
        const member = this.memberships.save(
          {
            discord_user_id: discordId,
            base_username: baseUsername,
            tier_id: tier.id,
            access_mode: existing?.access_mode ?? 'subscription',
            provision_jellyfin: allowNewAccounts,
            ...(newSubscriber ? { new_subscriber_pending: true as const } : {}),
            account_limit: tier.account_limit,
            active: true,
          },
          settings,
          existing?.revision,
        );
        if (newSubscriber) newSubscriber.enrolled_membership = structuredClone(member);
        return this.queue(
          'membership',
          requests.map((request) => ({
            ...request,
            ...(automaticSource !== undefined
              ? { automatic_subscription_source: automaticSource }
              : {}),
            ...(stripeEntitlement
              ? { stripe_entitlement: structuredClone(stripeEntitlement) }
              : {}),
            membership_revision: member.revision,
            ...(newSubscriber
              ? {
                  new_subscriber_policy_revision: newSubscriber.revision,
                  new_subscriber_event_id: newSubscriber.event_id,
                  new_subscriber_emitted_at: newSubscriber.emitted_at,
                }
              : {}),
          })),
        );
      }),
    );
  }
  private assertLinkedTarget(
    target: MediaUser | undefined,
    link: Link,
    settings: Settings,
  ): asserts target is MediaUser {
    if (
      !target ||
      target.Id !== link.remote_id ||
      target.Name !== link.username ||
      target.Policy?.IsAdministrator !== false ||
      typeof target.Policy.IsDisabled !== 'boolean' ||
      target.Id === settings.template_user_id ||
      target.Id === this.store.settings().template_user_id
    )
      throw new ServiceError('A linked account changed or is protected. Review it manually.');
  }
  private async updateLinkedAccess(
    jellyfin: MediaAPI,
    settings: Settings,
    memberId: string,
    slot: number,
    disabled: boolean,
    guard: () => void = () => {},
  ): Promise<boolean> {
    let link = this.store.link(memberId, slot);
    if (!link) throw new ServiceError('The membership account link no longer exists.');
    const target = await jellyfin.user(link.remote_id);
    const auth = this.store.authState();
    const registered = this.mediaOwnerships
      .list(settings)
      .some((owner) => owner.kind === 'jellyfin' && owner.account_id === target.Id);
    const info = auth?.kind === 'configured' || registered ? await jellyfin.systemInfo() : null;
    if (auth?.kind === 'configured' && info?.Id !== auth.serverId)
      throw new ServiceError('The paired Jellyfin server changed. No account access was modified.');
    guard();
    this.assertLinkedTarget(target, link, settings);
    // Family is a per-account manual decision. Never reconcile pending billing
    // flags or change access automatically for this selected target ID.
    if (this.profiles.get('jellyfin', target.Id, this.store.settings())?.family) return false;
    if (registered && (typeof info?.Id !== 'string' || !info.Id))
      throw new ServiceError(
        'The Jellyfin server identity could not be verified for account ownership.',
      );
    const ownershipGuard = () => {
      guard();
      const owner =
        typeof info?.Id === 'string'
          ? this.mediaOwnerships.get('jellyfin', info.Id, target.Id, this.store.settings())
          : null;
      if (
        owner &&
        (owner.discord_user_id !== memberId ||
          owner.slot !== slot ||
          owner.username !== target.Name)
      )
        throw new ServiceError(
          'The linked account contradicts its approved media owner or slot. No automatic access change was authorized.',
        );
    };
    ownershipGuard();
    const policy = structuredClone(target.Policy!);
    const isDisabled = policy.IsDisabled === true;
    if (link.pending_disabled !== null && isDisabled === Boolean(link.pending_disabled)) {
      this.store.saveLink(memberId, link.username, link.remote_id, isDisabled, slot);
      link = this.store.link(memberId, slot)!;
    }
    if (disabled && !isDisabled) {
      policy.IsDisabled = true;
      ownershipGuard();
      await this.setAccess(jellyfin, target.Id, policy, memberId, true, slot);
      ownershipGuard();
      this.store.saveLink(memberId, link.username, target.Id, true, slot);
    } else if (!disabled && isDisabled && link.disabled_by_jellyport) {
      policy.IsDisabled = false;
      ownershipGuard();
      await this.setAccess(jellyfin, target.Id, policy, memberId, false, slot);
      ownershipGuard();
      this.store.saveLink(memberId, link.username, target.Id, false, slot);
    } else if (!isDisabled) {
      this.store.saveLink(memberId, link.username, target.Id, false, slot);
    }
    return disabled || !isDisabled || Boolean(link.disabled_by_jellyport);
  }
  async recoveryInfo(username: string): Promise<{
    username: string;
    target_exists: boolean;
    target_user_id: string | null;
    eligible: boolean;
    reason: string;
  }> {
    validateUsername(username);
    const local = this.store.account(username),
      settings = this.store.settings();
    const target = await this.withClient(settings, 'jellyfin', async (jellyfin) =>
      this.target(await jellyfin.users(), username),
    );
    const eligible = Boolean(
      local &&
      ['uncertain', 'provisioning'].includes(local.status) &&
      target &&
      (!local.remote_id || local.remote_id === target.Id) &&
      target.Id !== settings.template_user_id &&
      !target.Policy?.IsAdministrator,
    );
    return {
      username,
      target_exists: Boolean(target),
      target_user_id: target?.Id ?? null,
      eligible,
      reason: ['clone_uncertain', 'clone_incomplete'].includes(local?.status ?? '')
        ? 'This account is an incomplete clone. Inspect its identity and restrictions in Jellyfin before continuing, or choose a fresh clone username. Default account recovery cannot replace its restrictions.'
        : eligible
          ? 'Inspect this Jellyfin account. Recovery will reset its password and apply your account defaults; watch history is preserved.'
          : 'Recovery is available only for an incomplete Jellyport creation with an existing, unprotected Jellyfin account.',
    };
  }
  async recoverAccount(
    username: string,
    targetUserId: string,
    discordUserId?: string | null,
  ): Promise<Job> {
    const settings = this.store.settings();
    const info = await this.recoveryInfo(username);
    if (
      ['clone_uncertain', 'clone_incomplete'].includes(this.store.account(username)?.status ?? '')
    )
      throw new ServiceError(info.reason);
    if (!info.eligible || info.target_user_id !== targetUserId)
      throw new ServiceError(
        'The inspected recovery target is no longer eligible. Refresh its details before proceeding.',
      );
    const mapping = this.mappings.getForTarget(targetUserId, username, this.store.settings());
    let slot = mapping?.membership_slot ?? 1;
    let member: Membership | null = null;
    if (discordUserId) {
      await this.validateRecipients([discordUserId]);
      member = this.memberships.get(discordUserId, this.store.settings());
      const link = this.store.linkForRemote(targetUserId);
      if (link && link.discord_user_id !== discordUserId)
        throw new ServiceError('This Jellyfin account already belongs to another Discord user.');
      if (link) slot = link.membership_slot;
      else if (mapping?.discord_user_id !== discordUserId && member) {
        const derivedSlot = [1, 2, 3].find(
          (candidate) =>
            username === membershipUsername(member!.base_username, candidate, settings),
        );
        if (derivedSlot) slot = derivedSlot;
      }
      const householdName =
        member?.active &&
        slot <= member.account_limit &&
        username === membershipUsername(member.base_username, slot, settings);
      if (
        (await this.recipientIdentity(discordUserId)).username !== username &&
        mapping?.discord_user_id !== discordUserId &&
        !householdName &&
        !link
      )
        throw new ServiceError(
          "Use the recipient's Discord username when recovering and linking an account.",
        );
      if (member && (!member.active || slot > member.account_limit))
        throw new ServiceError('The active membership does not permit this account slot.');
    }
    return this.queue('recover', [
      {
        username,
        discord_user_id: discordUserId,
        recover_target_id: targetUserId,
        membership_slot: slot,
        ...(member ? { membership_revision: member.revision } : {}),
        ...(mapping
          ? {
              source_user_id: mapping.source_user_id,
              mapping_id: mapping.id,
              mapping_revision: mapping.revision,
            }
          : {}),
      },
    ]);
  }
  async migrateUsers(
    sourceUserIds: string[],
    discordRecipients: Record<string, string> = {},
    expectedMappingRevisions?: Record<string, string | null>,
    requestedScope?: MigrationScope,
    sourceSnapshotIds?: Record<string, string>,
    previewTiming?: Job['preview_timing'],
    historyOnlyTargets?: Record<string, ReviewedHistoryTarget>,
    householdTargets?: Record<string, ReviewedHouseholdAccount>,
    explicitOwnerTargets?: Record<string, Omit<ReviewedHouseholdAccount, 'discord_username'>>,
    admissionGuard?: () => void,
  ): Promise<Job> {
    admissionGuard?.();
    const requestedAt = now();
    const scope = migrationScope(requestedScope);
    if (
      !sourceUserIds.length ||
      sourceUserIds.length > 100 ||
      new Set(sourceUserIds).size !== sourceUserIds.length
    )
      throw new ServiceError('Select 1–100 distinct Emby users.');
    if (Object.keys(discordRecipients).some((id) => !sourceUserIds.includes(id)))
      throw new ServiceError('A Discord recipient must belong to a selected source user.');
    if (
      expectedMappingRevisions &&
      (Object.keys(expectedMappingRevisions).length !== sourceUserIds.length ||
        Object.keys(expectedMappingRevisions).some((id) => !sourceUserIds.includes(id)) ||
        sourceUserIds.some((id) => !Object.hasOwn(expectedMappingRevisions, id)))
    )
      throw new ServiceError('Mapping revisions must cover exactly the selected Emby users.');
    const settings = this.store.settings();
    this.requireServer(settings, 'emby');
    this.requireServer(settings, 'jellyfin');
    const reviewedHouseholds = householdTargets ?? {};
    const explicitOwners = explicitOwnerTargets ?? {};
    const reviewedOwners = { ...reviewedHouseholds, ...explicitOwners };
    if (
      Object.keys(reviewedOwners).some(
        (id) => !sourceUserIds.includes(id) || historyOnlyTargets?.[id],
      )
    )
      throw new ServiceError(
        'Household owners must belong to selected, unprotected source accounts.',
      );
    for (const [id, proof] of Object.entries(explicitOwners)) {
      validateMembershipSlot(proof.slot);
      if (
        !proof.source_username ||
        !proof.server_id ||
        !Object.hasOwn(discordRecipients, id) ||
        discordRecipients[id] !== proof.discord_user_id
      )
        throw new ServiceError(
          'Confirm a Discord recipient and account slot for each reviewed source account.',
        );
      const suggested = reviewedHouseholds[id];
      if (
        suggested &&
        (suggested.discord_user_id !== proof.discord_user_id || suggested.slot !== proof.slot)
      )
        throw new ServiceError(
          'The selected owner or slot differs from the suggested household review. Save an explicit user mapping for exceptions.',
        );
    }
    if (Object.keys(explicitOwners).length) {
      await this.withClient(settings, 'emby', async (client) => {
        const info = await client.systemInfo();
        admissionGuard?.();
        for (const [id, proof] of Object.entries(explicitOwners)) {
          const user = await client.user(id);
          admissionGuard?.();
          if (info.Id !== proof.server_id || user.Id !== id || user.Name !== proof.source_username)
            throw new ServiceError(
              'The reviewed account identity changed. Prepare a new migration review.',
            );
        }
      });
      admissionGuard?.();
    }
    if (Object.keys(reviewedHouseholds).length) {
      const sourceUsers = await this.withClient(settings, 'emby', async (client) => {
        const info = await client.systemInfo();
        const result = [];
        for (const [id, proof] of Object.entries(reviewedHouseholds)) {
          const user = await client.user(id);
          if (info.Id !== proof.server_id || user.Id !== id || user.Name !== proof.source_username)
            throw new ServiceError('The reviewed household source changed. Prepare a new review.');
          result.push({ source_user_id: id, source_username: user.Name, discord_user_id: null });
        }
        return result;
      });
      const current = await this.householdSuggestions(sourceUsers, settings);
      admissionGuard?.();
      for (const [id, proof] of Object.entries(reviewedHouseholds)) {
        const actual = current[id];
        if (
          !actual ||
          actual.discord_user_id !== proof.discord_user_id ||
          actual.discord_username !== proof.discord_username ||
          actual.slot !== proof.slot
        )
          throw new ServiceError(
            'The suggested household owner changed. Prepare a new review or save an explicit user mapping.',
          );
      }
    }
    const registeredSources = this.mediaOwnerships
      .list(settings)
      .filter((owner) => owner.kind === 'emby' && sourceUserIds.includes(owner.account_id));
    const confirmsMigrationOwner = sourceUserIds.some(
      (id) => discordRecipients[id] || this.mappings.getForSource(id, settings)?.discord_user_id,
    );
    let ownershipServerId: string | undefined;
    const readOwnershipServerId = () =>
      this.withClient(settings, 'emby', async (client) => {
        const info = await client.systemInfo();
        admissionGuard?.();
        if (typeof info.Id !== 'string' || !info.Id)
          throw new ServiceError(
            'The Emby server identity could not be verified for approved ownership.',
          );
        return info.Id;
      });
    if (registeredSources.length || Object.keys(reviewedOwners).length)
      ownershipServerId = await readOwnershipServerId();
    admissionGuard?.();
    if (sourceSnapshotIds) {
      if (
        Object.keys(sourceSnapshotIds).length !== sourceUserIds.length ||
        sourceUserIds.some((id) => !Object.hasOwn(sourceSnapshotIds, id))
      )
        throw new ServiceError('Database captures must cover exactly the selected users.');
      await this.withClient(settings, 'emby', async (client) => {
        const info = await client.systemInfo();
        if (info.Version !== '4.10.1.0' || typeof info.Id !== 'string')
          throw new ServiceError('Emby version or identity changed. Review a new preview.');
        for (const id of sourceUserIds)
          await this.sourceSnapshots.select(id, settings, info.Id, sourceSnapshotIds[id]);
      });
      admissionGuard?.();
    }
    if (
      historyOnlyTargets &&
      Object.keys(historyOnlyTargets).some((id) => !sourceUserIds.includes(id))
    )
      throw new ServiceError('History-only targets must belong to selected source users.');
    const recipientSlots = new Set<string>();
    const requests = sourceUserIds.map((id): JobRequest => {
      const mapping = this.mappings.getForSource(id, settings);
      if (expectedMappingRevisions && expectedMappingRevisions[id] !== (mapping?.revision ?? null))
        throw new ServiceError(
          'The user mapping changed after preview. Review a new preview before migrating.',
        );
      const household = reviewedOwners[id];
      const recipient = Object.hasOwn(discordRecipients, id)
        ? discordRecipients[id]
        : household?.discord_user_id;
      if (
        household &&
        (recipient !== household.discord_user_id ||
          (mapping?.discord_user_id && (mapping.membership_slot ?? 1) !== household.slot))
      )
        throw new ServiceError(
          'The household recipient or slot differs from the approved review. Save a user mapping for exceptions.',
        );
      const historyOnly = historyOnlyTargets?.[id];
      if (historyOnly && recipient)
        throw new ServiceError(
          'History-only migration cannot send credentials or change Discord ownership.',
        );
      const registeredOwner = registeredSources.find(
        (owner) => owner.account_id === id && owner.server_id === ownershipServerId,
      );
      const slot = mapping?.discord_user_id
        ? (mapping.membership_slot ?? 1)
        : (registeredOwner?.slot ?? household?.slot ?? mapping?.membership_slot ?? 1);
      if (
        !historyOnly &&
        registeredOwner &&
        ((recipient && recipient !== registeredOwner.discord_user_id) ||
          (mapping?.discord_user_id &&
            mapping.discord_user_id !== registeredOwner.discord_user_id) ||
          slot !== registeredOwner.slot)
      )
        throw new ServiceError(
          'The selected recipient or mapping differs from this Emby account’s approved owner or slot.',
        );
      const member = recipient ? this.memberships.get(recipient, settings) : null;
      if (recipient) {
        const slotKey = `${recipient}:${slot}`;
        if (recipientSlots.has(slotKey))
          throw new ServiceError(
            'Choose a different Discord recipient or approved membership slot for each account.',
          );
        recipientSlots.add(slotKey);
        if (slot > 1) {
          const member = this.memberships.get(recipient, settings);
          if (!member?.active || slot > member.account_limit)
            throw new ServiceError(
              'Assign an active membership tier covering this account slot before migrating.',
            );
        }
      }
      if (recipient && mapping?.discord_user_id && mapping.discord_user_id !== recipient)
        throw new ServiceError(
          'The selected Discord recipient differs from this approved user mapping.',
        );
      return {
        migration_scope: scope,
        ...(historyOnly ? { history_only_target: structuredClone(historyOnly) } : {}),
        ...(sourceSnapshotIds ? { source_snapshot_id: sourceSnapshotIds[id] } : {}),
        source_user_id: id,
        source_ownership: {
          ...(ownershipServerId ? { server_id: ownershipServerId } : {}),
          identity_hash: this.ownershipHash(registeredOwner ?? null),
        },
        discord_user_id: recipient,
        membership_slot: slot,
        ...(member ? { membership_revision: member.revision } : {}),
        ...(mapping
          ? {
              username: mapping.target_username,
              mapping_id: mapping.id,
              mapping_revision: mapping.revision,
            }
          : {}),
      };
    });
    const registeredMappingApprovals: Record<
      string,
      Omit<ReviewedHouseholdAccount, 'discord_username'>
    > = {};
    for (const request of requests) {
      const id = request.source_user_id!;
      if (explicitOwners[id] || request.history_only_target || !request.discord_user_id) continue;
      const mapping = this.requestMapping(request, settings);
      const owner = registeredSources.find(
        (entry) => entry.account_id === id && entry.server_id === ownershipServerId,
      );
      if (
        mapping &&
        !mapping.discord_user_id &&
        owner?.discord_user_id === request.discord_user_id &&
        owner.slot === request.membership_slot
      ) {
        const proof = {
          source_username: owner.username,
          server_id: owner.server_id,
          discord_user_id: owner.discord_user_id,
          slot: owner.slot,
        };
        registeredMappingApprovals[id] = proof;
        reviewedOwners[id] = proof;
      }
    }
    if (Object.keys(registeredMappingApprovals).length) {
      await this.withClient(settings, 'emby', async (client) => {
        const info = await client.systemInfo();
        admissionGuard?.();
        for (const [id, proof] of Object.entries(registeredMappingApprovals)) {
          const user = await client.user(id);
          admissionGuard?.();
          if (info.Id !== proof.server_id || user.Id !== id || user.Name !== proof.source_username)
            throw new ServiceError(
              'The approved source account changed. Prepare a new mapping review.',
            );
        }
      });
      admissionGuard?.();
    }
    const mappingOwnerTargets = { ...explicitOwners, ...registeredMappingApprovals };
    await this.validateRecipients([
      ...new Set(
        requests.flatMap((request) => (request.discord_user_id ? [request.discord_user_id] : [])),
      ),
    ]);
    admissionGuard?.();
    // Manually selected account names need exact source ownership approval;
    // never derive their Discord identity by stripping a suffix or matching a name.
    const explicitOwnerNames = new Map<string, string>();
    for (const discordId of new Set(
      Object.values(mappingOwnerTargets).map((proof) => proof.discord_user_id),
    )) {
      const identity = await this.requireBot().recipientIdentity(discordId, false);
      admissionGuard?.();
      if (identity.id !== discordId)
        throw new ServiceError('Discord returned a different reviewed account owner.');
      explicitOwnerNames.set(discordId, identity.username);
    }
    const explicitTargets = new Map<
      string,
      { serverId: string; accountId: string | null; username: string }
    >();
    if (Object.keys(mappingOwnerTargets).length)
      await this.withClient(settings, 'jellyfin', async (client) => {
        const info = await client.systemInfo();
        admissionGuard?.();
        const auth = this.store.authState();
        if (
          typeof info.Id !== 'string' ||
          !info.Id ||
          (auth?.kind === 'configured' && auth.serverId !== info.Id)
        )
          throw new ServiceError('The Jellyfin server changed. Prepare a new account review.');
        const template = await this.template(client, settings);
        admissionGuard?.();
        const targets = await client.users();
        admissionGuard?.();
        for (const [id, proof] of Object.entries(mappingOwnerTargets)) {
          const mapping = this.mappings.getForSource(id, settings);
          const username = mapping?.target_username ?? proof.source_username;
          const target = this.mappedTarget(targets, mapping, username, settings);
          if (
            target &&
            (target.Id === template.Id ||
              target.Id === settings.template_user_id ||
              target.Policy?.IsAdministrator !== false ||
              target.Policy?.IsDisabled !== false)
          )
            throw new ServiceError(
              'A protected, disabled or unverifiable Jellyfin account cannot receive a new owner. Prepare a history-only review instead.',
            );
          explicitTargets.set(id, {
            serverId: info.Id,
            accountId: target?.Id ?? null,
            username,
          });
        }
      });
    admissionGuard?.();
    const assertExplicitTargetSlots = () => {
      const owners = this.mediaOwnerships.list(settings);
      for (const [id, target] of explicitTargets) {
        const proof = mappingOwnerTargets[id]!;
        const reserved = owners.find(
          (owner) =>
            owner.kind === 'jellyfin' &&
            owner.server_id === target.serverId &&
            owner.discord_user_id === proof.discord_user_id &&
            owner.slot === proof.slot,
        );
        const link = this.store.link(proof.discord_user_id, proof.slot);
        if (
          (reserved &&
            (reserved.account_id !== target.accountId || reserved.username !== target.username)) ||
          (link && (link.remote_id !== target.accountId || link.username !== target.username))
        )
          throw new ServiceError(
            'This owner already has a different Jellyfin account in the selected slot. Review its identity mapping first.',
          );
      }
    };
    // Preflight may await media or Discord reads. Queueing must use the same
    // configuration that was reviewed, rather than adopting a concurrent edit.
    if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
      throw new ServiceError(
        'Configuration changed during migration preparation. Prepare a new review.',
      );
    if (!ownershipServerId && confirmsMigrationOwner) {
      ownershipServerId = await readOwnershipServerId();
      admissionGuard?.();
      if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
        throw new ServiceError(
          'Configuration changed during migration preparation. Prepare a new review.',
        );
      for (const request of requests)
        request.source_ownership = {
          ...request.source_ownership,
          server_id: ownershipServerId,
          identity_hash: request.source_ownership?.identity_hash ?? null,
        };
    }
    for (const request of requests)
      if (ownershipServerId) this.sourceOwnership(request, settings, ownershipServerId);
    const allOwners = this.mediaOwnerships.list(settings);
    const approved: Omit<MediaOwnership, 'scope' | 'approved_at'>[] = [];
    for (const request of requests) {
      this.requestMapping(request, settings);
      this.assertMembershipRequest(request, settings);
    }
    for (const [id, proof] of Object.entries(reviewedOwners)) {
      const mapping = this.mappings.getForSource(id, settings);
      if (
        proof.server_id !== ownershipServerId ||
        (mapping &&
          ((!explicitOwners[id] && !registeredMappingApprovals[id]) ||
            mapping.source_username !== proof.source_username ||
            (mapping.discord_user_id && mapping.discord_user_id !== proof.discord_user_id) ||
            (mapping.discord_user_id && (mapping.membership_slot ?? 1) !== proof.slot)))
      )
        throw new ServiceError(
          'The household identity changed. Review a new preview or its explicit mapping.',
        );
      if (
        allOwners.some(
          (owner) =>
            owner.kind === 'emby' &&
            owner.server_id === proof.server_id &&
            ((owner.account_id === id &&
              (owner.discord_user_id !== proof.discord_user_id || owner.slot !== proof.slot)) ||
              (owner.discord_user_id === proof.discord_user_id &&
                owner.slot === proof.slot &&
                owner.account_id !== id)),
        )
      )
        throw new ServiceError(
          'This household account slot already has another approved source. Review its mapping.',
        );
      approved.push({
        kind: 'emby',
        server_id: proof.server_id,
        account_id: id,
        username: proof.source_username,
        discord_user_id: proof.discord_user_id,
        slot: proof.slot,
      });
    }
    // Ownership approval and the queued work are one local commit. Queue
    // preparation and persistence failures must not leave half an approval.
    // Later media failures retain this explicit administrator decision.
    try {
      return this.queue(
        'migrate',
        requests,
        requestedAt,
        previewTiming,
        approved.length
          ? (queuedRequests) => {
              admissionGuard?.();
              if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
                throw new ServiceError(
                  'Configuration changed during migration preparation. Prepare a new review.',
                );
              for (const request of queuedRequests) {
                this.requestMapping(request, settings);
                this.assertMembershipRequest(request, settings);
                if (ownershipServerId) this.sourceOwnership(request, settings, ownershipServerId);
              }
              assertExplicitTargetSlots();
              const additions = approved.flatMap((record) => {
                const target = explicitTargets.get(record.account_id);
                return this.migrationIdentityAdditions(
                  [
                    record,
                    ...(target?.accountId
                      ? [
                          {
                            kind: 'jellyfin' as const,
                            server_id: target.serverId,
                            account_id: target.accountId,
                            username: target.username,
                            discord_user_id: record.discord_user_id,
                            slot: record.slot,
                          },
                        ]
                      : []),
                  ],
                  settings,
                ).filter((addition) => addition.kind === 'emby');
              });
              this.mediaOwnerships.save(additions, settings);
              for (const request of queuedRequests) {
                const proof = reviewedOwners[request.source_user_id ?? ''];
                if (!proof) continue;
                const mapping = this.requestMapping(request, settings);
                if (
                  mappingOwnerTargets[request.source_user_id!] &&
                  mapping &&
                  !mapping.discord_user_id
                ) {
                  const updated = this.mappings.confirmMigrationOwner(
                    mapping.id,
                    mapping.revision,
                    proof.discord_user_id,
                    explicitOwnerNames.get(proof.discord_user_id)!,
                    proof.slot,
                    settings,
                  );
                  request.mapping_revision = updated.revision;
                }
                const owner = this.mediaOwnerships.get(
                  'emby',
                  proof.server_id,
                  request.source_user_id!,
                  settings,
                );
                if (!owner)
                  throw new ServiceError('The reviewed account ownership could not be saved.');
                request.source_ownership = {
                  server_id: proof.server_id,
                  identity_hash: this.ownershipHash(owner),
                };
              }
            }
          : undefined,
      );
    } catch (error) {
      // A later write can roll back a mapping after an earlier guard populated
      // its decrypted cache. Never expose that rolled-back owner or revision.
      this.mappings.invalidateCache();
      throw error;
    }
  }
  private async requireRoleServer(client: MediaAPI, role: AccountRole): Promise<void> {
    const info = await client.systemInfo();
    this.checkStopped();
    if (info.Id !== role.server_id)
      throw new ServiceError(
        'The Jellyfin server identity changed. No role settings were applied.',
      );
  }
  private assertDefaultRole(
    template: ProvisioningDefaults,
    request: JobRequest,
    settings: Settings,
  ): void {
    const role = template.accountRole;
    const current = this.store.settings();
    if ((current.default_role_id || '') !== (settings.default_role_id || ''))
      throw new ServiceError('The default account role changed. Review and start a new job.');
    if (!role) {
      if (request.default_role_revision)
        throw new ServiceError('The default account role changed. Review a new job.');
      return;
    }
    if (
      current.default_role_id !== role.id ||
      settings.default_role_id !== role.id ||
      request.default_role_revision !== role.revision ||
      this.roles.get(role.id, current)?.revision !== role.revision
    )
      throw new ServiceError('The default account role changed. Review and start a new job.');
  }
  private assertRoleUpdate(
    request: JobRequest,
    settings: Settings,
  ): { role: AccountRole; assignment: RoleAssignment } {
    this.checkStopped();
    const current = this.store.settings();
    if (current.jellyfin_url !== settings.jellyfin_url)
      throw new ServiceError('The Jellyfin destination changed. Review this role update.');
    const role = this.roles.get(request.role_id || '', settings);
    const assignment = this.roles.getAssignment(request.target_user_id || '', settings);
    if (
      !role ||
      role.revision !== request.role_revision ||
      !assignment ||
      assignment.role_id !== role.id ||
      assignment.revision !== request.role_assignment_revision ||
      assignment.username !== request.username
    )
      throw new ServiceError(
        'The role or account assignment changed. Review a new update before applying.',
      );
    return { role, assignment };
  }
  private assertRoleTarget(
    user: MediaUser,
    expectedId: string,
    expectedName: string,
    settings: Settings,
  ): void {
    if (
      user.Id !== expectedId ||
      user.Name !== expectedName ||
      user.Policy?.IsAdministrator !== false ||
      user.Policy?.IsDisabled !== false ||
      user.Id === settings.template_user_id ||
      user.Id === this.store.settings().template_user_id
    )
      throw new ServiceError(
        'The Jellyfin account changed or is protected. No further role settings were applied.',
      );
  }
  async applyRole(
    roleId: string,
    roleRevision: string,
    userIds: string[],
    sections: RoleSection[],
  ): Promise<Job> {
    if (
      !userIds.length ||
      userIds.length > 100 ||
      new Set(userIds).size !== userIds.length ||
      userIds.some((id) => typeof id !== 'string' || !id || id.length > 128) ||
      !sections.length ||
      sections.length > 3 ||
      new Set(sections).size !== sections.length ||
      sections.some((section) => !['policy', 'configuration', 'display'].includes(section))
    )
      throw new ServiceError(
        'Select 1–100 distinct assigned accounts and one or more settings groups.',
      );
    const settings = this.store.settings();
    const role = this.roles.get(roleId, settings);
    if (!role || role.revision !== roleRevision)
      throw new ServiceError('This account role changed. Reload it before applying.');
    if (sections.includes('display') && role.parameters.display === null)
      throw new ServiceError('This role has no Home screen preferences.');
    return this.withClient(settings, 'jellyfin', async (client) => {
      await this.requireRoleServer(client, role);
      if (
        sections.includes('display') &&
        (!client.displayPreferences || !client.setDisplayPreferences)
      )
        throw new ServiceError('This Jellyfin client cannot update Home screen preferences.');
      const requests: JobRequest[] = [];
      for (const userId of userIds) {
        const assignment = this.roles.getAssignment(userId, settings);
        if (!assignment || assignment.role_id !== role.id)
          throw new ServiceError(
            'Assign this role to every selected account before applying settings.',
          );
        const user = await client.user(userId);
        this.assertRoleTarget(user, userId, assignment.username, settings);
        const request: JobRequest = {
          username: user.Name,
          target_user_id: user.Id,
          role_id: role.id,
          role_revision: role.revision,
          role_assignment_revision: assignment.revision,
          role_sections: [...sections],
        };
        this.assertRoleUpdate(request, settings);
        requests.push(request);
      }
      for (const request of requests) this.assertRoleUpdate(request, settings);
      return this.queue('role_update', requests);
    });
  }
  private async oneRoleUpdate(
    job: Job,
    request: JobRequest,
    settings: Settings,
    client: MediaAPI,
  ): Promise<void> {
    const result: JobResult = {
      username: request.username || '',
      status: 'running',
      target_user_id: request.target_user_id,
      role_id: request.role_id,
      role_sections: [],
    };
    job.results.push(result);
    this.save(job);
    const check = () => {
      this.checkJobStopped(job);
      this.assertConnections(settings);
      return this.assertRoleUpdate(request, settings);
    };
    try {
      const { role } = check();
      result.role_name = role.name;
      if (
        !request.role_sections?.length ||
        request.role_sections.length > 3 ||
        new Set(request.role_sections).size !== request.role_sections.length ||
        request.role_sections.some(
          (section) => !['policy', 'configuration', 'display'].includes(section),
        )
      )
        throw new ServiceError('The queued role update is invalid. Review a new update.');
      for (const section of request.role_sections) {
        await this.requireRoleServer(client, role);
        check();
        const user = await client.user(request.target_user_id!);
        check();
        this.assertRoleTarget(user, request.target_user_id!, request.username!, settings);
        if (section === 'display') {
          if (
            role.parameters.display === null ||
            !client.displayPreferences ||
            !client.setDisplayPreferences
          )
            throw new ServiceError(
              'Home screen preferences are unavailable for this role or server.',
            );
          const current = await client.displayPreferences(user.Id);
          const confirmed = await client.user(user.Id);
          check();
          this.assertRoleTarget(confirmed, user.Id, user.Name, settings);
          await client.setDisplayPreferences(
            user.Id,
            mergeRoleSection('display', current, role.parameters),
          );
        } else if (section === 'policy') {
          await client.setPolicy(user.Id, mergeRoleSection(section, user.Policy!, role.parameters));
        } else {
          await client.setConfiguration(
            user.Id,
            mergeRoleSection(section, user.Configuration ?? {}, role.parameters),
          );
        }
        // A completed remote write remains part of the result even if a local role
        // edit prevents us from stamping the assignment as current afterwards.
        result.role_sections!.push(section);
        this.save(job);
        const { assignment } = check();
        this.roles.markApplied(user.Id, role.id, role.revision, assignment.revision, settings, [
          section,
        ]);
      }
      result.status = 'completed';
    } catch (error) {
      if (error instanceof StoppedError) throw error;
      result.status = 'failed';
      result.error =
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'Role settings could not be fully applied. Review completed groups before retrying.';
    }
    this.save(job);
  }
  private queue(
    kind: string,
    requests: JobRequest[],
    requestedAt?: string,
    previewTiming?: Job['preview_timing'],
    beforePersist?: (requests: JobRequest[]) => void,
  ): Job {
    if (this.stopping) throw new ServiceError('The app is stopping. Retry after it restarts.');
    const owners = this.mediaOwnerships.list(this.store.settings());
    requests = requests.map((request) => {
      if (!request.source_user_id || request.source_ownership !== undefined) return request;
      const candidates = owners.filter(
        (owner) => owner.kind === 'emby' && owner.account_id === request.source_user_id,
      );
      if (candidates.length > 1)
        throw new ServiceError(
          'Verify this Emby account’s current server ownership before queueing migration.',
        );
      const owner = candidates[0] ?? null;
      return {
        ...request,
        source_ownership: {
          ...(owner ? { server_id: owner.server_id } : {}),
          identity_hash: this.ownershipHash(owner),
        },
      };
    });
    requests = requests.map((request) =>
      request.source_user_id
        ? { ...request, migration_scope: migrationScope(request.migration_scope) }
        : request,
    );
    const timestamp = now();
    const job: Job = {
      id: randomUUID().replaceAll('-', ''),
      kind,
      status: 'queued',
      created_at: requestedAt ?? timestamp,
      updated_at: timestamp,
      progress: { processed: 0, total: requests.length },
      results: [],
      ...(previewTiming ? { preview_timing: structuredClone(previewTiming) } : {}),
      ...(requests.some((request) => request.source_snapshot_id)
        ? {
            source_snapshot_ids: Object.fromEntries(
              requests
                .filter((request) => request.source_snapshot_id && request.source_user_id)
                .map((request) => [request.source_user_id!, request.source_snapshot_id!]),
            ),
          }
        : {}),
      ...(kind === 'migrate' ? { migration_scope: 'watched_only' } : {}),
      ...(kind === 'membership'
        ? { membership_discord_user_id: requests[0]?.discord_user_id ?? undefined }
        : {}),
    };
    const settings = this.store.settings();
    if (requests.some((request) => request.source_user_id))
      job.destination_catalog_id = this.destinationSnapshots.queuedSelection(settings);
    if (
      kind !== 'role_update' &&
      kind !== 'clone' &&
      requests.some((request) => request.access_disabled === undefined) &&
      settings.default_role_id
    ) {
      const role = this.roles.get(settings.default_role_id, settings);
      if (!role)
        throw new ServiceError('The default account role is unavailable. Review Settings.');
      requests = requests.map((request) =>
        request.history_only_target
          ? request
          : { ...request, default_role_revision: role.revision },
      );
    }
    if (beforePersist)
      this.store.saveQueuedJob(job, requests, settings, () => beforePersist(requests));
    else this.store.saveQueuedJob(job, requests, settings);
    this.schedule(job, requests, settings);
    return structuredClone(job);
  }
  private schedule(job: Job, requests: JobRequest[], settings: Settings): void {
    if (this.jobTasks.has(job.id)) return;
    this.jobControllers.set(job.id, new AbortController());
    const controller = this.jobControllers.get(job.id)!;
    const task = Promise.resolve()
      .then(() =>
        requests.some((request) => request.source_user_id || request.clone_source)
          ? this.migrationMutex.run(() => this.run(job, requests, settings), controller.signal)
          : this.run(job, requests, settings),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    this.jobTasks.set(job.id, task);
    void task
      .finally(() => {
        this.jobTasks.delete(job.id);
        this.jobControllers.delete(job.id);
        this.activeJobs.delete(job.id);
      })
      .catch(() => {});
  }
  getJob(id: string): Job {
    const job = this.store.job(id);
    if (!job) throw new ServiceError('Job not found.');
    return job;
  }
  /** Clear only the reviewed local reports; never mutate accounts or media-server state. */
  clearJobHistory(jobIds: string[]): JobHistoryCleanupResult {
    if (
      !Array.isArray(jobIds) ||
      !jobIds.length ||
      jobIds.length > MAX_JOB_HISTORY_CLEANUP ||
      new Set(jobIds).size !== jobIds.length ||
      jobIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    )
      throw new ServiceError('Choose between 1 and 1000 distinct activity reports.');
    // No await separates this guard from the synchronous database transaction. A job
    // remains protected through its final save and task/controller cleanup, including
    // a canceled job that already displays a terminal status while still unwinding.
    return this.store.clearJobHistory(jobIds, this.protectedJobIds());
  }
  private protectedJobIds(): Set<string> {
    return new Set([
      ...this.jobTasks.keys(),
      ...this.jobControllers.keys(),
      ...this.activeJobs.keys(),
    ]);
  }
  jobRetentionStatus(): JobRetentionStatus {
    const days = this.store.jobRetentionDays();
    if (days !== this.retentionDays) {
      this.retentionDays = days;
      this.retentionCursor = null;
      this.retentionLastRun = { last_run_at: null, last_removed: 0, last_kept: 0, error: null };
    }
    return {
      retention_days: days,
      interval_seconds: JOB_RETENTION_INTERVAL_SECONDS,
      batch_limit: JOB_RETENTION_BATCH_LIMIT,
      ...this.retentionLastRun,
    };
  }
  setJobRetention(days: number): JobRetentionStatus {
    validateActivityRetentionDays(days);
    if (this.demo) throw new ServiceError('Demo activity retention is read-only.');
    // Retention policy is independent operational configuration: changing it must
    // not invalidate reviewed migrations or settings captured by active jobs.
    this.store.saveJobRetentionDays(days);
    return this.jobRetentionStatus();
  }
  runJobRetention(now = Date.now()): JobRetentionStatus {
    const status = this.jobRetentionStatus();
    if (this.stopping || this.demo || !status.retention_days) return status;
    try {
      const runAt = new Date(now).toISOString();
      const cutoff = now - status.retention_days * 86_400_000;
      let candidates = this.store.jobRetentionCandidates(
        cutoff,
        this.retentionCursor,
        JOB_RETENTION_BATCH_LIMIT,
      );
      if (!candidates.length && this.retentionCursor) {
        this.retentionCursor = null;
        candidates = this.store.jobRetentionCandidates(cutoff, null, JOB_RETENTION_BATCH_LIMIT);
      }
      const result = candidates.length
        ? this.store.clearJobHistory(
            candidates.map((item) => item.id),
            this.protectedJobIds(),
            { cutoff, now },
          )
        : { removed_ids: [], skipped: [] };
      // Advance past protected records too. A fixed oldest batch must never starve
      // later eligible reports; after exhaustion, revisit those guards next cycle.
      this.retentionCursor =
        candidates.length === JOB_RETENTION_BATCH_LIMIT ? candidates.at(-1)! : null;
      this.retentionLastRun = {
        last_run_at: runAt,
        last_removed: result.removed_ids.length,
        last_kept: result.skipped.length,
        error: null,
      };
    } catch {
      // Keep the cursor unchanged on failure so an atomic batch can be retried.
      // Neither status nor logs expose SQL errors, report identities or diagnostics.
      this.retentionLastRun = {
        last_run_at:
          Number.isFinite(now) && Math.abs(now) <= 8_640_000_000_000_000
            ? new Date(now).toISOString()
            : null,
        last_removed: 0,
        last_kept: 0,
        error:
          'Automatic activity cleanup could not finish. It will retry on the next scheduled pass.',
      };
    }
    return this.jobRetentionStatus();
  }
  cancelJob(id: string): Job {
    const job = this.getJob(id);
    if (!['queued', 'running'].includes(job.status)) return job;
    const queued = this.store.cancelQueuedJob(id);
    if (queued) {
      this.jobControllers.get(id)?.abort(new CanceledError('Job canceled.'));
      return queued;
    }
    const active = this.activeJobs.get(id) ?? job;
    active.cancel_requested = true;
    if (active.status === 'queued') {
      active.status = 'canceled';
      active.finished_at = now();
      active.error = 'Canceled before account work began.';
    }
    this.save(active);
    this.jobControllers.get(id)?.abort(new CanceledError('Job canceled.'));
    return structuredClone(active);
  }
  private save(job: Job): void {
    job.updated_at = now();
    this.store.saveJob(job);
  }
  private async provision(
    jellyfin: MediaAPI,
    settings: Settings,
    template: ProvisioningDefaults,
    username: string,
    allowExisting: boolean,
    recoverTargetId?: string,
    mapping: UserMapping | null = null,
    guard: () => void = () => {},
    beforeConfigure?: (target: MediaUser) => Promise<void>,
    deferActivation = false,
    freshAccountOnly = false,
    beforeCreate?: () => Promise<void>,
  ): Promise<[MediaUser, boolean, string | null]> {
    const roleGuard = async () => {
      if (template.accountRole) await this.requireRoleServer(jellyfin, template.accountRole);
      guard();
    };
    let target = this.mappedTarget(
      await jellyfin.users(),
      mapping,
      username,
      settings,
      recoverTargetId,
    );
    guard();
    if (freshAccountOnly && target)
      throw new ServiceError(
        'An existing Jellyfin account appeared. Review its identity manually.',
      );
    const local = this.store.account(username);
    if (['clone_uncertain', 'clone_incomplete'].includes(local?.status ?? '') && !deferActivation)
      throw new ServiceError(
        'This account is an incomplete clone. Default account recovery cannot replace its restrictions. Inspect it in Jellyfin before continuing.',
      );
    if (target?.Id === template.Id || (target && target.Id === settings.template_user_id))
      throw new ServiceError('The template account cannot be a destination account.');
    if (target?.Policy?.IsAdministrator)
      throw new ServiceError('A Jellyfin administrator cannot be a destination account.');
    if (target?.Policy?.IsDisabled && !recoverTargetId)
      throw new ServiceError('A disabled Jellyfin account cannot be a migration destination.');
    if (target && template.accountRole && (recoverTargetId || local?.status === 'provisioning')) {
      await roleGuard();
      const confirmed = await jellyfin.user(target.Id);
      guard();
      this.assertRoleTarget(confirmed, target.Id, username, settings);
      const assignment = this.roles.getAssignment(target.Id, settings);
      if (assignment && assignment.role_id !== template.accountRole.id)
        throw new ServiceError(
          'The account has a different role assignment. Review it before recovering account defaults.',
        );
    }
    let password: string | null = null;
    const preparedPassword = (value: string) => {
      // Reject an unusable configured message before any account/password mutation.
      accountCredentialMessage(settings, username, value);
      return value;
    };
    if (recoverTargetId) {
      if (
        !target ||
        target.Id !== recoverTargetId ||
        !local ||
        !['uncertain', 'provisioning'].includes(local.status) ||
        (local.remote_id && local.remote_id !== target.Id)
      )
        throw new ServiceError(
          'Recovery target changed. Inspect the account again; no password was reset.',
        );
      password = preparedPassword(this.store.accountPassword(local) ?? generatePassword(settings));
      this.store.saveAccount(
        username,
        target.Id,
        deferActivation ? 'clone_incomplete' : 'provisioning',
        password,
      );
      await roleGuard();
      await jellyfin.setPassword(target.Id, password);
    }
    if (target) {
      if (recoverTargetId) {
        /* Explicit inspected recovery already reset this tracked account. */
      } else if (local && local.remote_id === target.Id && local.status === 'provisioning') {
        password = preparedPassword(
          this.store.accountPassword(local) ?? generatePassword(settings),
        );
        await roleGuard();
        await jellyfin.setPassword(target.Id, password);
      } else if (allowExisting) return [target, false, null];
      else
        throw new ServiceError(
          'This Jellyfin username already exists. Its password and permissions were preserved. Use migration to merge watch history.',
        );
    } else {
      if (['uncertain', 'clone_uncertain', 'clone_incomplete'].includes(local?.status ?? ''))
        throw new ServiceError(
          'An earlier creation request had an uncertain outcome. Inspect Jellyfin before retrying this username.',
        );
      password = preparedPassword(generatePassword(settings));
      await roleGuard();
      await beforeCreate?.();
      guard();
      // Persist before the POST: a process exit between sending the request and receiving
      // its response must require inspection, rather than replaying account creation.
      this.store.saveAccount(
        username,
        null,
        deferActivation ? 'clone_uncertain' : 'uncertain',
        password,
      );
      try {
        target = await jellyfin.createUser(username, password);
      } catch (error) {
        if (error instanceof MediaError && [401, 403].includes(error.statusCode ?? 0)) {
          this.store.saveAccount(username, null, 'rejected');
          throw error;
        }
        this.store.saveAccount(
          username,
          null,
          deferActivation ? 'clone_uncertain' : 'uncertain',
          password,
        );
        throw new ServiceError(
          'Account creation outcome is uncertain. Inspect Jellyfin before retrying; no password was reset.',
        );
      }
      this.store.saveAccount(
        username,
        target.Id,
        deferActivation ? 'clone_incomplete' : 'provisioning',
        password,
      );
    }
    guard();
    await beforeConfigure?.(target);
    guard();
    if (template.accountRole) {
      await roleGuard();
      const live = await jellyfin.user(target.Id);
      guard();
      this.assertRoleTarget(live, target.Id, username, settings);
      await jellyfin.setPolicy(
        target.Id,
        mergeRoleSection('policy', live.Policy ?? {}, template.accountRole.parameters),
      );
      await roleGuard();
      const configured = await jellyfin.user(target.Id);
      guard();
      this.assertRoleTarget(configured, target.Id, username, settings);
      await jellyfin.setConfiguration(
        target.Id,
        mergeRoleSection(
          'configuration',
          configured.Configuration ?? {},
          template.accountRole.parameters,
        ),
      );
    } else {
      const policy = templatePolicy(template);
      if (deferActivation) policy.IsDisabled = true;
      await jellyfin.setPolicy(target.Id, policy);
      guard();
      await jellyfin.setConfiguration(target.Id, structuredClone(template.Configuration ?? {}));
    }
    return [target, true, password];
  }
  private async oneClone(
    job: Job,
    request: JobRequest,
    settings: Settings,
    jellyfin: MediaAPI,
    context: { source?: MediaItem[]; key?: string },
  ): Promise<void> {
    const pin = request.clone_source!;
    const username = request.username!;
    const guard = () => {
      this.checkJobStopped(job);
      this.assertConnections(settings);
    };
    const phase = (value: NonNullable<Job['progress']['phase']>) => {
      job.progress.phase = value;
      this.save(job);
    };
    const sourceGuard = async (full = false) => {
      guard();
      if ((await jellyfin.systemInfo()).Id !== pin.server_id)
        throw new ServiceError('The Jellyfin server changed. No further clone work was started.');
      const source = await jellyfin.user(pin.source_user_id);
      this.assertCloneSource(source, pin, settings);
      if (full) {
        const fresh = await this.reviewedCloneSource(jellyfin, pin, settings);
        if (fresh.parameters_hash !== pin.parameters_hash || fresh.server_id !== pin.server_id)
          throw new ServiceError(
            'The source account settings changed. Prepare a new clone review.',
          );
      }
      guard();
    };
    job.progress.current_user = username;
    phase('reading_source');
    await sourceGuard(true);
    if (!jellyfin.clonePlayedItems || !jellyfin.destinationItems)
      throw new ServiceError('This Jellyfin integration cannot perform bounded account cloning.');
    const sourceKey = JSON.stringify([pin.server_id, pin.source_user_id, pin.parameters_hash]);
    if (context.key && context.key !== sourceKey)
      throw new ServiceError('The clone source changed during this job. Review it again.');
    if (!context.source) {
      try {
        const items = await jellyfin.clonePlayedItems(pin.source_user_id);
        guard();
        const ids = new Set<string>();
        let bytes = 0;
        context.source = items.map((item) => {
          if (
            !item.Id ||
            ids.has(item.Id) ||
            item.UserData?.Played !== true ||
            ![
              'Movie',
              'Episode',
              'Audio',
              'MusicVideo',
              'Video',
              'Book',
              'AudioBook',
              'Trailer',
            ].includes(item.Type ?? '')
          )
            throw new ServiceError('The account clone source history could not be verified.');
          ids.add(item.Id);
          const value = { ...item, UserData: { Played: true } };
          delete value.SeriesProviderIds; // Same-server exact IDs need no derived cross-server series aliases.
          bytes += Buffer.byteLength(JSON.stringify(value));
          if (ids.size > 100_000 || bytes > 32 * 1024 * 1024)
            throw new ServiceError('The account clone source history exceeds its supported size.');
          return value;
        });
        context.key = sourceKey;
      } catch (error) {
        guard();
        throw new SourcePreparationError(
          error instanceof MediaError || error instanceof ServiceError
            ? error.message
            : 'Clone source history could not be prepared. No account was created.',
        );
      }
    }
    await sourceGuard(true);
    await this.assertNewCloneNames(jellyfin, [username], settings);
    const sourceItems = context.source;
    const result: JobResult = {
      username,
      status: 'running',
      created: false,
      applied: 0,
      cloned_from_user_id: pin.source_user_id,
      cloned_from_username: pin.source_username,
      source_username: pin.source_username,
      source_played: sourceItems.length,
      source_items: sourceItems.length,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      already_played: 0,
      discord_delivery: 'not_requested',
      data: migrationDetails(),
      warnings: [...pin.warnings],
    };
    job.results.push(result);
    this.save(job);
    let destinationId: string | undefined;
    let activated = false;
    const targetGuard = async () => {
      await sourceGuard();
      const target = await jellyfin.user(destinationId!);
      if (
        target.Id !== destinationId ||
        target.Name !== username ||
        target.Policy?.IsAdministrator !== false ||
        target.Policy.IsDisabled !== !activated ||
        target.Id === settings.template_user_id ||
        target.Id === this.store.settings().template_user_id ||
        target.Id === pin.source_user_id
      )
        throw new ServiceError('The clone destination is not a new independent account.');
      guard();
    };
    try {
      phase('preparing_account');
      const [target, created, password] = await this.provision(
        jellyfin,
        settings,
        {
          Id: pin.source_user_id,
          Name: pin.source_username,
          Policy: { ...structuredClone(pin.parameters.policy), IsDisabled: false },
          Configuration: structuredClone(pin.parameters.configuration),
        },
        username,
        false,
        undefined,
        null,
        guard,
        async (createdTarget) => {
          destinationId = createdTarget.Id;
          const newAccount = await jellyfin.user(createdTarget.Id);
          this.assertRoleTarget(newAccount, createdTarget.Id, username, settings);
          if (newAccount.Id === pin.source_user_id)
            throw new ServiceError('The clone destination is not a new independent account.');
          result.created = true;
          result.target_user_id = newAccount.Id;
          this.save(job);
          await jellyfin.setPolicy(newAccount.Id, {
            ...structuredClone(pin.parameters.policy),
            IsDisabled: true,
          });
          await targetGuard();
          await sourceGuard(true);
        },
        true,
      );
      destinationId = target.Id;
      result.created = created;
      result.target_user_id = target.Id;
      if (!created || !password)
        throw new ServiceError('The clone did not create an independent account.');
      const publicUrl = settings.jellyfin_public_url || settings.jellyfin_url;
      if (!request.clone_profile)
        throw new ServiceError('The reviewed account profile is unavailable.');
      await targetGuard();
      this.profiles.save(
        { kind: 'jellyfin', user_id: target.Id, ...request.clone_profile },
        settings,
        '',
      );
      if (pin.parameters.display !== null) {
        if (!jellyfin.displayPreferences || !jellyfin.setDisplayPreferences)
          throw new ServiceError(
            'Shared Home screen preferences could not be copied. The new account and credentials were preserved.',
          );
        const display = await jellyfin.displayPreferences(target.Id);
        await targetGuard();
        await jellyfin.setDisplayPreferences(
          target.Id,
          mergeRoleSection('display', display, pin.parameters),
        );
      }
      await targetGuard();
      const configured = await jellyfin.user(target.Id);
      const display =
        pin.parameters.display !== null ? await jellyfin.displayPreferences!(target.Id) : null;
      const contains = (expected: unknown, actual: unknown): boolean => {
        if (isObject(expected))
          return (
            isObject(actual) &&
            Object.entries(expected).every(([key, value]) => contains(value, actual[key]))
          );
        return JSON.stringify(expected) === JSON.stringify(actual);
      };
      if (
        !contains(pin.parameters.policy, configured.Policy) ||
        !contains(pin.parameters.configuration, configured.Configuration) ||
        (pin.parameters.display !== null && !contains(pin.parameters.display, display))
      )
        throw new ServiceError(
          'The new account settings could not be fully verified. Its credentials were preserved for review.',
        );
      await targetGuard();
      await sourceGuard(true);
      await jellyfin.setPolicy(target.Id, {
        ...structuredClone(configured.Policy!),
        IsAdministrator: false,
        IsDisabled: false,
      });
      activated = true;
      await targetGuard();
      this.store.saveCredentials(
        job.id,
        username,
        password,
        publicUrl,
        accountCredentialMessage(settings, username, password),
      );
      this.store.saveAccount(username, target.Id, 'ready');
      phase('reading_target');
      const targetItems = await jellyfin.destinationItems(target.Id, sourceItems);
      await targetGuard();
      const targets = new Map(targetItems.map((item) => [item.Id, item]));
      const plan: MatchPlan = { matches: [], unmatched: [], ambiguous: [] };
      for (const item of sourceItems) {
        const targetItem = targets.get(item.Id);
        if (targetItem)
          plan.matches.push({ source: item, target: targetItem, method: 'Same Jellyfin item ID' });
        else plan.unmatched.push(item);
      }
      result.matched = plan.matches.length;
      result.unmatched = plan.unmatched.length;
      result.already_played = plan.matches.filter(
        (match) => match.target.UserData?.Played === true,
      ).length;
      const expectations = new Map<string, VerificationExpectation>();
      phase('transferring_history');
      let remaining = 0;
      let pendingGuard: Promise<void> | undefined;
      let lastCheckpoint = performance.now();
      const beforeWrite = async () => {
        if (remaining <= 0) {
          pendingGuard ??= targetGuard()
            .then(() => {
              remaining = 100;
            })
            .finally(() => {
              pendingGuard = undefined;
            });
          await pendingGuard;
        }
        guard();
        remaining--;
      };
      result.applied = await migrateItemState(
        jellyfin,
        target.Id,
        plan,
        result.data!,
        guard,
        () => {},
        {
          migration_scope: 'watched_only',
          before_write: beforeWrite,
          expectation: (item, patch, unsupported) => {
            const expectation = captureExpectation(item, patch, 'watched_only');
            expectation.unsupported_fields = unsupported;
            expectations.set(item.Id, expectation);
          },
          progress: (processed, total, updated) => {
            Object.assign(job.progress, {
              items_processed: processed,
              items_total: total,
              items_updated: updated,
            });
            if (performance.now() - lastCheckpoint > 1000) {
              this.save(job);
              lastCheckpoint = performance.now();
            }
          },
        },
      );
      phase('verifying_history');
      await targetGuard();
      const observed = new Map(
        (await jellyfin.destinationItems(target.Id, targetItems)).map((item) => [item.Id, item]),
      );
      await targetGuard();
      const verification = (result.data!.verification = {
        checked: expectations.size,
        verified: 0,
        preserved_newer: 0,
        missing: 0,
        mismatched: 0,
        unsupported_fields: 0,
      });
      for (const [id, expectation] of expectations) {
        const evaluation = evaluateExpectation(expectation, observed.get(id));
        if (evaluation.status === 'missing') verification.missing++;
        else if (evaluation.status === 'mismatch') verification.mismatched++;
        else verification.verified++;
        verification.unsupported_fields += evaluation.unsupported_fields.length;
      }
      result.status =
        result.unmatched ||
        result.data!.failed_items ||
        verification.missing ||
        verification.mismatched ||
        verification.unsupported_fields ||
        result.data!.warnings.length
          ? 'partial'
          : 'completed';
    } catch (error) {
      if (error instanceof StoppedError) throw error;
      guard();
      result.status = 'failed';
      result.error =
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'The clone could not finish. The original account and any created accounts were preserved.';
    }
    this.save(job);
  }
  private async destinationItemsFor(
    job: Job,
    source: SourceSnapshot,
    targetId: string,
    scope: MigrationScope,
    settings: Settings,
    jellyfin: MediaAPI,
    context: DestinationCatalogContext,
    guard: () => void,
  ): Promise<MediaItem[]> {
    try {
      if (!jellyfin.destinationItems || (!job.destination_catalog_id && !jellyfin.catalogItems))
        throw new ServiceError(
          'This destination client cannot perform bounded history reads. Update the Jellyfin integration before migrating.',
        );
      guard();
      const info = await jellyfin.systemInfo();
      guard();
      if (typeof info.Id !== 'string' || !info.Id || typeof info.Version !== 'string')
        throw new ServiceError('The Jellyfin destination identity could not be verified.');
      const key = MigrationCatalogCache.key(
        settings.jellyfin_url,
        settings.jellyfin_api_key,
        info.Id,
        info.Version,
      );
      if (context.key && context.key !== key)
        throw new ServiceError(
          'The Jellyfin destination changed during this job. Review before retrying.',
        );
      const eligible = statePlan(source.items, [], settings, scope).unmatched;
      let candidates: MediaItem[];
      let byId: Map<string, MediaItem>;
      if (job.destination_catalog_id) {
        context.metadata = await this.destinationSnapshots.metadata(
          job.destination_catalog_id,
          settings,
          info.Id,
          info.Version,
        );
        candidates = await this.destinationSnapshots.candidates(
          job.destination_catalog_id,
          settings,
          info.Id,
          info.Version,
          eligible,
          settings.path_mappings,
          this.jobControllers.get(job.id)?.signal,
        );
        byId = new Map(candidates.map((item) => [item.Id, item]));
        context.key = key;
        this.destinationCacheHit(candidates.length);
        Object.assign(job.progress, {
          catalog_cache_hit: true,
          catalog_items: context.metadata.items,
        });
      } else {
        Object.assign(job.progress, {
          phase: 'indexing_target',
          catalog_pages: 0,
          catalog_items: 0,
          catalog_elapsed_ms: 0,
          catalog_last_page_ms: 0,
          catalog_cache_hit: false,
        });
        this.save(job);
        let lastCheckpoint = Date.now();
        let built = false;
        const onProgress = (value: CatalogProgress) => {
          Object.assign(job.progress, {
            catalog_pages: value.pages,
            catalog_items: value.items,
            catalog_elapsed_ms: Math.round(value.elapsed_ms),
            catalog_last_page_ms: Math.round(value.last_page_ms),
          });
          if (value.pages === 1 || Date.now() - lastCheckpoint >= 1000) {
            this.save(job);
            lastCheckpoint = Date.now();
          }
        };
        if (context.value) this.destinationCacheHit(context.value.items.length);
        else
          context.value = await this.destinationCatalogs.get(key, () => {
            built = true;
            return jellyfin.catalogItems!({
              signal: this.jobControllers.get(job.id)?.signal,
              onProgress,
            });
          });
        context.key = key;
        guard();
        job.progress.catalog_cache_hit = !built;
        job.progress.catalog_items = context.value.items.length;
        this.save(job);
        context.matcher ??= createMatcher(context.value.items, settings.path_mappings);
        context.byId ??= new Map(context.value.items.map((item) => [item.Id, item]));
        // Reuse exactly the same played-item eligibility as the final state plan.
        candidates = context.matcher.candidates(eligible);
        const ids = new Set(candidates.map((item) => item.Id));
        // Derived episode/season identifiers depend on their series. Read that small
        // dependency set too so cached series-provider edits cannot authorize a match.
        for (const item of [...candidates]) {
          const series = item.SeriesId ? context.byId.get(item.SeriesId) : undefined;
          if (series && item.SeriesProviderIds && !ids.has(series.Id)) {
            ids.add(series.Id);
            candidates.push(series);
          }
        }
        byId = context.byId;
      }
      job.progress.phase = 'reading_target';
      this.save(job);
      const items = await jellyfin.destinationItems(targetId, candidates);
      guard();
      const returned = new Set(items.map((item) => item.Id));
      for (const item of items) {
        const parent = item.SeriesId ? byId.get(item.SeriesId) : undefined;
        if (parent && item.SeriesProviderIds && !returned.has(parent.Id))
          throw new ServiceError(
            'A destination series identity could not be verified through this account. Review its library access before retrying.',
          );
      }
      return items;
    } catch (error) {
      this.destinationCatalogs.clear();
      delete context.key;
      delete context.value;
      delete context.matcher;
      delete context.byId;
      guard();
      throw new DestinationPreparationError(
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'The destination catalog or account state could not be prepared. Remaining accounts were not started.',
      );
    }
  }
  private async one(
    job: Job,
    request: JobRequest,
    settings: Settings,
    jellyfin: MediaAPI,
    template: ProvisioningDefaults,
    catalogContext: { key?: string; value?: MigrationCatalog },
    destinationContext: DestinationCatalogContext,
  ): Promise<void> {
    const accountStarted = performance.now();
    const timing = {
      elapsed_ms: 0,
      phase_ms: {} as Record<string, number>,
      checkpoints: { count: 0, total_duration_ms: 0, max_duration_ms: 0 },
    };
    let phaseStarted = accountStarted;
    let previousPhase: string | undefined;
    const recordPhase = () => {
      const time = performance.now();
      if (previousPhase)
        timing.phase_ms[previousPhase] =
          (timing.phase_ms[previousPhase] ?? 0) + time - phaseStarted;
      phaseStarted = time;
    };
    const scope = migrationScope(request.migration_scope);
    let source: SourceSnapshot | null = null;
    let savedMetadata: SnapshotMetadata | undefined;
    // Register only warnings produced at explicitly informational callsites. Any
    // other warning remains operationally uncertain, including future additions.
    const informationalWarnings = new Set<string>();
    let mapping = this.requestMapping(request, settings);
    let destinationId: string | null = null;
    let sourceOwnershipServerId: string | undefined;
    const registeredSource: { value: MediaOwnership | null } = { value: null };
    const registeredAccounts = this.mediaOwnerships.list(settings);
    const auth = this.store.authState();
    const bindsMigrationIdentity = Boolean(
      request.source_user_id && request.discord_user_id && !request.history_only_target,
    );
    const migrationIdentityScope = this.mediaOwnerships.scope(settings);
    let targetOwnershipServerId = auth?.kind === 'configured' ? auth.serverId : undefined;
    let targetOwnershipPin: { id: string; identity_hash: string | null } | undefined;
    let username: string;
    const phase = (value: NonNullable<Job['progress']['phase']>) => {
      recordPhase();
      previousPhase = value;
      job.progress.phase = value;
      this.save(job);
    };
    job.progress.current_user = mapping?.target_username ?? request.username;
    const guard = () => {
      this.checkJobStopped(job);
      this.assertConnections(settings);
      if (
        bindsMigrationIdentity &&
        this.mediaOwnerships.scope(this.store.settings()) !== migrationIdentityScope
      )
        throw new ServiceError(
          'The identity server configuration changed. Review a new migration before linking its accounts.',
        );
      this.assertMembershipRequest(request, settings);
      if (!request.history_only_target) this.assertDefaultRole(template, request, settings);
      this.assertMapping(mapping, request.source_user_id, settings);
      this.assertDestinationMapping(mapping, destinationId, username, settings);
      if (sourceOwnershipServerId)
        registeredSource.value = this.sourceOwnership(request, settings, sourceOwnershipServerId);
      if (targetOwnershipPin && targetOwnershipServerId && !request.history_only_target) {
        const owner = this.mediaOwnerships.get(
          'jellyfin',
          targetOwnershipServerId,
          targetOwnershipPin.id,
          this.store.settings(),
        );
        if (this.ownershipHash(owner) !== targetOwnershipPin.identity_hash)
          throw new ServiceError(
            'The approved Jellyfin account ownership changed during this migration. Review before retrying.',
          );
      }
    };
    if (
      registeredAccounts.length ||
      request.source_ownership?.identity_hash ||
      bindsMigrationIdentity
    ) {
      const info = await jellyfin.systemInfo();
      if (
        typeof info.Id !== 'string' ||
        !info.Id ||
        (targetOwnershipServerId && info.Id !== targetOwnershipServerId)
      )
        throw new ServiceError(
          'The Jellyfin server identity changed. Review account ownership before migrating.',
        );
      targetOwnershipServerId = info.Id;
    }
    if (request.source_user_id) {
      phase('reading_source');
      try {
        source = await this.withClient(
          settings,
          'emby',
          async (emby) => {
            if (!request.source_snapshot_id) {
              if (!emby.catalogItems || !emby.migrationState)
                throw new ServiceError(
                  'This source client cannot perform bounded history reads. Use a saved snapshot or update the source integration.',
                );
              const info = await emby.systemInfo();
              this.checkJobStopped(job);
              if (typeof info.Id !== 'string' || !info.Id || typeof info.Version !== 'string')
                throw new ServiceError('The Emby source identity could not be verified.');
              sourceOwnershipServerId = info.Id;
              registeredSource.value = this.sourceOwnership(request, settings, info.Id);
              const key = MigrationCatalogCache.key(
                settings.emby_url,
                settings.emby_api_key,
                info.Id,
                info.Version,
              );
              if (catalogContext.key && catalogContext.key !== key)
                throw new ServiceError(
                  'The Emby source changed during this job. Review before retrying.',
                );
              if (catalogContext.value)
                this.sourceWorkload.cacheHit('catalog', catalogContext.value.items.length);
              else
                catalogContext.value = await this.sourceCatalogs.get(key, () =>
                  emby.catalogItems!(),
                );
              catalogContext.key = key;
              this.checkJobStopped(job);
              const items = await emby.migrationState(
                request.source_user_id!,
                catalogContext.value.items,
                scope,
              );
              this.checkJobStopped(job);
              const source = await readMigrationSource(
                emby,
                request.source_user_id!,
                scope,
                items,
                this.jobControllers.get(job.id)?.signal,
              );
              source.catalog = {
                captured_at: new Date(catalogContext.value.capturedAt).toISOString(),
                items: catalogContext.value.items.length,
              };
              return source;
            }
            const info = await emby.systemInfo();
            if (info.Version !== '4.10.1.0' || typeof info.Id !== 'string')
              throw new ServiceError('Emby version or identity changed. Review a new preview.');
            sourceOwnershipServerId = info.Id;
            registeredSource.value = this.sourceOwnership(request, settings, info.Id);
            const selected = await this.sourceSnapshots.select(
              request.source_user_id!,
              settings,
              info.Id,
              request.source_snapshot_id,
            );
            savedMetadata = selected.metadata;
            const source = await readMigrationSource(
              emby,
              request.source_user_id!,
              scope,
              await this.sourceSnapshots.items(
                selected,
                request.source_user_id!,
                scope,
                this.jobControllers.get(job.id)?.signal,
              ),
              this.jobControllers.get(job.id)?.signal,
            );
            const historyWarnings = snapshotHistoryWarnings(selected.metadata.diagnostics);
            historyWarnings.forEach((warning) => informationalWarnings.add(warning));
            source.warnings.push(...historyWarnings);
            return source;
          },
          this.jobControllers.get(job.id)?.signal,
        );
        if (this.sourceWorkload.snapshot().cooldown_remaining_ms > 0)
          throw new MediaError(
            'Emby source preparation stopped after a slow or rejected read. No destination changes were started for this account.',
          );
      } catch (error) {
        this.checkJobStopped(job);
        throw new SourcePreparationError(
          error instanceof MediaError || error instanceof ServiceError
            ? error.message
            : 'The source data could not be prepared. Remaining accounts were not started.',
        );
      }
      if (source.user.Id !== request.source_user_id)
        throw new ServiceError('Emby returned a different source account. Reload the user list.');
      if (savedMetadata) savedMetadata.source_username = source.user.Name;
      if (mapping && source.user.Name !== mapping.source_username)
        throw new ServiceError('The mapped Emby account was renamed. Review its mapping.');
      if (registeredSource.value && source.user.Name !== registeredSource.value.username)
        throw new ServiceError(
          'The approved Emby account was renamed. Review its ownership before migrating.',
        );
      username = mapping?.target_user_id
        ? validateExistingMappingUsername(mapping.target_username)
        : validateUsername(mapping?.target_username ?? source.user.Name);
    } else username = validateUsername(request.username ?? '');
    job.progress.current_user = username;
    phase('preparing_account');
    if (
      request.membership_revision &&
      request.username !== undefined &&
      request.username !== username
    )
      throw new ServiceError(
        'The source username changed after membership review. Review its mapping before retrying.',
      );
    guard();
    let newSubscriberDiscordUsername: string | undefined;
    const assertNewSourceBeforeCreate = async () => {
      if (!request.new_subscriber_policy_revision) return;
      const member = this.assertMembershipRequest(request, settings)!;
      const names = new Set(
        [
          member.base_username,
          ...(newSubscriberDiscordUsername ? [newSubscriberDiscordUsername] : []),
        ]
          .flatMap((base) => automaticAccountNameCandidates(base, settings))
          .map(caseFold),
      );
      const isCreatedSibling = (id: string | null, name: string) => {
        const link = id ? this.store.linkForRemote(id) : null;
        return Boolean(
          link &&
          link.discord_user_id === request.discord_user_id &&
          link.membership_slot !== request.membership_slot &&
          link.username === name &&
          membershipUsername(member.base_username, link.membership_slot, settings) === name &&
          job.results.some(
            (result) =>
              result.created === true &&
              ['completed', 'partial'].includes(result.status) &&
              result.target_user_id === id &&
              result.username === name,
          ),
        );
      };
      if (
        [...names].some((name) => {
          const local = this.store.account(name);
          return local && !isCreatedSibling(local.remote_id, local.username);
        })
      )
        throw new ServiceError('An existing local account appeared. Review its identity manually.');
      if (Boolean(settings.emby_url) !== Boolean(settings.emby_api_key))
        throw new ServiceError(
          'Verify the configured Emby connection before automatic onboarding.',
        );
      if (settings.emby_url && settings.emby_api_key) {
        const sources = await this.withClient(settings, 'emby', (client) => client.users());
        guard();
        if (sources.some((source) => names.has(caseFold(source.Name))))
          throw new ServiceError(
            'An existing Emby account appeared. Review its Jellyfin opt-in manually.',
          );
      }
      const targets = await jellyfin.users();
      guard();
      if (
        targets.some(
          (target) => names.has(caseFold(target.Name)) && !isCreatedSibling(target.Id, target.Name),
        )
      )
        throw new ServiceError(
          'An existing Jellyfin account appeared. Review its Jellyfin opt-in manually.',
        );
    };
    const currentTarget = this.mappedTarget(
      await jellyfin.users(),
      mapping,
      username,
      settings,
      request.recover_target_id,
      Boolean(request.history_only_target),
    );
    if (request.new_subscriber_policy_revision && currentTarget)
      throw new ServiceError(
        'An existing Jellyfin account appeared. Review its identity manually.',
      );
    destinationId = currentTarget?.Id ?? null;
    if (!request.history_only_target && targetOwnershipServerId) {
      const owner = destinationId
        ? this.mediaOwnerships.get('jellyfin', targetOwnershipServerId, destinationId, settings)
        : null;
      const expectedOwner =
        registeredSource.value?.discord_user_id ??
        request.discord_user_id ??
        mapping?.discord_user_id;
      const expectedSlot =
        request.membership_slot ?? mapping?.membership_slot ?? registeredSource.value?.slot ?? 1;
      if (
        owner &&
        (!expectedOwner || owner.discord_user_id !== expectedOwner || owner.slot !== expectedSlot)
      )
        throw new ServiceError(
          'This Jellyfin account belongs to a different approved Discord owner or account slot. Review the account mapping.',
        );
      const reservedSlot = registeredAccounts.find(
        (account) =>
          account.kind === 'jellyfin' &&
          account.server_id === targetOwnershipServerId &&
          account.discord_user_id === expectedOwner &&
          account.slot === expectedSlot,
      );
      if (
        reservedSlot &&
        (reservedSlot.account_id !== destinationId || reservedSlot.username !== username)
      )
        throw new ServiceError(
          'The approved owner already has a different Jellyfin account in this slot. Select that account through a user mapping.',
        );
      if (destinationId)
        targetOwnershipPin = { id: destinationId, identity_hash: this.ownershipHash(owner) };
    }
    guard();
    const recipient = request.discord_user_id;
    const historyOnly = request.history_only_target;
    if (historyOnly && (!source || recipient || request.recover_target_id || request.role_id))
      throw new ServiceError('History-only migration cannot create, recover or manage accounts.');
    const validateHistoryTarget = async () => {
      if (!historyOnly) return;
      if (!historyOnly.administrator && !historyOnly.template)
        throw new ServiceError(
          'The reviewed history-only account is not protected. Prepare a new review.',
        );
      guard();
      const info = await jellyfin.systemInfo();
      guard();
      const live = await jellyfin.user(historyOnly.target_user_id);
      guard();
      if (
        info.Id !== historyOnly.server_id ||
        live.Id !== historyOnly.target_user_id ||
        live.Id !== currentTarget?.Id ||
        live.Name !== historyOnly.target_username ||
        live.Name !== username ||
        typeof live.Policy?.IsAdministrator !== 'boolean' ||
        live.Policy.IsAdministrator !== historyOnly.administrator ||
        live.Policy.IsDisabled !== false ||
        this.store.settings().template_user_id !== historyOnly.template_user_id ||
        (live.Id === this.store.settings().template_user_id || live.Id === template.Id) !==
          historyOnly.template
      )
        throw new ServiceError(
          'The reviewed history-only destination changed. Applied played flags are preserved; prepare a new review.',
        );
    };
    if (historyOnly) await validateHistoryTarget();
    if (recipient) {
      const slot = request.membership_slot ?? mapping?.membership_slot ?? 1;
      const identity = await this.recipientIdentity(recipient),
        link = this.store.link(recipient, slot);
      if (identity.id && identity.id !== recipient)
        throw new ServiceError(
          'Discord returned a different recipient identity. Review the mapping.',
        );
      if (request.new_subscriber_policy_revision) newSubscriberDiscordUsername = identity.username;
      const memberMapping = this.mappings.getForDiscord(recipient, settings, slot);
      if (memberMapping && memberMapping.id !== mapping?.id)
        throw new ServiceError(
          'This Discord user is approved for a different Emby mapping. Existing ownership was preserved.',
        );
      if (link && (link.username !== username || link.remote_id !== currentTarget?.Id))
        throw new ServiceError(
          'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
        );
      const member = request.membership_revision
        ? this.assertMembershipRequest(request, settings)
        : this.memberships.get(recipient, settings);
      if (slot > 1 && (!member?.active || slot > member.account_limit))
        throw new ServiceError('The membership no longer permits this account slot.');
      const approvedHouseholdName = Boolean(
        request.membership_revision &&
        member &&
        username === membershipUsername(member.base_username, slot, settings),
      );
      const registeredIdentity =
        registeredSource.value?.discord_user_id === recipient &&
        registeredSource.value.slot === slot;
      if (
        slot > 1 &&
        !link &&
        mapping?.discord_user_id !== recipient &&
        !approvedHouseholdName &&
        !registeredIdentity
      )
        throw new ServiceError(
          'Numbered membership accounts require an approved account slot and username.',
        );
      if (
        !link &&
        username !== identity.username &&
        mapping?.discord_user_id !== recipient &&
        !approvedHouseholdName &&
        !registeredIdentity
      )
        throw new ServiceError(
          "The destination username must match this recipient's Discord username or an approved mapping with their verified user ID.",
        );
      const existing = currentTarget ? this.store.linkForRemote(currentTarget.Id) : null;
      if (existing && (existing.discord_user_id !== recipient || existing.membership_slot !== slot))
        throw new ServiceError('This Jellyfin account is already linked to another Discord user.');
      if (source && sourceOwnershipServerId && !historyOnly)
        this.migrationIdentityAdditions(
          [
            {
              kind: 'emby',
              server_id: sourceOwnershipServerId,
              account_id: source.user.Id,
              username: source.user.Name,
              discord_user_id: recipient,
              slot,
            },
          ],
          settings,
        );
    }
    const result: JobResult = {
      timing,
      username,
      ...(historyOnly ? { history_only: true } : {}),
      ...(source ? { source_username: source.user.Name } : {}),
      ...(source?.catalog ? { source_catalog: source.catalog } : {}),
      ...(savedMetadata ? { source_snapshot: savedMetadata } : {}),
      ...(mapping ? { mapping_id: mapping.id } : {}),
      status: 'running',
      created: false,
      applied: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      already_played: 0,
      discord_delivery: 'not_requested',
    };
    if (source) {
      result.data = migrationDetails();
      for (const warning of source.warnings) migrationWarning(result.data, warning);
    }
    guard();
    job.results.push(result);
    this.save(job);
    const pinCreatedTarget = async (target: MediaUser) => {
      destinationId = target.Id;
      if (!historyOnly && targetOwnershipServerId && !targetOwnershipPin) {
        const owner = this.mediaOwnerships.get(
          'jellyfin',
          targetOwnershipServerId,
          target.Id,
          settings,
        );
        const expectedOwner =
          registeredSource.value?.discord_user_id ?? recipient ?? mapping?.discord_user_id;
        const expectedSlot =
          request.membership_slot ?? mapping?.membership_slot ?? registeredSource.value?.slot ?? 1;
        if (owner && (owner.discord_user_id !== expectedOwner || owner.slot !== expectedSlot))
          throw new ServiceError(
            'The new Jellyfin account acquired a different approved owner before migration completed. Credentials were not delivered.',
          );
        targetOwnershipPin = { id: target.Id, identity_hash: this.ownershipHash(owner) };
      }
      guard();
    };
    try {
      const [target, created, password] = historyOnly
        ? ([currentTarget!, false, null] as const)
        : await this.provision(
            jellyfin,
            settings,
            template,
            username,
            Boolean(request.source_user_id),
            request.recover_target_id,
            mapping,
            guard,
            pinCreatedTarget,
            false,
            Boolean(request.new_subscriber_policy_revision),
            assertNewSourceBeforeCreate,
          );
      Object.assign(result, { created, target_user_id: target.Id });
      destinationId = target.Id;
      const publicUrl = settings.jellyfin_public_url || settings.jellyfin_url;
      const message = password ? accountCredentialMessage(settings, username, password) : undefined;
      if (password) {
        this.store.saveCredentials(job.id, username, password, publicUrl, message);
        this.store.saveAccount(username, target.Id, 'ready');
      }
      guard();
      if (!historyOnly && mapping && !mapping.target_user_id)
        mapping = this.mappings.bindTarget(mapping.id, mapping.revision, target.Id, settings);
      // Recheck the stable identity and protection flags after provisioning, before personal data.
      const liveTarget = historyOnly ? currentTarget! : await jellyfin.user(target.Id);
      if (
        liveTarget.Id !== target.Id ||
        liveTarget.Name !== username ||
        (!historyOnly &&
          (liveTarget.Id === template.Id ||
            liveTarget.Id === settings.template_user_id ||
            liveTarget.Policy?.IsAdministrator)) ||
        liveTarget.Policy?.IsDisabled
      )
        throw new ServiceError(
          'The destination account changed or became protected. Review it before retrying.',
        );
      guard();
      if (created && template.accountRole) {
        const role = template.accountRole;
        this.assertRoleTarget(liveTarget, target.Id, username, settings);
        const previous = this.roles.getAssignment(target.Id, settings);
        if (previous && previous.role_id !== role.id)
          throw new ServiceError(
            'The account role was changed during provisioning. Review the account before retrying.',
          );
        const [assignment] = this.roles.assign(role.id, role.revision, [liveTarget], settings);
        const sections: RoleSection[] = ['policy', 'configuration'];
        Object.assign(result, { role_id: role.id, role_name: role.name, role_sections: sections });
        if (role.parameters.display !== null) {
          await this.requireRoleServer(jellyfin, role);
          guard();
          let preferences: JsonObject | undefined;
          try {
            if (!jellyfin.displayPreferences || !jellyfin.setDisplayPreferences)
              throw new ServiceError('Home preferences are unavailable.');
            preferences = await jellyfin.displayPreferences(target.Id);
          } catch (error) {
            if (error instanceof StoppedError) throw error;
            result.warnings = [
              'The account was created, but its Home screen preferences could not be applied. Review the role update before retrying.',
            ];
          }
          if (preferences) {
            guard();
            const confirmed = await jellyfin.user(target.Id);
            guard();
            this.assertRoleTarget(confirmed, target.Id, username, settings);
            try {
              await jellyfin.setDisplayPreferences!(
                target.Id,
                mergeRoleSection('display', preferences, role.parameters),
              );
              sections.push('display');
              this.save(job);
            } catch (error) {
              if (error instanceof StoppedError) throw error;
              result.warnings = [
                'The account was created, but its Home screen preferences could not be applied. Review the role update before retrying.',
              ];
            }
          }
          // Protection and identity errors are fatal; optional Home API failures
          // alone may leave an otherwise usable new account with a warning.
          await this.requireRoleServer(jellyfin, role);
          const confirmed = await jellyfin.user(target.Id);
          this.assertRoleTarget(confirmed, target.Id, username, settings);
        }
        guard();
        this.roles.markApplied(
          target.Id,
          role.id,
          role.revision,
          assignment!.revision,
          settings,
          sections,
        );
      }
      if (recipient) {
        const slot = request.membership_slot ?? mapping?.membership_slot ?? 1;
        const existing = this.store.linkForRemote(target.Id);
        if (
          existing &&
          (existing.discord_user_id !== recipient || existing.membership_slot !== slot)
        )
          throw new ServiceError(
            'This Jellyfin account is already linked to another Discord user.',
          );
        const previous = this.store.link(recipient, slot);
        if (previous && (previous.remote_id !== target.Id || previous.username !== username))
          throw new ServiceError(
            'This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.',
          );
        if (source && !historyOnly) {
          if (!sourceOwnershipServerId || !targetOwnershipServerId)
            throw new ServiceError(
              'Verify both media-server identities before linking migrated accounts.',
            );
          await this.withClient(settings, 'emby', async (emby) => {
            const info = await emby.systemInfo();
            guard();
            if (info.Id !== sourceOwnershipServerId)
              throw new ServiceError(
                'The Emby server changed before migration identity confirmation. Review its accounts.',
              );
            const confirmed = await emby.user(source!.user.Id);
            guard();
            if (confirmed.Id !== source!.user.Id || confirmed.Name !== source!.user.Name)
              throw new ServiceError(
                'The Emby source identity changed before linking migrated accounts. Review its account.',
              );
          });
          const info = await jellyfin.systemInfo();
          guard();
          const confirmed = await jellyfin.user(target.Id);
          guard();
          if (
            info.Id !== targetOwnershipServerId ||
            confirmed.Id !== target.Id ||
            confirmed.Name !== username ||
            confirmed.Policy?.IsAdministrator !== false ||
            confirmed.Policy.IsDisabled !== false ||
            confirmed.Id === settings.template_user_id
          )
            throw new ServiceError(
              'The Jellyfin destination identity changed before linking migrated accounts. Review its account.',
            );
          const sourceRecord = {
            kind: 'emby' as const,
            server_id: sourceOwnershipServerId,
            account_id: source.user.Id,
            username: source.user.Name,
            discord_user_id: recipient,
            slot,
          };
          const targetRecord = {
            kind: 'jellyfin' as const,
            server_id: targetOwnershipServerId,
            account_id: target.Id,
            username,
            discord_user_id: recipient,
            slot,
          };
          this.store.db.exec('SAVEPOINT jellyport_migration_identity');
          let boundSource: MediaOwnership, boundTarget: MediaOwnership;
          try {
            guard();
            const additions = this.migrationIdentityAdditions(
              [sourceRecord, targetRecord],
              settings,
            );
            const currentLink = this.store.link(recipient, slot);
            this.mediaOwnerships.save(additions, settings);
            this.store.saveLink(
              recipient,
              username,
              target.Id,
              Boolean(currentLink?.disabled_by_jellyport),
              slot,
            );
            const savedSource = this.mediaOwnerships.get(
              'emby',
              sourceOwnershipServerId,
              source.user.Id,
              settings,
            );
            const savedTarget = this.mediaOwnerships.get(
              'jellyfin',
              targetOwnershipServerId,
              target.Id,
              settings,
            );
            if (!savedSource || !savedTarget)
              throw new ServiceError(
                'The migrated account ownership could not be persisted. Review the account identities before retrying.',
              );
            boundSource = savedSource;
            boundTarget = savedTarget;
            this.store.db.exec('RELEASE jellyport_migration_identity');
          } catch (error) {
            this.store.db.exec('ROLLBACK TO jellyport_migration_identity');
            this.store.db.exec('RELEASE jellyport_migration_identity');
            throw error;
          }
          // Rebase only the records authenticated inside our own successful
          // transaction. A later conflicting write must still trip the guards.
          request.source_ownership = {
            server_id: sourceOwnershipServerId,
            identity_hash: this.ownershipHash(boundSource),
          };
          registeredSource.value = boundSource;
          targetOwnershipPin = { id: target.Id, identity_hash: this.ownershipHash(boundTarget) };
          guard();
        } else
          this.store.saveLink(
            recipient,
            username,
            target.Id,
            Boolean(previous?.disabled_by_jellyport),
            slot,
          );
      }
      if (source && result.data) {
        guard();
        phase('reading_target');
        const targetItems = await this.destinationItemsFor(
          job,
          source,
          target.Id,
          scope,
          settings,
          jellyfin,
          destinationContext,
          guard,
        );
        if (destinationContext.metadata) result.destination_catalog = destinationContext.metadata;
        phase('matching');
        const matcher = createMatcher(targetItems, settings.path_mappings);
        const [plan, stats] = this.plan(source.items, targetItems, settings, scope, matcher);
        Object.assign(result, stats);
        result.ambiguous_items = [];
        result.unmatched_items = [];
        let diagnosticBytes = Buffer.byteLength('{"ambiguous_items":[],"unmatched_items":[]}');
        let diagnosticBudgetLimited = false;
        const retainDiagnostic = (value: MigrationItemSummary): boolean => {
          const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
          if (bytes > MAX_RESULT_DIAGNOSTIC_BYTES - diagnosticBytes) {
            diagnosticBudgetLimited = true;
            return false;
          }
          diagnosticBytes += bytes;
          return true;
        };
        // Prefer actionable ambiguity explanations over unmatched entries when
        // unusually long names/paths fill the bounded administrator diagnostics.
        for (const item of plan.ambiguous.slice(0, 200)) {
          const summary = previewItemSummary(item.source);
          const candidates = item.candidates.slice(0, 20).map(previewItemSummary);
          const detail: MigrationAmbiguitySummary = {
            ...summary,
            candidate_ids: candidates.map((candidate) => candidate.id),
            candidates,
            candidate_count: item.candidates.length,
            method: item.method,
            reason_codes: item.reason_codes,
            reason: item.reason,
            path_resolution: item.path_resolution,
          };
          if (!retainDiagnostic(detail)) break;
          result.ambiguous_items.push(detail);
        }
        for (const item of plan.unmatched.slice(0, 200)) {
          const summary = previewItemSummary(item);
          const detail = { ...summary, type: summary.type ?? '' };
          if (!retainDiagnostic(detail)) break;
          result.unmatched_items.push(detail);
        }
        const informationalWarning = (details: MigrationDetails, message: string) => {
          informationalWarnings.add(message);
          migrationWarning(details, message);
        };
        if (diagnosticBudgetLimited)
          informationalWarning(
            result.data,
            'Result diagnostic details are limited to 1 MiB per account. Full counts are shown; migration checks every item.',
          );
        if (
          plan.unmatched.length > 200 ||
          plan.ambiguous.length > 200 ||
          plan.ambiguous.some((entry) => entry.candidates.length > 20)
        )
          informationalWarning(
            result.data,
            'Result details are limited to 200 unmatched items, 200 ambiguous items, and 20 candidates per item. Full counts are shown; migration checks every item.',
          );
        phase('transferring_history');
        Object.assign(job.progress, {
          phase: 'transferring_history',
          items_processed: 0,
          items_total: plan.matches.length,
          items_updated: 0,
        });
        this.save(job);
        const expectations = new Map<string, VerificationExpectation[]>();
        let lastCheckpoint = performance.now();
        const checkpoint = (force = false) => {
          const started = performance.now();
          // Progress is observational. Bound full-job persistence independently of
          // write throughput; account uncertainty journals remain immediate.
          if (force || started - lastCheckpoint >= 1000) {
            this.save(job);
            const duration = performance.now() - started;
            timing.checkpoints.count++;
            timing.checkpoints.total_duration_ms += duration;
            timing.checkpoints.max_duration_ms = Math.max(
              timing.checkpoints.max_duration_ms,
              duration,
            );
            lastCheckpoint = performance.now();
          }
        };
        let remainingGuardedWrites = 0;
        let checkingHistoryTarget: Promise<void> | undefined;
        const beforeHistoryWrite = async () => {
          if (!historyOnly) return;
          if (remainingGuardedWrites <= 0) {
            checkingHistoryTarget ??= validateHistoryTarget()
              .then(() => {
                remainingGuardedWrites = 100;
              })
              .finally(() => {
                checkingHistoryTarget = undefined;
              });
            await checkingHistoryTarget;
          }
          guard();
          remainingGuardedWrites--;
        };
        try {
          result.applied = await migrateItemState(
            jellyfin,
            target.Id,
            plan,
            result.data,
            guard,
            () => {},
            {
              migration_scope: scope,
              ...(historyOnly ? { before_write: beforeHistoryWrite } : {}),
              expectation: (target, patch, unsupported) => {
                const expected = captureExpectation(target, patch, scope);
                expected.unsupported_fields = [
                  ...new Set([...(expected.unsupported_fields ?? []), ...unsupported]),
                ];
                const existing = expectations.get(target.Id) ?? [];
                existing.push(expected);
                expectations.set(target.Id, existing);
              },
              progress: (processed, total, updated) => {
                Object.assign(job.progress, {
                  items_processed: processed,
                  items_total: total,
                  items_updated: updated,
                });
                checkpoint();
              },
            },
          );
        } finally {
          // Workers have drained before this final checkpoint. Only observational job
          // updates are batched; account uncertainty journals stay immediate.
          checkpoint(true);
        }
        guard();
        phase('verifying_history');
        result.data.verification = {
          checked: expectations.size,
          verified: 0,
          preserved_newer: 0,
          missing: 0,
          mismatched: 0,
          unsupported_fields: 0,
        };
        const verification = result.data.verification;
        try {
          const byId = new Map(targetItems.map((item) => [item.Id, item]));
          const candidates = [...expectations.values()].map((values) => {
            const item = values[0]!.item;
            const trusted = byId.get(item.Id);
            const membership = trusted?.JellyportLibraryIds;
            return membership === undefined
              ? item
              : {
                  ...item,
                  JellyportLibraryIds: [...membership],
                  ...(trusted?.JellyportLibraryConfigHash
                    ? { JellyportLibraryConfigHash: trusted.JellyportLibraryConfigHash }
                    : {}),
                };
          });
          const ids = new Set(candidates.map((item) => item.Id));
          for (const item of [...candidates]) {
            const parent = item.SeriesId ? byId.get(item.SeriesId) : undefined;
            if (parent && item.SeriesProviderIds && !ids.has(parent.Id)) {
              ids.add(parent.Id);
              candidates.push(parent);
            }
          }
          if (historyOnly) await validateHistoryTarget();
          const observed = new Map(
            (await jellyfin.destinationItems!(target.Id, candidates)).map((item) => [
              item.Id,
              item,
            ]),
          );
          guard();
          if (historyOnly) await validateHistoryTarget();
          for (const item of candidates) {
            if (
              item.SeriesProviderIds &&
              item.SeriesId &&
              byId.has(item.SeriesId) &&
              !observed.has(item.SeriesId)
            )
              throw new ServiceError('A series identity could not be independently verified.');
          }
          for (const [id, values] of expectations) {
            const evaluations = values.map((expected) =>
              evaluateExpectation(expected, observed.get(id)),
            );
            verification.unsupported_fields += new Set(
              evaluations.flatMap((value) => value.unsupported_fields),
            ).size;
            if (evaluations.some((value) => value.status === 'missing')) verification.missing++;
            else if (evaluations.some((value) => value.status === 'mismatch'))
              verification.mismatched++;
            else if (evaluations.some((value) => value.status === 'preserved_newer'))
              verification.preserved_newer++;
            else verification.verified++;
          }
          if (verification.missing || verification.mismatched || verification.unsupported_fields)
            migrationWarning(
              result.data,
              'Independent Jellyfin readback did not verify every intended history field. Review missing, mismatched and unsupported counts before retrying.',
            );
        } catch (error) {
          guard();
          verification.missing = expectations.size;
          migrationWarning(
            result.data,
            'Independent Jellyfin history verification could not finish. Applied changes are preserved; review before retrying.',
          );
        }
        this.save(job);
        guard();
      }
      let archivedMessage: BotMessageHistory | undefined;
      let archiveSent = false;
      let deliveryAcknowledged = false;
      if (recipient && password)
        try {
          phase('delivering_credentials');
          await this.validateRecipients([recipient]);
          const identity = await this.recipientIdentity(recipient);
          if (
            (identity.id && identity.id !== recipient) ||
            this.store.link(recipient, request.membership_slot ?? mapping?.membership_slot ?? 1)
              ?.remote_id !== target.Id
          )
            throw new ServiceError(
              'The Discord recipient identity changed. Credentials were preserved for administrator review.',
            );
          guard();
          archivedMessage = {
            id: randomUUID(),
            kind: 'credentials',
            recipient_id: recipient,
            recipient_username: identity.username,
            account_username: username,
            membership_slot: request.membership_slot ?? mapping?.membership_slot ?? 1,
            content: discordCredentialContent(message!),
            status: 'pending',
            created_at: now(),
          };
          this.store.saveBotMessage(job.id, archivedMessage);
          const receipt = await this.requireBot().sendCredentials(
            recipient,
            username,
            password,
            publicUrl,
            this.recipientRequiresMembershipRole(recipient),
            message,
          );
          deliveryAcknowledged = true;
          result.discord_delivery = 'sent';
          this.store.saveBotMessage(job.id, {
            ...archivedMessage,
            ...receipt,
            status: 'sent',
            sent_at: receipt?.sent_at ?? now(),
          });
          archiveSent = true;
          result.discord_delivery = 'sent';
          this.store.deleteCredentials(job.id, username);
        } catch {
          if (archivedMessage && !archiveSent) {
            try {
              this.store.saveBotMessage(job.id, { ...archivedMessage, status: 'uncertain' });
            } catch {
              /* The durable pending attempt remains uncertain; never resend automatically. */
            }
          }
          result.discord_delivery = deliveryAcknowledged ? 'sent' : 'failed';
          result.delivery_error = deliveryAcknowledged
            ? 'Discord confirmed delivery, but local message archival or temporary credential cleanup could not finish. Any retained recovery credentials remain available until expiration.'
            : 'Discord delivery was not confirmed. Credentials remain available for one-time reveal for 24 hours.';
        }
      else if (recipient) result.discord_delivery = 'skipped_existing_account';
      if (source && result.data) {
        const verification = result.data.verification;
        const writes = result.data.write_metrics;
        result.migration_outcome = {
          version: 1,
          execution:
            !result.error &&
            !result.delivery_error &&
            !result.warnings?.length &&
            !result.data.failed_items &&
            !result.data.warnings.some((warning) => !informationalWarnings.has(warning)) &&
            writes &&
            writes.failed === 0 &&
            writes.attempts === writes.succeeded &&
            verification &&
            verification.checked === verification.verified + verification.preserved_newer &&
            !verification.missing &&
            !verification.mismatched &&
            !verification.unsupported_fields
              ? 'verified'
              : 'needs_review',
          unresolved_source_history: savedMetadata?.diagnostics?.orphan_state_items ?? 0,
        };
      }
      result.status =
        result.unmatched ||
        result.ambiguous ||
        result.discord_delivery === 'failed' ||
        result.data?.failed_items ||
        result.data?.warnings.length ||
        result.warnings?.length
          ? 'partial'
          : 'completed';
    } catch (error) {
      if (error instanceof StoppedError) throw error;
      result.status = 'failed';
      if (source && result.data)
        result.migration_outcome = {
          version: 1,
          execution: 'needs_review',
          unresolved_source_history: savedMetadata?.diagnostics?.orphan_state_items ?? 0,
        };
      result.error =
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'This account could not be completed. Review server connectivity and run again; existing passwords are preserved.';
      if (error instanceof DestinationPreparationError) {
        this.save(job);
        throw error;
      }
    } finally {
      recordPhase();
      timing.elapsed_ms = Math.round(performance.now() - accountStarted);
      for (const key of Object.keys(timing.phase_ms))
        timing.phase_ms[key] = Math.round(timing.phase_ms[key]!);
      this.save(job);
    }
    this.save(job);
  }
  private checkStopped(): void {
    if (this.stopping) throw new StoppedError();
  }
  private checkJobStopped(job: Job): void {
    this.checkStopped();
    if (job.cancel_requested || this.jobControllers.get(job.id)?.signal.aborted)
      throw new CanceledError('Job canceled.');
  }
  private assertConnections(settings: Settings): void {
    const live = this.store.settings();
    if (
      ['emby_url', 'emby_api_key', 'jellyfin_url', 'jellyfin_api_key'].some(
        (key) => live[key as keyof Settings] !== settings[key as keyof Settings],
      )
    ) {
      this.sourceCatalogs.clear();
      this.destinationCatalogs.clear();
      throw new ServiceError('A media server connection changed. Review and start a new job.');
    }
  }
  private async run(job: Job, requests: JobRequest[], settings: Settings): Promise<void> {
    if (this.stopping || !this.store.claimQueuedJob(job.id)) return;
    this.activeJobs.set(job.id, job);
    const catalogContext: { key?: string; value?: MigrationCatalog } = {};
    const destinationContext: DestinationCatalogContext = {};
    const cloneContext: { source?: MediaItem[]; key?: string } = {};
    job.status = 'running';
    job.started_at = new Date().toISOString();
    job.queue_ms = Math.max(0, Date.parse(job.started_at) - Date.parse(job.created_at));
    this.save(job);
    let releaseSnapshots: (() => Promise<void>) | undefined;
    try {
      // Durable jobs from older releases may still request "complete". Narrow them
      // before any source extraction or account mutation and report the actual scope.
      requests = requests.map((request) =>
        request.source_user_id
          ? { ...request, migration_scope: migrationScope(request.migration_scope) }
          : request,
      );
      if (job.kind === 'migrate') job.migration_scope = 'watched_only';
      this.save(job);
      this.checkJobStopped(job);
      this.assertConnections(settings);
      releaseSnapshots = this.sourceSnapshots.retainForJob(
        requests.flatMap((request) =>
          request.source_snapshot_id ? [request.source_snapshot_id] : [],
        ),
      );
      await this.withClient(
        settings,
        'jellyfin',
        async (jellyfin) => {
          if (requests.some((request) => request.source_user_id)) {
            if (!job.destination_catalog_id && this.destinationSnapshots.queuedSelection(settings))
              throw new ServiceError(
                'This queued migration has no saved Jellyfin catalog pin. Review a new migration.',
              );
            if (job.destination_catalog_id) {
              const info = await jellyfin.systemInfo();
              if (typeof info.Id !== 'string' || typeof info.Version !== 'string')
                throw new ServiceError('The Jellyfin identity could not be verified.');
              await this.destinationSnapshots.metadata(
                job.destination_catalog_id,
                settings,
                info.Id,
                info.Version,
              );
            }
          }
          const template =
            job.kind === 'role_update' ||
            job.kind === 'clone' ||
            requests.every((request) => request.access_disabled !== undefined)
              ? null
              : await this.template(jellyfin, settings);
          for (const request of requests) {
            const work = () =>
              this.mutationMutex.run(async () => {
                this.checkJobStopped(job);
                const accountStarted = performance.now();
                const previousResults = job.results.length;
                try {
                  if (request.access_disabled !== undefined) {
                    const member = this.assertMembershipRequest(request, settings);
                    if (!member || !request.discord_user_id || !request.target_user_id)
                      throw new ServiceError('Invalid queued membership action.');
                    const link = this.store.link(request.discord_user_id, request.membership_slot);
                    if (
                      !link ||
                      link.remote_id !== request.target_user_id ||
                      link.username !== request.username
                    )
                      throw new ServiceError(
                        'The linked membership account changed. Review it first.',
                      );
                    const family =
                      this.profiles.get('jellyfin', request.target_user_id, this.store.settings())
                        ?.family === true;
                    if (!family) await this.recipientIdentity(request.discord_user_id);
                    const available = await this.updateLinkedAccess(
                      jellyfin,
                      settings,
                      request.discord_user_id,
                      request.membership_slot!,
                      request.access_disabled,
                      () => {
                        this.checkJobStopped(job);
                        this.assertMembershipRequest(request, settings);
                      },
                    );
                    job.results.push({
                      username: request.username!,
                      target_user_id: request.target_user_id,
                      status: available ? 'completed' : 'partial',
                      created: false,
                      ...(!available
                        ? {
                            warnings: [
                              this.profiles.get(
                                'jellyfin',
                                request.target_user_id,
                                this.store.settings(),
                              )?.family
                                ? 'Family account access is managed manually. The membership access change was skipped.'
                                : 'This account was disabled outside Jellyport and remains disabled. Review it in Jellyfin.',
                            ],
                          }
                        : {}),
                    });
                  } else if (job.kind === 'clone')
                    await this.oneClone(job, request, settings, jellyfin, cloneContext);
                  else if (job.kind === 'role_update')
                    await this.oneRoleUpdate(job, request, settings, jellyfin);
                  else
                    await this.one(
                      job,
                      request,
                      settings,
                      jellyfin,
                      template!,
                      catalogContext,
                      destinationContext,
                    );
                } catch (error) {
                  if (error instanceof StoppedError) throw error;
                  if (!(error instanceof MediaError || error instanceof ServiceError)) throw error;
                  if (error instanceof DestinationPreparationError) throw error;
                  job.results.push({
                    username: request.username ?? request.source_user_id ?? '',
                    status: 'failed',
                    error: error.message,
                  });
                  if (error instanceof SourcePreparationError) throw error;
                } finally {
                  for (const result of job.results.slice(previousResults))
                    result.timing ??= {
                      elapsed_ms: Math.round(performance.now() - accountStarted),
                      phase_ms: {},
                    };
                }
                this.checkJobStopped(job);
                if (
                  request.source_user_id &&
                  this.sourceWorkload.snapshot().cooldown_remaining_ms > 0
                )
                  throw new ServiceError(
                    'Emby migration reads stopped after a slow or rejected request. Review results and wait before retrying; remaining accounts were not started.',
                  );
                job.progress.processed++;
                delete job.progress.current_user;
                delete job.progress.phase;
                delete job.progress.items_processed;
                delete job.progress.items_total;
                delete job.progress.items_updated;
                delete job.progress.catalog_pages;
                delete job.progress.catalog_items;
                delete job.progress.catalog_elapsed_ms;
                delete job.progress.catalog_last_page_ms;
                delete job.progress.catalog_cache_hit;
                this.save(job);
              });
            if (request.source_user_id || request.clone_source)
              await this.historyMutex.run(work, this.jobControllers.get(job.id)?.signal);
            else await work();
          }
        },
        this.jobControllers.get(job.id)?.signal,
      );
      this.checkJobStopped(job);
      const statuses = job.results.map((result) => result.status);
      job.status = statuses.every((status) => status === 'completed')
        ? 'completed'
        : statuses.every((status) => status === 'failed')
          ? 'failed'
          : 'partial';
    } catch (error) {
      if (job.cancel_requested || error instanceof CanceledError) {
        job.status = 'canceled';
        job.error =
          'Canceled. Already-applied changes were preserved; review results before rerunning.';
        for (const result of job.results)
          if (result.status === 'running') result.status = 'interrupted';
      } else if (error instanceof StoppedError || this.stopping) {
        job.status = 'interrupted';
        job.error = 'App stopped during this job. Review results before starting another update.';
      } else {
        job.status = 'failed';
        job.error =
          error instanceof MediaError || error instanceof ServiceError
            ? error.message
            : 'Job failed unexpectedly. Check configuration and server availability.';
      }
    } finally {
      try {
        await releaseSnapshots?.();
      } catch {
        if (job.status === 'completed') job.status = 'partial';
        job.error ??= 'Temporary snapshot cleanup failed. Review private storage permissions.';
      }
      job.finished_at = new Date().toISOString();
      job.elapsed_ms = Math.max(0, Date.parse(job.finished_at) - Date.parse(job.created_at));
      if (job.preview_timing)
        job.workflow_elapsed_ms = job.preview_timing.elapsed_ms + job.elapsed_ms;
      this.save(job);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.sourceWorkload.close();
    this.sourceCatalogs.clear();
    this.destinationCatalogs.clear();
    await this.sourceSnapshots.stop();
    await this.destinationSnapshots.stop();
    await Promise.allSettled([...this.clients].map((client) => client.close()));
    await Promise.allSettled([...this.jobTasks.values()]);
  }
  private assertStripeEntitlement(fact: StripeEntitlementFact): void {
    if (this.store.settings().new_subscriber_source !== 'stripe' || !this.verifyStripeEntitlement)
      throw new ServiceError(
        'Select and connect the verified Stripe subscription source before applying billing access.',
      );
    this.verifyStripeEntitlement(fact);
  }
  private assertAutomaticSubscriptionSource(source: string | null | undefined): void {
    if (this.store.settings().new_subscriber_source === 'stripe' && source !== 'stripe')
      throw new SubscriptionSourceChanged(
        'Stripe is the selected membership authority. Review this non-Stripe event explicitly; no further automatic account changes are authorized.',
      );
  }
  async recordStripeEntitlement(fact: StripeEntitlementFact): Promise<void> {
    this.assertStripeEntitlement(fact);
    const event = await this.recordSubscription({
      id: fact.event_id,
      action: fact.action,
      source: 'stripe',
      discord_user_id: fact.discord_user_id,
      emitted_at: fact.observed_at,
      detail: (this.store.settings().membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS).find(
        (tier) => tier.id === fact.tier_id,
      )?.plan_name,
      stripe_entitlement: fact,
    });
    if (!['applied', 'ignored'].includes(event.status))
      throw new ServiceError('Stripe membership action requires administrator review.');
  }
  async recordSubscription(incoming: SubscriptionInput): Promise<SubscriptionEvent> {
    if (incoming.source === 'stripe') {
      if (!incoming.stripe_entitlement)
        throw new ServiceError('Verified Stripe entitlement evidence is required.');
      this.assertStripeEntitlement(incoming.stripe_entitlement);
      if (
        incoming.id !== incoming.stripe_entitlement.event_id ||
        incoming.action !== incoming.stripe_entitlement.action ||
        incoming.discord_user_id !== incoming.stripe_entitlement.discord_user_id
      )
        throw new ServiceError(
          'The Stripe event does not match its verified account owner or action.',
        );
    }
    const existing = this.store.subscription(String(incoming.id));
    if (existing) return existing;
    if (!['subscribe', 'cancel', 'expire'].includes(incoming.action))
      throw new ServiceError('Unknown subscription action.');
    const event: SubscriptionEvent = {
      id: String(incoming.id),
      action: incoming.action,
      username: incoming.username,
      discord_user_id: incoming.discord_user_id,
      source: incoming.source,
      detail: incoming.detail,
      emitted_at: incoming.emitted_at,
      ...(incoming.stripe_entitlement
        ? { stripe_entitlement: structuredClone(incoming.stripe_entitlement) }
        : {}),
      status: 'pending',
      created_at: now(),
    };
    const settings = this.store.settings();
    if (event.discord_user_id && !this.recipientRequiresSubscription(event.discord_user_id)) {
      event.status = 'ignored';
      event.result =
        'Complimentary access is managed by an administrator; subscription event ignored.';
      this.store.saveSubscription(event);
      return event;
    }
    this.store.saveSubscription(event);
    let automatic =
      event.action === 'subscribe'
        ? settings.auto_provision
        : settings.auto_disable && (event.action === 'expire' || settings.disable_on_cancel);
    if (settings.new_subscriber_source === 'stripe' && event.source !== 'stripe') automatic = false;
    if (event.action === 'subscribe') {
      try {
        const tier = this.subscriptionTier(event, settings);
        event.tier_id = tier.id;
        event.account_limit = tier.account_limit;
        if (
          settings.auto_create_new_subscribers &&
          settings.new_subscriber_source !== 'stripe' &&
          settings.auto_provision &&
          event.source !== 'mee6_message' &&
          event.discord_user_id &&
          !this.memberships.get(event.discord_user_id, settings) &&
          !this.store.linksForMember(event.discord_user_id).length
        ) {
          automatic = false;
          event.result =
            'Waiting for a recognized MEE6 plan announcement or administrator review; no account was created.';
        }
        if (
          event.discord_user_id &&
          this.isMembershipDowngrade(event.discord_user_id, tier.account_limit, settings) &&
          !settings.auto_disable
        )
          automatic = false;
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        event.error = error.message;
        automatic = false;
      }
      this.store.saveSubscription(event);
    }
    if (
      !automatic &&
      settings.auto_provision &&
      settings.auto_create_new_subscribers &&
      settings.new_subscriber_source !== 'stripe' &&
      event.action === 'subscribe' &&
      event.discord_user_id &&
      ['discord_role', 'role_reconciliation'].includes(event.source ?? '') &&
      !this.memberships.get(event.discord_user_id, settings) &&
      !this.store.linksForMember(event.discord_user_id).length
    ) {
      const pending = this.store
        .subscriptions()
        .filter(
          (candidate) =>
            candidate.id !== event.id &&
            candidate.status === 'pending' &&
            candidate.action === 'subscribe' &&
            candidate.discord_user_id === event.discord_user_id &&
            this.newSubscriberGuard(candidate, settings) &&
            resolveMembershipTier(
              candidate.detail ?? '',
              settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS,
            ),
        );
      // A role is permission to retry one fresh announcement, never a source of
      // plan identity or authority to replay older/failed account creation.
      if (pending.length === 1) {
        try {
          if ((await this.requireBot().membershipActive(event.discord_user_id)) === true) {
            const applied = await this.applySubscription(pending[0]!.id, true);
            if (applied.status === 'applied') {
              event.status = 'ignored';
              event.result =
                'The fresh MEE6 plan announcement was applied after the active subscriber role was verified.';
              event.error = null;
              this.store.saveSubscription(event);
            }
          }
        } catch {
          // The announcement retains its own failure/review state. Never retry
          // credentials or create a second account job from this generic event.
        }
      }
    }
    if (automatic && event.discord_user_id)
      try {
        await this.applySubscription(event.id, true);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
      }
    return this.store.subscription(event.id)!;
  }
  async applySubscription(id: string, automatic = false): Promise<SubscriptionEvent> {
    return this.subscriptionMutex.run(async () => {
      const event = this.store.subscription(id);
      if (!event) throw new ServiceError('Subscription event not found.');
      if (['applied', 'ignored', 'processing'].includes(event.status)) return event;
      const assertSource = () => {
        if (automatic) this.assertAutomaticSubscriptionSource(event.source);
      };
      const holdForSourceReview = () => {
        event.status = 'pending';
        event.error = null;
        event.result =
          'Stripe is the selected membership authority. This non-Stripe event requires explicit administrator review. Any completed account work is preserved; no further automatic changes were made.';
        this.store.saveSubscription(event);
        return event;
      };
      try {
        assertSource();
      } catch (error) {
        if (error instanceof SubscriptionSourceChanged) return holdForSourceReview();
        throw error;
      }
      if (event.source === 'stripe') {
        if (!event.stripe_entitlement)
          throw new ServiceError('Verified Stripe entitlement evidence is required.');
        this.assertStripeEntitlement(event.stripe_entitlement);
        if (
          event.id !== event.stripe_entitlement.event_id ||
          event.action !== event.stripe_entitlement.action ||
          event.discord_user_id !== event.stripe_entitlement.discord_user_id
        )
          throw new ServiceError(
            'The Stripe event does not match its verified account owner or action.',
          );
      }
      if (!event.discord_user_id)
        throw new ServiceError(
          'This message could not be resolved to one Discord user ID. Use a manual account action after verifying the member.',
        );
      if (!this.recipientRequiresSubscription(event.discord_user_id)) {
        event.status = 'ignored';
        event.result =
          'Complimentary access is managed by an administrator; subscription event ignored.';
        this.store.saveSubscription(event);
        return event;
      }
      const waitingSettings = this.store.settings();
      if (
        automatic &&
        event.action === 'subscribe' &&
        this.newSubscriberGuard(event, waitingSettings) &&
        waitingSettings.discord_member_role_id &&
        event.source !== 'stripe' &&
        !this.memberships.get(event.discord_user_id, waitingSettings) &&
        !this.store.linksForMember(event.discord_user_id).length
      ) {
        let active: boolean | null = null;
        try {
          active = await this.requireBot().membershipActive(event.discord_user_id);
        } catch {
          /* Keep the verified announcement pending. */
        }
        if (active !== true) {
          event.status = 'pending';
          event.error = null;
          event.result =
            'Waiting for the active subscriber role to be verified. No account was created; a fresh role event or administrator review can continue this signup.';
          this.store.saveSubscription(event);
          return event;
        }
      }
      const emitted = Date.parse(event.emitted_at ?? '');
      if (
        Number.isFinite(emitted) &&
        this.store
          .subscriptions()
          .some(
            (previous) =>
              previous.discord_user_id === event.discord_user_id &&
              previous.status === 'applied' &&
              Date.parse(previous.emitted_at ?? '') > emitted,
          )
      ) {
        event.status = 'ignored';
        event.result = 'A newer membership event was already applied; obsolete event ignored.';
        this.store.saveSubscription(event);
        return event;
      }
      event.status = 'processing';
      event.error = null;
      this.store.saveSubscription(event);
      try {
        assertSource();
        const memberId = event.discord_user_id;
        const settings = this.store.settings();
        if (
          event.action === 'expire' &&
          ['discord_role', 'role_reconciliation'].includes(event.source ?? '')
        ) {
          const active = await this.requireBot().membershipActive(memberId);
          if (active === null)
            throw new ServiceError('Membership could not be verified. No account was disabled.');
          if (active) {
            event.status = 'ignored';
            event.result =
              'Member currently has the active role; obsolete expiration event ignored.';
            this.store.saveSubscription(event);
            return event;
          }
        }
        if (event.action === 'subscribe') {
          const tier = this.subscriptionTier(event, settings);
          if (
            automatic &&
            (!settings.auto_provision ||
              (this.isMembershipDowngrade(memberId, tier?.account_limit, settings) &&
                !settings.auto_disable))
          )
            throw new ServiceError(
              'This tier change requires administrator review under the current automation settings.',
            );
          event.tier_id = tier.id;
          event.account_limit = tier.account_limit;
          const existing = this.memberships.get(memberId, settings);
          if (existing?.new_subscriber_pending) {
            event.status = 'pending';
            event.error = null;
            event.result =
              'A previous automatic signup remains unresolved. Review the account results and explicitly choose Jellyfin provisioning in Memberships; no account was created or migrated.';
            this.store.saveSubscription(event);
            return event;
          }
          let newSubscriberJob: Job | undefined;
          const newSubscriber =
            automatic && !existing && !this.store.linksForMember(memberId).length
              ? this.newSubscriberGuard(event, settings)
              : null;
          if (newSubscriber) {
            try {
              newSubscriberJob = await this.provisionMembership(
                memberId,
                tier.id,
                undefined,
                undefined,
                newSubscriber,
                event.stripe_entitlement,
                automatic ? (event.source ?? '') : undefined,
              );
            } catch (error) {
              if (newSubscriber.enrolled_membership)
                await this.membershipMutex.run(() =>
                  this.mutationMutex.run(async () => {
                    this.memberships.holdProvisioning(newSubscriber.enrolled_membership!);
                  }),
                );
              // An established identity is a normal opt-in hold. Connectivity,
              // configuration races and unverifiable reads remain visible failures.
              if (!(error instanceof NewSubscriberOptInRequired)) throw error;
            }
          }
          if (newSubscriberJob) {
            event.job_id = newSubscriberJob.id;
            delete event.report_cleared;
            this.store.saveSubscription(event);
            await this.jobTasks.get(newSubscriberJob.id);
            assertSource();
            const outcome = this.getJob(newSubscriberJob.id);
            if (
              !['completed', 'partial'].includes(outcome.status) ||
              outcome.results.length !== tier.account_limit ||
              outcome.results.some(
                (result) =>
                  result.status !== 'completed' &&
                  !(
                    result.status === 'partial' &&
                    result.discord_delivery === 'failed' &&
                    result.created &&
                    !result.error &&
                    !result.warnings?.length &&
                    !result.data?.warnings.length
                  ),
              )
            ) {
              // A later announcement must not turn an uncertain first signup
              // into an unguarded retry. Preserve completed slots and any newer
              // administrator decision, but require an explicit provisioning
              // opt-in before filling additional slots after this failure.
              await this.membershipMutex.run(() =>
                this.mutationMutex.run(async () => {
                  if (newSubscriber?.enrolled_membership)
                    this.memberships.holdProvisioning(newSubscriber.enrolled_membership);
                }),
              );
              throw new ServiceError(
                'New-subscriber account creation failed. Automatic provisioning is held for administrator review; completed account slots are preserved.',
              );
            }
            event.result = outcome.results.some((result) => result.discord_delivery === 'failed')
              ? 'Jellyfin accounts created, but private credential delivery failed. Reveal credentials in the linked job; creation will not be retried.'
              : 'New-subscriber Jellyfin accounts created and credentials sent privately. No Emby history was read or migrated.';
            if (newSubscriber?.enrolled_membership)
              await this.membershipMutex.run(() =>
                this.mutationMutex.run(async () => {
                  this.memberships.completeProvisioning(newSubscriber.enrolled_membership!);
                }),
              );
          } else if (
            (!existing || existing.provision_jellyfin === false) &&
            !this.store.linksForMember(memberId).length
          ) {
            // A subscription establishes entitlement. It must not silently opt a
            // new member into a second media server or start a history migration.
            await this.membershipMutex.run(() =>
              this.mutationMutex.run(async () => {
                const current = this.memberships.get(memberId, this.store.settings());
                if (
                  JSON.stringify(settings) !== JSON.stringify(this.store.settings()) ||
                  current?.revision !== existing?.revision
                )
                  throw new ServiceError(
                    'Configuration or membership changed. Review and try again.',
                  );
                if (!current && this.memberships.hasOtherScope(memberId, settings))
                  throw new ServiceError(
                    'Restore the original paired server before changing this membership.',
                  );
                const identity = await this.requireBot().recipientIdentity(memberId, false);
                if (identity.id && identity.id !== memberId)
                  throw new ServiceError(
                    'Discord returned a different member. Reload and try again.',
                  );
                if (
                  JSON.stringify(settings) !== JSON.stringify(this.store.settings()) ||
                  this.memberships.get(memberId, settings)?.revision !== existing?.revision
                )
                  throw new ServiceError(
                    'Configuration or membership changed. Review and try again.',
                  );
                this.checkStopped();
                assertSource();
                if (event.stripe_entitlement)
                  this.assertStripeEntitlement(event.stripe_entitlement);
                this.memberships.save(
                  {
                    discord_user_id: memberId,
                    base_username: current?.base_username ?? identity.username,
                    tier_id: tier.id,
                    account_limit: tier.account_limit,
                    access_mode: 'subscription',
                    provision_jellyfin: false,
                    active: true,
                  },
                  settings,
                  current?.revision,
                );
              }),
            );
            event.result =
              'Membership entitlement updated. Jellyfin provisioning remains opt-in for existing members, established identities and unverified signups; no media account was created or migrated.';
          } else {
            const job = await this.provisionMembership(
              memberId,
              tier.id,
              undefined,
              undefined,
              undefined,
              event.stripe_entitlement,
              automatic ? (event.source ?? '') : undefined,
            );
            event.job_id = job.id;
            delete event.report_cleared;
            this.store.saveSubscription(event);
            await this.jobTasks.get(job.id);
            assertSource();
            const outcome = this.getJob(job.id);
            if (
              ['failed', 'interrupted'].includes(outcome.status) ||
              outcome.results.some((result) => result.status === 'failed')
            )
              throw new ServiceError('Account provisioning failed. Review the linked job.');
            event.result =
              'Membership account allowance applied; existing passwords and history preserved.';
          }
        } else {
          if (
            automatic &&
            (!settings.auto_disable || (event.action === 'cancel' && !settings.disable_on_cancel))
          )
            throw new ServiceError(
              'This access change requires administrator review under the current automation settings.',
            );
          let linkedAccessUpdated = false;
          await this.membershipMutex.run(() =>
            this.mutationMutex.run(async () => {
              this.checkStopped();
              assertSource();
              const previous = this.memberships.get(memberId, this.store.settings());
              if (previous?.access_mode === 'complimentary') {
                event.status = 'ignored';
                event.result =
                  'Complimentary access is managed by an administrator; subscription event ignored.';
                return;
              }
              if (!previous && this.memberships.hasOtherScope(memberId, this.store.settings()))
                throw new ServiceError(
                  'This member belongs to a different paired server configuration. No account access was modified.',
                );
              const links = this.store.linksForMember(memberId);
              if (!links.length && !previous)
                throw new ServiceError(
                  'This Discord member has no Jellyport identity link. No account was disabled.',
                );
              const primary = this.store.link(memberId) ?? links[0];
              const saveInactive = () => (
                assertSource(),
                event.stripe_entitlement && this.assertStripeEntitlement(event.stripe_entitlement),
                this.memberships.save(
                  {
                    discord_user_id: memberId,
                    base_username: previous?.base_username ?? primary!.username,
                    tier_id: previous?.tier_id ?? 'sloop',
                    access_mode: previous?.access_mode ?? 'subscription',
                    provision_jellyfin: previous?.provision_jellyfin ?? true,
                    ...(previous?.new_subscriber_pending
                      ? { new_subscriber_pending: true as const }
                      : {}),
                    account_limit: previous?.account_limit ?? 1,
                    active: false,
                    inactive_reason: event.action as 'cancel' | 'expire',
                  },
                  settings,
                  previous?.revision,
                )
              );
              if (!links.length) {
                if (JSON.stringify(settings) !== JSON.stringify(this.store.settings()))
                  throw new ServiceError('Configuration changed. Review and try again.');
                saveInactive();
                return;
              }
              await this.withClient(settings, 'jellyfin', async (jellyfin) => {
                // Capture all slots after an in-flight account mutation finishes.
                for (const link of links)
                  this.assertLinkedTarget(await jellyfin.user(link.remote_id), link, settings);
                const member = saveInactive();
                const guard = () => {
                  assertSource();
                  if (event.stripe_entitlement)
                    this.assertStripeEntitlement(event.stripe_entitlement);
                  this.checkStopped();
                  if (
                    this.memberships.get(memberId, this.store.settings())?.revision !==
                    member.revision
                  )
                    throw new ServiceError(
                      'The membership changed. Review its current access before retrying.',
                    );
                };
                guard();
                for (const link of links)
                  await this.updateLinkedAccess(
                    jellyfin,
                    settings,
                    memberId,
                    link.membership_slot,
                    true,
                    guard,
                  );
                linkedAccessUpdated = true;
              });
            }),
          );
          if (event.status !== 'ignored')
            event.result = linkedAccessUpdated
              ? 'Eligible linked account access disabled; manually flagged Family accounts, passwords, and watch history preserved.'
              : 'Membership entitlement marked inactive; no Jellyfin account was required or modified.';
        }
        if (event.status !== 'ignored') event.status = 'applied';
      } catch (error) {
        if (error instanceof SubscriptionSourceChanged) return holdForSourceReview();
        if (!this.recipientRequiresSubscription(event.discord_user_id)) {
          event.status = 'ignored';
          event.error = null;
          event.result =
            'Complimentary access is managed by an administrator; subscription event ignored.';
          this.store.saveSubscription(event);
          return event;
        }
        event.status = 'failed';
        event.error =
          error instanceof ServiceError || error instanceof MediaError
            ? error.message
            : 'Subscription action failed. Check bot connectivity and account links.';
        this.store.saveSubscription(event);
        throw new ServiceError(event.error);
      }
      this.store.saveSubscription(event);
      return event;
    });
  }
  private subscriptionTier(event: SubscriptionEvent, settings: Settings) {
    const tiers = settings.membership_tiers ?? DEFAULT_MEMBERSHIP_TIERS;
    if (event.source === 'stripe') {
      if (!event.stripe_entitlement)
        throw new ServiceError('Verified Stripe entitlement evidence is required.');
      this.assertStripeEntitlement(event.stripe_entitlement);
      const tier = tiers.find((entry) => entry.id === event.stripe_entitlement!.tier_id);
      if (!tier)
        throw new ServiceError('Map the verified Stripe price to a current membership tier.');
      return tier;
    }
    if (event.source !== 'mee6_message' || !event.detail?.trim()) {
      const previous = event.discord_user_id
        ? this.memberships.get(event.discord_user_id, settings)
        : null;
      const tier = previous
        ? tiers.find((entry) => entry.id === previous.tier_id)
        : (tiers.find((entry) => entry.id === 'sloop' && entry.account_limit === 1) ??
          tiers.find((entry) => entry.account_limit === 1));
      if (!tier)
        throw new ServiceError('Choose a configured membership tier before applying this event.');
      return tier;
    }
    const tier = resolveMembershipTier(event.detail, tiers);
    if (!tier)
      throw new ServiceError(
        'This subscription plan is not configured. Map its exact plan name in Settings and review the event.',
      );
    return tier;
  }
  private isMembershipDowngrade(
    memberId: string,
    limit: number | undefined,
    settings: Settings,
  ): boolean {
    const previous = this.memberships.get(memberId, settings);
    const desired = limit ?? previous?.account_limit ?? 1;
    return (
      desired < (previous?.account_limit ?? 1) ||
      this.store
        .linksForMember(memberId)
        .some((link) => link.membership_slot > desired && !link.disabled_by_jellyport)
    );
  }
  ignoreSubscription(id: string): SubscriptionEvent {
    const event = this.store.subscription(id);
    if (!event) throw new ServiceError('Subscription event not found.');
    if (event.status === 'processing')
      throw new ServiceError('Wait for this subscription action to finish.');
    event.status = 'ignored';
    this.store.saveSubscription(event);
    return event;
  }
  private async setAccess(
    client: MediaAPI,
    remoteId: string,
    policy: JsonObject,
    memberId: string,
    disabled: boolean,
    slot = 1,
  ): Promise<void> {
    this.store.setLinkPending(memberId, disabled, slot);
    try {
      await client.setPolicy(remoteId, policy);
    } catch (error) {
      if (
        error instanceof MediaError &&
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        this.store.setLinkPending(memberId, null, slot);
      throw error;
    }
  }
  async reconcileMemberships(): Promise<void> {
    const settings = this.store.settings();
    if (!settings.discord_role_events || !settings.discord_member_role_id || !this.bot) return;
    const memberIds = new Set([
      ...this.store.links().map((link) => link.discord_user_id),
      ...this.memberships.list(settings).map((member) => member.discord_user_id),
    ]);
    for (const memberId of memberIds) {
      const links = this.store.linksForMember(memberId);
      const member = this.memberships.get(memberId, settings);
      if (
        member?.access_mode === 'complimentary' ||
        (!member && this.memberships.hasOtherScope(memberId, settings))
      )
        continue;
      const active = await this.bot.membershipActive(memberId);
      if (active === null) continue;
      if (active && member?.active === false && member.inactive_reason === 'cancel') continue;
      const limit = member?.account_limit ?? 1;
      const needsRenewal =
        member?.active === false ||
        links.some(
          (link) =>
            link.membership_slot <= limit &&
            (link.disabled_by_jellyport || link.pending_disabled !== null),
        );
      const needsExpiration = member
        ? member.active !== false
        : links.some((link) => !link.disabled_by_jellyport);
      if ((active && !needsRenewal) || (!active && !needsExpiration)) continue;
      const action = active ? 'subscribe' : 'expire';
      if (
        this.store
          .subscriptions()
          .some(
            (event) =>
              event.source === 'role_reconciliation' &&
              event.discord_user_id === memberId &&
              event.action === action &&
              ['pending', 'processing', 'failed'].includes(event.status),
          )
      )
        continue;
      await this.recordSubscription({
        id: `reconcile-${randomUUID()}`,
        action,
        discord_user_id: memberId,
        username: (this.store.link(memberId) ?? links[0])?.username,
        source: 'role_reconciliation',
        emitted_at: now(),
      });
    }
    if (settings.auto_provision) {
      const members = await this.bot.activeMembers();
      if (members === null) return;
      for (const member of members) {
        const known = this.memberships.get(member.id, settings);
        if (
          known?.access_mode === 'complimentary' ||
          (known?.active === false && known.inactive_reason === 'cancel') ||
          (!known && this.memberships.hasOtherScope(member.id, settings))
        )
          continue;
        if (
          this.store.link(member.id) ||
          this.store
            .subscriptions()
            .some(
              (event) =>
                event.source === 'role_reconciliation' &&
                event.discord_user_id === member.id &&
                event.action === 'subscribe' &&
                event.status !== 'ignored',
            )
        )
          continue;
        await this.recordSubscription({
          id: `reconcile-${randomUUID()}`,
          action: 'subscribe',
          discord_user_id: member.id,
          username: member.username,
          source: 'role_reconciliation',
          emitted_at: now(),
        });
      }
    }
  }
}
