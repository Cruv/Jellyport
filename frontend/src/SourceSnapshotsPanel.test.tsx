// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SourceSnapshotsPanel from './SourceSnapshotsPanel';
import { SourceSnapshotNote } from './components';
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
const pluginStatus: SourceSnapshotStatus = {
  ...status,
  capture_method: 'plugin_backup',
  last_attempt_at: '2026-10-15T03:05:00Z',
  last_finished_at: '2026-10-15T03:05:10Z',
  records: status.records.map((record) => ({
    ...record,
    source_type: 'plugin_backup',
    backup_created_at: '2026-10-14T03:00:00Z',
    backup_fingerprint: 'a'.repeat(64),
    plugin_version: '1.8.7.0',
    started_at: '2026-10-15T03:05:00Z',
    finished_at: '2026-10-15T03:05:10Z',
    expires_at: '2026-10-16T03:00:00Z',
  })),
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Saved Emby database capture settings', () => {
  it('shows plugin history age from the original backup and separately labels the later import', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-15T04:00:00Z'));
    const api: Api = async <T,>() => pluginStatus as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByLabelText('Enable daily backup import');
    const row = screen.getByText('All Emby users').closest('tr')!;
    expect(within(row).getByText(new Date('2026-10-14T03:00:00Z').toLocaleString())).toBeTruthy();
    expect(within(row).getByText('25h 0m old')).toBeTruthy();
    expect(
      within(row).getByText(`Imported ${new Date('2026-10-15T03:05:10Z').toLocaleString()}`),
    ).toBeTruthy();
    expect(within(row).getByText('Available')).toBeTruthy();
    expect(
      screen.getByText(/History expires 48 hours after the original backup time/),
    ).toBeTruthy();
    expect(screen.getByText(/Importing an unchanged backup does not make it newer/)).toBeTruthy();
    expect(screen.getByText(/Jellyport checks stable backup files before importing/)).toBeTruthy();
    expect(screen.queryByText(/consistent SQLite online backup/)).toBeNull();
    expect(screen.queryByText(pluginStatus.records[0]!.backup_fingerprint!)).toBeNull();
  });

  it('retains plugin provenance and backup-age guidance when the active helper uses another method', async () => {
    const api: Api = async <T,>() =>
      ({ ...pluginStatus, capture_method: 'sqlite_online_backup' }) as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Emby plugin backup');
    expect(screen.getByText('SQLite online backup')).toBeTruthy();
    expect(screen.getByText('Backup age stays with the original backup.')).toBeTruthy();
    expect(
      screen.getByText(/History expires 48 hours after the original backup time/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture database now' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByRole('button', { name: 'Import latest backup' })).toBeNull();
  });

  it('expires plugin history at 48 hours even when the backup was imported recently', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T03:01:00Z'));
    const api: Api = async <T,>() =>
      ({
        ...pluginStatus,
        records: pluginStatus.records.map((record) => ({
          ...record,
          finished_at: '2026-10-16T03:00:50Z',
        })),
      }) as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Expired');
    expect(screen.getByText('48h 1m old')).toBeTruthy();
    expect(screen.queryByText('Just now')).toBeNull();
  });

  it('labels manual import and daily scheduling while using the existing authenticated routes', async () => {
    const calls: { path: string; options?: ApiOptions }[] = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      calls.push({ path, options });
      return pluginStatus as T;
    };
    const notify = vi.fn();
    render(<SourceSnapshotsPanel api={api} notify={notify} demo={false} />);
    const time = await screen.findByLabelText('Import time');
    expect(screen.getByLabelText('Enable daily backup import')).toHaveProperty('checked', false);
    expect(screen.getByText(/This does not change Emby’s backup schedule/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Enable daily backup import'));
    fireEvent.change(time, { target: { value: '04:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save import schedule' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Backup import schedule saved.'));
    expect(calls.find((call) => call.options?.method === 'PUT')).toMatchObject({
      path: '/api/source-snapshots/schedule',
      options: { body: { enabled: true, hour: 4, minute: 15, expected_revision: 'revision-1' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import latest backup' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Backup import started. You can follow its status here.'),
    );
    expect(calls.find((call) => call.options?.method === 'POST')).toMatchObject({
      path: '/api/source-snapshots/refresh',
    });
  });

  it('reports plugin source failures without exposing paths and keeps existing imports visible', async () => {
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method === 'POST') throw new Error('PRIVATE_BACKUP_PATH');
      return pluginStatus as T;
    };
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import latest backup' }));
    await screen.findByRole('alert');
    expect(
      screen.getByText(
        'Backup import could not start. Check the backup folder and refresh status.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('All Emby users')).toBeTruthy();
    expect(screen.queryByText('PRIVATE_BACKUP_PATH')).toBeNull();
  });

  it('shows a plugin-specific unavailable source and disables import when its helper is absent', async () => {
    const api: Api = async <T,>() => ({ ...pluginStatus, available: false }) as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Emby backup source is unavailable.');
    expect(screen.getByRole('button', { name: 'Import latest backup' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Configure the backup folder using/)).toBeTruthy();
  });

  it('carries original backup and import dates separately into migration review and result notes', () => {
    render(<SourceSnapshotNote snapshot={pluginStatus.records[0]!} />);
    const note = screen.getByText(/Saved Emby plugin backup/);
    expect(note.textContent).toContain(
      `backed up ${new Date('2026-10-14T03:00:00Z').toLocaleString()}`,
    );
    expect(note.textContent).toContain(
      `Imported ${new Date('2026-10-15T03:05:10Z').toLocaleString()}`,
    );
    expect(note.textContent).toContain('importing it again does not refresh its history');
    expect(note.textContent).not.toContain('Read window');
  });

  it('labels the active file-copy helper and retained copies without promising transactional history', async () => {
    const copied: SourceSnapshotStatus = {
      ...status,
      capture_method: 'file_copy',
      records: status.records.map((record) => ({ ...record, source_type: 'file_copy' })),
    };
    const api: Api = async <T,>() => copied as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Scheduled file copy');
    expect(screen.getByText('File copy')).toBeTruthy();
    expect(screen.getByText('File copies use best-effort history.')).toBeTruthy();
    expect(screen.getByText(/Live file copies are not transactional/)).toBeTruthy();
    expect(
      screen.getByText(/Some history may be missing or inconsistent even when validation passes/),
    ).toBeTruthy();
    expect(screen.getByText(/no filesystem snapshot or downtime is needed/)).toBeTruthy();
    expect(screen.queryByText(/consistent SQLite online backup is captured/)).toBeNull();
    const row = screen.getByText('File copy').closest('tr')!;
    expect(within(row).getByText('Complete database capture')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture database now' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('retains file-copy provenance and its warning when the helper switches back to online backups', async () => {
    const api: Api = async <T,>() =>
      ({
        ...status,
        last_error: 'Database capture validation failed.',
        records: status.records.map((record) => ({ ...record, source_type: 'file_copy' })),
      }) as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('File copy');
    expect(screen.getByText('SQLite online backup')).toBeTruthy();
    expect(screen.getByText(/consistent SQLite online backup is captured/)).toBeTruthy();
    expect(screen.getByText(/Live file copies are not transactional/)).toBeTruthy();
    expect(
      screen.getByText(/Database capture validation failed.*Previous valid captures are retained/),
    ).toBeTruthy();
    expect(screen.getByText(/Failed captures keep the last good copy/)).toBeTruthy();
    expect(screen.queryByText('Scheduled file copy')).toBeNull();
  });

  it('defaults an old status response without capture metadata to online backup guidance', async () => {
    const legacy: SourceSnapshotStatus = {
      ...status,
      capture_method: undefined,
      records: status.records.map((record) => ({ ...record, source_type: undefined })),
    };
    const api: Api = async <T,>() => legacy as T;
    render(<SourceSnapshotsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('All Emby users');
    expect(screen.getByText('SQLite online backup')).toBeTruthy();
    expect(screen.getByText(/consistent SQLite online backup is captured/)).toBeTruthy();
    expect(screen.getByText('Complete database capture')).toBeTruthy();
    expect(screen.queryByText('File copies use best-effort history.')).toBeNull();
    expect(screen.queryByText('Scheduled file copy')).toBeNull();
    expect(screen.getByRole('button', { name: 'Capture database now' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('carries file-copy provenance and history limitations into shared migration review and result notes', () => {
    render(<SourceSnapshotNote snapshot={{ ...status.records[0]!, source_type: 'file_copy' }} />);
    expect(screen.getByText(/Saved Emby snapshot · File copy · Emby 4.10.1.0/)).toBeTruthy();
    expect(screen.getByText(/Copy window:/)).toBeTruthy();
    expect(
      screen.getByText(/some history may be missing or inconsistent even when validation passes/),
    ).toBeTruthy();
    expect(screen.queryByText(/Read window:/)).toBeNull();
  });

  it.each(['sqlite_online_backup', undefined] as const)(
    'keeps existing online and legacy migration notes compatible (%s)',
    (source_type) => {
      render(<SourceSnapshotNote snapshot={{ ...status.records[0]!, source_type }} />);
      expect(screen.getByText(/Saved Emby snapshot · Emby 4.10.1.0/)).toBeTruthy();
      expect(screen.getByText(/Read window:/)).toBeTruthy();
      expect(screen.getByText(/Activity after this window is not included/)).toBeTruthy();
      expect(screen.queryByText(/not transactional/)).toBeNull();
      expect(screen.queryByText(/File copy/)).toBeNull();
    },
  );

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
      screen.getByText(/Migrations use only played flags from the captured database/),
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
