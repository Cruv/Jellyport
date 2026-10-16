import { posix } from 'node:path';
import { isObject, MAX_CATALOG_ITEMS, type MediaItem } from './media.js';
import { nameKey } from './identity.js';
import { MediaError } from './errors.js';

export interface PathMapping {
  source: string;
  target: string;
}
export interface MediaMatch {
  source: MediaItem;
  target: MediaItem;
  method: string;
}
export interface AmbiguousMatch {
  source: MediaItem;
  candidates: MediaItem[];
}
export interface MatchPlan {
  matches: MediaMatch[];
  unmatched: MediaItem[];
  ambiguous: AmbiguousMatch[];
}
/** Reusable only while its destination catalog and path mappings remain unchanged. */
export interface PreparedMatcher {
  (source: MediaItem[]): MatchPlan;
  /** All identity candidates, before access filtering, precedence or disambiguation. */
  candidates(source: MediaItem[]): MediaItem[];
}
/** Fail closed instead of truncating ambiguity decisions or retaining quadratic result arrays. */
export const MAX_AMBIGUOUS_CANDIDATES = 200_000;
/** Lists library item types with a supported, conservative identity strategy. */
export const MIGRATABLE_ITEM_TYPES = [
  'Movie',
  'Episode',
  'Series',
  'Season',
  'Audio',
  'MusicAlbum',
  'MusicArtist',
  'MusicVideo',
  'Video',
  'Book',
  'AudioBook',
  'Photo',
  'PhotoAlbum',
  'Trailer',
  'BoxSet',
] as const;
const supportedTypes = new Set<string>(MIGRATABLE_ITEM_TYPES.map((type) => type.toLowerCase()));
const providerNames: Record<string, string> = {
  imdb: 'imdb',
  tmdb: 'tmdb',
  themoviedb: 'tmdb',
  tvdb: 'tvdb',
  thetvdb: 'tvdb',
  tvmaze: 'tvmaze',
  anidb: 'anidb',
  anilist: 'anilist',
  myanimelist: 'myanimelist',
  kitsu: 'kitsu',
  tmdbcollection: 'tmdbcollection',
  musicbrainzrecording: 'musicbrainzrecording',
  musicbrainztrack: 'musicbrainztrack',
  musicbrainzreleasetrack: 'musicbrainztrack',
  musicbrainzalbum: 'musicbrainzalbum',
  musicbrainzrelease: 'musicbrainzalbum',
  musicbrainzreleasegroup: 'musicbrainzreleasegroup',
  musicbrainzartist: 'musicbrainzartist',
  musicbrainzalbumartist: 'musicbrainzartist',
  audiodbalbum: 'audiodbalbum',
  audiodbartist: 'audiodbartist',
  isbn: 'isbn',
  isbn10: 'isbn',
  isbn13: 'isbn',
  googlebooks: 'googlebooks',
  comicvine: 'comicvine',
};
const videoProviders = new Set([
  'imdb',
  'tmdb',
  'tvdb',
  'tvmaze',
  'anidb',
  'anilist',
  'myanimelist',
  'kitsu',
]);
const typeProviders: Record<string, ReadonlySet<string>> = {
  movie: videoProviders,
  episode: videoProviders,
  series: videoProviders,
  season: videoProviders,
  musicvideo: videoProviders,
  video: videoProviders,
  // Album/artist IDs can appear on every song and must never identify an Audio item.
  audio: new Set(['musicbrainzrecording', 'musicbrainztrack']),
  musicalbum: new Set(['musicbrainzalbum', 'musicbrainzreleasegroup', 'audiodbalbum']),
  musicartist: new Set(['musicbrainzartist', 'audiodbartist']),
  boxset: new Set(['tmdbcollection']),
  book: new Set(['isbn', 'googlebooks', 'comicvine']),
  audiobook: new Set(['isbn']),
};
export const caseFold = nameKey;

