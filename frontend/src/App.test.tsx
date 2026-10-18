// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { StrictMode } from 'react';
import type {
  Job,
  MigrationDetails,
  Session,
  Settings,
  SetupConnection,
  SourceSnapshotMetadata,
  SourceSnapshotStatus,
  HistoryCleanupResult,
} from './types';

const session: Session = {
  authenticated: true,
  csrf_token: 'test-csrf',
  demo: false,
  setup_required: false,
  setup_connected: false,
  user: { id: 'admin-id', name: 'jellyfin-admin' },
};
const job: Job = {
  id: 'job-1',
  kind: 'create',
  status: 'completed',
  created_at: '2026-10-07T12:00:00Z',
  results: [
    {
      username: '<script>bad()</script>',
      status: 'created',
      created: true,
      discord_delivery: 'not_requested',
    },
  ],
};
const emptyPlayedDetails: MigrationDetails = {
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
};
const overview = {
  counts: { emby_users: 1, jellyfin_users: 1, jobs: 1 },
  connections: {
    emby: { connected: true, configured: true },
    jellyfin: { connected: true, configured: true },
    discord: { connected: false },
  },
  recent_jobs: [job],
};
const sourceSnapshot: SourceSnapshotMetadata = {
  id: '12345678-1234-4234-8234-123456789012',
  source_type: 'sqlite_online_backup',
  schema: 'Emby 4.10 user data',
  source_server_url: 'http://emby:8096',
  source_server_id: 'synthetic-source',
  source_server_version: '4.10.1.0',
  source_user_id: '',
  source_username: 'All Emby users',
  scope: 'complete',
  started_at: '2026-10-08T03:00:00Z',
  finished_at: '2026-10-08T03:00:05Z',
  expires_at: '2026-10-10T03:00:05Z',
  items: 0,
  playlists: 0,
  playlist_entries: 0,
  bytes: 1024,
  avatar: false,
};
const settings: Settings = {
  emby_url: '',
  emby_api_key_set: true,
  jellyfin_url: '',
  jellyfin_api_key_set: true,
  jellyfin_auth_managed: false,
  jellyfin_public_url: '',
  template_user_id: 'template',
  path_mappings: [],
  discord_enabled: false,
  discord_bot_token_set: false,
  discord_guild_id: '',
  discord_admin_role_id: '',
  discord_member_role_id: '',
  discord_application_id: '',
  discord_subscription_channel_id: '',
  discord_subscription_bot_id: '',
  discord_message_events: false,
  discord_role_events: false,
  auto_provision: false,
  auto_disable: false,
  disable_on_cancel: false,
  bot_invite_url: '',
};
let responses: Record<string, unknown>;
let statuses: Record<string, number>;
let requests: { path: string; options?: RequestInit }[];
beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  requests = [];
  statuses = {};
  responses = {
    '/api/session': session,
    '/api/overview': overview,
    '/api/jobs': { jobs: [job] },
    '/api/jobs/job-1': job,
    '/api/jobs/job-1/credentials': {
      credentials: [
        { username: 'alex', password: 'one-time-secret', server_url: 'javascript:alert(1)' },
      ],
    },
    '/api/settings': settings,
    '/api/users': { emby: [], jellyfin: [] },
    '/api/user-mappings': { mappings: [] },
    '/api/account-roles': { roles: [], assignments: [] },
    '/api/jobs/retention': {
      retention_days: 0,
      interval_seconds: 60,
      batch_limit: 100,
      last_run_at: null,
      last_removed: 0,
      last_kept: 0,
      error: null,
    },
    '/api/source-snapshots': {
      available: false,
      capture_method: 'sqlite_online_backup',
      config: {
        enabled: false,
        hour: 3,
        minute: 0,
        time_zone: 'UTC',
        scope: 'complete',
        revision: 'revision-1',
      },
      running: false,
      last_attempt_at: null,
      last_finished_at: null,
      last_error: null,
      users_total: 0,
      users_processed: 0,
      users_succeeded: 0,
      users_failed: 0,
      snapshots: 0,
      encrypted_bytes: 0,
      records: [],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      requests.push({ path, options });
      if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
      const value = responses[path];
      const status = statuses[path] || 200;
      if (status >= 200 && status < 300) {
        if (path === '/api/setup/connect')
          responses['/api/session'] = (value as SetupConnection).session;
        else if (['/api/login', '/api/logout', '/api/setup/complete'].includes(path))
          responses['/api/session'] = value;
      }
      return { ok: status >= 200 && status < 300, status, json: async () => value };
    }),
  );
});

