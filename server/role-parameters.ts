import { ServiceError } from './errors.js';
import type { JsonObject, MediaUser } from './media.js';

export type RoleSection = 'policy' | 'configuration' | 'display';
export interface RoleParameters {
  policy: JsonObject;
  configuration: JsonObject;
  display: JsonObject | null;
}

type Check = (value: unknown) => boolean;
const boolean: Check = (value) => typeof value === 'boolean';
const integer =
  (maximum: number, minimum = 0): Check =>
  (value) =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum;
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const enumeration =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);
const identifier: Check = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text: Check = (value) =>
  typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const array =
  (check: Check, limit = 512): Check =>
  (value) =>
    Array.isArray(value) &&
    value.length <= limit &&
    Object.keys(value).length === value.length &&
    value.every(check);
const language: Check = (value) =>
  value === null ||
  value === '' ||
  (typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value));
const record = (value: unknown): value is JsonObject =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const scheduleDay = enumeration(
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Everyday',
  'Weekday',
  'Weekend',
);
const schedule: Check = (value) =>
  record(value) &&
  Object.keys(value).length === 3 &&
  scheduleDay(value.DayOfWeek) &&
  typeof value.StartHour === 'number' &&
  Number.isFinite(value.StartHour) &&
  typeof value.EndHour === 'number' &&
  Number.isFinite(value.EndHour) &&
  value.StartHour >= 0 &&
  value.StartHour <= 24 &&
  value.EndHour >= 0 &&
  value.EndHour <= 24 &&
  ['DayOfWeek', 'StartHour', 'EndHour'].every((field) => Object.hasOwn(value, field));

const policy: Record<string, Check> = {
  IsAdministrator: (value) => value === false,
  IsHidden: boolean,
  EnableCollectionManagement: boolean,
  EnableSubtitleManagement: boolean,
  EnableLyricManagement: boolean,
  MaxParentalRating: nullable(integer(1_000)),
  MaxParentalSubRating: nullable(integer(1_000)),
  BlockedTags: array(text, 256),
  AllowedTags: array(text, 256),
  EnableUserPreferenceAccess: boolean,
  AccessSchedules: array(schedule, 64),
  BlockUnratedItems: array(
    enumeration(
      'Movie',
      'Trailer',
      'Series',
      'Music',
      'Book',
      'LiveTvChannel',
      'LiveTvProgram',
      'ChannelContent',
      'Other',
    ),
    9,
  ),
  EnableRemoteControlOfOtherUsers: boolean,
  EnableSharedDeviceControl: boolean,
  EnableRemoteAccess: boolean,
  EnableLiveTvManagement: boolean,
  EnableLiveTvAccess: boolean,
  EnableMediaPlayback: boolean,
  EnableAudioPlaybackTranscoding: boolean,
  EnableVideoPlaybackTranscoding: boolean,
  EnablePlaybackRemuxing: boolean,
  ForceRemoteSourceTranscoding: boolean,
  EnableContentDeletion: boolean,
  EnableContentDeletionFromFolders: array(identifier),
  EnableContentDownloading: boolean,
  EnableSyncTranscoding: boolean,
  EnableMediaConversion: boolean,
  EnabledDevices: array(identifier),
  EnableAllDevices: boolean,
  EnabledChannels: array(identifier),
  EnableAllChannels: boolean,
  EnabledFolders: array(identifier),
  EnableAllFolders: boolean,
  MaxActiveSessions: integer(10_000),
  EnablePublicSharing: boolean,
  BlockedMediaFolders: array(identifier),
  BlockedChannels: array(identifier),
  RemoteClientBitrateLimit: integer(2_147_483_647),
  SyncPlayAccess: enumeration('CreateAndJoinGroups', 'JoinGroups', 'None'),
};