function providers(item: MediaItem, field: string): Map<string, Set<string>> {
  const raw = item[field];
  const result = new Map<string, Set<string>>();
  if (!isObject(raw)) return result;
  const allowed = field === 'SeriesProviderIds' ? videoProviders : typeProviders[kind(item)];
  for (const [key, value] of Object.entries(raw)) {
    const providerKey = caseFold(key.trim());
    let provider = Object.hasOwn(providerNames, providerKey)
      ? providerNames[providerKey]
      : undefined;
    // Verified Emby backups store collection IDs as Tmdb on BoxSet items; also
    // accept the explicit TmdbCollection alias. Keep this interpretation
    // within BoxSet identity, collecting conflicting aliases conservatively.
    if (provider === 'tmdb' && kind(item) === 'boxset') provider = 'tmdbcollection';
    if (
      provider &&
      allowed?.has(provider) &&
      (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
    ) {
      const normalized =
        provider === 'googlebooks'
          ? String(value).trim()
          : provider === 'isbn'
            ? caseFold(String(value).trim().replaceAll(/[\s-]/g, ''))
            : caseFold(String(value).trim());
      if (!normalized) continue;
      if (!result.has(provider)) result.set(provider, new Set());
      result.get(provider)!.add(normalized);
    }
  }
  return result;
}
function kind(item: MediaItem): string {
  return String(item.Type ?? '').toLowerCase();
}
function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
    return Number(value);
  return null;
}
function episodeRange(item: MediaItem): number[] | null {
  const season = number(item.ParentIndexNumber),
    episode = number(item.IndexNumber);
  if (season === null || episode === null) return null;
  const end = number(item.IndexNumberEnd) ?? episode;
  return end < episode ? null : [season, episode, end];
}
function seriesNumbers(item: MediaItem): number[] | null {
  if (kind(item) === 'episode') return episodeRange(item);
  if (kind(item) === 'season') {
    const season = number(item.IndexNumber);
    return season === null ? null : [season];
  }
  return null;
}
function providerEntries(item: MediaItem, field: string): Array<[string, string]> {
  return [...providers(item, field)].flatMap(([provider, ids]) =>
    [...ids].map((id) => [provider, id] as [string, string]),
  );
}
function path(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return (
    posix.normalize(value.trim().normalize('NFC').replaceAll('\\', '/')).replace(/\/$/, '') || '/'
  );
}
function mappedPath(item: MediaItem, mappings: Array<[string, string]>): string | null {
  const value = path(item.Path);
  if (value)
    for (const [source, target] of mappings) {
      if (value === source) return target;
      const prefix = source.replace(/\/+$/, '') + '/';
      if (value.startsWith(prefix))
        return path(target.replace(/\/+$/, '') + '/' + value.slice(prefix.length));
    }
  return value;
}
function normalizedMappings(pathMappings: PathMapping[]): Array<[string, string]> {
  return pathMappings
    .flatMap((mapping) => {
      const sourcePath = path(mapping.source),
        targetPath = path(mapping.target);
      return sourcePath && targetPath ? [[sourcePath, targetPath] as [string, string]] : [];
    })
    .sort((a, b) => b[0].length - a[0].length);
}

/** Identity buckets for a disk-backed candidate union. Final access-scoped matching is unchanged. */
export function catalogCandidateKeys(
  item: MediaItem,
  pathMappings: PathMapping[] = [],
  source = false,
): string[] {
  const type = kind(item);
  if (!supportedTypes.has(type)) return [];
  const keys = new Set<string>();
  if (type !== 'season')
    for (const [provider, value] of providerEntries(item, 'ProviderIds'))
      keys.add(JSON.stringify(['provider', type, provider, value]));
  const numbers = seriesNumbers(item);
  if (numbers)
    for (const [provider, value] of providerEntries(item, 'SeriesProviderIds'))
      keys.add(JSON.stringify(['series', type, provider, value, ...numbers]));
  const value = source ? mappedPath(item, normalizedMappings(pathMappings)) : path(item.Path);
  if (value) keys.add(JSON.stringify(['path', type, value]));
  return [...keys];
}
function compatible(source: MediaItem, target: MediaItem): boolean {
  if (kind(source) !== kind(target)) return false;
  const fields = ['ProviderIds'];
  if (['episode', 'season'].includes(kind(source))) {
    fields.push('SeriesProviderIds');
    const a = seriesNumbers(source),
      b = seriesNumbers(target);
    if (a && b && a.join(',') !== b.join(',')) return false;
  }
  for (const field of fields) {
    const a = providers(source, field),
      b = providers(target, field);
    // Contradictory aliases must not silently overwrite one another, even for a path match.
    if ([...a.values(), ...b.values()].some((ids) => ids.size > 1)) return false;
    if ([...a].some(([key, ids]) => b.has(key) && !b.get(key)!.has([...ids][0]!))) return false;
  }
  return true;
}
function add(index: Map<string, Set<number>>, key: unknown[], value: number): void {
  const encoded = JSON.stringify(key);
  if (!index.has(encoded)) index.set(encoded, new Set());
  index.get(encoded)!.add(value);
}
function lookup(index: Map<string, Set<number>>, key: unknown[]): Set<number> {
  return index.get(JSON.stringify(key)) ?? new Set();
}

