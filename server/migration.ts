import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createMatcher, type MatchPlan, type PreparedMatcher } from './matching.js';
import {
  isObject,
  type MediaAPI,
  type MediaItem,
  type MediaUser,
  type MediaUserDataPatch,
  type MediaPlaylist,
} from './media.js';
import { MediaError, ServiceError } from './errors.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';

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
export type MigrationScope = 'complete' | 'watched_only';
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : 0;
const ticks = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function playedDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? new Date(time).toISOString() : undefined;
}
const rating = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;

export function hasPersonalState(item: MediaItem): boolean {
  const data = item.UserData ?? {};
  return (
    data.IsFavorite === true ||
    typeof data.Likes === 'boolean' ||
    rating(data.Rating) ||
    (playable.has(item.Type ?? '') &&
      (data.Played === true ||
        ticks(data.PlaybackPositionTicks) > 0 ||
        count(data.PlayCount) > 0 ||
        !!playedDate(data.LastPlayedDate)))
  );
}

/** Additive merge: no unwatch, no unfavorite, no summed counts, and ties favor Jellyfin. */
export function mergeUserData(
  source: MediaItem,
  target: MediaItem,
  scope: MigrationScope = 'complete',
): MediaUserDataPatch {
  const from = source.UserData ?? {},
    to = target.UserData ?? {};
  const patch: MediaUserDataPatch = {};
  if (scope === 'watched_only') {
    if (!playable.has(source.Type ?? '') || from.Played !== true || to.Played === true)
      return patch;
    patch.Played = true;
    return patch;
  }
  if (from.IsFavorite === true && to.IsFavorite !== true) patch.IsFavorite = true;
  if (typeof from.Likes === 'boolean' && typeof to.Likes !== 'boolean') patch.Likes = from.Likes;
  if (rating(from.Rating) && !rating(to.Rating)) patch.Rating = from.Rating;
  // Container played/count/position values are derived from their children on each server.
  if (!playable.has(source.Type ?? '')) return patch;
  if (from.Played === true && to.Played !== true) patch.Played = true;
  if (count(from.PlayCount) > count(to.PlayCount)) patch.PlayCount = count(from.PlayCount);
  const sourceDate = playedDate(from.LastPlayedDate),
    targetDate = playedDate(to.LastPlayedDate);
  const newer = !!sourceDate && (!targetDate || sourceDate > targetDate);
  if (newer) patch.LastPlayedDate = sourceDate;
  const position = ticks(from.PlaybackPositionTicks),
    existing = ticks(to.PlaybackPositionTicks);
  const knownPosition =
    typeof from.PlaybackPositionTicks === 'number' &&
    Number.isSafeInteger(from.PlaybackPositionTicks) &&
    from.PlaybackPositionTicks >= 0;
  const duration = ticks(target.RunTimeTicks);
  if (
    knownPosition &&
    ((!!sourceDate && !!targetDate && sourceDate > targetDate) ||
      (!targetDate && existing === 0 && to.Played !== true)) &&
    (position === 0 || duration === 0 || position < duration) &&
    position !== existing
  )
    patch.PlaybackPositionTicks = position;
  return patch;
}

export function statePlan(
  source: MediaItem[],
  target: MediaItem[],
  settings: Settings,
  scope: MigrationScope = 'complete',
  preparedMatcher?: PreparedMatcher,
): MatchPlan {
  const match = preparedMatcher ?? createMatcher(target, settings.path_mappings);
  return match(
    source.filter((item) =>
      scope === 'watched_only'
        ? playable.has(item.Type ?? '') && item.UserData?.Played === true
        : item.Type !== 'Playlist' && hasPersonalState(item),
    ),
  );
}

