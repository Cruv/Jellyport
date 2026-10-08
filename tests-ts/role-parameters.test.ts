import { describe, expect, it } from 'vitest';
import {
  captureRoleParameters,
  mergeRoleSection,
  validateRoleParameters,
  type RoleParameters,
} from '../server/role-parameters.js';
import { DemoServers } from '../server/demo.js';

const valid = (): RoleParameters => ({
  policy: {
    IsAdministrator: false,
    EnableAllFolders: false,
    EnabledFolders: ['library-1'],
    EnableContentDownloading: false,
  },
  configuration: {
    AudioLanguagePreference: 'eng',
    SubtitleMode: 'Smart',
    HidePlayedInLatest: true,
    EnableNextEpisodeAutoPlay: true,
  },
  display: {
    ShowBackdrop: true,
    CustomPrefs: {
      homesection0: 'resume',
      homesection1: 'nextup',
      useEpisodeImagesInNextUpAndResume: 'true',
      skipBackLength: '10000',
      'landing-library-1': 'movies',
    },
  },
});

describe('role parameter snapshots', () => {
  it('captures supported settings while stripping identity, credentials, admin and disabled state', () => {
    const source = {
      Id: 'source-user',
      Name: 'Source',
      Password: 'never-store',
      LastActivityDate: 'secret-date',
      Policy: {
        ...valid().policy,
        IsAdministrator: true,
        IsDisabled: true,
        AuthenticationProviderId: 'secret-plugin',
        PasswordResetProviderId: 'secret-reset',
        InvalidLoginAttemptCount: 9,
        LoginAttemptsBeforeLockout: 4,
        AccessSchedules: [
          { DayOfWeek: 'Weekday', StartHour: 8, EndHour: 22, Id: 19, UserId: 'source-user' },
        ],
      },
      Configuration: {
        ...valid().configuration,
        EnableLocalPassword: true,
        CastReceiverId: 'private-device',
        CustomPreference: 'private-value',
      },
    };
    const captured = captureRoleParameters(source, {
      ...valid().display,
      Id: 'source-display',
      Client: 'emby',
      CustomPrefs: {
        ...(valid().display!.CustomPrefs as object),
        pluginToken: 'never-store',
        customCss: 'url(https://secret.test)',
        homesection2: 'LATESTMEDIA',
        enableNextVideoInfoOverlay: 'True',
      },
    });
    expect(captured.parameters.policy).toEqual({
      ...valid().policy,
      AccessSchedules: [{ DayOfWeek: 'Weekday', StartHour: 8, EndHour: 22 }],
    });
    expect(captured.parameters.configuration).toEqual(valid().configuration);
    expect(captured.parameters.display).toEqual({
      ShowBackdrop: true,
      CustomPrefs: {
        ...(valid().display!.CustomPrefs as object),
        homesection2: 'latestmedia',
        enableNextVideoInfoOverlay: 'true',
      },
    });
    expect(captured.warnings).toHaveLength(4);
    expect(JSON.stringify(captured)).not.toMatch(
      /never-store|private-|secret-|source-user|source-display/,
    );
    expect(source.Policy.IsAdministrator).toBe(true);
    expect(source.Policy.AccessSchedules[0]?.UserId).toBe('source-user');
  });

  it('does not share mutable source data with the saved snapshot', () => {
    const user = {
      Id: 'u',
      Name: 'name',
      Policy: { EnabledFolders: ['library-1'] },
      Configuration: { OrderedViews: ['library-1'] },
    };
    const home = { CustomPrefs: { homesection0: 'resume' } };
    const captured = captureRoleParameters(user, home);
    user.Policy.EnabledFolders.push('library-2');
    user.Configuration.OrderedViews.reverse();
    home.CustomPrefs.homesection0 = 'nextup';
    expect(captured.parameters.policy.EnabledFolders).toEqual(['library-1']);
    expect(captured.parameters.display!.CustomPrefs).toEqual({ homesection0: 'resume' });
  });

  it('warns explicitly when home preferences cannot be captured', () => {
    const result = captureRoleParameters({ Id: 'u', Name: 'name' });
    expect(result.parameters).toEqual({
      policy: { IsAdministrator: false },
      configuration: {},
      display: null,
    });
    expect(result.warnings).toEqual([
      'Home screen preferences were not available; this role will leave them unchanged.',
    ]);
  });
  it.each(['horizontal', 'vertical', ''])(
    'captures and applies the supported TV home orientation %j',
    (tvhome) => {
      const captured = captureRoleParameters(
        { Id: 'source', Name: 'source' },
        { CustomPrefs: { tvhome: tvhome.toUpperCase() } },
      );
      expect(captured.parameters.display).toEqual({ CustomPrefs: { tvhome } });
      expect(captured.warnings).toEqual([]);
      expect(() => validateRoleParameters(captured.parameters)).not.toThrow();
      expect(
        mergeRoleSection(
          'display',
          { CustomPrefs: { tvhome: 'old', untouched: 'target-only' } },
          captured.parameters,
        ),
      ).toEqual({ CustomPrefs: { tvhome, untouched: 'target-only' } });
    },
  );
  it('round-trips all ten ordered Home sections, hidden rows and an explicit default slot', () => {
    const sections = [
      'none',
      'nextup',
      'resume',
      'latestmedia',
      'librarybuttons',
      'smalllibrarytiles',
      'resumeaudio',
      'resumebook',
      'livetv',
      '',
    ];
    const source = Object.fromEntries(
      sections.map((section, index) => [`homesection${index}`, section.toUpperCase()]),
    );
    const captured = captureRoleParameters(
      { Id: 'source', Name: 'source' },
      { CustomPrefs: { ...source, tvhome: 'VERTICAL' } },
    );
    const expected = Object.fromEntries(
      sections.map((section, index) => [`homesection${index}`, section]),
    );
    expect(captured.parameters.display).toEqual({
      CustomPrefs: { ...expected, tvhome: 'vertical' },
    });
    const target = {
      CustomPrefs: {
        ...Object.fromEntries(sections.map((_, index) => [`homesection${index}`, 'latestmedia'])),
        tvhome: 'horizontal',
        targetOnly: 'preserved',
      },
    };
    const merged = mergeRoleSection('display', target, captured.parameters);
    expect(merged.CustomPrefs).toEqual({
      ...expected,
      tvhome: 'vertical',
      targetOnly: 'preserved',
    });
    const roundTrip = captureRoleParameters({ Id: 'target', Name: 'target' }, merged);
    expect(roundTrip.parameters.display).toEqual(captured.parameters.display);
    expect(target.CustomPrefs).toMatchObject({ homesection0: 'latestmedia' });
  });
  it('preserves blank legacy Home defaults without inventing absent section settings', () => {
    const captured = captureRoleParameters(
      { Id: 'source', Name: 'source' },
      { CustomPrefs: { homesection0: '', homesection3: '', homesection7: 'none' } },
    );
    expect(captured.warnings).toEqual([]);
    expect(captured.parameters.display).toEqual({
      CustomPrefs: { homesection0: '', homesection3: '', homesection7: 'none' },
    });
    const merged = mergeRoleSection(
      'display',
      {
        CustomPrefs: {
          homesection0: 'nextup',
          homesection1: 'livetv',
          homesection3: 'resume',
          homesection7: 'latestmedia',
        },
      },
      captured.parameters,
    );
    expect(merged.CustomPrefs).toEqual({
      homesection0: '',
      homesection1: 'livetv',
      homesection3: '',
      homesection7: 'none',
    });
  });
  it('captures a nullable unset TV home as an explicit safe default reset', () => {
    const captured = captureRoleParameters(
      { Id: 'source', Name: 'source' },
      { CustomPrefs: { tvhome: null } },
    );
    expect(captured.parameters.display).toEqual({ CustomPrefs: { tvhome: '' } });
    expect(captured.warnings).toEqual([]);
    expect(
      mergeRoleSection('display', { CustomPrefs: { tvhome: 'vertical' } }, captured.parameters),
    ).toEqual({ CustomPrefs: { tvhome: '' } });
    expect(() =>
      validateRoleParameters({ ...valid(), display: { CustomPrefs: { tvhome: null } } }),
    ).toThrow();
  });
  it.each([
    'diagonal',
    'https://attacker.example',
    'javascript:alert(1)',
    '<script>',
    'horizontal\n',
    1,
    false,
    {},
  ])('rejects untrusted TV orientation %j without persisting it', (tvhome) => {
    const candidate = { ...valid(), display: { CustomPrefs: { tvhome } } };
    expect(() => validateRoleParameters(candidate)).toThrow(
      'Role parameters contain unsupported fields or invalid values.',
    );
    const captured = captureRoleParameters(
      { Id: 'source', Name: 'source' },
      { CustomPrefs: { tvhome, homesection0: 'resume' } },
    );
    expect(captured.parameters.display).toEqual({ CustomPrefs: { homesection0: 'resume' } });
    expect(captured.warnings).toHaveLength(1);
  });
  it('rejects prototype-bearing Home parameters and unverified local or plugin keys', () => {
    for (const prefs of [
      JSON.parse('{"tvhome":"vertical","__proto__":{"tvhome":"horizontal"}}'),
      Object.create({ tvhome: 'vertical' }),
      { tvhome: 'vertical', maxDaysForNextUp: '100' },
      { tvhome: 'vertical', enableRewatchingInNextUp: 'true' },
      { tvhome: 'vertical', pluginToken: 'secret' },
    ]) {
      expect(() => validateRoleParameters({ ...valid(), display: { CustomPrefs: prefs } })).toThrow(
        'Role parameters contain unsupported fields or invalid values.',
      );
    }
  });

  it.each([
    { policy: { IsAdministrator: true } },
    { policy: { IsDisabled: false } },
    { policy: { AuthenticationProviderId: 'provider' } },
    { policy: { PasswordResetProviderId: 'provider' } },
    { policy: { InvalidLoginAttemptCount: 0 } },
    { policy: { LoginAttemptsBeforeLockout: -1 } },
    { configuration: { EnableLocalPassword: true } },
    { configuration: { CastReceiverId: 'device' } },
    { display: { Id: 'private-user' } },
    { display: { CustomPrefs: { pluginToken: 'secret-token' } } },
    { display: { CustomPrefs: { customCss: 'background:url(https://example.test)' } } },
    { display: { CustomPrefs: { homesection10: 'resume' } } },
    { display: { CustomPrefs: { homesection0: 'https://example.test' } } },
    { display: { CustomPrefs: { 'landing-library': 'javascript:alert(1)' } } },
  ])('rejects unsupported or account-specific fields without echoing their values: %j', (patch) => {
    expect(() => validateRoleParameters({ ...valid(), ...patch })).toThrow(
      'Role parameters contain unsupported fields or invalid values.',
    );
  });

  it.each([
    null,
    [],
    {},
    { ...valid(), extra: true },
    { ...valid(), policy: null },
    { ...valid(), display: [] },
    { ...valid(), policy: { IsHidden: 'false' } },
    { ...valid(), policy: { MaxActiveSessions: -1 } },
    { ...valid(), policy: { MaxActiveSessions: 1.5 } },
    { ...valid(), policy: { MaxActiveSessions: 10_001 } },
    { ...valid(), policy: { RemoteClientBitrateLimit: Infinity } },
    { ...valid(), policy: { EnabledFolders: ['x'.repeat(129)] } },
    { ...valid(), policy: { EnabledFolders: ['library?userId=other'] } },
    { ...valid(), policy: { EnabledFolders: Array(513).fill('library') } },
    { ...valid(), policy: { EnabledFolders: Array(2) } },
    { ...valid(), policy: { BlockedTags: ['bad\ncontrol'] } },
    {
      ...valid(),
      policy: {
        AccessSchedules: [{ DayOfWeek: 'Monday', StartHour: 0, EndHour: 24, UserId: 'other' }],
      },
    },
    {
      ...valid(),
      policy: { AccessSchedules: [{ DayOfWeek: 'Monday', StartHour: -1, EndHour: 24 }] },
    },
    { ...valid(), policy: { BlockUnratedItems: ['UnknownType'] } },
    { ...valid(), configuration: { AudioLanguagePreference: 'not-a-valid-language-value' } },
    { ...valid(), configuration: { SubtitleMode: 0 } },
    { ...valid(), display: { CustomPrefs: { skipForwardLength: '3600001' } } },
    { ...valid(), display: { CustomPrefs: { skipForwardLength: '1e3' } } },
    { ...valid(), display: { CustomPrefs: { useEpisodeImagesInNextUpAndResume: true } } },
    { ...valid(), policy: JSON.parse('{"__proto__":{"IsAdministrator":true}}') },
    { ...valid(), configuration: Object.create({ HidePlayedInLatest: true }) },
  ])('rejects malformed, unbounded and prototype-bearing role data: %j', (value) => {
    expect(() => validateRoleParameters(value)).toThrow(
      'Role parameters contain unsupported fields or invalid values.',
    );
  });

  it('accepts supported nullable preferences, safe parental settings and bounded schedules', () => {
    const parameters = valid();
    parameters.policy = {
      MaxParentalRating: null,
      MaxParentalSubRating: 21,
      AllowedTags: ['Family'],
      AccessSchedules: [{ DayOfWeek: 'Everyday', StartHour: 0, EndHour: 24 }],
      SyncPlayAccess: 'JoinGroups',
    };
    parameters.configuration = {
      AudioLanguagePreference: null,
      SubtitleLanguagePreference: 'pt-BR',
      OrderedViews: ['movies'],
      EnableNextEpisodeAutoPlay: false,
    };
    expect(() => validateRoleParameters(parameters)).not.toThrow();
  });

  it('skips malformed imported settings without persisting them or logging values', () => {
    const captured = captureRoleParameters(
      {
        Id: 'u',
        Name: 'name',
        Policy: { EnabledFolders: ['not?an=id'], IsHidden: true },
        Configuration: { SubtitleMode: 'Unknown', AudioLanguagePreference: 'eng' },
      },
      { CustomPrefs: { homesection0: 'resume', skipForwardLength: '-500', customCss: 'secret' } },
    );
    expect(captured.parameters).toEqual({
      policy: { IsAdministrator: false, IsHidden: true },
      configuration: { AudioLanguagePreference: 'eng' },
      display: { CustomPrefs: { homesection0: 'resume' } },
    });
    expect(captured.warnings).toHaveLength(3);
    expect(JSON.stringify(captured)).not.toMatch(/secret|not\?an=id|Unknown|-500/);
  });
});