/** Build once for one destination catalog; its identity metadata must remain unchanged. */
export function createMatcher(
  targetItems: MediaItem[],
  pathMappings: PathMapping[] = [],
): PreparedMatcher {
  const target = targetItems.slice();
  const providerIndex = new Map<string, Set<number>>(),
    seriesIndex = new Map<string, Set<number>>(),
    pathIndex = new Map<string, Set<number>>();
  target.forEach((item, index) => {
    const type = kind(item);
    if (!supportedTypes.has(type)) return;
    // Season ProviderIds vary between server/provider versions (series IDs or season IDs).
    // They are checked for contradictions, but only series + number proves season identity.
    if (type !== 'season')
      for (const [provider, value] of providerEntries(item, 'ProviderIds'))
        add(providerIndex, [type, provider, value], index);
    const numbers = seriesNumbers(item);
    if (numbers)
      for (const [provider, value] of providerEntries(item, 'SeriesProviderIds'))
        add(seriesIndex, [type, provider, value, ...numbers], index);
    const value = path(item.Path);
    if (value) add(pathIndex, [type, value], index);
  });
  const mappings = normalizedMappings(pathMappings);
  const match = (source: MediaItem[]): MatchPlan => {
    const result: MatchPlan = { matches: [], unmatched: [], ambiguous: [] };
    let retainedCandidates = 0;
    for (const item of source) {
      const type = kind(item);
      if (!supportedTypes.has(type)) {
        result.unmatched.push(item);
        continue;
      }
      const value = mappedPath(item, mappings);
      const pathCandidates = value ? lookup(pathIndex, [type, value]) : new Set<number>();
      let candidates = new Set<number>(),
        method = 'provider_id';
      if (type !== 'season')
        for (const [provider, id] of providerEntries(item, 'ProviderIds'))
          for (const index of lookup(providerIndex, [type, provider, id])) candidates.add(index);
      if (!candidates.size && ['episode', 'season'].includes(type)) {
        const numbers = seriesNumbers(item);
        if (numbers) {
          method = type === 'episode' ? 'series_episode' : 'series_season';
          for (const [provider, id] of providerEntries(item, 'SeriesProviderIds'))
            for (const index of lookup(seriesIndex, [type, provider, id, ...numbers]))
              candidates.add(index);
        }
      }
      if (!candidates.size) {
        candidates = new Set(pathCandidates);
        method = 'path';
      }
      const values = () => {
        if (candidates.size > MAX_AMBIGUOUS_CANDIDATES - retainedCandidates)
          throw new MediaError(
            'The migration matching plan contains too many ambiguous candidates. Resolve duplicate media identities before retrying.',
          );
        retainedCandidates += candidates.size;
        return [...candidates].sort((a, b) => a - b).map((index) => target[index]!);
      };
      if ([...candidates].some((index) => !compatible(item, target[index]!))) {
        result.ambiguous.push({ source: item, candidates: values() });
        continue;
      }
      if (candidates.size > 1) {
        const narrowed = new Set([...candidates].filter((index) => pathCandidates.has(index)));
        if (narrowed.size === 1) {
          candidates = narrowed;
          method += '+path';
        }
      }
      if (candidates.size === 1)
        result.matches.push({ source: item, target: target[[...candidates][0]!]!, method });
      else if (candidates.size) result.ambiguous.push({ source: item, candidates: values() });
      else result.unmatched.push(item);
    }
    return result;
  };
  return Object.assign(match, {
    candidates(source: MediaItem[]): MediaItem[] {
      const selected = new Set<number>();
      // Many history entries can share the same identity. Visit each index bucket once
      // rather than repeatedly expanding large collision sets for every source entry.
      const visited = new Set<Set<number>>();
      const collect = (values: Set<number>) => {
        if (!values.size || visited.has(values)) return;
        visited.add(values);
        for (const index of values) {
          selected.add(index);
          if (selected.size > MAX_CATALOG_ITEMS)
            throw new MediaError(
              'The migration matching candidates exceed the supported item limit.',
            );
        }
      };
      for (const item of source) {
        const type = kind(item);
        if (!supportedTypes.has(type)) continue;
        if (type !== 'season')
          for (const [provider, id] of providerEntries(item, 'ProviderIds'))
            collect(lookup(providerIndex, [type, provider, id]));
        const numbers = seriesNumbers(item);
        if (numbers)
          for (const [provider, id] of providerEntries(item, 'SeriesProviderIds'))
            collect(lookup(seriesIndex, [type, provider, id, ...numbers]));
        const value = mappedPath(item, mappings);
        if (value) collect(lookup(pathIndex, [type, value]));
      }
      // Include lower-priority identities and contradictory candidates too. Removing
      // inaccessible provider hits can reveal a series/path fallback; removing a path
      // narrowing hit can restore ambiguity. Only final user-scoped matching decides.
      return [...selected].sort((a, b) => a - b).map((index) => target[index]!);
    },
  });
}

/** Type-scoped provider identity, complete series numbering, then exact mapped path; never titles. */
export function matchItems(
  source: MediaItem[],
  target: MediaItem[],
  pathMappings: PathMapping[] = [],
): MatchPlan {
  return createMatcher(target, pathMappings)(source);
}