export function portableConfiguration(
  source: unknown,
  template: unknown,
): { configuration: Record<string, unknown>; copied: string[] } {
  const configuration = isObject(template) ? structuredClone(template) : {};
  const copied: string[] = [];
  if (!isObject(source)) return { configuration, copied };
  for (const key of [
    'PlayDefaultAudioTrack',
    'DisplayMissingEpisodes',
    'HidePlayedInLatest',
    'RememberAudioSelections',
    'RememberSubtitleSelections',
    'EnableNextEpisodeAutoPlay',
  ]) {
    if (typeof source[key] === 'boolean') {
      configuration[key] = source[key];
      copied.push(key);
    }
  }
  for (const key of ['AudioLanguagePreference', 'SubtitleLanguagePreference']) {
    if (
      typeof source[key] === 'string' &&
      source[key].length <= 64 &&
      !/[\u0000-\u001f\u007f]/.test(source[key])
    ) {
      configuration[key] = source[key];
      copied.push(key);
    }
  }
  if (
    typeof source.SubtitleMode === 'string' &&
    ['Default', 'Always', 'OnlyForced', 'None', 'Smart'].includes(source.SubtitleMode)
  ) {
    configuration.SubtitleMode = source.SubtitleMode;
    copied.push('SubtitleMode');
  }
  return { configuration, copied };
}

export interface SourcePlaylist {
  playlist: MediaPlaylist;
  items: MediaItem[];
  error?: string;
}
export interface SourceSnapshot {
  catalog?: { captured_at: string; items: number };
  user: MediaUser;
  items: MediaItem[];
  playlists: SourcePlaylist[];
  warnings: string[];
}
export interface MigrationDetails {
  /** Aggregate destination mutation measurements, excluding account and item identities. */
  write_metrics?: {
    attempts: number;
    succeeded: number;
    failed: number;
    cumulative_ms: number;
    max_ms: number;
    peak_in_flight: number;
  };
  /** Bounded diagnostics for the authenticated administrator; never application logs. */
  failed_updates?: { target_id: string; item_type: string; error: string }[];
  verification?: {
    checked: number;
    verified: number;
    preserved_newer: number;
    missing: number;
    mismatched: number;
    unsupported_fields: number;
  };
  items_updated: number;
  favorites: number;
  resume_positions: number;
  play_counts: number;
  last_played_dates: number;
  ratings: number;
  preferences: string[];
  avatar: boolean;
  playlists_created: number;
  playlists_existing: number;
  playlist_items_added: number;
  playlist_items_skipped: number;
  playlist_duplicates_skipped: number;
  failed_items: number;
  history_dates_missing: number;
  warnings: string[];
}
export const migrationDetails = (): MigrationDetails => ({
  items_updated: 0,
  favorites: 0,
  resume_positions: 0,
  play_counts: 0,
  last_played_dates: 0,
  ratings: 0,
  preferences: [],
  avatar: false,
  playlists_created: 0,
  playlists_existing: 0,
  playlist_items_added: 0,
  playlist_items_skipped: 0,
  playlist_duplicates_skipped: 0,
  failed_items: 0,
  history_dates_missing: 0,
  warnings: [],
});
export function migrationWarning(details: MigrationDetails, message: string): void {
  if (!details.warnings.includes(message) && details.warnings.length < 50)
    details.warnings.push(message);
}

export async function readMigrationSource(
  emby: MediaAPI,
  sourceId: string,
  scope: MigrationScope = 'complete',
  savedItems?: MediaItem[],
  signal?: AbortSignal,
): Promise<SourceSnapshot> {
  if (!Array.isArray(savedItems))
    throw new ServiceError(
      'Prepared source history is required. Read bounded user state or a saved snapshot before migration.',
    );
  const check = () => signal?.throwIfAborted();
  check();
  const user = await emby.user(sourceId);
  check();
  const items = savedItems;
  const result: SourceSnapshot = { user, items, playlists: [], warnings: [] };
  if (scope === 'watched_only') return result;
  if (!emby.playlists || !emby.playlistItems) {
    result.warnings.push('This source client cannot read playlists.');
    return result;
  }
  try {
    check();
    const playlists = await emby.playlists(sourceId);
    check();
    if (playlists.length > 500)
      result.warnings.push(
        'Only the first 500 source playlists were read. Remaining playlists were skipped.',
      );
    let total = 0;
    let retainedBytes = 0;
    for (const playlist of playlists.slice(0, 500)) {
      check();
      try {
        const entries = await emby.playlistItems(playlist.Id, sourceId);
        check();
        retainedBytes += Buffer.byteLength(JSON.stringify(playlist));
        for (const item of entries) {
          retainedBytes += Buffer.byteLength(JSON.stringify(item));
          if (retainedBytes > 32 * 1024 * 1024)
            throw new ServiceError(
              'The source playlists exceed the supported memory budget. No destination changes were started.',
            );
        }
        if (entries.length > 100_000 - total) {
          result.warnings.push(
            'The total source playlist limit of 100,000 entries was reached. Remaining playlists were skipped.',
          );
          break;
        }
        total += entries.length;
        result.playlists.push({ playlist, items: entries });
      } catch (error) {
        check();
        if (error instanceof ServiceError) throw error;
        result.playlists.push({
          playlist,
          items: [],
          error: 'A source playlist could not be read.',
        });
      }
    }
  } catch (error) {
    check();
    if (error instanceof ServiceError) throw error;
    result.warnings.push('Source playlists could not be read; library data can still migrate.');
  }
  return result;
}

