import { createHash, randomUUID } from 'node:crypto';
import { createMatcher, matchItems, type MatchPlan } from './matching.js';
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
    const sourceDate = playedDate(from.LastPlayedDate),
      targetDate = playedDate(to.LastPlayedDate);
    if (sourceDate && (!targetDate || sourceDate > targetDate)) patch.LastPlayedDate = sourceDate;
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
): MatchPlan {
  return matchItems(
    source.filter((item) =>
      scope === 'watched_only'
        ? playable.has(item.Type ?? '') && item.UserData?.Played === true
        : item.Type !== 'Playlist' && hasPersonalState(item),
    ),
    target,
    settings.path_mappings,
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
  user: MediaUser;
  items: MediaItem[];
  playlists: SourcePlaylist[];
  warnings: string[];
}
export interface MigrationDetails {
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
): Promise<SourceSnapshot> {
  const user = await emby.user(sourceId);
  const items = await (scope === 'watched_only' && emby.watchedItems
    ? emby.watchedItems(sourceId)
    : emby.migrationItems
      ? emby.migrationItems(sourceId)
      : emby.items(sourceId));
  const result: SourceSnapshot = { user, items, playlists: [], warnings: [] };
  if (scope === 'watched_only') return result;
  if (!emby.playlists || !emby.playlistItems) {
    result.warnings.push('This source client cannot read playlists.');
    return result;
  }
  try {
    const playlists = await emby.playlists(sourceId);
    if (playlists.length > 500)
      result.warnings.push(
        'Only the first 500 source playlists were read. Remaining playlists were skipped.',
      );
    let total = 0;
    for (const playlist of playlists.slice(0, 500)) {
      try {
        const entries = await emby.playlistItems(playlist.Id, sourceId);
        if (entries.length > 100_000 - total) {
          result.warnings.push(
            'The total source playlist limit of 100,000 entries was reached. Remaining playlists were skipped.',
          );
          break;
        }
        total += entries.length;
        result.playlists.push({ playlist, items: entries });
      } catch {
        result.playlists.push({
          playlist,
          items: [],
          error: 'A source playlist could not be read.',
        });
      }
    }
  } catch {
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
    progress?: (processed: number, total: number, updated: number) => void;
    migration_scope?: MigrationScope;
  } = {},
): Promise<number> {
  const concurrency = options.concurrency ?? 4;
  const scope = options.migration_scope ?? 'complete';
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new ServiceError('Migration concurrency must be between 1 and 4.');
  stopped();
  let capabilities = { userData: false };
  try {
    if (jellyfin.migrationCapabilities) capabilities = await jellyfin.migrationCapabilities();
  } catch {
    migrationWarning(
      details,
      'Jellyfin capabilities could not be verified. Only legacy watched and favorite updates will be attempted.',
    );
  }
  if (scope === 'watched_only' && !capabilities.userData)
    migrationWarning(
      details,
      'This older Jellyfin version uses its watched-item endpoint, which may update playback dates, counts or resume state. Jellyfin 10.9 or newer is required to preserve those fields precisely.',
    );
  let applied = 0;
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
  const missingDate = (source: MediaItem, target: MediaItem) => {
    if (
      source.Type === 'Episode' &&
      source.UserData?.Played === true &&
      !playedDate(source.UserData.LastPlayedDate) &&
      !playedDate(target.UserData?.LastPlayedDate)
    )
      details.history_dates_missing++;
  };
  const apply = async (match: MatchPlan['matches'][number]): Promise<boolean> => {
    guard();
    try {
      const target = { ...match.target };
      // Already merged snapshots need no remote reads or writes. Potential changes still use
      // a fresh destination read, so later Jellyfin activity wins immediately before a write.
      if (!Object.keys(mergeUserData(match.source, target, scope)).length) {
        missingDate(match.source, target);
        return false;
      }
      if (capabilities.userData && jellyfin.userData)
        target.UserData = await jellyfin.userData(userId, target.Id);
      guard();
      const patch = mergeUserData(match.source, target, scope);
      missingDate(match.source, target);
      if (!Object.keys(patch).length) return false;
      if (capabilities.userData && jellyfin.updateUserData) {
        if (!jellyfin.userData)
          throw new ServiceError(
            'Fresh Jellyfin user data is required before detailed migration updates.',
          );
        guard();
        await jellyfin.updateUserData(userId, target.Id, patch);
        if (patch.Played) applied++;
        if (patch.IsFavorite) details.favorites++;
        if (patch.PlaybackPositionTicks !== undefined) details.resume_positions++;
        if (patch.PlayCount !== undefined) details.play_counts++;
        if (patch.LastPlayedDate) details.last_played_dates++;
        if (patch.Likes !== undefined || patch.Rating !== undefined) details.ratings++;
      } else {
        let changed = false;
        if (patch.Played) {
          const date = playedDate(match.source.UserData?.LastPlayedDate);
          guard();
          await jellyfin.markPlayed(userId, target.Id, date);
          applied++;
          changed = true;
          if (!date)
            migrationWarning(
              details,
              'This older Jellyfin version records its current date when a watched item has no source playback date. Next Up ordering may differ.',
            );
        }
        if (patch.IsFavorite && jellyfin.markFavorite) {
          guard();
          await jellyfin.markFavorite(userId, target.Id);
          details.favorites++;
          changed = true;
        }
        if (
          Object.keys(patch).some(
            (key) =>
              !['Played', 'IsFavorite'].includes(key) &&
              !(key === 'LastPlayedDate' && patch.Played === true),
          ) ||
          (patch.IsFavorite && !jellyfin.markFavorite)
        )
          migrationWarning(
            details,
            'This Jellyfin version/client supports limited user data. Upgrade to Jellyfin 10.9 or newer for resume positions, counts, dates and ratings.',
          );
        if (!changed) return false;
      }
      details.items_updated++;
      saved();
      return true;
    } catch (error) {
      guard();
      details.failed_items++;
      migrationWarning(
        details,
        error instanceof MediaError || error instanceof ServiceError
          ? error.message
          : 'An item could not be updated. Review the migration and retry.',
      );
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
  if (details.history_dates_missing)
    migrationWarning(
      details,
      'Some watched episodes have no original playback date. Their watched flags are copied, but Jellyfin Next Up may omit these series.',
    );
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
  const matchPlaylist = createMatcher(targetItems, settings.path_mappings);
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
