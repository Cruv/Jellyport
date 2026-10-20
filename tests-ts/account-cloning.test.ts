import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { MediaClient, type JsonObject, type MediaAPI, type MediaItem } from '../server/media.js';
import { MediaError } from '../server/errors.js';
import { Service, type Job } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import { CloneReviews, type CloneAccountsInput } from '../server/account-cloning.js';

interface Call {
  method: string;
  args: unknown[];
}
describe('reviewed independent Jellyfin account clones', () => {
  let path: string, store: Store, servers: DemoServers, service: Service;
  let calls: Call[];
  let before: ((method: string, args: unknown[]) => Promise<void>) | undefined;
  let after: ((method: string, args: unknown[], result: unknown) => Promise<void>) | undefined;
  const input = (): CloneAccountsInput => ({
    source_user_id: 'kids',
    expected_source_username: 'Kids',
    accounts: [
      { username: 'KidOne', family: true },
      { username: 'KidTwo', family: false },
    ],
  });
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'jellyport-clone-'));
    store = new Store(path);
    servers = new DemoServers();
    calls = [];
    before = undefined;
    after = undefined;
    const settings = {
      ...DEFAULT_SETTINGS,
      jellyfin_url: 'http://jellyfin',
      jellyfin_api_key: 'synthetic-key',
      template_user_id: 'template',
    };
    const pending = store.resetAuth(settings.jellyfin_url);
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: settings.jellyfin_url,
        serverId: 'demo-jellyfin',
        apiKeyName: 'test',
      },
      () => settings,
    );
    servers.users.jellyfin.push({
      Id: 'kids',
      Name: 'Kids',
      Policy: {
        IsAdministrator: false,
        IsDisabled: false,
        IsHidden: true,
        EnableAllFolders: false,
        EnabledFolders: ['kids-library'],
        BlockedTags: ['adult'],
        MaxParentalRating: 6,
        BlockUnratedItems: ['Movie', 'Series'],
        EnableContentDownloading: false,
        LoginAttemptsBeforeLockout: -1,
        InvalidLoginAttemptCount: 2,
        AuthenticationProviderId: 'source-provider',
        PasswordResetProviderId: 'source-reset',
        AccessSchedules: [
          { DayOfWeek: 'Weekday', StartHour: 8, EndHour: 20, Id: 1, UserId: 'kids' },
        ],
      },
      Configuration: {
        SubtitleMode: 'Smart',
        HidePlayedInLatest: true,
        EnableNextEpisodeAutoPlay: true,
        CastReceiverId: 'source-device',
      },
      Password: 'source-never-copy',
      Token: 'source-token',
    });
    servers.display.kids = {
      Id: 'private-display',
      CustomPrefs: { homesection0: 'resume', homesection1: 'nextup', pluginToken: 'source-secret' },
      ShowBackdrop: true,
    };
    servers.played.kids = new Set(['1', '3']);
    servers.userData.kids = {
      '1': { PlaybackPositionTicks: 125_000, IsFavorite: true, PlayCount: 4 },
    };
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args);
        for (const method of [
          'users',
          'user',
          'systemInfo',
          'clonePlayedItems',
          'createUser',
          'setPassword',
          'setPolicy',
          'setConfiguration',
          'displayPreferences',
          'setDisplayPreferences',
          'destinationItems',
          'updateUserData',
          'catalogItems',
          'migrationItems',
          'renameUser',
        ] as const) {
          const original = client[method];
          if (!original) continue;
          (client as unknown as Record<string, unknown>)[method] = async (...values: unknown[]) => {
            calls.push({ method, args: structuredClone(values) });
            await before?.(method, values);
            const result = await (original as (...params: unknown[]) => Promise<unknown>).apply(
              client,
              values,
            );
            await after?.(method, values, result);
            return result;
          };
        }
        return client;
      },
    });
  });
  afterEach(async () => {
    before = undefined;
    after = undefined;
    await service.stop();
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const source = () => servers.users.jellyfin.find((user) => user.Id === 'kids')!;
  const writes = () =>
    calls.filter((call) =>
      [
        'createUser',
        'setPassword',
        'setPolicy',
        'setConfiguration',
        'setDisplayPreferences',
        'updateUserData',
        'renameUser',
      ].includes(call.method),
    );
  async function finish(job: Job) {
    await service.jobTasks.get(job.id);
    return service.getJob(job.id);
  }
  async function clone(value = input()) {
    return finish(await service.cloneAccounts(await service.reviewCloneAccounts(value)));
  }

  it('reviews without history reads or writes and never exposes the source credentials or parameters', async () => {
    const reviewed = await service.reviewCloneAccounts(input());
    const reviews = new CloneReviews();
    const publicReview = reviews.save('owner', 'context', reviewed);
    expect(
      calls.some((call) =>
        ['clonePlayedItems', 'catalogItems', 'migrationItems', 'destinationItems'].includes(
          call.method,
        ),
      ),
    ).toBe(false);
    expect(writes()).toEqual([]);
    expect(publicReview.warnings).not.toContain(
      'Unsupported or account-specific permission fields were excluded.',
    );
    expect(publicReview.warnings).toContain(
      'Unsupported or account-specific configuration fields were excluded.',
    );
    expect(publicReview.warnings).toContain(
      'Unsupported display fields and custom preferences were excluded. Client-local options cannot be copied.',
    );
    expect(JSON.stringify(publicReview)).not.toMatch(
      /source-never-copy|source-token|source-secret|source-provider|parameters|EnabledFolders/,
    );
    expect(reviewed.source.parameters.policy).toMatchObject({
      LoginAttemptsBeforeLockout: -1,
      MaxParentalRating: 6,
      EnabledFolders: ['kids-library'],
    });
    expect(reviewed.source.parameters.policy).not.toHaveProperty('InvalidLoginAttemptCount');
    expect(reviewed.source.parameters.policy.AccessSchedules).toEqual([
      { DayOfWeek: 'Weekday', StartHour: 8, EndHour: 20 },
    ]);
    expect(() => reviews.take('other', 'context', publicReview.id)).toThrow(/expired|changed/);
    expect(() => reviews.take('owner', 'changed', publicReview.id)).toThrow(/expired|changed/);
    expect(reviews.take('owner', 'context', publicReview.id)).toEqual(reviewed);
    expect(() => reviews.take('owner', 'context', publicReview.id)).toThrow(/expired|changed/);
  });
  it('creates two independent accounts with one source read, protected settings, separate passwords and played flags only', async () => {
    const untouched = structuredClone({
      user: source(),
      data: servers.userData.kids,
      played: [...servers.played.kids!],
      display: servers.display.kids,
    });
    const job = await clone();
    expect(job.status).toBe('completed');
    expect(job.results).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'clonePlayedItems')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'catalogItems')).toHaveLength(0);
    const credentials = store.takeCredentials(job.id);
    expect(credentials.map((value) => value.username)).toEqual(['KidOne', 'KidTwo']);
    expect(new Set(credentials.map((value) => value.password)).size).toBe(2);
    expect(store.takeCredentials(job.id)).toEqual([]);
    for (const result of job.results) {
      expect(result).toMatchObject({
        status: 'completed',
        created: true,
        source_played: 2,
        matched: 2,
        applied: 2,
        cloned_from_user_id: 'kids',
      });
      const user = servers.users.jellyfin.find((entry) => entry.Id === result.target_user_id)!;
      expect(user.Id).not.toBe('kids');
      expect(user.Policy).toMatchObject({
        IsAdministrator: false,
        IsDisabled: false,
        MaxParentalRating: 6,
        BlockedTags: ['adult'],
        EnableAllFolders: false,
        EnabledFolders: ['kids-library'],
        LoginAttemptsBeforeLockout: -1,
      });
      expect(user.Configuration).toMatchObject({ SubtitleMode: 'Smart', HidePlayedInLatest: true });
      expect(user.Configuration).not.toHaveProperty('CastReceiverId');
      expect(servers.display[user.Id]?.CustomPrefs).toMatchObject({
        homesection0: 'resume',
        homesection1: 'nextup',
      });
      expect(store.linkForRemote(user.Id)).toBeNull();
      expect(service.roles.getAssignment(user.Id, store.settings())).toBeNull();
      expect(service.profiles.get('jellyfin', user.Id, store.settings())?.family).toBe(
        result.username === 'KidOne',
      );
      expect(servers.userData[user.Id]).toEqual({ '1': { Played: true }, '3': { Played: true } });
      expect(result.data?.verification).toMatchObject({
        checked: 2,
        verified: 2,
        missing: 0,
        mismatched: 0,
      });
      const policyCalls = writes().filter(
        (call) => call.method === 'setPolicy' && call.args[0] === user.Id,
      );
      expect(policyCalls[0]?.args[1]).toMatchObject({ IsDisabled: true });
      expect(policyCalls.at(-1)?.args[1]).toMatchObject({ IsDisabled: false });
    }
    expect(writes().filter((call) => call.args[0] === 'kids')).toEqual([]);
    expect(writes().some((call) => call.method === 'setPassword')).toBe(false);
    expect({
      user: source(),
      data: servers.userData.kids,
      played: [...servers.played.kids!],
      display: servers.display.kids,
    }).toEqual(untouched);
    expect(JSON.stringify(job)).not.toMatch(/source-never-copy|source-token|source-secret/);
  });
  it.each(['administrator', 'template', 'disabled', 'unknown policy'])(
    'rejects a protected %s source without writes',
    async (kind) => {
      if (kind === 'administrator') source().Policy!.IsAdministrator = true;
      if (kind === 'template')
        store.saveSettings({ ...store.settings(), template_user_id: 'kids' });
      if (kind === 'disabled') source().Policy!.IsDisabled = true;
      if (kind === 'unknown policy') delete source().Policy!.IsAdministrator;
      await expect(service.reviewCloneAccounts(input())).rejects.toThrow(
        /enabled|administrator|template/,
      );
      expect(writes()).toEqual([]);
    },
  );
  it.each(['duplicate', 'existing', 'unsupported restriction', 'invalid restriction'])(
    'fails closed for %s',
    async (kind) => {
      const value = input();
      if (kind === 'duplicate') value.accounts[1]!.username = 'KIDONE';
      if (kind === 'existing') value.accounts[0]!.username = 'Kids';
      if (kind === 'unsupported restriction') source().Policy!.UnknownParentalDeny = true;
      if (kind === 'invalid restriction') source().Policy!.MaxParentalRating = 'six';
      await expect(service.reviewCloneAccounts(value)).rejects.toThrow();
      expect(writes()).toEqual([]);
    },
  );
  it('rejects a changed source policy after review and stale server identities before account creation', async () => {
    const reviewed = await service.reviewCloneAccounts(input());
    source().Policy!.MaxParentalRating = 18;
    await expect(service.cloneAccounts(reviewed)).rejects.toThrow(/settings changed/);
    source().Policy!.MaxParentalRating = 6;
    before = async (method) => {
      if (method === 'clonePlayedItems') source().Name = 'Changed';
    };
    const job = await finish(await service.cloneAccounts(reviewed));
    expect(job.status).toBe('failed');
    expect(writes()).toEqual([]);
  });
  it.each(['setConfiguration', 'setDisplayPreferences'])(
    'keeps incomplete account disabled when %s fails',
    async (method) => {
      const value = input();
      value.accounts = [value.accounts[0]!];
      before = async (current) => {
        if (current === method) throw new MediaError('Synthetic failure');
      };
      const job = await clone(value);
      expect(job.status).toBe('failed');
      const created = servers.users.jellyfin.find((user) => user.Name === 'KidOne')!;
      expect(created.Policy?.IsDisabled).toBe(true);
      expect(store.takeCredentials(job.id)).toEqual([]);
      expect(store.account('KidOne')?.status).toBe('clone_incomplete');
      await expect(service.recoverAccount('KidOne', created.Id)).rejects.toThrow(
        /incomplete clone|restrictions/,
      );
      expect(writes().some((call) => call.method === 'updateUserData')).toBe(false);
      expect(source().Policy?.IsDisabled).toBe(false);
    },
  );
  it('stops before creation when parental restrictions change during history capture', async () => {
    const reviewed = await service.reviewCloneAccounts(input());
    after = async (method) => {
      if (method === 'clonePlayedItems') source().Policy!.MaxParentalRating = 3;
    };
    const job = await finish(await service.cloneAccounts(reviewed));
    expect(job.status).toBe('failed');
    expect(writes()).toEqual([]);
  });
  it('keeps the new account disabled when library restrictions change during account preparation', async () => {
    const value = input();
    value.accounts = [value.accounts[0]!];
    after = async (method) => {
      if (method === 'setConfiguration')
        source().Policy!.EnabledFolders = ['more-restricted-library'];
    };
    const job = await clone(value);
    expect(job.status).toBe('failed');
    expect(servers.users.jellyfin.find((user) => user.Name === 'KidOne')?.Policy?.IsDisabled).toBe(
      true,
    );
    expect(store.takeCredentials(job.id)).toEqual([]);
  });
  it('journals uncertain creation and blocks a blind retry or existing-account adoption', async () => {
    const value = input();
    value.accounts = [value.accounts[0]!];
    before = async (method) => {
      if (method === 'createUser') throw new MediaError('Synthetic timeout');
    };
    const job = await clone(value);
    expect(job.status).toBe('failed');
    expect(store.account('KidOne')?.status).toBe('clone_uncertain');
    before = undefined;
    await expect(service.reviewCloneAccounts(value)).rejects.toThrow(/unfinished creation/);
    expect(calls.filter((call) => call.method === 'createUser')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'setPassword')).toBe(false);
    await expect(service.recoverAccount('KidOne', 'unknown')).rejects.toThrow(
      /incomplete clone|restrictions/,
    );
  });
  it('keeps clone recovery restrictions durable after report cleanup and a restart', async () => {
    const value = input();
    value.accounts = [value.accounts[0]!];
    before = async (method) => {
      if (method === 'setConfiguration') throw new MediaError('Synthetic setup failure');
    };
    const job = await clone(value);
    expect(service.clearJobHistory([job.id])).toEqual({
      removed_ids: [],
      skipped: [{ id: job.id, reason: 'recovery_required' }],
    });
    // The durable origin journal remains authoritative even without a presentation report.
    store.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
    await service.stop();
    store.close();
    store = new Store(path);
    service = new Service(store, { clientFactory: servers.factory });
    const target = servers.users.jellyfin.find((user) => user.Name === 'KidOne')!;
    expect(store.account('KidOne')?.status).toBe('clone_incomplete');
    await expect(service.recoverAccount('KidOne', target.Id)).rejects.toThrow(
      /incomplete clone|restrictions/,
    );
    await expect(service.createAccount('KidOne')).rejects.toThrow(/incomplete clone|restrictions/);
    expect(target.Policy?.IsDisabled).toBe(true);
  });
  it('does not let a malicious create response modify the source or another existing ID', async () => {
    const value = input();
    value.accounts = [value.accounts[0]!];
    after = async (method, _args, result) => {
      if (method === 'createUser') Object.assign(result as object, { Id: 'kids' });
    };
    const job = await clone(value);
    expect(job.status).toBe('failed');
    expect(writes().filter((call) => call.args[0] === 'kids')).toEqual([]);
  });
  it('reports a failed write and independent ignored-write verification instead of success', async () => {
    const value = input();
    value.accounts = [value.accounts[0]!];
    after = async (method, args) => {
      if (method === 'updateUserData') {
        servers.played[args[0] as string]?.delete(args[1] as string);
        delete servers.userData[args[0] as string]?.[args[1] as string];
      }
    };
    const job = await clone(value);
    expect(job.status).toBe('partial');
    expect(job.results[0]?.data?.verification).toMatchObject({
      checked: 2,
      verified: 0,
      mismatched: 2,
    });
  });
  it('cancels before account work without reading history or creating accounts', async () => {
    const reviewed = await service.reviewCloneAccounts(input());
    const job = await service.cloneAccounts(reviewed);
    service.cancelJob(job.id);
    const completed = await finish(job);
    expect(completed.status).toBe('canceled');
    expect(writes()).toEqual([]);
    expect(calls.some((call) => call.method === 'clonePlayedItems')).toBe(false);
  });
  it('renames one stable ID while retaining password, policy, personal data and shared Home settings', async () => {
    const untouched = structuredClone(source());
    const result = await service.renameAccount({
      user_id: 'kids',
      expected_username: 'Kids',
      username: 'KidThree',
    });
    expect(result).toEqual({ user_id: 'kids', username: 'KidThree', previous_username: 'Kids' });
    expect(source()).toEqual({ ...untouched, Name: 'KidThree' });
    expect(writes().map((call) => call.method)).toEqual(['renameUser']);
    expect(servers.userData.kids?.['1']?.PlaybackPositionTicks).toBe(125_000);
    expect(servers.display.kids?.CustomPrefs).toMatchObject({ homesection0: 'resume' });
  });
  it('reconciles a timed-out successful rename by exact ID without replaying the POST', async () => {
    after = async (method) => {
      if (method === 'renameUser') throw new MediaError('Synthetic lost response');
    };
    const result = await service.renameAccount({
      user_id: 'kids',
      expected_username: 'Kids',
      username: 'KidThree',
    });
    expect(result.username).toBe('KidThree');
    expect(writes().filter((call) => call.method === 'renameUser')).toHaveLength(1);
  });
  it('retains uncertain rename evidence and refuses a blind retry', async () => {
    before = async (method) => {
      if (method === 'renameUser') throw new MediaError('Synthetic lost response');
    };
    const request = { user_id: 'kids', expected_username: 'Kids', username: 'KidThree' };
    await expect(service.renameAccount(request)).rejects.toThrow(/could not be fully confirmed/);
    before = undefined;
    await expect(service.renameAccount(request)).rejects.toThrow(/uncertain outcome/);
    expect(writes().filter((call) => call.method === 'renameUser')).toHaveLength(1);
    expect(await service.renameAccountRecovery('kids')).toEqual({
      pending: {
        user_id: 'kids',
        expected_username: 'Kids',
        username: 'KidThree',
        can_confirm: false,
      },
    });
    source().Name = 'KidThree'; // Owner verifies/finishes the name in Jellyfin itself.
    expect(await service.renameAccountRecovery('kids')).toEqual({
      pending: {
        user_id: 'kids',
        expected_username: 'Kids',
        username: 'KidThree',
        can_confirm: true,
      },
    });
    expect((await service.renameAccount(request)).username).toBe('KidThree');
    expect(writes().filter((call) => call.method === 'renameUser')).toHaveLength(1);
    expect(await service.renameAccountRecovery('kids')).toEqual({ pending: null });
  });
});