export async function migrateItemState(
  jellyfin: MediaAPI,
  userId: string,
  plan: MatchPlan,
  details: MigrationDetails,
  stopped: () => void,
  saved: () => void,
  options: {
    concurrency?: number;
    /** Revalidate reviewed account boundaries before a bounded mutation batch. */
    before_write?: () => Promise<void>;
    progress?: (processed: number, total: number, updated: number) => void;
    migration_scope?: MigrationScope;
    expectation?: (target: MediaItem, patch: MediaUserDataPatch, unsupported: string[]) => void;
  } = {},
): Promise<number> {
  const concurrency = options.concurrency ?? 6;
  // Historical jobs and clients may still send "complete". The public migration
  // writer always transfers only additive played flags, irrespective of that value.
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6)
    throw new ServiceError('Migration concurrency must be between 1 and 6.');
  // Every worker must yield before an already-merged history can starve a pending
  // cancellation timer for more than 1,000 matches across the whole pool.
  const yieldInterval = Math.min(250, Math.floor(1000 / concurrency));
  stopped();
  let capabilities = { userData: false };
  try {
    if (jellyfin.migrationCapabilities) capabilities = await jellyfin.migrationCapabilities();
  } catch {
    stopped();
    migrationWarning(
      details,
      'Jellyfin partial user-data support could not be verified. Watched flags were not changed.',
    );
  }
  let applied = 0;
  const metrics = (details.write_metrics ??= {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    cumulative_ms: 0,
    max_ms: 0,
    peak_in_flight: 0,
  });
  let inFlight = 0;
  const confirmedPlayed = new Set<string>();
  const attemptedTargets = new Set<string>();
  let processed = 0;
  let reportedUpdated = 0;
  let fatal = false;
  let fatalError: unknown;
  const latchFailure = (error: unknown) => {
    if (fatal) return;
    fatal = true;
    fatalError = error;
  };
  const guard = () => {
    if (fatal) throw fatalError;
    try {
      stopped();
    } catch (error) {
      latchFailure(error);
      throw error;
    }
  };
  guard();
  const apply = async (match: MatchPlan['matches'][number]): Promise<boolean> => {
    guard();
    try {
      if (!playable.has(match.source.Type ?? '') || match.source.UserData?.Played !== true)
        return false;
      const target = { ...match.target };
      if (confirmedPlayed.has(target.Id)) target.UserData = { ...target.UserData, Played: true };
      const patch = mergeUserData(match.source, target, 'watched_only');
      // The access-scoped candidate batch supplied fresh flags. Setting only true is
      // additive and idempotent, so individual chronology reads are unnecessary.
      // The caller independently re-reads all matched flags after workers drain.
      if (!Object.keys(patch).length) {
        confirmedPlayed.add(target.Id);
        options.expectation?.(target, {}, []);
        return false;
      }
      const supported = capabilities.userData && !!jellyfin.updateUserData;
      options.expectation?.(target, patch, supported ? [] : ['Played']);
      if (!supported)
        throw new ServiceError(
          'Watched-flag updates require Jellyfin’s partial user-data API. Legacy watched endpoints were not used because they can change resume positions, dates and counts.',
        );
      if (attemptedTargets.has(target.Id))
        throw new ServiceError(
          'An earlier played-flag update for this destination had an unverified outcome. No duplicate mutation was sent.',
        );
      guard();
      try {
        await options.before_write?.();
      } catch (error) {
        latchFailure(error);
        throw error;
      }
      guard();
      attemptedTargets.add(target.Id);
      const began = performance.now();
      metrics.attempts++;
      inFlight++;
      metrics.peak_in_flight = Math.max(metrics.peak_in_flight, inFlight);
      try {
        await jellyfin.updateUserData!(userId, target.Id, { Played: true });
        metrics.succeeded++;
      } catch (error) {
        metrics.failed++;
        throw error;
      } finally {
        inFlight--;
        const elapsed = performance.now() - began;
        metrics.cumulative_ms += elapsed;
        metrics.max_ms = Math.max(metrics.max_ms, elapsed);
      }
      confirmedPlayed.add(target.Id);
      applied++;
      details.items_updated++;
      saved();
      return true;
    } catch (error) {
      guard();
      details.failed_items++;
      const message =
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'An item could not be updated. Review the migration and retry.';
      const failures = (details.failed_updates ??= []);
      if (failures.length < 200)
        failures.push({
          target_id: match.target.Id,
          item_type: match.source.Type ?? 'Unknown',
          error: message,
        });
      else
        migrationWarning(
          details,
          'Failed-update details are limited to 200 items. The full failed-item count is shown.',
        );
      migrationWarning(details, message);
      return false;
    }
  };
  // Different Emby versions/editions can resolve to one Jellyfin item. Their reads and
  // mutations must remain ordered even while unrelated target items run concurrently.
  const byTarget = new Map<string, MatchPlan['matches']>();
  for (const match of plan.matches) {
    const group = byTarget.get(match.target.Id) ?? [];
    group.push(match);
    byTarget.set(match.target.Id, group);
  }
  const groups = [...byTarget.values()];
  let next = 0;
  const worker = async () => {
    try {
      while (!fatal) {
        const group = groups[next++];
        if (!group) return;
        for (const match of group) {
          if (fatal) return;
          const changed = await apply(match);
          processed++;
          if (changed) reportedUpdated++;
          options.progress?.(processed, plan.matches.length, reportedUpdated);
          // Unchanged histories can complete entirely through resolved promises. Yield
          // periodically so timer/request-driven cancellation can run between no-ops.
          if (processed % yieldInterval === 0) {
            await delay(0);
            guard();
          }
        }
      }
    } catch (error) {
      latchFailure(error);
      throw error;
    }
  };
  // Drain every worker before propagating a fatal guard/stop. Callers can then release
  // their account mutation lock without leaving remote writes running behind it.
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  if (fatal) throw fatalError;
  return applied;
}