describe('Activity report cleanup', () => {
  const past = (id: string, status = 'completed'): Job => ({
    ...job,
    id,
    status,
    created_at: '2000-01-01T00:00:00Z',
    finished_at: '2000-01-02T00:00:00Z',
    results: [{ username: `private-${id}`, status: 'completed' }],
  });
  async function review(jobs: Job[]) {
    responses['/api/jobs'] = { jobs };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete activity…' }));
    return screen.findByRole('dialog', { name: 'Delete activity history?' });
  }
  const cleanupRequests = () => requests.filter((request) => request.path === '/api/jobs/cleanup');

  it('requires explicit approval and cancellation sends no request', async () => {
    const dialog = await review([
      past('old'),
      past('running', 'running'),
      past('unknown', 'future'),
    ]);
    expect(within(dialog).getByText(/1 finished report selected/)).toBeTruthy();
    expect(within(dialog).getByText(/2 active or unrecognized operations excluded/)).toBeTruthy();
    expect(
      within(dialog).getByText(/does not undo migrations, change media accounts/),
    ).toBeTruthy();
    expect(within(dialog).queryByText('private-old')).toBeNull();
    expect(cleanupRequests()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cleanupRequests()).toHaveLength(0);
  });

  it('uses current filters across pagination and clears only frozen reviewed IDs with CSRF', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) =>
      past(`old-${i}`, i % 2 ? 'failed' : 'completed'),
    );
    responses['/api/jobs'] = { jobs };
    responses['/api/jobs/cleanup'] = {
      removed_ids: jobs.filter((item) => item.status === 'failed').map((item) => item.id),
      skipped: [],
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Status' }), {
      target: { value: 'failed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete activity…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Reports to review' })).toHaveProperty(
      'value',
      'filtered',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Recorded before' })).toHaveProperty(
      'value',
      'all',
    );
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Reports to review' }), {
      target: { value: 'filtered' },
    });
    expect(within(dialog).getByRole('button', { name: 'Delete 30 reports' })).toBeTruthy();
    // A concurrent refresh finishes another matching job after this review opened.
    responses['/api/jobs'] = { jobs: [...jobs, past('newly-finished', 'failed')] };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('61 operations')).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 30 reports' }));
    await within(dialog).findByText('30 reports deleted. 0 kept.');
    const request = cleanupRequests()[0];
    expect(request.options?.method).toBe('POST');
    expect(JSON.parse(request.options!.body as string)).toEqual({
      job_ids: jobs.filter((item) => item.status === 'failed').map((item) => item.id),
    });
    expect((request.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.getByText('31 operations')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'failed' },
    });
    expect(screen.getByText('private-newly-finished')).toBeTruthy();
    expect(screen.queryByText('private-old-1')).toBeNull();
  });

  it('includes recent completed reports by default and offers an explicit older-report filter', async () => {
    const recent = { ...past('recent'), finished_at: '2099-01-01T00:00:00Z' };
    const dialog = await review([recent]);
    expect(within(dialog).getByRole('combobox', { name: 'Recorded before' })).toHaveProperty(
      'value',
      'all',
    );
    expect(
      (within(dialog).getByRole('button', { name: 'Delete 1 report' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Recorded before' }), {
      target: { value: '30' },
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Delete 0 reports' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it.each(['failed', 'partial'])(
    'defaults a filtered %s review to all ages without including unrelated reports',
    async (status) => {
      const target = { ...past('selected', status), finished_at: '2099-01-01T00:00:00Z' };
      responses['/api/jobs'] = { jobs: [target, past('unrelated')] };
      responses['/api/jobs/cleanup'] = { removed_ids: ['selected'], skipped: [] };
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
      fireEvent.change(await screen.findByRole('combobox', { name: 'Status' }), {
        target: { value: status },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Delete activity…' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('combobox', { name: 'Reports to review' })).toHaveProperty(
        'value',
        'filtered',
      );
      expect(within(dialog).getByRole('combobox', { name: 'Recorded before' })).toHaveProperty(
        'value',
        'all',
      );
      expect(
        within(dialog).getByText(/Finished reports include Failed and Needs review/),
      ).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 report' }));
      await within(dialog).findByText('1 report deleted. 0 kept.');
      expect(JSON.parse(cleanupRequests()[0].options!.body as string)).toEqual({
        job_ids: ['selected'],
      });
    },
  );

  it('defaults a search-only review to the matching reports at any age', async () => {
    responses['/api/jobs'] = { jobs: [past('selected'), past('unrelated')] };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search operations' }), {
      target: { value: 'private-selected' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete activity…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Reports to review' })).toHaveProperty(
      'value',
      'filtered',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Recorded before' })).toHaveProperty(
      'value',
      'all',
    );
    expect(within(dialog).getByRole('button', { name: 'Delete 1 report' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(cleanupRequests()).toHaveLength(0);
  });

  it('refuses an oversized review instead of silently truncating it', async () => {
    const dialog = await review(Array.from({ length: 1001 }, (_, i) => past(`old-${i}`)));
    expect(within(dialog).getByRole('alert').textContent).toContain('Delete at most 1,000 reports');
    expect(
      (within(dialog).getByRole('button', { name: 'Delete 1,001 reports' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(cleanupRequests()).toHaveLength(0);
  });

  it('keeps failed requests retryable and groups protected reasons without disclosing identifiers', async () => {
    const dialog = await review([past('old'), past('protected')]);
    statuses['/api/jobs/cleanup'] = 503;
    responses['/api/jobs/cleanup'] = { detail: 'History cleanup is unavailable.' };
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 reports' }));
    await within(dialog).findByRole('alert');
    expect(
      (within(dialog).getByRole('button', { name: 'Delete 2 reports' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    statuses['/api/jobs/cleanup'] = 200;
    responses['/api/jobs/cleanup'] = {
      removed_ids: ['old'],
      skipped: [
        { id: 'protected', reason: 'pending_credentials' },
        { id: 'outside-review', reason: 'private-arbitrary-text' },
      ],
    };
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 reports' }));
    await within(dialog).findByText('1 report deleted. 1 kept.');
    expect(
      within(dialog).getByText(/New credentials still await delivery or one-time reveal: 1/),
    ).toBeTruthy();
    expect(
      within(dialog).queryByText(/private-arbitrary-text|outside-review|private-protected/),
    ).toBeNull();
    expect(cleanupRequests()).toHaveLength(2);
    expect(cleanupRequests()[0].options?.body).toBe(cleanupRequests()[1].options?.body);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.getByText('private-protected')).toBeTruthy();
    expect(screen.queryByText('private-old')).toBeNull();
  });

  it('prevents duplicate requests and disables closing while clearing', async () => {
    const dialog = await review([past('old')]);
    const original = globalThis.fetch;
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path !== '/api/jobs/cleanup') return original(path, options);
        requests.push({ path, options });
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const clear = within(dialog).getByRole('button', { name: 'Delete 1 report' });
    fireEvent.click(clear);
    fireEvent.click(clear);
    expect(cleanupRequests()).toHaveLength(1);
    expect(
      (within(dialog).getByRole('button', { name: 'Close dialog' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    await act(async () =>
      finish({
        ok: true,
        status: 200,
        json: async () => ({ removed_ids: ['old'], skipped: [] }),
      } as Response),
    );
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('suppresses a late cleanup result after navigation away', async () => {
    const dialog = await review([past('old')]);
    const original = globalThis.fetch;
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) =>
        path === '/api/jobs/cleanup'
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : original(path, options),
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await act(async () =>
      finish({
        ok: true,
        status: 200,
        json: async () => ({ removed_ids: ['old'], skipped: [] }),
      } as Response),
    );
    expect(screen.queryByText('1 report deleted. 0 kept.')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not restore history or errors from cleanup after administrator sign-out', async () => {
    const dialog = await review([past('old')]);
    responses['/api/logout'] = { ...session, authenticated: false, user: undefined };
    const original = globalThis.fetch;
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) =>
        path === '/api/jobs/cleanup'
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : original(path, options),
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Welcome back' });
    await act(async () =>
      finish({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'late-cleanup-error' }),
      } as Response),
    );
    expect(screen.queryByText('late-cleanup-error')).toBeNull();
    expect(screen.queryByText('private-old')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('supports clearing one finished migration report from its details', async () => {
    responses['/api/jobs/cleanup'] = {
      removed_ids: ['job-1'],
      skipped: [],
    } satisfies HistoryCleanupResult;
    const detail = await openJob();
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete report…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this report?' });
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 report' }));
    await within(dialog).findByText('1 report deleted. 0 kept.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: 'View operation details' })).toBeNull();
    expect(JSON.parse(cleanupRequests()[0].options!.body as string)).toEqual({
      job_ids: ['job-1'],
    });
  });

  it('never offers single-report deletion for an active or unknown operation', async () => {
    responses['/api/jobs/job-1'] = { ...job, status: 'finalizing' };
    const dialog = await openJob();
    expect(within(dialog).queryByRole('button', { name: 'Delete report…' })).toBeNull();
  });

  it('completes report deletion with StrictMode effect replay enabled', async () => {
    responses['/api/jobs'] = { jobs: [past('old')] };
    responses['/api/jobs/cleanup'] = { removed_ids: ['old'], skipped: [] };
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete activity…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 report' }));
    await within(dialog).findByText('1 report deleted. 0 kept.');
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function openJob() {
  render(<App />);
  await screen.findByRole('heading', { name: 'Overview', level: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'View operation details' }));
  return screen.findByRole('dialog');
}
async function selectSettingsTab(section: string, subsection?: string) {
  const tabs = await screen.findByRole('tablist', { name: 'Settings sections' });
  fireEvent.click(within(tabs).getByRole('tab', { name: section }));
  if (subsection) fireEvent.click(await screen.findByRole('tab', { name: subsection }));
}
const runningPreviewTask = {
  id: 'preview-task-1',
  status: 'running',
  progress: { processed: 0, total: 2 },
};
const readyPreviewTask = {
  ...runningPreviewTask,
  status: 'ready',
  progress: { processed: 2, total: 2 },
  preview: {
    users: [
      { source_user_id: 'e-alex', username: 'alex', target_exists: false, stats: {} },
      { source_user_id: 'e-river', username: 'river', target_exists: false, stats: {} },
    ],
  },
};
function prepareRunningPreview() {
  responses['/api/users'] = {
    emby: [
      { Id: 'e-alex', Name: 'alex' },
      { Id: 'e-river', Name: 'river' },
    ],
    jellyfin: [],
  };
  responses['/api/migrations/preview'] = runningPreviewTask;
  statuses['/api/migrations/preview'] = 202;
  responses['/api/migrations/preview/preview-task-1'] = runningPreviewTask;
}
async function selectAndPreview() {
  fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
  await screen.findByText('Preparing migration review… 0 of 2 users complete.');
}
async function selectAndPreviewReady() {
  fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
  await screen.findByRole('dialog');
}
describe('React account safeguards', () => {
  it('keeps a newer draft and blocks duplicate saves when an old Settings request finishes after remount', async () => {
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let finish!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementation(async (path, options) => {
      if (String(path) === '/api/settings' && options?.method === 'PUT') {
        requests.push({ path: String(path), options });
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return original(path, options);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    fireEvent.change(document.getElementById('setting-emby_url')!, {
      target: { value: 'http://submitted-a.example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(screen.getByText('A settings save is still in progress.')).toBeTruthy();
    fireEvent.change(document.getElementById('setting-emby_url')!, {
      target: { value: 'http://newer-draft-b.example.test' },
    });
    const submit = screen.getByRole('button', { name: 'Save settings' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.submit(submit.closest('form')!);
    expect(
      requests.filter((r) => r.path === '/api/settings' && r.options?.method === 'PUT'),
    ).toHaveLength(1);
    await act(async () =>
      finish({ ok: true, status: 200, json: async () => settings } as Response),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect((document.getElementById('setting-emby_url') as HTMLInputElement).value).toBe(
      'http://newer-draft-b.example.test',
    );
    expect(screen.queryByText('Settings saved. Your connections are ready to test.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect((document.getElementById('setting-emby_url') as HTMLInputElement).value).toBe(
      'http://newer-draft-b.example.test',
    );
    expect(
      requests.filter((r) => r.path === '/api/settings' && r.options?.method === 'PUT'),
    ).toHaveLength(1);
  });

  it('retains unsaved Settings input through main navigation and refresh without serializing or saving it', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    fireEvent.change(document.getElementById('setting-emby_url')!, {
      target: { value: 'http://private-draft.example.test' },
    });
    await selectSettingsTab('Account defaults', 'Passwords & messages');
    fireEvent.change(screen.getByLabelText('Generated password length'), {
      target: { value: '22' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    responses['/api/settings'] = {
      ...settings,
      emby_url: 'http://newer-source.example.test',
      password_length: 30,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect((document.getElementById('setting-emby_url') as HTMLInputElement).value).toBe(
      'http://private-draft.example.test',
    );
    await selectSettingsTab('Account defaults', 'Passwords & messages');
    expect((screen.getByLabelText('Generated password length') as HTMLInputElement).value).toBe(
      '22',
    );
    expect(window.location.href).not.toContain('private-draft');
    expect(JSON.stringify(window.history.state)).not.toContain('private-draft');
    expect(
      requests.filter((r) => r.path === '/api/settings' && r.options?.method === 'PUT'),
    ).toHaveLength(0);
  });
  it('retains account input across main navigation but requires a new recovery inspection', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Create account', level: 1 });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'UnsubmittedCrew' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Recover interrupted creation' }));
    fireEvent.change(screen.getByLabelText('Account to inspect'), {
      target: { value: 'InspectLater' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Create account', level: 1 });
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('UnsubmittedCrew');
    fireEvent.click(screen.getByRole('tab', { name: 'Recover interrupted creation' }));
    expect((screen.getByLabelText('Account to inspect') as HTMLInputElement).value).toBe(
      'InspectLater',
    );
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(
      requests.some((r) => r.path === '/api/accounts' || r.path === '/api/accounts/recover'),
    ).toBe(false);
  });
  it('clears retained drafts on sign-out before a new administrator session', async () => {
    responses['/api/logout'] = { ...session, authenticated: false, user: undefined };
    responses['/api/login'] = session;
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Create account', level: 1 });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'PrivateUnsubmitted' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Jellyfin username');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'synthetic-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Create account', level: 1 });
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('');
  });

  it('keeps a persistent last-known-status warning when job polling fails, then reconciles on refresh', async () => {
    let poll: (() => Promise<void>) | undefined;
    const realInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 3000) {
        poll = callback as () => Promise<void>;
        return 999 as unknown as ReturnType<typeof setInterval>;
      }
      return realInterval(callback, timeout, ...args);
    }) as typeof setInterval);
    const active = { ...job, status: 'running', results: [] };
    responses['/api/overview'] = { ...overview, recent_jobs: [active] };
    responses['/api/jobs'] = { jobs: [active] };
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    await waitFor(() => expect(poll).toBeTypeOf('function'));
    statuses['/api/jobs'] = 503;
    responses['/api/jobs'] = { detail: 'Synthetic temporary failure' };
    await act(async () => {
      await poll!();
    });
    expect(screen.getByText('Activity updates paused.')).toBeTruthy();
    expect(screen.getByText(/The last known operation status is shown/)).toBeTruthy();
    expect(requests.filter((r) => r.options?.method === 'POST')).toHaveLength(0);
    statuses['/api/jobs'] = 200;
    responses['/api/jobs'] = { jobs: [job] };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    await waitFor(() => expect(screen.queryByText('Activity updates paused.')).toBeNull());
    expect(screen.getByRole('button', { name: 'Delete activity…' })).toBeTruthy();
  });
  it('distinguishes a still-processing subscription from a completed access change', async () => {
    const event = {
      id: 'processing-event',
      action: 'subscribe',
      username: 'Crew',
      status: 'pending',
      created_at: '2026-10-18T00:00:00Z',
    };
    responses['/api/subscriptions'] = { events: [event] };
    responses['/api/subscriptions/processing-event/apply'] = { ...event, status: 'processing' };
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Subscriptions' }));
    await screen.findByRole('heading', { name: 'Subscriptions', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Apply/ }));
    await screen.findByText(
      'Subscription processing is in progress. Follow its operation before retrying.',
    );
    expect(screen.queryByText('Subscription event processed.')).toBeNull();
  });

  it.each([
    {
      name: 'unreadable JSON',
      error: new SyntaxError('synthetic-private-body-fragment'),
      message:
        'Jellyport’s response could not be read. Refresh to check its status before retrying.',
    },
    {
      name: 'canceled response body',
      error: Object.assign(new Error('Response reading was canceled.'), { name: 'AbortError' }),
      message: 'Response reading was canceled.',
    },
  ])(
    'keeps role collections intact when a 200 response has $name, and permits an explicit successful refresh',
    async ({ error, message: failure }) => {
      window.history.replaceState(null, '', '#/roles');
      render(<App />);
      await screen.findByRole('searchbox', { name: 'Find saved roles' });
      const original = fetch;
      let unreadable = true;
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, options?: RequestInit) => {
          if (path === '/api/account-roles' && unreadable) {
            unreadable = false;
            return Promise.resolve(
              Object.assign(new Response(null, { status: 200 }), {
                json: async () => {
                  throw error;
                },
              }),
            );
          }
          return original(path, options);
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refresh roles' }));
      await screen.findByText(failure);
      expect(screen.getByRole('heading', { name: 'Account roles', level: 1 })).toBeTruthy();
      expect(screen.getByRole('searchbox', { name: 'Find saved roles' })).toBeTruthy();
      expect(document.body.textContent).not.toContain('synthetic-private-body-fragment');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh roles' }));
      await screen.findByRole('searchbox', { name: 'Find saved roles' });
      expect(screen.queryByText(failure)).toBeNull();
      expect(screen.getByRole('heading', { name: 'Account roles', level: 1 })).toBeTruthy();
      expect(
        requests.filter((request) => request.options?.method && request.options.method !== 'GET'),
      ).toEqual([]);
    },
  );
  it('loads a bookmarked or restored page once, after its own parent data is ready', async () => {
    const original = fetch;
    let deferSettings = true;
    let reply: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path === '/api/settings' && deferSettings) {
          deferSettings = false;
          return new Promise<Response>((resolve) => {
            reply = resolve;
          });
        }
        return original(path, options);
      }),
    );
    const roleRequests = () => requests.filter((request) => request.path === '/api/account-roles');
    const completeSettings = async () => {
      await waitFor(() => expect(reply).toBeTypeOf('function'));
      expect(screen.queryByRole('heading', { name: 'Account roles', level: 1 })).toBeNull();
      await act(async () => {
        reply!(new Response(JSON.stringify(settings), { status: 200 }));
      });
      await screen.findByRole('searchbox', { name: 'Find saved roles' });
    };

    window.history.replaceState(null, '', '#/roles');
    render(<App />);
    await waitFor(() => expect(reply).toBeTypeOf('function'));
    expect(roleRequests()).toHaveLength(0);
    await completeSettings();
    expect(roleRequests()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    deferSettings = true;
    reply = undefined;
    await act(async () => window.history.back());
    await waitFor(() => expect(reply).toBeTypeOf('function'));
    expect(window.location.hash).toBe('#/roles');
    expect(roleRequests()).toHaveLength(1);
    await completeSettings();
    expect(roleRequests()).toHaveLength(2);
  });
  it.each(['unreadable', 'null', 'primitive'])(
    'still clears the administrator session when an unauthorized response has a %s body',
    async (body) => {
      window.history.replaceState(null, '', '#/roles');
      render(<App />);
      await screen.findByRole('searchbox', { name: 'Find saved roles' });
      const original = fetch;
      responses['/api/session'] = { ...session, authenticated: false, user: undefined };
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, options?: RequestInit) => {
          if (path === '/api/account-roles')
            return Promise.resolve(
              Object.assign(new Response(null, { status: 401 }), {
                json: async () => {
                  if (body === 'unreadable') throw new SyntaxError('synthetic-private-error-body');
                  return body === 'null' ? null : 'synthetic-private-error-body';
                },
              }),
            );
          return original(path, options);
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refresh roles' }));
      await screen.findByLabelText('Jellyfin username');
      expect(screen.queryByRole('heading', { name: 'Account roles', level: 1 })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
      expect(document.body.textContent).not.toContain('synthetic-private-error-body');
      expect(window.location.hash).toBe('#/roles');
    },
  );
  it.each([
    ['overview', 'Overview'],
    ['users', 'Users'],
    ['migrate', 'Migrate users'],
    ['mappings', 'User mappings'],
    ['roles', 'Account roles'],
    ['accounts', 'Create account'],
    ['memberships', 'Memberships'],
    ['subscriptions', 'Subscriptions'],
    ['activity', 'Activity'],
    ['settings', 'Settings'],
  ])(
    'restores the bookmarked %s page after a reload without replaying actions',
    async (target, title) => {
      responses['/api/user-directory'] = { users: [] };
      responses['/api/memberships'] = { memberships: [] };
      responses['/api/subscriptions'] = { events: [] };
      window.history.replaceState(null, '', `#/${target}`);
      const view = render(<App />);
      await screen.findByRole('heading', { name: title, level: 1 });
      expect(window.location.hash).toBe(
        target === 'settings' ? '#/settings/media/emby' : `#/${target}`,
      );
      view.unmount();
      render(<App />);
      await screen.findByRole('heading', { name: title, level: 1 });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(
        requests.filter((request) => request.options?.method && request.options.method !== 'GET'),
      ).toEqual([]);
      expect(window.history.state).toBeNull();
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    },
  );
  it('uses Back and Forward for pages without restoring an open operation dialog', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    expect(window.location.hash).toBe('#/activity');
    fireEvent.click(screen.getByRole('button', { name: 'View operation details' }));
    await screen.findByRole('dialog');
    await act(async () => window.history.back());
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => window.history.forward());
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      requests.filter((request) => request.options?.method && request.options.method !== 'GET'),
    ).toEqual([]);
  });
  it.each(['Back', 'main navigation'])(
    'does not reopen a deferred operation report after %s changes the page',
    async (action) => {
      const original = fetch;
      let reply!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, options?: RequestInit) => {
          if (path === '/api/jobs/job-1')
            return new Promise<Response>((resolve) => {
              reply = resolve;
            });
          return original(path, options);
        }),
      );
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
      await screen.findByRole('heading', { name: 'Activity', level: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'View operation details' }));
      if (action === 'Back') await act(async () => window.history.back());
      else fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
      await screen.findByRole('heading', { name: 'Overview', level: 1 });
      await act(async () => {
        reply({ ok: true, status: 200, json: async () => job } as Response);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.body.classList.contains('modal-open')).toBe(false);
      expect(window.location.hash).toBe('#/overview');
      expect(
        requests.filter((request) => request.options?.method && request.options.method !== 'GET'),
      ).toEqual([]);
    },
  );
  it('keeps the active route when using Skip to content', async () => {
    window.history.replaceState(null, '', '#/activity');
    render(<App />);
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(window.location.hash).toBe('#/activity');
    expect(document.activeElement?.id).toBe('workspace-content');
  });
  it('restores nested Settings tabs and preserves unsaved fields through Back and Forward', async () => {
    window.history.replaceState(null, '', '#/settings/media/jellyfin');
    const view = render(<App />);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(screen.getByRole('tab', { name: 'Jellyfin' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const url = screen.getByLabelText(/Public sign-in URL/) as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://synthetic-draft.example.invalid' } });
    await selectSettingsTab('Account defaults', 'Passwords & messages');
    expect(window.location.hash).toBe('#/settings/accounts/passwords');
    await act(async () => window.history.back());
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Permissions' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    await act(async () => window.history.back());
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Jellyfin' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(url.value).toBe('https://synthetic-draft.example.invalid');
    await act(async () => window.history.forward());
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Permissions' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    await act(async () => window.history.forward());
    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: 'Passwords & messages' }).getAttribute('aria-selected'),
      ).toBe('true'),
    );
    expect(url.value).toBe('https://synthetic-draft.example.invalid');
    view.unmount();
    render(<App />);
    await screen.findByRole('tab', { name: 'Passwords & messages' });
    expect(
      screen.getByRole('tab', { name: 'Passwords & messages' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect((document.querySelector('#setting-jellyfin_public_url') as HTMLInputElement).value).toBe(
      '',
    );
    expect(
      requests.filter((request) => request.options?.method && request.options.method !== 'GET'),
    ).toEqual([]);
  });
  it('keeps a requested page behind administrator authentication without encoding credentials', async () => {
    const anonymousSession = { ...session, authenticated: false, user: undefined };
    responses['/api/session'] = anonymousSession;
    responses['/api/login'] = session;
    window.history.replaceState(null, '', '#/accounts/recover');
    render(<App />);
    await screen.findByLabelText('Jellyfin username');
    expect(screen.queryByRole('heading', { name: 'Create account', level: 1 })).toBeNull();
    expect(window.location.hash).toBe('#/accounts/recover');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), {
      target: { value: 'synthetic-admin' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'synthetic-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Create account', level: 1 });
    expect(
      screen
        .getByRole('tab', { name: 'Recover interrupted creation' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByLabelText('Account to inspect')).toHaveProperty('value', '');
    expect(window.location.hash).toBe('#/accounts/recover');
    expect(
      requests
        .filter((request) => request.options?.method && request.options.method !== 'GET')
        .map((request) => request.path),
    ).toEqual(['/api/login']);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('defaults plugin migrations to saved history even before any backup has been imported', async () => {
    prepareRunningPreview();
    responses['/api/source-snapshots'] = {
      ...(responses['/api/source-snapshots'] as SourceSnapshotStatus),
      capture_method: 'plugin_backup',
      available: false,
    };
    responses['/api/migrations/preview'] = {
      id: 'missing-backup-preview',
      status: 'failed',
      error: 'No completed database capture is available. Import an Emby backup first.',
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    const choice = await screen.findByLabelText('Use saved Emby snapshot');
    await waitFor(() => expect(choice).toHaveProperty('checked', true));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    await screen.findByText(
      'No completed database capture is available. Import an Emby backup first.',
    );
    const preview = requests.find((request) => request.path === '/api/migrations/preview')!;
    expect(JSON.parse(String(preview.options?.body)).use_snapshots).toBe(true);
    expect(requests.filter((request) => request.path === '/api/source-snapshots')).toHaveLength(1);
    expect(requests.some((request) => request.path === '/api/source-snapshots/refresh')).toBe(
      false,
    );
  });

  it.each(['sqlite_online_backup', 'file_copy', undefined] as const)(
    'keeps the existing live default for a verified legacy source mode (%s)',
    async (capture_method) => {
      prepareRunningPreview();
      responses['/api/source-snapshots'] = {
        ...(responses['/api/source-snapshots'] as SourceSnapshotStatus),
        capture_method,
      };
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
      await screen.findByLabelText('Use saved Emby snapshot');
      await waitFor(() =>
        expect(screen.queryByText('Checking history source settings…')).toBeNull(),
      );
      expect(screen.getByLabelText('Use saved Emby snapshot')).toHaveProperty('checked', false);
    },
  );

  it.each(['failed', 'unsupported', 'unobserved'] as const)(
    'requires an explicit source choice when history defaults cannot be verified (%s)',
    async (mode) => {
      prepareRunningPreview();
      responses['/api/migrations/preview'] = {
        id: 'explicit-live-preview',
        status: 'failed',
        error: 'Fixture preview stopped.',
      };
      if (mode === 'failed') {
        statuses['/api/source-snapshots'] = 500;
        responses['/api/source-snapshots'] = { detail: 'PRIVATE_SOURCE_DETAIL' };
      } else if (mode === 'unsupported')
        responses['/api/source-snapshots'] = {
          snapshots: 0,
          records: [],
          capture_method: 'unknown-method',
        };
      else
        responses['/api/source-snapshots'] = {
          ...(responses['/api/source-snapshots'] as SourceSnapshotStatus),
          history_source_known: false,
        };
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
      await screen.findByText('History source settings could not be loaded.');
      fireEvent.click(
        await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
      expect(requests.some((request) => request.path === '/api/migrations/preview')).toBe(false);
      expect(screen.queryByText('PRIVATE_SOURCE_DETAIL')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Use live Emby reads' }));
      fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
      await screen.findByText('Fixture preview stopped.');
      const preview = requests.find((request) => request.path === '/api/migrations/preview')!;
      expect(JSON.parse(String(preview.options?.body))).not.toHaveProperty('use_snapshots');
    },
  );

  it.each([true, false])(
    'does not override an explicit source choice when defaults arrive late (saved=%s)',
    async (saved) => {
      prepareRunningPreview();
      const transport = vi.mocked(fetch).getMockImplementation()!;
      let release!: (value: Response) => void;
      vi.mocked(fetch).mockImplementation(async (input, options) => {
        if (String(input) !== '/api/source-snapshots') return transport(input, options);
        requests.push({ path: String(input), options });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
      await screen.findByLabelText('Use saved Emby snapshot');
      expect(screen.getByText('Checking history source settings…')).toBeTruthy();
      if (saved) fireEvent.click(screen.getByLabelText('Use saved Emby snapshot'));
      else fireEvent.click(screen.getByRole('button', { name: 'Use live Emby reads' }));
      await act(async () =>
        release(
          new Response(
            JSON.stringify({
              ...(responses['/api/source-snapshots'] as SourceSnapshotStatus),
              capture_method: saved ? 'sqlite_online_backup' : 'plugin_backup',
            }),
          ),
        ),
      );
      expect(screen.getByLabelText('Use saved Emby snapshot')).toHaveProperty('checked', saved);
      expect(screen.queryByText('Checking history source settings…')).toBeNull();
    },
  );

  it('aborts a pending history-source lookup on navigation away without adopting its late defaults', async () => {
    prepareRunningPreview();
    const transport = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: Response) => void;
    let signal: AbortSignal | null | undefined;
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      if (String(input) !== '/api/source-snapshots') return transport(input, options);
      requests.push({ path: String(input), options });
      signal = options?.signal;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    await screen.findByLabelText('Use saved Emby snapshot');
    fireEvent.click(
      within(screen.getByRole('complementary', { name: 'Main navigation' })).getByRole('button', {
        name: 'Overview',
      }),
    );
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      release(
        new Response(
          JSON.stringify({
            ...(responses['/api/source-snapshots'] as SourceSnapshotStatus),
            capture_method: 'plugin_backup',
          }),
        ),
      ),
    );
    expect(screen.queryByText('History source settings could not be loaded.')).toBeNull();
  });

  it('loads editable tier defaults and only saves their definitions without provisioning accounts', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Automation');
    await screen.findByRole('heading', { name: 'Membership tiers' });
    const tiers = screen.getAllByLabelText('Tier name');
    const limits = screen.getAllByLabelText('Account allowance');
    expect(tiers.map((input) => (input as HTMLInputElement).value)).toEqual([
      'Sloop',
      'Brigantine',
      'Galleon',
    ]);
    expect(limits.map((input) => (input as HTMLSelectElement).value)).toEqual(['1', '2', '3']);
    fireEvent.change(screen.getByLabelText('Edit membership tier'), { target: { value: '1' } });
    fireEvent.change(tiers[1], { target: { value: 'Brigantine Crew' } });
    fireEvent.change(screen.getAllByLabelText('Subscription plan name')[1], {
      target: { value: 'Brigantine Paid Plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved. Your connections are ready to test.');
    const saved = requests.find(
      (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
    )!;
    expect(JSON.parse(String(saved.options?.body)).membership_tiers[1]).toEqual({
      id: 'brigantine',
      name: 'Brigantine Crew',
      plan_name: 'Brigantine Paid Plan',
      account_limit: 2,
    });
    expect(requests.some((request) => request.path === '/api/memberships/provision')).toBe(false);
  });

  it('clears membership owners and account names when the administrator signs out', async () => {
    responses['/api/memberships'] = {
      memberships: [
        {
          discord_user_id: '123456789012345678',
          base_username: 'private-owner',
          tier_id: 'brigantine',
          account_limit: 2,
          active: true,
          revision: 'revision-1',
          links: [
            {
              discord_user_id: '123456789012345678',
              username: 'private-family-account',
              remote_id: 'jf-1',
              membership_slot: 2,
              disabled_by_jellyport: 0,
              pending_disabled: null,
            },
          ],
        },
      ],
    };
    responses['/api/logout'] = { ...session, authenticated: false, user: undefined };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Memberships' }));
    await screen.findByText('private-family-account');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Jellyfin username');
    expect(screen.queryByText('private-family-account')).toBeNull();
    expect(screen.queryByText('private-owner')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('uses a saved default role for fresh account creation without a fallback template', async () => {
    responses['/api/settings'] = { ...settings, template_user_id: '', default_role_id: 'role-1' };
    responses['/api/accounts'] = job;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alex' } });
    const form = screen.getByLabelText('Username').closest('form')!;
    const submit = within(form).getByRole('button', { name: 'Create account' });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/accounts')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/accounts')!.options?.body),
      ),
    ).toEqual({ username: 'alex' });
  });
  it('loads roles into settings and saves the selected default independently of the template', async () => {
    responses['/api/account-roles'] = {
      roles: [
        {
          id: 'role-1',
          name: 'Crew defaults',
          revision: 'revision-1',
          parameters: { policy: {}, configuration: {}, display: null },
        },
      ],
      assignments: [],
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Account defaults');
    await screen.findByRole('option', { name: 'Crew defaults' });
    fireEvent.change(screen.getByLabelText('Default account role'), {
      target: { value: 'role-1' },
    });
    fireEvent.change(screen.getByLabelText('Fallback template user'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved. Your connections are ready to test.');
    const saved = requests.find(
      (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
    )!;
    expect(JSON.parse(String(saved.options?.body))).toMatchObject({
      default_role_id: 'role-1',
      template_user_id: '',
    });
  });
  it('opens account role management from the main navigation', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Account roles' }));
    await screen.findByRole('heading', { name: 'Account roles', level: 1 });
    await screen.findByRole('heading', { name: 'No saved roles' });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(screen.getByRole('heading', { name: 'Create an account role' })).toBeTruthy();
    expect(requests.some((request) => request.path === '/api/account-roles')).toBe(true);
  });
  it('keeps the saved default selected when role names finish loading later', async () => {
    responses['/api/settings'] = { ...settings, default_role_id: 'role-1' };
    const baseFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let resolveRoles!: (value: unknown) => void;
    vi.mocked(globalThis.fetch).mockImplementation(async (...args) => {
      if (args[0] === '/api/account-roles') {
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((resolve) => {
              resolveRoles = resolve;
            }),
        } as Response;
      }
      return baseFetch(...args);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    // Wait for this deferred read to start so Settings and its routing effects
    // are mounted before interacting with a tab from its first rendered frame.
    await waitFor(() => expect(resolveRoles).toBeTypeOf('function'));
    await act(async () => selectSettingsTab('Account defaults'));
    await screen.findByRole('option', { name: 'Saved default role' });
    expect((screen.getByLabelText('Default account role') as HTMLSelectElement).value).toBe(
      'role-1',
    );
    await act(async () =>
      resolveRoles({ roles: [{ id: 'role-1', name: 'Crew defaults' }], assignments: [] }),
    );
    await screen.findByRole('option', { name: 'Crew defaults' });
    expect((screen.getByLabelText('Default account role') as HTMLSelectElement).value).toBe(
      'role-1',
    );
  });
  it('reveals credentials only after explicit confirmation, renders text safely, and clears secrets on close', async () => {
    let dialog = await openJob();
    expect(within(dialog).getByText('<script>bad()</script>')).toBeTruthy();
    expect(dialog.querySelector('script')).toBeNull();
    expect(requests.some((request) => request.path.endsWith('/credentials'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal new credentials' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reveal new account credentials?')).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith('/credentials'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal credentials' }));
    await screen.findByText('one-time-secret');
    const reveal = requests.find((request) => request.path.endsWith('/credentials'))!;
    expect(reveal.options?.method).toBe('POST');
    expect((reveal.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('one-time-secret')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows and copies the captured message as plain text and clears it on close', async () => {
    const message =
      '<img src=x onerror=alert(1)>\nWelcome, alex!\nPassword: one-time-secret\nhttps://jellyfin.example';
    responses['/api/jobs/job-1/credentials'] = {
      credentials: [
        {
          username: 'alex',
          password: 'one-time-secret',
          server_url: 'https://jellyfin.example',
          message,
        },
      ],
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await openJob();
      fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Reveal credentials' }));
      await screen.findByText('one-time-secret');
      const dialog = screen.getByRole('dialog');
      expect(dialog.querySelector('.credential-message')?.textContent).toBe(message);
      expect(dialog.querySelector('img')).toBeNull();
      expect(writeText).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy credentials' }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(message);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByText(message)).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
  it('does not display late credential responses after the dialog is closed', async () => {
    await openJob();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
    let resolve!: (value: unknown) => void;
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementationOnce(
      async () =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((done) => {
              resolve = done;
            }),
        }) as Response,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reveal credentials' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    resolve({ credentials: [{ username: 'alex', password: 'late-secret' }] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revealing…' })).toBeNull());
    expect(screen.queryByText('late-secret')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('requires inspection and explicit approval before account recovery, and invalidates approval when inputs change', async () => {
    responses['/api/accounts/recovery?username=alex'] = {
      username: 'alex',
      eligible: true,
      reason: 'Tracked incomplete creation',
      target_user_id: 'jf-alex',
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Create account', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: 'Recover interrupted creation' }));
    fireEvent.change(screen.getByLabelText('Account to inspect'), { target: { value: 'alex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    await screen.findByText('alex · Eligible for recovery');
    expect(
      (screen.getByRole('button', { name: 'Recover account' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByLabelText(
        'I inspected this Jellyfin account and approve a new password and account defaults.',
      ),
    );
    expect(
      (screen.getByRole('button', { name: 'Recover account' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.input(screen.getByLabelText('Account to inspect'), {
      target: { value: 'different' },
    });
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/accounts/recover')).toBe(false);
  });
  it('selects a Discord member and fills the fresh account username without typing an ID', async () => {
    responses['/api/discord/members?query=Captain'] = {
      members: [
        {
          id: '123456789012345678',
          username: 'alex.actual',
          display_name: 'Alex',
          nickname: 'Captain Alex',
          membership_active: true,
        },
      ],
      truncated: false,
    };
    responses['/api/accounts'] = job;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.change(await screen.findByLabelText('Discord member (optional)'), {
      target: { value: 'Captain' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @alex.actual' }));
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('alex.actual');
    fireEvent.click(
      within(screen.getByLabelText('Username').closest('form')!).getByRole('button', {
        name: 'Create account',
      }),
    );
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/accounts')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/accounts')!.options?.body),
      ),
    ).toEqual({
      username: 'alex.actual',
      discord_user_id: '123456789012345678',
    });
  });
  it('invalidates recovery approval when a searched Discord recipient is selected', async () => {
    responses['/api/accounts/recovery?username=alex'] = {
      username: 'alex',
      eligible: true,
      reason: 'Tracked incomplete creation',
      target_user_id: 'jf-alex',
    };
    responses['/api/discord/members?query=alex'] = {
      members: [
        {
          id: '123456789012345678',
          username: 'alex',
          display_name: null,
          nickname: null,
          membership_active: true,
        },
      ],
      truncated: false,
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Recover interrupted creation' }));
    fireEvent.change(screen.getByLabelText('Account to inspect'), { target: { value: 'alex' } });
    fireEvent.focus(screen.getByLabelText('Recovery Discord member (optional)'));
    await screen.findByRole('button', { name: 'Select @alex' });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    await screen.findByText('alex · Eligible for recovery');
    fireEvent.click(
      screen.getByLabelText(
        'I inspected this Jellyfin account and approve a new password and account defaults.',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Select @alex' }));
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/accounts/recover')).toBe(false);
  });
  it('states that manual cancellation approval disables access immediately before sending the request', async () => {
    const event = {
      id: 'event-1',
      username: 'alex',
      discord_user_id: '123456789012345678',
      action: 'cancel',
      status: 'pending',
      created_at: '2026-10-07T12:00:00Z',
    };
    responses['/api/subscriptions'] = { events: [event] };
    responses['/api/subscriptions/event-1/apply'] = { ...event, status: 'applied' };
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Subscriptions' }));
    await screen.findByRole('heading', { name: 'Subscriptions', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        /Approving this event manually disables all linked account slots immediately/,
      ),
    ).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable linked accounts now' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(true),
    );
  });
  it('clears the authenticated console and private dialogs on a rejected session', async () => {
    await openJob();
    responses['/api/session'] = { ...session, authenticated: false, user: undefined };
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementationOnce(
      async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({ detail: 'Sign in to Jellyport.' }),
        }) as Response,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('<script>bad()</script>')).toBeNull();
  });

  it.each(['network', 'service', 'allocation'] as const)(
    'clears private credentials after a %s logout failure without restoring the old session',
    async (failure) => {
      await openJob();
      fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Reveal credentials' }));
      await screen.findByText('one-time-secret');
      const fetch = vi.mocked(globalThis.fetch);
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (input, options) => {
        if (String(input) === '/api/logout') {
          if (failure === 'network') throw new TypeError('Synthetic connection failure.');
          return {
            ok: false,
            status: failure === 'service' ? 503 : 429,
            json: async () => ({
              detail: failure === 'service' ? 'Service unavailable.' : 'Too many new sessions.',
            }),
          } as Response;
        }
        return original(input, options);
      });
      const previousSessionRequests = requests.filter(
        (request) => request.path === '/api/session',
      ).length;
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await screen.findByText('Welcome back');
      expect(screen.getByRole('alert').textContent).toContain(
        'server sign-out could not be confirmed',
      );
      expect(screen.queryByText('one-time-secret')).toBeNull();
      expect(screen.queryByText('<script>bad()</script>')).toBeNull();
      expect(screen.queryByText('jellyfin-admin')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(requests.filter((request) => request.path === '/api/session')).toHaveLength(
        previousSessionRequests,
      );
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    },
  );

  it('does not restore private dialogs from a credential response arriving after failed logout', async () => {
    await openJob();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
    let resolve!: (value: unknown) => void;
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/credentials'))
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((done) => {
              resolve = done;
            }),
        } as Response;
      if (String(input) === '/api/logout') throw new TypeError('Synthetic connection failure.');
      return original(input, options);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal credentials' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    await act(async () => {
      resolve({
        credentials: [{ username: 'late-private-user', password: 'late-private-password' }],
      });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revealing…' })).toBeNull());
    expect(screen.queryByText('late-private-user')).toBeNull();
    expect(screen.queryByText('late-private-password')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Overview', level: 1 })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'server sign-out could not be confirmed',
    );
  });

  it('requires fresh credential verification after a failed logout even when the server retains its session', async () => {
    await openJob();
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, options) => {
      if (String(input) === '/api/logout') throw new TypeError('Synthetic connection failure.');
      return original(input, options);
    });
    responses['/api/login'] = { detail: 'Incorrect credentials.' };
    statuses['/api/login'] = 401;
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'incorrect' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Incorrect credentials.'),
    );
    expect(screen.queryByRole('heading', { name: 'Overview', level: 1 })).toBeNull();
    expect(screen.queryByText('<script>bad()</script>')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('previews selected users and preserves optional Discord links in a bulk migration', async () => {
    responses['/api/users'] = {
      emby: [
        { Id: 'e-alex', Name: 'alex' },
        { Id: 'e-river', Name: 'river' },
      ],
      jellyfin: [{ Id: 'j-river', Name: 'river' }],
    };
    responses['/api/migrations/preview'] = {
      id: 'preview-bulk',
      status: 'ready',
      progress: { processed: 2, total: 2 },
      preview: {
        users: [
          {
            source_user_id: 'e-alex',
            username: 'alex',
            target_exists: false,
            stats: { source_played: 2, matched: 2 },
          },
          {
            source_user_id: 'e-river',
            username: 'river',
            target_exists: true,
            stats: { source_played: 1, matched: 1 },
          },
        ],
      },
    };
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    responses['/api/discord/members?query=river'] = {
      members: [
        {
          id: '123456789012345678',
          username: 'river',
          display_name: 'River Display',
          nickname: 'River Captain',
          membership_active: true,
        },
      ],
      truncated: false,
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Migrate users' }),
    );
    await screen.findByRole('checkbox', { name: 'Select all visible Emby users' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge into existing account')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'The existing Jellyfin password and account permissions will be preserved.',
      ),
    ).toBeTruthy();
    expect(requests.some((request) => request.path.startsWith('/api/discord/members'))).toBe(false);
    fireEvent.focus(within(dialog).getAllByLabelText('Discord recipient (optional)')[1]);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Select @river' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
    );
    const request = requests.find((value) => value.path === '/api/migrations')!;
    expect(JSON.parse(String(request.options?.body))).toEqual({
      source_user_ids: ['e-alex', 'e-river'],
      preview_id: 'preview-bulk',
      migration_scope: 'watched_only',
      discord_recipients: { 'e-river': '123456789012345678' },
    });
  });
  it('shows deferred played flags without invented zero counts and narrows legacy approval', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = {
      ...readyPreviewTask,
      preview: {
        migration_scope: 'complete',
        users: readyPreviewTask.preview.users.map((user) => ({
          ...user,
          stats: null,
          history_deferred: true,
          unmatched: [],
          ambiguous: [],
        })),
      },
    };
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    expect(
      await screen.findByText(
        /Previews check accounts and backup freshness without scanning libraries/,
      ),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('History details deferred')).toHaveLength(2);
    expect(
      within(dialog).getAllByText(/Matching and played flags are read after approval/),
    ).toHaveLength(2);
    expect(
      within(dialog).getByText(/Existing Jellyfin personal state stays unchanged/),
    ).toBeTruthy();
    expect(within(dialog).queryByText('Played in Emby')).toBeNull();
    expect(within(dialog).queryByText('Matched to Jellyfin')).toBeNull();
    expect(within(dialog).queryByText('Unmatched')).toBeNull();
    expect(within(dialog).queryByText('Ambiguous')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/migrations')!.options?.body),
      ).migration_scope,
    ).toBe('watched_only');
  });

  it('polls preview progress and only offers migration approval after the preview is ready', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview/preview-task-1'] = {
      ...runningPreviewTask,
      progress: { processed: 1, total: 2 },
    };
    render(<App />);
    await selectAndPreview();
    expect(screen.getByLabelText('Use saved Emby snapshot')).toHaveProperty('checked', false);
    expect(
      JSON.parse(
        String(
          requests.find((request) => request.path === '/api/migrations/preview')?.options?.body,
        ),
      ),
    ).not.toHaveProperty('use_snapshots');
    expect(screen.queryByLabelText('Migration data')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Complete migration' })).toBeNull();
    expect(
      JSON.parse(
        String(
          requests.find((request) => request.path === '/api/migrations/preview')?.options?.body,
        ),
      ).migration_scope,
    ).toBe('watched_only');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preparing review…' })).toHaveProperty(
      'disabled',
      true,
    );
    await screen.findByText(
      'Preparing migration review… 1 of 2 users complete.',
      {},
      { timeout: 3000 },
    );
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
    responses['/api/migrations/preview/preview-task-1'] = readyPreviewTask;
    const dialog = await screen.findByRole('dialog', {}, { timeout: 3000 });
    expect(within(dialog).getByRole('button', { name: 'Start migration' })).toBeTruthy();
    expect(screen.queryByText(/Preparing migration review/)).toBeNull();
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
    const polls = requests.filter(
      (request) => request.path === '/api/migrations/preview/preview-task-1',
    );
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls.every((request) => !!request.options?.signal)).toBe(true);
  });

  it('shows a failed preview error and releases the preview button without starting a migration', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview/preview-task-1'] = {
      ...runningPreviewTask,
      status: 'failed',
      error: 'The Emby library could not be read. Check the server connection and retry.',
    };
    render(<App />);
    await selectAndPreview();
    await screen.findByText(
      'The Emby library could not be read. Check the server connection and retry.',
      {},
      { timeout: 3000 },
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview migration (2)' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
  });

  it('reviews played flags without a scope picker and excludes legacy personal-data counts', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = {
      ...readyPreviewTask,
      preview: {
        ...readyPreviewTask.preview,
        migration_scope: 'watched_only',
        users: readyPreviewTask.preview.users.map((user) => ({
          ...user,
          stats: {
            source_played: 20,
            matched: 20,
            source_favorites: 999,
            source_resume: 999,
            source_playlists: 999,
          },
        })),
      },
    };
    responses['/api/migrations'] = { ...job, kind: 'migrate', migration_scope: 'watched_only' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    expect(screen.queryByLabelText('Migration data')).toBeNull();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 users selected · played status only')).toBeTruthy();
    expect(
      within(dialog).getByText(/New accounts still use your account role or template defaults/),
    ).toBeTruthy();
    expect(within(dialog).getAllByText('Played in Emby')).toHaveLength(2);
    expect(within(dialog).queryByText('Favorites in Emby')).toBeNull();
    expect(within(dialog).queryByText('Resume positions')).toBeNull();
    expect(within(dialog).queryByText('Playlists')).toBeNull();
    const preview = requests.find((request) => request.path === '/api/migrations/preview')!;
    expect(JSON.parse(String(preview.options?.body))).toEqual({
      source_user_ids: ['e-alex', 'e-river'],
      migration_scope: 'watched_only',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
    );
    const migration = requests.find((request) => request.path === '/api/migrations')!;
    expect(JSON.parse(String(migration.options?.body))).toEqual({
      source_user_ids: ['e-alex', 'e-river'],
      preview_id: 'preview-task-1',
      migration_scope: 'watched_only',
      discord_recipients: {},
    });
  });

  it.each([undefined, 'complete'] as const)(
    'narrows a legacy preview with scope %s to explicit played-status approval',
    async (legacyScope) => {
      prepareRunningPreview();
      responses['/api/migrations/preview'] = {
        ...readyPreviewTask,
        preview: { ...readyPreviewTask.preview, migration_scope: legacyScope },
      };
      responses['/api/migrations'] = { ...job, kind: 'migrate' };
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
      expect(screen.queryByLabelText('Migration data')).toBeNull();
      fireEvent.click(
        await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('2 users selected · played status only')).toBeTruthy();
      expect(within(dialog).queryByText('Favorites in Emby')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
      await waitFor(() =>
        expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
      );
      expect(
        JSON.parse(
          String(requests.find((request) => request.path === '/api/migrations')?.options?.body),
        ).migration_scope,
      ).toBe('watched_only');
    },
  );

  it('pins approved saved source generations independently of a later source selection change', async () => {
    prepareRunningPreview();
    const pins = { 'e-alex': sourceSnapshot.id, 'e-river': sourceSnapshot.id };
    responses['/api/migrations/preview'] = {
      ...readyPreviewTask,
      preview: {
        ...readyPreviewTask.preview,
        source_snapshot_ids: pins,
        users: readyPreviewTask.preview.users.map((user) => ({
          ...user,
          source_snapshot: sourceSnapshot,
        })),
      },
    };
    responses['/api/migrations'] = {
      ...job,
      kind: 'migrate',
      results: [{ username: 'alex', status: 'completed', source_snapshot: sourceSnapshot }],
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    fireEvent.click(await screen.findByLabelText('Use saved Emby snapshot'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Saved Emby data selected.')).toBeTruthy();
    expect(within(dialog).getAllByText(/Saved Emby snapshot/)).toHaveLength(2);
    expect(
      JSON.parse(
        String(
          requests.find((request) => request.path === '/api/migrations/preview')?.options?.body,
        ),
      ),
    ).toMatchObject({ use_snapshots: true });
    fireEvent.click(screen.getByLabelText('Use saved Emby snapshot'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await screen.findByRole('heading', { name: 'Migration details' });
    const body = JSON.parse(
      String(requests.find((request) => request.path === '/api/migrations')?.options?.body),
    );
    expect(body.source_snapshot_ids).toEqual(pins);
    expect(body).not.toHaveProperty('use_snapshots');
    expect(screen.getByText(/Saved Emby snapshot/)).toBeTruthy();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('refuses a saved-source preview without a complete pinned generation map instead of silently using live reads', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = readyPreviewTask;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    fireEvent.click(await screen.findByLabelText('Use saved Emby snapshot'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    await screen.findByText(
      'The saved snapshot preview is incomplete. Refresh saved snapshots in Settings or choose live Emby reads.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.filter((request) => request.path === '/api/migrations/preview')).toHaveLength(
      1,
    );
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
  });

  it('shows a missing or expired saved source error without retrying a live preview', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = {
      detail: 'Saved Emby snapshot expired. Capture again or choose live reads.',
    };
    statuses['/api/migrations/preview'] = 409;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    fireEvent.click(await screen.findByLabelText('Use saved Emby snapshot'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    await screen.findByText('Saved Emby snapshot expired. Capture again or choose live reads.');
    expect(requests.filter((request) => request.path === '/api/migrations/preview')).toHaveLength(
      1,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores live source selection after sign-out and a new administrator sign-in', async () => {
    prepareRunningPreview();
    responses['/api/logout'] = anonymous;
    responses['/api/login'] = session;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    fireEvent.click(await screen.findByLabelText('Use saved Emby snapshot'));
    expect(screen.getByLabelText('Use saved Emby snapshot')).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'synthetic-admin-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByLabelText('Use saved Emby snapshot')).toHaveProperty(
      'checked',
      false,
    );
  });

  it('retains a ready review for acceptance and deletes it only when the administrator closes it', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = { ...readyPreviewTask, elapsed_ms: 1250 };
    render(<App />);
    await selectAndPreviewReady();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Review build: 1.3 seconds/)).toBeTruthy();
    expect(requests.some(({ options }) => options?.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to users' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.filter(({ options }) => options?.method === 'DELETE')).toHaveLength(1);
  });
  it.each(['navigation', 'sign out', 'unmount'] as const)(
    'releases a retained ready review once on %s',
    async (action) => {
      prepareRunningPreview();
      responses['/api/migrations/preview'] = readyPreviewTask;
      responses['/api/logout'] = anonymous;
      const view = render(<App />);
      await selectAndPreviewReady();
      expect(requests.some(({ options }) => options?.method === 'DELETE')).toBe(false);
      if (action === 'unmount') view.unmount();
      else if (action === 'navigation')
        fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
      else fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() =>
        expect(requests.filter(({ options }) => options?.method === 'DELETE')).toHaveLength(1),
      );
      expect(requests.some(({ path }) => path === '/api/migrations')).toBe(false);
      if (action === 'sign out') {
        expect(requests.findIndex(({ options }) => options?.method === 'DELETE')).toBeLessThan(
          requests.findIndex(({ path }) => path === '/api/logout'),
        );
      }
    },
  );
  it('submits a retained preview ID and lets the accepted job own it without a premature deletion', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = readyPreviewTask;
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    render(<App />);
    await selectAndPreviewReady();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Start migration' }),
    );
    await screen.findByRole('heading', { name: 'Migration details' });
    const accepted = requests.find(({ path }) => path === '/api/migrations')!;
    expect(JSON.parse(String(accepted.options?.body)).preview_id).toBe('preview-task-1');
    expect(requests.some(({ options }) => options?.method === 'DELETE')).toBe(false);
  });
  it('refreshes an expired review without silently accepting or using the expired review ID', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview'] = readyPreviewTask;
    responses['/api/migrations'] = {
      detail: 'This migration review expired. Prepare a new preview.',
    };
    statuses['/api/migrations'] = 409;
    render(<App />);
    await selectAndPreviewReady();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Start migration' }),
    );
    await screen.findByText('This migration review expired. Prepare a new preview.');
    responses['/api/migrations/preview'] = { ...readyPreviewTask, id: 'refreshed-preview' };
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Refresh review' }),
    );
    await screen.findByRole('dialog');
    expect(requests.filter(({ options }) => options?.method === 'DELETE')).toHaveLength(1);
    expect(requests.filter(({ path }) => path === '/api/migrations')).toHaveLength(1);
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    statuses['/api/migrations'] = 200;
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Start migration' }),
    );
    await screen.findByRole('heading', { name: 'Migration details' });
    const attempts = requests.filter(({ path }) => path === '/api/migrations');
    expect(JSON.parse(String(attempts[1].options?.body)).preview_id).toBe('refreshed-preview');
  });
  it('shows durable combined timing for the whole accepted job and excludes human review wait', async () => {
    responses['/api/jobs/job-1'] = {
      ...job,
      kind: 'migrate',
      elapsed_ms: 90000,
      queue_ms: 2000,
      workflow_elapsed_ms: 101500,
      preview_timing: {
        preview_id: 'timed-preview',
        started_at: '2026-10-16T12:00:00Z',
        finished_at: '2026-10-16T12:00:11.500Z',
        elapsed_ms: 11500,
        user_count: 4,
      },
    };
    const dialog = await openJob();
    expect(
      within(dialog).getByText(
        /Combined migration elapsed: 101.5 seconds · review build: 11.5 seconds · accepted migration: 90.0 seconds/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Human review wait is excluded/)).toBeTruthy();
    expect(within(dialog).getByText(/whole job duration, not an average per user/)).toBeTruthy();
  });
  it('labels accepted-only timing honestly when a historical or direct job has no recorded review timing', async () => {
    responses['/api/jobs/job-1'] = { ...job, kind: 'migrate', elapsed_ms: 90000 };
    const dialog = await openJob();
    expect(within(dialog).getByText(/Accepted migration elapsed: 90.0 seconds/)).toBeTruthy();
    expect(
      within(dialog).getByText(/Review-build timing was not recorded for this job/),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Combined migration elapsed/)).toBeNull();
    expect(within(dialog).queryByText(/Preparation\/queue: 0.0/)).toBeNull();
  });
  it('cancels a preview when leaving the migration page and ignores an already pending late result', async () => {
    prepareRunningPreview();
    const normalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (path, options) => {
      if (path === '/api/migrations/preview/preview-task-1' && options?.method !== 'DELETE') {
        requests.push({ path: String(path), options });
        return pending;
      }
      return normalFetch(path, options);
    });
    render(<App />);
    await selectAndPreview();
    await waitFor(
      () =>
        expect(
          requests.some((request) => request.path === '/api/migrations/preview/preview-task-1'),
        ).toBe(true),
      { timeout: 3000 },
    );
    const poll = requests.find(
      (request) => request.path === '/api/migrations/preview/preview-task-1',
    )!;
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    expect(poll.options?.signal?.aborted).toBe(true);
    const cancelled = requests.find(
      (request) =>
        request.path === '/api/migrations/preview/preview-task-1' &&
        request.options?.method === 'DELETE',
    )!;
    expect(cancelled).toBeTruthy();
    expect((cancelled.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'test-csrf',
    );
    await act(async () => {
      release({ ok: true, status: 200, json: async () => readyPreviewTask } as Response);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Preparing migration review/)).toBeNull();
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
  });

  it('receives and cancels a delayed preview task after navigating away during its initial request', async () => {
    prepareRunningPreview();
    const normalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (path, options) => {
      if (path === '/api/migrations/preview') {
        requests.push({ path: String(path), options });
        return pending;
      }
      return normalFetch(path, options);
    });
    render(<App />);
    await selectAndPreview();
    expect(
      requests.find((request) => request.path === '/api/migrations/preview')?.options?.signal,
    ).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    expect(requests.some((request) => request.options?.method === 'DELETE')).toBe(false);
    await act(async () => {
      release({ ok: true, status: 202, json: async () => runningPreviewTask } as Response);
    });
    await waitFor(() =>
      expect(
        requests.filter(
          (request) =>
            request.path === '/api/migrations/preview/preview-task-1' &&
            request.options?.method === 'DELETE',
        ),
      ).toHaveLength(1),
    );
    expect(
      requests.some(
        (request) =>
          request.path === '/api/migrations/preview/preview-task-1' &&
          request.options?.method !== 'DELETE',
      ),
    ).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Preparing migration review/)).toBeNull();
  });

  it('cancels a known preview after a polling network error so another attempt can start', async () => {
    prepareRunningPreview();
    const normalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (path, options) => {
      if (path === '/api/migrations/preview/preview-task-1' && options?.method !== 'DELETE') {
        requests.push({ path: String(path), options });
        throw new TypeError('Failed to fetch');
      }
      return normalFetch(path, options);
    });
    render(<App />);
    await selectAndPreview();
    await screen.findByText(
      'Could not reach Jellyport. Check that the application is running and try again.',
      {},
      { timeout: 3000 },
    );
    expect(
      requests.filter(
        (request) =>
          request.path === '/api/migrations/preview/preview-task-1' &&
          request.options?.method === 'DELETE',
      ),
    ).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Preview migration (2)' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
  });

  it('lets the administrator cancel matching and return to selecting users', async () => {
    prepareRunningPreview();
    render(<App />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preview' }));
    expect(screen.queryByText(/Preparing migration review/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview migration (2)' })).toHaveProperty(
      'disabled',
      false,
    );
    await waitFor(() =>
      expect(
        requests.filter(
          (request) =>
            request.path === '/api/migrations/preview/preview-task-1' &&
            request.options?.method === 'DELETE',
        ),
      ).toHaveLength(1),
    );
    expect(screen.getByRole('checkbox', { name: 'Select all visible Emby users' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('aborts and cancels an active preview before signing out', async () => {
    prepareRunningPreview();
    responses['/api/logout'] = anonymous;
    render(<App />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    const cancelIndex = requests.findIndex(
      (request) =>
        request.path === '/api/migrations/preview/preview-task-1' &&
        request.options?.method === 'DELETE',
    );
    const logoutIndex = requests.findIndex((request) => request.path === '/api/logout');
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeLessThan(logoutIndex);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels an authenticated preview on unmount and stops its polling', async () => {
    prepareRunningPreview();
    const view = render(<App />);
    await selectAndPreview();
    view.unmount();
    expect(
      requests.filter(
        (request) =>
          request.path === '/api/migrations/preview/preview-task-1' &&
          request.options?.method === 'DELETE',
      ),
    ).toHaveLength(1);
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
  });

  it('clears rejected preview sessions without sending cancellation under an invalid session', async () => {
    prepareRunningPreview();
    responses['/api/migrations/preview/preview-task-1'] = { detail: 'Sign in to Jellyport.' };
    statuses['/api/migrations/preview/preview-task-1'] = 401;
    render(<App />);
    await selectAndPreview();
    await screen.findByText('Welcome back', {}, { timeout: 3000 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.some((request) => request.options?.method === 'DELETE')).toBe(false);
    expect(requests.some((request) => request.path === '/api/migrations')).toBe(false);
  });
  it('shows approved identity exceptions and submits the preview mapping revision with its verified recipient', async () => {
    responses['/api/users'] = { emby: [{ Id: 'complex', Name: 'Mr. Complex !' }], jellyfin: [] };
    responses['/api/migrations/preview'] = {
      id: 'preview-mapped',
      status: 'ready',
      progress: { processed: 1, total: 1 },
      preview: {
        users: [
          {
            source_user_id: 'complex',
            source_username: 'Mr. Complex !',
            username: 'simple',
            target_exists: true,
            mapping_id: 'map-1',
            mapping_revision: 'approved-revision',
            discord_user_id: '123456789012345678',
            discord_username: 'discord.original',
            stats: {
              source_played: 2,
              source_favorites: 3,
              source_resume: 1,
              source_playlists: 2,
              matched: 5,
            },
            warnings: ['Some source playlists could not be read.'],
          },
        ],
      },
    };
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (1)' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Mapped Emby account: Mr. Complex ! → Jellyfin: simple'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Some source playlists could not be read.')).toBeTruthy();
    expect(within(dialog).queryByText('Favorites in Emby')).toBeNull();
    expect(within(dialog).queryByText('Resume positions')).toBeNull();
    expect(within(dialog).queryByText('Playlists')).toBeNull();
    const recipient = dialog.querySelector('input[name="complex"]') as HTMLInputElement;
    expect(recipient.value).toBe('123456789012345678');
    expect(within(dialog).getByText('@discord.original')).toBeTruthy();
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Clear Discord member @discord.original',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/migrations')!.options?.body),
      ),
    ).toEqual({
      source_user_ids: ['complex'],
      preview_id: 'preview-mapped',
      migration_scope: 'watched_only',
      discord_recipients: { complex: '123456789012345678' },
      mapping_revisions: { complex: 'approved-revision' },
    });
  });
  it('cancels queued jobs, updates their displayed status and keeps completed-change guidance explicit', async () => {
    responses['/api/jobs/job-1'] = { ...job, status: 'queued', results: [] };
    responses['/api/jobs/job-1/cancel'] = { ...job, status: 'canceled', results: [] };
    const dialog = await openJob();
    expect(
      within(dialog).getByText(
        /Changes already applied to media accounts are kept and are not rolled back/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Review the results before rerunning/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel job' }));
    expect(await within(dialog).findByText('Canceled')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Cancel job' })).toBeNull();
    const cancellation = requests.find((request) => request.path === '/api/jobs/job-1/cancel')!;
    expect(cancellation.options?.method).toBe('POST');
    expect((cancellation.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'test-csrf',
    );
    expect(JSON.parse(String(cancellation.options?.body))).toEqual({});
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Canceled')).toBeTruthy();
  });
  it('shows cancellation draining for running jobs and prevents duplicate requests', async () => {
    responses['/api/jobs/job-1'] = { ...job, status: 'running', results: [] };
    responses['/api/jobs/job-1/cancel'] = {
      ...job,
      status: 'running',
      cancel_requested: true,
      results: [],
    };
    const dialog = await openJob();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel job' }));
    const canceling = await within(dialog).findByRole('button', { name: 'Canceling…' });
    await waitFor(() => expect(canceling).toHaveProperty('disabled', true));
    fireEvent.click(canceling);
    expect(requests.filter((request) => request.path === '/api/jobs/job-1/cancel')).toHaveLength(1);
    expect(within(dialog).getByText('In progress')).toBeTruthy();
    expect(
      await screen.findByText(
        'Cancellation requested. Completed changes are kept; review results before rerunning.',
      ),
    ).toBeTruthy();
  });
  it('leaves the active job available for retry if its cancellation fails', async () => {
    responses['/api/jobs/job-1'] = { ...job, status: 'running', results: [] };
    responses['/api/jobs/job-1/cancel'] = { detail: 'Cancellation could not be confirmed.' };
    statuses['/api/jobs/job-1/cancel'] = 503;
    const dialog = await openJob();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel job' }));
    await screen.findByText('Cancellation could not be confirmed.');
    expect(within(dialog).getByRole('button', { name: 'Cancel job' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(within(dialog).getByText('In progress')).toBeTruthy();
  });

  it.each([undefined, 'complete', 'watched_only'] as const)(
    'preserves historical broad migration results with scope %s and escapes source names and warnings',
    async (scope) => {
      responses['/api/jobs/job-1'] = {
        ...job,
        kind: 'migrate',
        migration_scope: scope,
        status: 'partial',
        results: [
          {
            username: 'simple',
            source_username: '<script>source()</script>',
            status: 'partial',
            data: {
              items_updated: 4,
              favorites: 2,
              resume_positions: 1,
              play_counts: 3,
              last_played_dates: 2,
              ratings: 1,
              preferences: ['SubtitleMode'],
              avatar: true,
              playlists_created: 1,
              playlists_existing: 2,
              playlist_items_added: 3,
              playlist_items_skipped: 1,
              playlist_duplicates_skipped: 0,
              failed_items: 0,
              history_dates_missing: 0,
              warnings: ['<img src=x onerror=unsafe()>'],
            },
          },
        ],
      };
      const dialog = await openJob();
      expect(within(dialog).getByText('Historical migration')).toBeTruthy();
      expect(within(dialog).getByText('4 items updated')).toBeTruthy();
      expect(within(dialog).getByText('2 favorites')).toBeTruthy();
      expect(within(dialog).getByText('1 resume positions')).toBeTruthy();
      expect(within(dialog).getByText('1 playlists created')).toBeTruthy();
      expect(within(dialog).getByText('Profile image copied')).toBeTruthy();
      expect(
        within(dialog).getByText('Emby: <script>source()</script> → Jellyfin: simple'),
      ).toBeTruthy();
      expect(within(dialog).getByText('<img src=x onerror=unsafe()>')).toBeTruthy();
      expect(dialog.querySelector('script,img')).toBeNull();
    },
  );
  it('shows played-status verification without suggesting unsupported data was migrated', async () => {
    responses['/api/jobs/job-1'] = {
      ...job,
      kind: 'migrate',
      migration_scope: 'watched_only',
      results: [
        {
          username: 'alex',
          status: 'migrated',
          applied: 4,
          data: {
            items_updated: 4,
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
            verification: {
              checked: 4,
              verified: 4,
              preserved_newer: 0,
              missing: 0,
              mismatched: 0,
              unsupported_fields: 0,
            },
          },
        },
      ],
    };
    const dialog = await openJob();
    expect(within(dialog).getByText('4 played updates')).toBeTruthy();
    expect(
      within(dialog).getByText(/Independent played-status verification: 4 verified/),
    ).toBeTruthy();
    expect(within(dialog).queryByText('Historical migration')).toBeNull();
    expect(within(dialog).queryByText(/playlists created/)).toBeNull();
    expect(within(dialog).queryByText(/resume positions/)).toBeNull();
    expect(within(dialog).queryByText(/favorites/)).toBeNull();
  });
  it('reports request workload and escaped failed played updates without implying complete success', async () => {
    responses['/api/jobs/job-1'] = {
      ...job,
      kind: 'migrate',
      status: 'partial',
      migration_scope: 'watched_only',
      results: [
        {
          username: 'alex',
          status: 'partial',
          timing: {
            elapsed_ms: 1000,
            phase_ms: { transferring_history: 900 },
            checkpoints: { count: 4, total_duration_ms: 120, max_duration_ms: 90 },
          },
          data: {
            ...emptyPlayedDetails,
            items_updated: 88,
            failed_items: 12,
            write_metrics: {
              attempts: 100,
              succeeded: 88,
              failed: 12,
              cumulative_ms: 2040,
              max_ms: 910,
              peak_in_flight: 4,
            },
            failed_updates: [
              {
                target_id: 'target-404',
                item_type: 'Episode',
                error: '<script>unsafe()</script> HTTP 404',
              },
            ],
          },
        },
      ],
    };
    const dialog = await openJob();
    expect(within(dialog).getAllByText('Needs review')).toHaveLength(2);
    expect(within(dialog).getByText('12 failed updates')).toBeTruthy();
    expect(
      within(dialog).getByText(
        /Progress checkpoints: 4 persisted · 0.1 seconds total · 0.1 seconds slowest/,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/100 attempted · 88 succeeded · 12 failed · peak 4 in flight/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        /Cumulative request time: 2.0 seconds; slowest request: 0.9 seconds/,
      ),
    ).toBeTruthy();
    const failures = within(dialog).getByText('Failed played updates (12)').closest('details')!;
    fireEvent.click(within(failures).getByText('Failed played updates (12)'));
    expect(within(failures).getByText('target-404')).toBeTruthy();
    expect(
      within(failures).getByText(/Episode · <script>unsafe\(\)<\/script> HTTP 404/),
    ).toBeTruthy();
    expect(within(failures).getByText(/Showing 1 of 12 failed updates/)).toBeTruthy();
    expect(dialog.querySelector('script,img')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('bounds failed played update details while retaining the full failure count', async () => {
    responses['/api/jobs/job-1'] = {
      ...job,
      kind: 'migrate',
      status: 'partial',
      migration_scope: 'watched_only',
      results: [
        {
          username: 'alex',
          status: 'partial',
          data: {
            ...emptyPlayedDetails,
            failed_items: 220,
            failed_updates: Array.from({ length: 201 }, (_, index) => ({
              target_id: `target-${index}`,
              item_type: 'Movie',
              error: 'Jellyfin HTTP 500',
            })),
          },
        },
      ],
    };
    const dialog = await openJob();
    expect(within(dialog).getByText('220 failed updates')).toBeTruthy();
    const failures = within(dialog).getByText('Failed played updates (220)').closest('details')!;
    fireEvent.click(within(failures).getByText('Failed played updates (220)'));
    expect(within(failures).getAllByRole('listitem')).toHaveLength(200);
    expect(within(failures).getByText('target-199')).toBeTruthy();
    expect(within(failures).queryByText('target-200')).toBeNull();
    expect(within(failures).getByText(/Showing 200 of 220 failed updates/)).toBeTruthy();
    expect(
      within(failures).getByText(/At most 200 item details are retained per account/),
    ).toBeTruthy();
  });
  it('keeps older failure results readable when request metrics and individual details are absent', async () => {
    responses['/api/jobs/job-1'] = {
      ...job,
      kind: 'migrate',
      status: 'partial',
      results: [
        {
          username: 'alex',
          status: 'partial',
          data: {
            ...emptyPlayedDetails,
            failed_items: 2,
          },
        },
      ],
    };
    const dialog = await openJob();
    const failures = within(dialog).getByText('Failed item updates (2)').closest('details')!;
    fireEvent.click(within(failures).getByText('Failed item updates (2)'));
    expect(
      within(failures).getByText('Individual failure details were not recorded for this job.'),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Played-status write requests/)).toBeNull();
  });
  it('closes mobile navigation when moving to a page and dismisses private dialogs with Escape', async () => {
    vi.stubGlobal('innerWidth', 400);
    const dialog = await openJob();
    // The DOM can be visible before the modal's focus and keyboard effects have run.
    const close = within(dialog).getByRole('button', { name: 'Close dialog' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.keyDown(close, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('keeps keyboard focus in open mobile navigation and restores it on dismissal', async () => {
    vi.stubGlobal('innerWidth', 400);
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#workspace-content',
    );
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    expect(toggle.getAttribute('aria-controls')).toBe('workspace-navigation');
    fireEvent.click(toggle);
    const first = screen.getByRole('button', { name: 'Overview' });
    const last = screen.getByRole('button', { name: 'Sign out' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('focuses the current mobile page and contains keyboard focus that starts outside navigation', async () => {
    vi.stubGlobal('innerWidth', 400);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Activity' }));

    toggle.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Overview' }));
    toggle.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(toggle);
  });
  it('dismisses mobile navigation when expanding to desktop and releases its keyboard trap', async () => {
    vi.stubGlobal('innerWidth', 400);
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    fireEvent.click(toggle);
    vi.stubGlobal('innerWidth', 850);
    fireEvent(window, new Event('resize'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    vi.stubGlobal('innerWidth', 851);
    fireEvent(window, new Event('resize'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Close navigation' })).toBeNull();
    expect(document.activeElement).toBe(toggle);

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    fireEvent(window, tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });
  it('retains an open drawer in wide touch-phone landscape and closes it when the same viewport uses a fine pointer', async () => {
    let width = 430;
    let coarse = true;
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return width <= (query.includes('850px') ? 850 : 700) || (width <= 1100 && coarse);
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    fireEvent.click(toggle);
    expect(document.body.classList.contains('navigation-open')).toBe(true);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
    width = 956;
    fireEvent(window, new Event('resize'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.classList.contains('navigation-open')).toBe(true);
    coarse = false;
    fireEvent(window, new Event('resize'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.classList.contains('navigation-open')).toBe(false);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });
  it('keeps navigation and modal scroll locks independent and releases navigation locks on dismissal', async () => {
    vi.stubGlobal('innerWidth', 430);
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(document.body.classList.contains('navigation-open')).toBe(true);
    document.body.classList.add('modal-open');
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(document.body.classList.contains('navigation-open')).toBe(false);
    expect(document.body.classList.contains('modal-open')).toBe(true);
    document.body.classList.remove('modal-open');
  });
  it('hands focus and scroll ownership from the drawer to a deferred operation dialog', async () => {
    vi.stubGlobal('innerWidth', 430);
    const original = fetch;
    let reply!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path === '/api/jobs/job-1')
          return new Promise<Response>((resolve) => {
            reply = resolve;
          });
        return original(path, options);
      }),
    );
    // jsdom has no layout, so expose the visible dialog controls to its focus trap.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
      const rect = new DOMRect(0, 0, 100, 44);
      return Object.assign([rect], {
        item: (index: number) => (index === 0 ? rect : null),
      }) as DOMRectList;
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'View operation details' }));
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    fireEvent.click(toggle);
    expect(document.body.classList.contains('navigation-open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Overview' }));
    await act(async () => {
      reply({ ok: true, status: 200, json: async () => job } as Response);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Operation details' });
    const first = within(dialog).getByRole('button', { name: 'Close dialog' });
    const last = within(dialog).getByRole('button', { name: 'Reveal new credentials' });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.classList.contains('navigation-open')).toBe(false);
    expect(document.body.classList.contains('modal-open')).toBe(true);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.click(first);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.classList.contains('modal-open')).toBe(false);
    expect(document.body.classList.contains('navigation-open')).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });
  it.each(['sign out', 'unmount'] as const)(
    'releases the navigation focus trap and scroll lock after %s',
    async (action) => {
      vi.stubGlobal('innerWidth', 430);
      responses['/api/logout'] = { ...session, authenticated: false, user: undefined };
      const { unmount } = render(<App />);
      await screen.findByRole('heading', { name: 'Overview', level: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
      expect(document.body.classList.contains('navigation-open')).toBe(true);
      if (action === 'unmount') unmount();
      else {
        fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
        await screen.findByLabelText('Jellyfin username');
      }
      expect(document.body.classList.contains('navigation-open')).toBe(false);
      const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(false);
      if (action === 'unmount') {
        expect(document.documentElement.style.getPropertyValue('--viewport-height')).toBe('');
        expect(document.documentElement.style.getPropertyValue('--viewport-top')).toBe('');
      }
    },
  );
  it('saves independent activity retention through the authenticated CSRF-protected API', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Activity');
    await screen.findByText('Automatic cleanup off');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable automatic activity cleanup' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Keep reports for this many days' }), {
      target: { value: '14' },
    });
    responses['/api/jobs/retention'] = {
      ...(responses['/api/jobs/retention'] as object),
      retention_days: 14,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Save activity retention' }));
    await screen.findByText('Automatic activity cleanup saved.');
    const request = requests.find(
      (request) => request.path === '/api/jobs/retention' && request.options?.method === 'PUT',
    )!;
    expect((request.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(JSON.parse(request.options!.body as string)).toEqual({ retention_days: 14 });
    expect(
      requests.some(
        (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it.each(['media', 'accounts', 'discord', 'automation', 'history', 'activity'])(
    'opens a legacy bookmarked %s settings section and writes a durable route when navigating elsewhere',
    async (section) => {
      const original = window.location.href;
      window.history.replaceState(null, '', `#settings-${section}`);
      try {
        render(<App />);
        await screen.findByRole('heading', { name: 'Settings', level: 1 });
        const sections = screen.getByRole('tablist', { name: 'Settings sections' });
        const labels: Record<string, string> = {
          media: 'Servers',
          accounts: 'Account defaults',
          discord: 'Discord',
          automation: 'Automation',
          history: 'Saved history',
          activity: 'Activity',
        };
        expect(
          within(sections)
            .getByRole('tab', { name: labels[section] })
            .getAttribute('aria-selected'),
        ).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
        await screen.findByRole('heading', { name: 'Overview', level: 1 });
        expect(window.location.hash).toBe('#/overview');
      } finally {
        window.history.replaceState(null, '', original);
      }
    },
  );
});

const anonymous: Session = { ...session, authenticated: false, user: undefined };
const setupSession: Session = { ...anonymous, setup_required: true };
const pendingSession: Session = {
  ...setupSession,
  setup_connected: true,
  csrf_token: 'pending-csrf',
};
const connection: SetupConnection = {
  session: pendingSession,
  server: { url: 'http://jellyfin:8096' },
  templates: [
    { Id: 'admin-id', Name: 'Admin user', Policy: { IsAdministrator: true } },
    { Id: 'disabled', Name: 'Disabled user', Policy: { IsDisabled: true } },
    {
      Id: 'template',
      Name: 'Member template',
      Policy: { IsAdministrator: false, IsDisabled: false },
    },
  ],
  defaults: { template_user_id: 'template', jellyfin_public_url: 'https://media.example.com' },
};

describe('Jellyfin administrator sign-in and setup', () => {
  it('guides secure-cookie HTTP visitors to their HTTPS address without collecting sign-in credentials', async () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    responses['/api/session'] = { ...anonymous, secure_cookie: true };
    render(<App />);
    await screen.findByRole('heading', { name: 'HTTPS is required for sign-in' });
    expect(screen.getByText(/Open your HTTPS reverse-proxy address to continue/)).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin username')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/login')).toBe(false);
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
  });

  it('allows secure-cookie HTTP setup and transitions to HTTPS guidance when setup completes', async () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    responses['/api/session'] = { ...setupSession, secure_cookie: true };
    responses['/api/setup/connect'] = {
      ...connection,
      session: { ...pendingSession, secure_cookie: true },
    };
    responses['/api/setup/complete'] = {
      ...anonymous,
      csrf_token: 'finished-csrf',
      secure_cookie: true,
    };
    render(<App />);
    const apiKey = (await screen.findByLabelText('Jellyfin API key')) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(apiKey, { target: { value: 'local-setup-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(apiKey.value).toBe('');
    await screen.findByText('Choose account permissions');
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByText('Setup complete. Your server connection has been saved.');
    expect(screen.getByRole('heading', { name: 'HTTPS is required for sign-in' })).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin API key')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin username')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/setup/connect')).toBe(true);
    expect(requests.some((request) => request.path === '/api/setup/complete')).toBe(true);
    expect(requests.some((request) => request.path === '/api/login')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('preserves normal administrator sign-in over HTTPS with secure cookies enabled', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    responses['/api/session'] = { ...anonymous, secure_cookie: true };
    responses['/api/login'] = { ...session, secure_cookie: true };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'https-admin-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(password.value).toBe('');
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    const login = requests.find((request) => request.path === '/api/login')!;
    expect(JSON.parse(String(login.options?.body))).toEqual({
      username: 'jellyfin-admin',
      password: 'https-admin-password',
    });
  });

  it('does not transmit a password if refreshed session policy requires HTTPS on an HTTP page', async () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    responses['/api/session'] = anonymous;
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'do-not-send-password' } });
    responses['/api/session'] = { ...anonymous, secure_cookie: true };
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(password.value).toBe('');
    await screen.findByRole('heading', { name: 'HTTPS is required for sign-in' });
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(requests.some((request) => request.path === '/api/login')).toBe(false);
    expect(
      requests.some((request) => String(request.options?.body).includes('do-not-send-password')),
    ).toBe(false);
  });

  it('retries a failed session fetch from the sign-in page', async () => {
    responses['/api/session'] = { detail: 'Jellyport is temporarily unavailable.' };
    statuses['/api/session'] = 503;
    render(<App />);
    await screen.findByRole('button', { name: 'Retry connection' });
    expect(screen.getByRole('alert').textContent).toBe('Jellyport is temporarily unavailable.');
    responses['/api/session'] = anonymous;
    statuses['/api/session'] = 200;
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByLabelText('Jellyfin username');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('signs in with the Jellyfin username and password, clears the form secret, and displays the administrator', async () => {
    responses['/api/session'] = anonymous;
    responses['/api/login'] = session;
    render(<App />);
    await screen.findByText('Welcome back');
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    fireEvent.change(password, { target: { value: 'my-jellyfin-password!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(password.value).toBe('');
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    expect(screen.getByText('jellyfin-admin')).toBeTruthy();
    const login = requests.find((request) => request.path === '/api/login')!;
    expect(JSON.parse(String(login.options?.body))).toEqual({
      username: 'jellyfin-admin',
      password: 'my-jellyfin-password!',
    });
    expect((login.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps sign-in errors inline and clears rejected passwords', async () => {
    responses['/api/session'] = anonymous;
    responses['/api/login'] = { detail: 'Only Jellyfin administrators can sign in.' };
    statuses['/api/login'] = 403;
    render(<App />);
    await screen.findByText('Welcome back');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'member' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'rejected-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Only Jellyfin administrators can sign in.',
    );
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
  });

  it('connects with a pre-created API key, filters unsafe templates, and finishes at administrator sign-in', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = connection;
    responses['/api/setup/complete'] = { ...anonymous, csrf_token: 'finished-csrf' };
    responses['/api/login'] = session;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    const apiKey = screen.getByLabelText('Jellyfin API key') as HTMLInputElement;
    expect(apiKey.type).toBe('password');
    expect([...apiKey.form!.querySelectorAll('input')].map((field) => field.name)).toEqual([
      'jellyfin_url',
      'api_key',
    ]);
    expect(screen.queryByLabelText('Jellyfin username')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect((screen.getByLabelText('Jellyfin server URL') as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(apiKey, { target: { value: 'pre-created-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(apiKey.value).toBe('');
    await screen.findByText('Choose account permissions');
    expect(screen.queryByRole('option', { name: 'Admin user' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Disabled user' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Member template' })).toBeTruthy();
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect(JSON.parse(String(connect.options?.body))).toEqual({
      jellyfin_url: 'http://jellyfin:8096',
      api_key: 'pre-created-api-key',
    });
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByText(
      'Setup complete. Sign in with your Jellyfin administrator account to continue.',
    );
    expect(screen.getByText('Welcome back')).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin API key')).toBeNull();
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
    const complete = requests.find((request) => request.path === '/api/setup/complete')!;
    expect(JSON.parse(String(complete.options?.body))).toEqual({
      template_user_id: 'template',
      jellyfin_public_url: 'https://media.example.com',
    });
    expect((complete.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'pending-csrf',
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'admin-login-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    const login = requests.find((request) => request.path === '/api/login')!;
    expect(JSON.parse(String(login.options?.body))).toEqual({
      username: 'admin',
      password: 'admin-login-password',
    });
    expect((login.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'finished-csrf',
    );
  });

  it('keeps the setup wizard available after a rejected Jellyfin API key and clears it', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = {
      detail: 'Jellyfin did not accept that API key.',
    };
    statuses['/api/setup/connect'] = 401;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin API key'), {
      target: { value: 'bad-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Jellyfin did not accept that API key.');
    expect(screen.getByText('Connect your Jellyfin server')).toBeTruthy();
    expect((screen.getByLabelText('Jellyfin API key') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
  it('prefills and locks the connected server during guided setup for an existing workspace', async () => {
    const storedUrl = 'http://existing-jellyfin:8096';
    responses['/api/session'] = { ...setupSession, setup_server_url: storedUrl };
    responses['/api/setup/connect'] = { ...connection, server: { url: storedUrl } };
    render(<App />);
    const server = (await screen.findByLabelText('Jellyfin server URL')) as HTMLInputElement;
    expect(server.value).toBe(storedUrl);
    expect(server.readOnly).toBe(true);
    expect(
      screen.getByText('Use a key from the Jellyfin server already connected to this workspace.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Jellyfin API key'), {
      target: { value: 'existing-server-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect(JSON.parse(String(connect.options?.body))).toEqual({
      jellyfin_url: storedUrl,
      api_key: 'existing-server-api-key',
    });
  });

  it('resumes connected setup after a reload and refreshes template users without collecting credentials again', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = { ...connection, templates: [] };
    render(<App />);
    await screen.findByText(
      'No regular template users are available. You can finish setup and configure an account role later.',
    );
    expect(screen.queryByLabelText('Jellyfin API key')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    responses['/api/setup'] = connection;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh users' }));
    await screen.findByRole('option', { name: 'Member template' });
    expect(
      (screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('replaces the key for the bound Jellyfin connection and immediately clears the masked input', async () => {
    responses['/api/settings'] = {
      ...settings,
      jellyfin_url: 'http://jellyfin:8096',
      jellyfin_auth_managed: true,
    };
    responses['/api/auth/service-key'] = responses['/api/settings'];
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Servers', 'Jellyfin');
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const server = document.querySelector<HTMLInputElement>('#setting-jellyfin_url')!;
    expect(server.readOnly).toBe(true);
    expect(document.querySelector('#setting-jellyfin_api_key')).toBeNull();
    const keyField = screen.getByLabelText('Replacement Jellyfin API key') as HTMLInputElement;
    expect(keyField.type).toBe('password');
    expect(keyField.value).toBe('');
    fireEvent.change(keyField, { target: { value: 'replacement-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace Jellyfin API key' }));
    expect(keyField.value).toBe('');
    await screen.findByText('Jellyfin API key replaced.');
    const request = requests.find((value) => value.path === '/api/auth/service-key')!;
    expect(request.options?.method).toBe('POST');
    expect(JSON.parse(String(request.options?.body))).toEqual({ api_key: 'replacement-api-key' });
    expect((request.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('reconnects an unfinished setup using logout and the new setup session CSRF token', async () => {
    const restartedSession = { ...setupSession, csrf_token: 'restarted-csrf' };
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = connection;
    responses['/api/logout'] = restartedSession;
    responses['/api/setup/connect'] = connection;
    render(<App />);
    await screen.findByText('Choose account permissions');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Jellyfin' }));
    await screen.findByText('Connect your Jellyfin server');
    expect((screen.getByLabelText('Jellyfin API key') as HTMLInputElement).value).toBe('');
    const logout = requests.find((request) => request.path === '/api/logout')!;
    expect(logout.options?.method).toBe('POST');
    expect((logout.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'pending-csrf',
    );
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin API key'), {
      target: { value: 'new-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect((connect.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'restarted-csrf',
    );
  });
  it('rediscovers an expired pending cookie before sending a protected setup request', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = connection;
    responses['/api/setup/complete'] = { detail: 'Setup session expired. Connect Jellyfin again.' };
    statuses['/api/setup/complete'] = 403;
    render(<App />);
    await screen.findByText('Choose account permissions');
    responses['/api/session'] = { ...setupSession, csrf_token: 'fresh-csrf' };
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByLabelText('Jellyfin server URL');
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByText('Connect your Jellyfin server')).toBeTruthy();
    expect((screen.getByLabelText('Jellyfin API key') as HTMLInputElement).value).toBe('');
    expect(requests.some((request) => request.path === '/api/setup/complete')).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe(
      'Setup session expired. Connect Jellyfin again.',
    );
  });
  it('refreshes an expired setup cookie before reconnect logout and uses the new CSRF token', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = connection;
    responses['/api/logout'] = { ...setupSession, csrf_token: 'logout-csrf' };
    render(<App />);
    await screen.findByText('Choose account permissions');
    responses['/api/session'] = { ...setupSession, csrf_token: 'renewed-csrf' };
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Jellyfin' }));
    await screen.findByText('Connect your Jellyfin server');
    const logout = requests.find((request) => request.path === '/api/logout')!;
    expect((logout.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'renewed-csrf',
    );
  });
  it('renews an expired anonymous cookie before transmitting the setup API key', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = connection;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    responses['/api/session'] = { ...setupSession, csrf_token: 'renewed-setup-csrf' };
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    const apiKey = screen.getByLabelText('Jellyfin API key') as HTMLInputElement;
    fireEvent.change(apiKey, { target: { value: 'server-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(apiKey.value).toBe('');
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect((connect.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'renewed-setup-csrf',
    );
  });
  it('clears an unsubmitted setup API key when the sign-in component unmounts', async () => {
    responses['/api/session'] = setupSession;
    const view = render(<App />);
    const keyField = (await screen.findByLabelText('Jellyfin API key')) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'unsubmitted-api-key' } });
    view.unmount();
    expect(keyField.value).toBe('');
    expect(requests.some((request) => request.path === '/api/setup/connect')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('clears rejected replacement keys without altering the bound server', async () => {
    responses['/api/settings'] = {
      ...settings,
      jellyfin_url: 'http://jellyfin:8096',
      jellyfin_auth_managed: true,
    };
    responses['/api/auth/service-key'] = { detail: 'Jellyfin did not accept that API key.' };
    statuses['/api/auth/service-key'] = 400;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Servers', 'Jellyfin');
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'rejected-replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace Jellyfin API key' }));
    expect(keyField.value).toBe('');
    await screen.findByText('Jellyfin did not accept that API key.');
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect((screen.getByLabelText('Replacement Jellyfin API key') as HTMLInputElement).value).toBe(
      '',
    );
    expect(requests.filter((request) => request.path === '/api/auth/service-key')).toHaveLength(1);
    expect(
      requests.some(
        (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
      ),
    ).toBe(false);
  });
  it('omits replacement keys from ordinary settings saves and clears the field', async () => {
    responses['/api/settings'] = {
      ...settings,
      jellyfin_url: 'http://jellyfin:8096',
      jellyfin_auth_managed: true,
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Servers', 'Jellyfin');
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'not-for-settings-save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(keyField.value).toBe('');
    await screen.findByText('Settings saved. Your connections are ready to test.');
    const request = requests.find(
      (value) => value.path === '/api/settings' && value.options?.method === 'PUT',
    )!;
    expect(String(request.options?.body)).not.toContain('not-for-settings-save');
    expect(JSON.parse(String(request.options?.body))).not.toHaveProperty('api_key');
    expect(requests.some((value) => value.path === '/api/auth/service-key')).toBe(false);
  });
  it('aborts replacement requests and clears any unsubmitted key when leaving settings', async () => {
    responses['/api/settings'] = { ...settings, jellyfin_auth_managed: true };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Servers', 'Jellyfin');
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'pending-replacement-key' } });
    let signal: AbortSignal | undefined;
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path === '/api/auth/service-key') {
          signal = options?.signal || undefined;
          return new Promise(() => {});
        }
        return original(path, options);
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace Jellyfin API key' }));
    expect(keyField.value).toBe('');
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(screen.queryByText('Jellyfin API key replaced.')).toBeNull();
  });
  it('clears an unsubmitted replacement key when leaving Settings', async () => {
    responses['/api/settings'] = { ...settings, jellyfin_auth_managed: true };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await selectSettingsTab('Servers', 'Jellyfin');
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'unsubmitted-replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await waitFor(() => expect(keyField.value).toBe(''));
    expect(requests.some((request) => request.path === '/api/auth/service-key')).toBe(false);
  });
});
