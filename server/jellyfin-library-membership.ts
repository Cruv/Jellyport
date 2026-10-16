import { createHash } from 'node:crypto';
import { ServiceError } from './errors.js';

export interface JellyfinLibraryConfigEntry {
  id: string;
  locations: string[];
}

/** Match the verified ASCII portion of OrdinalIgnoreCase without Unicode guesses. */
export function jellyfinAsciiPathKey(path: string): string {
  return path.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** Shared by the neutral backup projection and fresh /Library/VirtualFolders. */
export function jellyfinLibraryConfigHash(libraries: JellyfinLibraryConfigEntry[]): string {
  const invalid = () => new ServiceError('Jellyfin returned unsupported library configuration.');
  if (!Array.isArray(libraries) || libraries.length > 1000) throw invalid();
  const seen = new Set<string>();
  let bytes = 2;
  const rows: Array<[string, string[]]> = [];
  for (const library of libraries) {
    if (
      !library ||
      typeof library !== 'object' ||
      typeof library.id !== 'string' ||
      !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(library.id) ||
      !Array.isArray(library.locations) ||
      library.locations.length > 1000
    )
      throw invalid();
    const id = library.id.replaceAll('-', '').toLowerCase();
    if (id === '0'.repeat(32) || seen.has(id)) throw invalid();
    seen.add(id);
    const locations: string[] = [];
    const paths = new Set<string>();
    for (const path of library.locations) {
      if (
        typeof path !== 'string' ||
        !path ||
        path.length > 16_384 ||
        /[\u0000-\u001f\u007f]/.test(path) ||
        paths.has(path)
      )
        throw invalid();
      paths.add(path);
      locations.push(path);
      bytes += Buffer.byteLength(JSON.stringify(path)) + 1;
      if (bytes > 8 * 1024 * 1024) throw invalid();
    }
    rows.push([id, locations.sort()]);
    bytes += id.length + 6;
    if (bytes > 8 * 1024 * 1024) throw invalid();
  }
  rows.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const canonical = JSON.stringify(rows);
  if (Buffer.byteLength(canonical) > 8 * 1024 * 1024) throw invalid();
  return createHash('sha256').update(canonical).digest('hex');
}
