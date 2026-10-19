import { MediaError } from './errors.js';

/** Safe identity and options only; the native server's filesystem path is private. */
export interface JellyfinBackupManifest {
  name: string;
  created_at: string;
  server_version: string;
  backup_engine_version: string;
  database: true;
  metadata: boolean;
  trickplay: boolean;
  subtitles: boolean;
}

export interface JellyfinBackupTask {
  key: string;
  state: 'Idle' | 'Cancelling' | 'Running';
}

const MAX_ENTRIES = 10_000;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const version = (value: unknown): value is string =>
  typeof value === 'string' &&
  !/[\r\n]/.test(value) &&
  /^\d{1,5}\.\d{1,5}(?:\.\d{1,5}){0,2}$/.test(value);
const invalid = () => new MediaError('Jellyfin returned invalid backup information.');

function validDateParts(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function validJellyfinBackupName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^jellyfin-backup-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.zip$/.exec(value);
  return !!(
    match &&
    match[0] === value &&
    validDateParts(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60 &&
    Number(match[6]) < 60
  );
}

function createdAt(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  // System.Text.Json emits DateTimeOffset with an explicit offset and up to seven
  // fractional digits. Reject permissive Date.parse formats and normalized dates.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (
    !match ||
    match[0] !== value ||
    !validDateParts(Number(match[1]), Number(match[2]), Number(match[3])) ||
    Number(match[4]) >= 24 ||
    Number(match[5]) >= 60 ||
    Number(match[6]) >= 60 ||
    (match[7] !== undefined &&
      (Number(match[8]) > 14 ||
        Number(match[9]) >= 60 ||
        (Number(match[8]) === 14 && Number(match[9]) !== 0)))
  )
    throw invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalid();
  return new Date(time).toISOString();
}

export function parseJellyfinBackupManifest(value: unknown): JellyfinBackupManifest {
  if (
    !object(value) ||
    typeof value.Path !== 'string' ||
    value.Path.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value.Path) ||
    !version(value.ServerVersion) ||
    !version(value.BackupEngineVersion) ||
    !object(value.Options) ||
    value.Options.Database !== true ||
    typeof value.Options.Metadata !== 'boolean' ||
    typeof value.Options.Trickplay !== 'boolean' ||
    typeof value.Options.Subtitles !== 'boolean'
  )
    throw invalid();
  const name = value.Path.split(/[\\/]/).at(-1);
  if (!validJellyfinBackupName(name)) throw invalid();
  return {
    name,
    created_at: createdAt(value.DateCreated),
    server_version: value.ServerVersion,
    backup_engine_version: value.BackupEngineVersion,
    database: true,
    metadata: value.Options.Metadata,
    trickplay: value.Options.Trickplay,
    subtitles: value.Options.Subtitles,
  };
}

export function parseJellyfinBackups(value: unknown): JellyfinBackupManifest[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid();
  const names = new Set<string>();
  return value.map((entry) => {
    const parsed = parseJellyfinBackupManifest(entry);
    if (names.has(parsed.name)) throw invalid();
    names.add(parsed.name);
    return parsed;
  });
}

export function parseJellyfinBackupTasks(value: unknown): JellyfinBackupTask[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid();
  return value.map((entry) => {
    if (
      !object(entry) ||
      typeof entry.Key !== 'string' ||
      /[\r\n]/.test(entry.Key) ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.Key) ||
      !['Idle', 'Cancelling', 'Running'].includes(entry.State as string)
    )
      throw invalid();
    return { key: entry.Key, state: entry.State as JellyfinBackupTask['state'] };
  });
}