export async function migratePlaylists(
  store: Store,
  settings: Settings,
  sourceId: string,
  userId: string,
  source: SourcePlaylist[],
  targetItems: MediaItem[],
  jellyfin: MediaAPI,
  details: MigrationDetails,
  stopped: () => void,
  saved: () => void,
  preparedMatcher?: PreparedMatcher,
): Promise<void> {
  if (!source.length) return;
  let capabilities = { privatePlaylists: false, playlistDuplicates: false };
  try {
    if (jellyfin.migrationCapabilities) capabilities = await jellyfin.migrationCapabilities();
  } catch {
    migrationWarning(
      details,
      'Jellyfin private playlist support could not be verified. Playlists were skipped.',
    );
    return;
  }
  if (!capabilities.privatePlaylists || !jellyfin.playlistItems || !jellyfin.createPlaylist) {
    migrationWarning(
      details,
      'Private playlist migration requires Jellyfin 10.9 or newer and a compatible client. No public playlist was created.',
    );
    return;
  }
  const matchPlaylist = preparedMatcher ?? createMatcher(targetItems, settings.path_mappings);
  for (const entry of source) {
    stopped();
    if (entry.error) {
      migrationWarning(details, entry.error);
      continue;
    }
    try {
      const plan = matchPlaylist(entry.items);
      const mapped = new Map(plan.matches.map((match) => [match.source.Id, match.target.Id]));
      let ids = entry.items.flatMap((item) => (mapped.has(item.Id) ? [mapped.get(item.Id)!] : []));
      details.playlist_items_skipped += entry.items.length - ids.length;
      if (!capabilities.playlistDuplicates) {
        const unique = [...new Set(ids)];
        details.playlist_duplicates_skipped += ids.length - unique.length;
        ids = unique;
      }
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            settings.emby_url,
            sourceId,
            entry.playlist.Id,
            settings.jellyfin_url,
            userId,
          ]),
        )
        .digest('hex');
      let record = store.playlistImport(key);
      let createdHere = false;
      if (!record) {
        record = {
          name: `${String(entry.playlist.Name ?? 'Playlist').slice(0, 160)} (Emby import ${randomUUID().slice(0, 8)})`,
          status: 'creating',
        };
        store.savePlaylistImport(key, record);
      }
      if (!record.targetId && record.status !== 'creating') {
        migrationWarning(
          details,
          'An earlier playlist creation had an uncertain outcome. Review Jellyfin before retrying; no duplicate was created.',
        );
        continue;
      }
      if (!record.targetId) {
        // Persist uncertainty BEFORE the mutation. A restart/timeout cannot create a second copy.
        record.status = 'uncertain';
        store.savePlaylistImport(key, record);
        const types: Record<string, string> = {
          Movie: 'Video',
          Episode: 'Video',
          Video: 'Video',
          MusicVideo: 'Video',
          Trailer: 'Video',
          Audio: 'Audio',
          AudioBook: 'Audio',
          Photo: 'Photo',
          Book: 'Book',
        };
        const first = plan.matches[0]?.target;
        const mediaType = ['Audio', 'Video', 'Photo', 'Book'].includes(
          String(entry.playlist.MediaType),
        )
          ? String(entry.playlist.MediaType)
          : first &&
            (types[first.Type ?? ''] ??
              (['Audio', 'Video', 'Photo', 'Book'].includes(String(first.MediaType))
                ? String(first.MediaType)
                : undefined));
        // Privacy and membership are set in one request. Never append to a saved copy:
        // its owner may have made it public/shared since the preceding migration.
        const created = await jellyfin.createPlaylist(userId, record.name, mediaType, ids);
        record = { ...record, targetId: created.Id, status: 'ready' };
        store.savePlaylistImport(key, record);
        details.playlists_created++;
        createdHere = true;
      }
      stopped();
      const targetId = record.targetId;
      if (!targetId) throw new ServiceError('The created playlist did not return an identifier.');
      const current = await jellyfin.playlistItems(targetId, userId);
      const observed = current.map((item) => item.Id);
      const hash = (values: string[]) =>
        createHash('sha256').update(JSON.stringify(values)).digest('hex');
      if (
        record.status === 'complete' &&
        record.content_hash &&
        record.content_hash !== hash(observed)
      ) {
        migrationWarning(
          details,
          'An imported playlist was edited. Its existing contents were preserved.',
        );
        continue;
      }
      if (hash(observed) !== hash(ids)) {
        migrationWarning(
          details,
          'An imported playlist differs from its source or was not confirmed complete. Review it in Jellyfin. No entries were appended because the copy may now be shared.',
        );
        continue;
      }
      if (createdHere) details.playlist_items_added += observed.length;
      else details.playlists_existing++;
      record.status = 'complete';
      record.content_hash = hash(observed);
      store.savePlaylistImport(key, record);
      saved();
      if (hasPersonalState(entry.playlist)) {
        await migrateItemState(
          jellyfin,
          userId,
          {
            matches: [
              {
                source: { ...entry.playlist, Type: 'Playlist' },
                target: { Id: targetId, Type: 'Playlist' },
                method: 'import_journal',
              },
            ],
            unmatched: [],
            ambiguous: [],
          },
          details,
          stopped,
          saved,
        );
      }
    } catch (error) {
      stopped();
      migrationWarning(
        details,
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'A playlist could not be migrated. Existing playlists were preserved.',
      );
    }
  }
  if (details.playlist_items_skipped)
    migrationWarning(
      details,
      'Some playlist entries are missing or ambiguous in Jellyfin and were skipped.',
    );
  if (details.playlist_duplicates_skipped)
    migrationWarning(
      details,
      'This Jellyfin version removes duplicate playlist entries. First occurrences and their order were preserved.',
    );
}