describe('bounded documented Jellyfin account clone transport', () => {
  it('pages only played playable items without totals, images or full catalog/series scans', async () => {
    const requests: URL[] = [];
    const catalog: MediaItem[] = Array.from({ length: 235 }, (_, index) => ({
      Id: `m${index}`,
      Type: index % 2 ? 'Episode' : 'Movie',
      Name: `Item ${index}`,
      UserData: { Played: true, IsFavorite: true, PlaybackPositionTicks: 99 },
      ProviderIds: { Tmdb: String(index) },
    }));
    const client = new MediaClient('http://jellyfin', 'synthetic', 'jellyfin', {
      catalogIdleMs: 0,
      sleep: async () => {},
      transport: async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        const start = Number(parsed.searchParams.get('StartIndex'));
        return Response.json({ Items: catalog.slice(start, start + 73), TotalRecordCount: 0 });
      },
    });
    const result = await client.clonePlayedItems('kids');
    expect(result).toHaveLength(235);
    expect(requests).toHaveLength(5);
    for (const url of requests) {
      expect(url.pathname).toBe('/Items');
      expect(url.searchParams.get('UserId')).toBe('kids');
      expect(url.searchParams.get('IsPlayed')).toBe('true');
      expect(url.searchParams.get('EnableTotalRecordCount')).toBe('false');
      expect(url.searchParams.get('IncludeItemTypes')).not.toMatch(/Series|Season/);
      expect(url.searchParams.get('Limit')).toBe('100');
      expect(url.searchParams.get('Fields')).toBe('ProviderIds,Path');
      expect(url.searchParams.get('EnableImages')).toBe('false');
    }
    await client.close();
  });
  it('rejects a shifted repeated page rather than silently dropping history', async () => {
    const client = new MediaClient('http://jellyfin', 'synthetic', 'jellyfin', {
      catalogIdleMs: 0,
      transport: async () =>
        Response.json({ Items: [{ Id: 'm', Type: 'Movie', UserData: { Played: true } }] }),
    });
    await expect(client.clonePlayedItems('kids')).rejects.toThrow(/repeated/);
    await client.close();
  });
  it('bounds transient read retries and backoff without retrying unrelated work', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const client = new MediaClient('http://jellyfin', 'synthetic', 'jellyfin', {
      catalogIdleMs: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
      transport: async () => {
        attempts++;
        return attempts < 3
          ? new Response('', { status: 429, headers: { 'Retry-After': '99' } })
          : Response.json({ Items: [] });
      },
    });
    expect(await client.clonePlayedItems('kids')).toEqual([]);
    expect(attempts).toBe(3);
    expect(delays).toEqual([2000, 2000]);
    await client.close();
  });
  it('cancels an in-flight page promptly and starts no further page', async () => {
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const client = new MediaClient('http://jellyfin', 'synthetic', 'jellyfin', {
      transport: async () => {
        calls++;
        entered();
        return new Promise<Response>(() => {});
      },
    });
    const result = client.clonePlayedItems('kids');
    const rejected = expect(result).rejects.toThrow();
    await pending;
    await client.close();
    await rejected;
    expect(calls).toBe(1);
  });
  it('bounds retained history bytes before adopting a source result', async () => {
    let calls = 0;
    const providers = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`Provider${index}`, 'x'.repeat(1024)]),
    );
    const client = new MediaClient('http://jellyfin', 'synthetic', 'jellyfin', {
      catalogIdleMs: 0,
      transport: async () => {
        const start = calls++ * 100;
        return Response.json({
          Items: Array.from({ length: 100 }, (_, offset) => ({
            Id: `m${start + offset}`,
            Type: 'Movie',
            ProviderIds: providers,
            UserData: { Played: true },
          })),
        });
      },
    });
    await expect(client.clonePlayedItems('kids')).rejects.toThrow(/supported size/);
    expect(calls).toBeLessThanOrEqual(6);
    await client.close();
  });
  it('sends a narrow rename with the existing configuration and never retries it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MediaClient('http://jellyfin', 'synthetic', 'jellyfin', {
      sleep: async () => {},
      transport: async (url, init) => {
        calls.push({ url, init });
        return new Response('', { status: 503 });
      },
    });
    await expect(
      client.renameUser('kids', 'KidThree', { SubtitleMode: 'Smart' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get('userId')).toBe('kids');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      Id: 'kids',
      Name: 'KidThree',
      Configuration: { SubtitleMode: 'Smart' },
    });
    await client.close();
  });
});