describe('applying selected role parameters', () => {
  it('preserves disable and authentication state, applies supported permissions and prevents admin escalation', () => {
    const current = {
      IsAdministrator: true,
      IsDisabled: true,
      AuthenticationProviderId: 'target-auth',
      InvalidLoginAttemptCount: 5,
      EnabledFolders: ['old-library'],
      TargetPluginSetting: { private: true },
    };
    const merged = mergeRoleSection('policy', current, valid());
    expect(merged).toEqual({
      ...current,
      ...valid().policy,
      IsDisabled: true,
      IsAdministrator: false,
    });
    expect(current.IsAdministrator).toBe(true);
    expect(current.EnabledFolders).toEqual(['old-library']);
    expect(merged.TargetPluginSetting).not.toBe(current.TargetPluginSetting);
  });

  it('preserves user-specific and unselected preferences including unknown display extensions', () => {
    const parameters = valid();
    expect(
      mergeRoleSection(
        'configuration',
        { EnableLocalPassword: true, CastReceiverId: 'my-device', HidePlayedInLatest: false },
        parameters,
      ),
    ).toEqual({
      EnableLocalPassword: true,
      CastReceiverId: 'my-device',
      ...parameters.configuration,
    });
    expect(
      mergeRoleSection(
        'display',
        {
          Id: 'target',
          Client: 'emby',
          CustomPrefs: { pluginValue: 'mine', homesection0: 'latestmedia', homesection8: 'livetv' },
        },
        parameters,
      ),
    ).toEqual({
      Id: 'target',
      Client: 'emby',
      ShowBackdrop: true,
      CustomPrefs: {
        pluginValue: 'mine',
        homesection8: 'livetv',
        ...(parameters.display!.CustomPrefs as object),
      },
    });
    parameters.display = null;
    expect(
      mergeRoleSection(
        'display',
        { ShowBackdrop: false, CustomPrefs: { existing: 'mine' } },
        parameters,
      ),
    ).toEqual({ ShowBackdrop: false, CustomPrefs: { existing: 'mine' } });
  });

  it('never changes a disabled user into an enabled user', () => {
    expect(mergeRoleSection('policy', { IsDisabled: false }, valid()).IsDisabled).toBe(false);
    expect(mergeRoleSection('policy', {}, valid())).not.toHaveProperty('IsDisabled');
    expect(() =>
      mergeRoleSection('policy', {}, { ...valid(), policy: { IsDisabled: false } }),
    ).toThrow();
  });

  it('implements isolated, cloned demo display preferences without writing to Emby', async () => {
    const demo = new DemoServers();
    const jellyfin = demo.factory('http://unused.test', 'unused', 'jellyfin');
    const initial = await jellyfin.displayPreferences!('template');
    expect(initial.CustomPrefs).toMatchObject({ homesection1: 'resume', homesection2: 'nextup' });
    await jellyfin.setDisplayPreferences!('j-river', { CustomPrefs: { homesection0: 'resume' } });
    const captured = await jellyfin.displayPreferences!('j-river');
    captured.CustomPrefs = {};
    expect(await jellyfin.displayPreferences!('j-river')).toEqual({
      CustomPrefs: { homesection0: 'resume' },
    });
    const emby = demo.factory('http://unused.test', 'unused', 'emby');
    await expect(emby.setDisplayPreferences!('e-alex', {})).rejects.toThrow('only on Jellyfin');
  });
});