const configuration: Record<string, Check> = {
  AudioLanguagePreference: language,
  PlayDefaultAudioTrack: boolean,
  SubtitleLanguagePreference: language,
  DisplayMissingEpisodes: boolean,
  GroupedFolders: array(identifier),
  SubtitleMode: enumeration('Default', 'Always', 'OnlyForced', 'None', 'Smart'),
  DisplayCollectionsView: boolean,
  OrderedViews: array(identifier),
  LatestItemsExcludes: array(identifier),
  MyMediaExcludes: array(identifier),
  HidePlayedInLatest: boolean,
  RememberAudioSelections: boolean,
  RememberSubtitleSelections: boolean,
  EnableNextEpisodeAutoPlay: boolean,
};

const homeSection = enumeration(
  '', // Jellyfin Web saves an empty value when the slot should use its default.
  'none',
  'smalllibrarytiles',
  'librarybuttons',
  'activerecordings',
  'resume',
  'resumeaudio',
  'resumebook',
  'latestmedia',
  'nextup',
  'livetv',
);
const landing = enumeration(
  '',
  'albums',
  'albumartists',
  'artists',
  'channels',
  'collections',
  'episodes',
  'favorites',
  'genres',
  'guide',
  'movies',
  'networks',
  'playlists',
  'programs',
  'recordings',
  'schedule',
  'series',
  'shows',
  'songs',
  'suggestions',
  'trailers',
  'upcoming',
  'authors',
  'books',
  'folders',
  'mixed',
  'photos',
  'photoalbums',
  'seriestimers',
  'studios',
  'videos',
);
const booleanString = enumeration('true', 'false');
const duration: Check = (value) =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,6})$/.test(value) && Number(value) <= 3_600_000;
function customCheck(key: string): Check | undefined {
  if (/^homesection[0-9]$/.test(key)) return homeSection;
  if (key === 'tvhome') return enumeration('', 'horizontal', 'vertical');
  if (/^landing-[A-Za-z0-9_-]{1,128}$/.test(key)) return landing;
  if (
    [
      'useEpisodeImagesInNextUpAndResume',
      'enableNextVideoInfoOverlay',
      'enableVideoRemainingTime',
    ].includes(key)
  )
    return booleanString;
  if (['skipBackLength', 'skipForwardLength'].includes(key)) return duration;
  return undefined;
}
const customPreferences: Check = (value) =>
  record(value) &&
  Object.keys(value).length <= 128 &&
  Object.entries(value).every(([key, entry]) => customCheck(key)?.(entry) === true);
const display: Record<string, Check> = {
  RememberIndexing: boolean,
  RememberSorting: boolean,
  ShowBackdrop: boolean,
  ShowSidebar: boolean,
  ScrollDirection: enumeration('Horizontal', 'Vertical'),
  SortOrder: enumeration('Ascending', 'Descending'),
  SortBy: nullable(
    enumeration(
      'SortName',
      'Name',
      'PremiereDate',
      'ProductionYear',
      'CommunityRating',
      'DateCreated',
      'DatePlayed',
      'PlayCount',
      'Runtime',
      'Random',
      'Album',
      'Artist',
      'AlbumArtist',
    ),
  ),
  IndexBy: nullable(enumeration('PremiereDate', 'ProductionYear', 'CommunityRating')),
  CustomPrefs: customPreferences,
};

const invalid = () =>
  new ServiceError('Role parameters contain unsupported fields or invalid values.');
function validSection(value: unknown, checks: Record<string, Check>): value is JsonObject {
  return (
    record(value) &&
    Object.keys(value).length <= Object.keys(checks).length &&
    Object.entries(value).every(([key, entry]) => Object.hasOwn(checks, key) && checks[key]!(entry))
  );
}

/** Only supported, bounded settings may be persisted or supplied by the admin editor. */
export function validateRoleParameters(value: unknown): asserts value is RoleParameters {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    !['policy', 'configuration', 'display'].every((key) => Object.hasOwn(value, key)) ||
    !validSection(value.policy, policy) ||
    !validSection(value.configuration, configuration) ||
    (value.display !== null && !validSection(value.display, display))
  )
    throw invalid();
}

function project(
  value: unknown,
  checks: Record<string, Check>,
): { result: JsonObject; omitted: boolean } {
  const result: JsonObject = {};
  if (!record(value)) return { result, omitted: value !== undefined && value !== null };
  let omitted = false;
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(checks, key) || !checks[key]!(entry)) {
      omitted = true;
      continue;
    }
    result[key] = structuredClone(entry);
  }
  return { result, omitted };
}

