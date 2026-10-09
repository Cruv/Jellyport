// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SourceSnapshotsPanel from './SourceSnapshotsPanel';
import type { Api, ApiOptions, SourceSnapshotStatus } from './types';

const status: SourceSnapshotStatus = {
  available: true,
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
  last_attempt_at: '2026-10-08T03:00:00Z',
  last_finished_at: '2026-10-08T03:00:05Z',
  last_error: null,
  users_total: 0,
  users_processed: 0,
  users_succeeded: 0,
  users_failed: 0,
  snapshots: 1,
  encrypted_bytes: 1024,
  records: [
    {
      source_type: 'sqlite_online_backup',
      schema: 'Emby 4.10 user data',
      id: '12345678-1234-4234-8234-123456789012',
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
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Saved Emby database capture settings', () => {
  it('starts scheduling off at the server time and saves a revision-checked schedule independently', async () => {
    const calls: { path: string; options?: ApiOptions }[] = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      calls.push({ path, options });
      return (
        options?.method === 'PUT'
          ? {
              ...status,
              config: {
                ...status.config,
                enabled: true,
                hour: 4,
                minute: 15,
                time_zone: 'Europe/London',
                revision: 'revision-2',
              },
            }
          : status
      ) as T;
    };
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    const time = await screen.findByLabelText('Capture time');
    expect(time).toHaveProperty('value', '03:00');
    expect(screen.getByLabelText('Enable daily database capture')).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Time zone')).toHaveProperty('value', 'UTC');
    expect(
      screen.getByText(/Database captures support both complete and watched-only migrations/),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Enable daily database capture'));
    fireEvent.change(time, { target: { value: '04:15' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/London' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save capture schedule' }));
    await waitFor(() => expect(calls.some((call) => call.options?.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.options?.method === 'PUT')).toMatchObject({
      path: '/api/source-snapshots/schedule',
      options: {
        body: {
          enabled: true,
          hour: 4,
          minute: 15,
          time_zone: 'Europe/London',
          scope: 'complete',
          expected_revision: 'revision-1',
        },
      },
    });
  });

  it('keeps last good captures visible after unsupported schema or status failures without exposing raw errors', async () => {
    let fail = false;
    const api: Api = async <T,>() => {
      if (fail) throw new Error('PRIVATE_DATABASE_PATH');
      return {
        ...status,
        last_error: 'Unsupported Emby database schema. Update Jellyport or choose live reads.',
      } as T;
    };
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('All Emby users');
    expect(screen.getByText(/Unsupported Emby database schema/)).toBeTruthy();
    expect(screen.getByText(/Previous valid captures are retained/)).toBeTruthy();
    expect(screen.getByText(/Emby 4.10.1.0/)).toBeTruthy();
    expect(screen.queryByText('http://emby:8096')).toBeNull();
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot status' }));
    await screen.findByRole('alert');
    expect(screen.getByText('All Emby users')).toBeTruthy();
    expect(screen.queryByText(/PRIVATE_DATABASE_PATH/)).toBeNull();
  });

  it('disables database capture when the host source mount is unavailable', async () => {
    const api: Api = async <T,>() => ({ ...status, available: false }) as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Emby database source is unavailable.');
    expect(screen.getByRole('button', { name: 'Capture database now' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('All Emby users')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Docker deployment guide' }).getAttribute('href'),
    ).toContain('/docs/docker-deployment.md');
  });

  it('keeps schedule and capture mutations disabled in demo mode', async () => {
    const api = vi.fn(async () => status) as Api;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo />);
    await screen.findByLabelText('Capture time');
    for (const name of ['Save capture schedule', 'Capture database now', 'Clear saved captures']) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(screen.getByLabelText('Enable daily database capture')).toHaveProperty('disabled', true);
    expect(vi.mocked(api)).toHaveBeenCalledOnce();
  });

  it('polls a running database capture and aborts an in-flight poll on navigation away', async () => {
    vi.useFakeTimers();
    let count = 0;
    let release!: (value: SourceSnapshotStatus) => void;
    let pollSignal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      count++;
      if (count === 1) return { ...status, running: true } as T;
      pollSignal = options?.signal;
      return (await new Promise<SourceSnapshotStatus>((resolve) => {
        release = resolve;
      })) as T;
    };
    const view = render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await act(async () => {});
    expect(
      screen.getByRole('progressbar', { name: 'Database capture progress' }).hasAttribute('value'),
    ).toBe(false);
    expect(screen.getByRole('button', { name: 'Clear saved captures' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(count).toBe(2);
    view.unmount();
    expect(pollSignal?.aborted).toBe(true);
    await act(async () => {
      release(status);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(count).toBe(2);
  });

  it('aborts a capture request on unmount and ignores its late response', async () => {
    let release!: (value: SourceSnapshotStatus) => void;
    let signal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method !== 'POST') return status as T;
      signal = options.signal;
      return (await new Promise<SourceSnapshotStatus>((resolve) => {
        release = resolve;
      })) as T;
    };
    const notify = vi.fn();
    const view = render(<SourceSnapshotsPanel api={api} notify={notify} demo={false} />);
    await screen.findByText('All Emby users');
    fireEvent.click(screen.getByRole('button', { name: 'Capture database now' }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => release({ ...status, running: true }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('reports pinned-capture deletion refusal and keeps the last good database copy visible', async () => {
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method === 'DELETE') throw new Error('RAW_SQLITE_DETAIL');
      return status as T;
    };
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('All Emby users');
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved captures' }));
    await screen.findByText(/A capture or migration may still be using them/);
    expect(screen.getByText('All Emby users')).toBeTruthy();
    expect(screen.queryByText(/RAW_SQLITE_DETAIL/)).toBeNull();
  });
});
