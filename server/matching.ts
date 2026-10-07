import { posix } from 'node:path';
import { isObject, type MediaItem } from './media.js';
import { nameKey } from './identity.js';

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
};
export const caseFold = nameKey;

function providers(item: MediaItem, field: string): Record<string, string> {
  const raw = item[field];
  if (!isObject(raw)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const providerKey = caseFold(key.trim());
    const provider = Object.hasOwn(providerNames, providerKey)
      ? providerNames[providerKey]
      : undefined;
    if (
      provider &&
      (typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value)))
    ) {
      const normalized = caseFold(String(value).trim());
      if (normalized) result[provider] = normalized;
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
function compatible(source: MediaItem, target: MediaItem): boolean {
  const fields = ['ProviderIds'];
  if (kind(source) === 'episode') {
    fields.push('SeriesProviderIds');
    const a = episodeRange(source),
      b = episodeRange(target);
    if (a && b && a.join(',') !== b.join(',')) return false;
  }
  for (const field of fields) {
    const a = providers(source, field),
      b = providers(target, field);
    if (Object.keys(a).some((key) => key in b && a[key] !== b[key])) return false;
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

/** Provider identity, complete series/episode identity, then exact mapped path; never titles. */
export function matchItems(
  source: MediaItem[],
  target: MediaItem[],
  pathMappings: PathMapping[] = [],
): MatchPlan {
  const providerIndex = new Map<string, Set<number>>(),
    seriesIndex = new Map<string, Set<number>>(),
    pathIndex = new Map<string, Set<number>>();
  target.forEach((item, index) => {
    const type = kind(item);
    if (!['movie', 'episode'].includes(type)) return;
    for (const [provider, value] of Object.entries(providers(item, 'ProviderIds')))
      add(providerIndex, [type, provider, value], index);
    const numbers = episodeRange(item);
    if (type === 'episode' && numbers)
      for (const [provider, value] of Object.entries(providers(item, 'SeriesProviderIds')))
        add(seriesIndex, [provider, value, ...numbers], index);
    const value = path(item.Path);
    if (value) add(pathIndex, [type, value], index);
  });
  const mappings = pathMappings
    .flatMap((mapping) => {
      const sourcePath = path(mapping.source),
        targetPath = path(mapping.target);
      return sourcePath && targetPath ? [[sourcePath, targetPath] as [string, string]] : [];
    })
    .sort((a, b) => b[0].length - a[0].length);
  const result: MatchPlan = { matches: [], unmatched: [], ambiguous: [] };
  for (const item of source) {
    const type = kind(item);
    if (!['movie', 'episode'].includes(type)) {
      result.unmatched.push(item);
      continue;
    }
    const value = mappedPath(item, mappings);
    const pathCandidates = value ? lookup(pathIndex, [type, value]) : new Set<number>();
    let candidates = new Set<number>(),
      method = 'provider_id';
    for (const [provider, id] of Object.entries(providers(item, 'ProviderIds')))
      for (const index of lookup(providerIndex, [type, provider, id])) candidates.add(index);
    if (!candidates.size && type === 'episode') {
      const numbers = episodeRange(item);
      if (numbers) {
        method = 'series_episode';
        for (const [provider, id] of Object.entries(providers(item, 'SeriesProviderIds')))
          for (const index of lookup(seriesIndex, [provider, id, ...numbers]))
            candidates.add(index);
      }
    }
    if (!candidates.size) {
      candidates = new Set(pathCandidates);
      method = 'path';
    }
    const values = () => [...candidates].sort((a, b) => a - b).map((index) => target[index]!);
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
}