/** Capture a snapshot, never a live link to the source account or its credentials. */
export function captureRoleParameters(
  user: MediaUser,
  preferences?: JsonObject | null,
): { parameters: RoleParameters; warnings: string[] } {
  const warnings: string[] = [];
  const permissionSource = record(user.Policy) ? { ...user.Policy } : user.Policy;
  if (record(permissionSource)) {
    if (permissionSource.IsAdministrator === true)
      warnings.push('Administrator access is never included in a role.');
    permissionSource.IsAdministrator = false;
    // Current Jellyfin schedule entities may carry database/user IDs. They must never become role data.
    if (Array.isArray(permissionSource.AccessSchedules))
      permissionSource.AccessSchedules = permissionSource.AccessSchedules.map((entry) =>
        record(entry)
          ? { DayOfWeek: entry.DayOfWeek, StartHour: entry.StartHour, EndHour: entry.EndHour }
          : entry,
      );
  }
  const permissions = project(permissionSource, policy);
  permissions.result.IsAdministrator = false;
  if (permissions.omitted)
    warnings.push('Unsupported or account-specific permission fields were excluded.');
  const account = project(user.Configuration, configuration);
  if (account.omitted)
    warnings.push('Unsupported or account-specific configuration fields were excluded.');
  let home: JsonObject | null = null;
  if (preferences === undefined || preferences === null) {
    warnings.push(
      'Home screen preferences were not available; this role will leave them unchanged.',
    );
  } else {
    const top = { ...preferences };
    let customOmitted = false;
    if (record(top.CustomPrefs)) {
      const custom: JsonObject = {};
      for (const [key, value] of Object.entries(top.CustomPrefs)) {
        // Unset TvHome is nullable in Jellyfin's database and GET response.
        // Persist a safe reset-to-default string; other nullable keys remain excluded.
        // Jellyfin also serializes some boolean/enum preferences with title case.
        const normalized =
          key === 'tvhome' && value === null
            ? ''
            : typeof value === 'string' &&
                (customCheck(key) === booleanString ||
                  key === 'tvhome' ||
                  /^homesection[0-9]$/.test(key) ||
                  /^landing-/.test(key))
              ? value.toLowerCase()
              : value;
        if (customCheck(key)?.(normalized)) custom[key] = normalized;
        else customOmitted = true;
      }
      if (Object.keys(custom).length <= 128) top.CustomPrefs = custom;
      else {
        delete top.CustomPrefs;
        customOmitted = true;
      }
    }
    const captured = project(top, display);
    home = captured.result;
    if (captured.omitted || customOmitted)
      warnings.push(
        'Unsupported display fields and custom preferences were excluded. Client-local options cannot be copied.',
      );
  }
  const parameters = { policy: permissions.result, configuration: account.result, display: home };
  validateRoleParameters(parameters);
  return { parameters, warnings };
}

/** Merge with a fresh target read so settings outside this role remain the user's own. */
export function mergeRoleSection(
  section: RoleSection,
  current: JsonObject,
  parameters: RoleParameters,
): JsonObject {
  validateRoleParameters(parameters);
  if (!record(current) || !['policy', 'configuration', 'display'].includes(section))
    throw invalid();
  const snapshot = parameters[section];
  const result = { ...structuredClone(current), ...structuredClone(snapshot ?? {}) };
  if (section === 'policy') {
    result.IsAdministrator = false;
    // IsDisabled is intentionally absent from validated snapshots. Preserve subscription/admin state.
    if (Object.hasOwn(current, 'IsDisabled')) result.IsDisabled = current.IsDisabled;
  }
  if (section === 'display' && snapshot && record(snapshot.CustomPrefs)) {
    result.CustomPrefs = {
      ...(record(current.CustomPrefs) ? structuredClone(current.CustomPrefs) : {}),
      ...structuredClone(snapshot.CustomPrefs),
    };
  }
  return result;
}
