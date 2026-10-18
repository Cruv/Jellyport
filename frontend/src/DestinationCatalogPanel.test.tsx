// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DestinationCatalogPanel, { type DestinationCatalogStatus } from './DestinationCatalogPanel';
import type { Api, ApiOptions } from './types';

const now = Date.parse('2026-01-02T04:00:00Z');
const status: DestinationCatalogStatus = {
  config: { enabled: false, hour: 3, minute: 0, time_zone: 'UTC', revision: 'catalog-revision-1' },
  next_run_at: null,
  last_finished_at: '2026-01-02T03:59:59Z',
  last_outcome: 'succeeded',
  configured: true,
  available: true,
  running: false,
  record: {
    id: 'synthetic-catalog-generation',
    items: 120_000,
    keys: 220_000,
    bytes: 3 * 1024 ** 2,
    server_version: '10.11.6',
    backup_engine_version: '0.2.0',
    backup_created_at: '2026-01-01T03:00:00Z',
    imported_at: '2026-01-02T03:59:59Z',
    import_elapsed_ms: 1500,
    expires_at: '2026-01-03T03:00:00Z',
  },
  last_error: null,
  last_attempt_at: '2026-01-02T03:59:57Z',
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saved destination catalog settings', () => {
  it.each(
    (['failed', 'interrupted'] as const).flatMap((outcome) =>
      (['none', 'current', 'expired'] as const).map((retained) => ({ outcome, retained })),
    ),
  )(
    'reports retained-data knowledge truthfully after $outcome with $retained matching catalog',
    async ({ outcome, retained }) => {
      vi.spyOn(Date, 'now').mockReturnValue(
        retained === 'expired' ? Date.parse('2026-01-04T04:00:00Z') : now,
      );
      const api: Api = async <T,>() =>
        ({
          ...status,
          last_outcome: outcome,
          last_error: 'Import attempt did not finish.',
          record: retained === 'none' ? null : status.record,
        }) as T;
      render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
      expect((await screen.findByRole('alert')).textContent).toBe('Import attempt did not finish.');
      expect(screen.getByText(outcome === 'failed' ? 'Failed' : 'Interrupted')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Import latest Jellyfin backup' })).toHaveProperty(
        'disabled',
        false,
      );
      expect(screen.getByRole('button', { name: 'Refresh status' })).toHaveProperty(
        'disabled',
        false,
      );
      expect(screen.queryByText('Previous valid saved data is retained.')).toBeNull();
      if (retained === 'none') {
        expect(screen.getByText('No previous saved data is available.')).toBeTruthy();
        expect(screen.queryByText('Previous saved data is retained.')).toBeNull();
        expect(screen.queryByRole('table', { name: 'Imported Jellyfin catalog' })).toBeNull();
      } else {
        expect(screen.getByText('Previous saved data is retained.')).toBeTruthy();
        expect(screen.queryByText('No previous saved data is available.')).toBeNull();
        expect(screen.getByText(retained === 'expired' ? 'Expired' : 'Available')).toBeTruthy();
        if (retained === 'expired')
          expect(screen.queryByText('Saved matching catalog available')).toBeNull();
      }
    },
  );
  it.each([false, true])(
    'does not imply retained matching data exists in the empty state (retained=%s)',
    async (retained) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const api: Api = async <T,>() =>
        ({
          ...status,
          configured: retained,
          available: false,
          usable: false,
          record: retained ? status.record : null,
        }) as T;
      render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
      await screen.findByText('Saved matching catalog unavailable.');
      if (retained) {
        expect(
          screen.getByText(/The last imported catalog remains listed for review/),
        ).toBeTruthy();
        expect(screen.getByRole('table', { name: 'Imported Jellyfin catalog' })).toBeTruthy();
        expect(screen.queryByText(/No matching catalog has been imported yet/)).toBeNull();
      } else {
        expect(screen.getByText(/No matching catalog has been imported yet/)).toBeTruthy();
        expect(
          screen.queryByText(/The last imported catalog remains listed for review/),
        ).toBeNull();
        expect(screen.queryByRole('table', { name: 'Imported Jellyfin catalog' })).toBeNull();
        expect(
          screen.getByRole('button', { name: 'Import latest Jellyfin backup' }),
        ).toHaveProperty('disabled', true);
      }
    },
  );
  it('saves a revision-checked daily import schedule without starting an import, then leaves it unchanged during manual import', async () => {
    let value = { ...status };
    const calls: Array<{ path: string; options?: ApiOptions }> = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      calls.push({ path, options });
      if (options?.method === 'PUT')
        value = {
          ...value,
          config: {
            enabled: true,
            hour: 4,
            minute: 15,
            time_zone: 'America/New_York',
            revision: 'catalog-revision-2',
          },
          next_run_at: '2026-10-19T08:15:00Z',
        };
      if (options?.method === 'POST') value = { ...value, running: true, last_outcome: 'running' };
      return value as T;
    };
    const notify = vi.fn();
    render(<DestinationCatalogPanel api={api} notify={notify} demo={false} />);
    const time = await screen.findByLabelText('Import time');
    fireEvent.click(screen.getByLabelText('Enable daily backup import'));
    fireEvent.change(time, { target: { value: '04:15' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save import schedule' }));
    await act(async () => {});
    expect(calls.find((call) => call.options?.method === 'PUT')).toMatchObject({
      path: '/api/destination-catalog/schedule',
      options: {
        body: {
          enabled: true,
          hour: 4,
          minute: 15,
          time_zone: 'America/New_York',
          expected_revision: 'catalog-revision-1',
        },
      },
    });
    expect(calls.filter((call) => call.options?.method === 'POST')).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('Jellyfin backup import schedule saved.');
    expect(screen.getByText('Daily at 04:15 (America/New_York)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import latest Jellyfin backup' }));
    await act(async () => {});
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '04:15');
    expect(calls.filter((call) => call.options?.method === 'PUT')).toHaveLength(1);
    expect(calls.find((call) => call.options?.method === 'POST')?.options?.body).toBeUndefined();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('retains unsaved schedule edits through hidden tabs and reconciles a newer saved revision without replaying actions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-18T04:00:00Z');
    let reads = 0;
    const api: Api = async <T,>() =>
      ({
        ...status,
        running: true,
        config:
          ++reads === 1
            ? status.config
            : { ...status.config, hour: 5, revision: 'catalog-revision-2' },
      }) as T;
    const view = render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Import time'), { target: { value: '04:20' } });
    view.rerender(
      <DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} active={false} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(reads).toBe(1);
    view.rerender(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await act(async () => {});
    expect(reads).toBe(2);
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '04:20');
    expect(screen.getByText(/The saved schedule changed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save import schedule' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved schedule' }));
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '05:00');
    expect(reads).toBe(2);
  });
  it('labels original backup age separately from import time and describes live activity safeguards', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const api: Api = async <T,>() => status as T;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    const table = await screen.findByRole('table', { name: 'Imported Jellyfin catalog' });
    expect(within(table).getByText('25h 0m old')).toBeTruthy();
    expect(
      within(table).getByText(new Date(status.record!.backup_created_at).toLocaleString()),
    ).toBeTruthy();
    expect(
      within(table).getByText(`Imported ${new Date(status.record!.imported_at).toLocaleString()}`),
    ).toBeTruthy();
    expect(within(table).getByText('Import duration 1.5 s')).toBeTruthy();
    expect(within(table).getByText('120,000 matching items')).toBeTruthy();
    expect(within(table).getByText('220,000 matching keys · 3.0 MiB')).toBeTruthy();
    expect(within(table).getByText('Available')).toBeTruthy();
    expect(
      screen.getByText(
        /Current Jellyfin watch history and account access are still checked through its API/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/No saved Jellyfin user history is imported/)).toBeTruthy();
    expect(screen.getByText(/Importing it again does not make the catalog newer/)).toBeTruthy();
    expect(screen.queryByText(status.record!.id)).toBeNull();
  });

  it('expires at the original backup deadline without relying on another status request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T02:59:59Z'));
    const api = vi.fn(async <T,>() => status as T) as Api;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await act(async () => {});
    expect(screen.getByText('Available')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('The saved matching catalog has expired.')).toBeTruthy();
    expect(screen.queryByText('Available')).toBeNull();
    expect(vi.mocked(api)).toHaveBeenCalledOnce();
  });

  it('shows configuration and unavailable states without inventing a catalog', async () => {
    const api: Api = async <T,>() =>
      ({ ...status, configured: false, available: false, record: null }) as T;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Jellyfin backup import is not configured.');
    expect(screen.getByText('No saved Jellyfin matching catalog')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Docker deployment guide' })).toHaveProperty(
      'href',
      'https://github.com/Cruv/Jellyport/blob/main/docs/docker-deployment.md',
    );
    expect(screen.getByRole('button', { name: 'Import latest Jellyfin backup' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Clear matching catalog' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps a good catalog available when a later import failed and renders server errors as text', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const last_error = 'Backup import failed. <script>synthetic()</script>';
    const api: Api = async <T,>() => ({ ...status, last_error }) as T;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText(last_error);
    expect(screen.getByText('Saved matching catalog available')).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });

  it('keeps an unexpired saved catalog usable when its import helper is unavailable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const api: Api = async <T,>() => ({ ...status, available: false }) as T;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Jellyfin backup import helper is unavailable.');
    expect(screen.getByText('Saved matching catalog available')).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import latest Jellyfin backup' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Clear matching catalog' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('starts one import without a body and blocks duplicate mutations while its request is pending', async () => {
    const pending = deferred<DestinationCatalogStatus>();
    const calls: Array<{ path: string; options?: ApiOptions }> = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      calls.push({ path, options });
      return (options?.method === 'POST' ? await pending.promise : status) as T;
    };
    const notify = vi.fn();
    render(<DestinationCatalogPanel api={api} notify={notify} demo={false} />);
    await screen.findByRole('table');
    const button = screen.getByRole('button', { name: 'Import latest Jellyfin backup' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(calls.filter((call) => call.options?.method === 'POST')).toHaveLength(1);
    const request = calls.at(-1)!;
    expect(request.path).toBe('/api/destination-catalog/refresh');
    expect(request.options?.body).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Starting import…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Refresh status' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Clear matching catalog' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => pending.resolve({ ...status, running: true }));
    expect(notify).toHaveBeenCalledWith(
      'Jellyfin backup import started. You can follow its status here.',
    );
    expect(
      screen
        .getByRole('progressbar', { name: 'Jellyfin catalog import progress' })
        .hasAttribute('value'),
    ).toBe(false);
  });

  it('polls only while importing and stops after completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    let calls = 0;
    const api: Api = async <T,>() => ({ ...status, running: ++calls === 1 }) as T;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await act(async () => {});
    expect(calls).toBe(1);
    expect(screen.getByText('Importing Jellyfin backup…')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(calls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(calls).toBe(2);
    expect(screen.getByText('Saved matching catalog available')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls).toBe(2);
  });

  it('does not overlap slow polls and aborts an in-flight poll on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const pending = deferred<DestinationCatalogStatus>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (++calls === 1) return { ...status, running: true } as T;
      signal = options?.signal;
      return (await pending.promise) as T;
    };
    const view = render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(calls).toBe(2);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(status);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls).toBe(2);
  });

  it('ignores an older status response after an import starts', async () => {
    const stale = deferred<DestinationCatalogStatus>();
    let reads = 0;
    let staleSignal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method === 'POST') return { ...status, running: true } as T;
      if (++reads === 1) return status as T;
      staleSignal = options?.signal;
      return (await stale.promise) as T;
    };
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(staleSignal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Import latest Jellyfin backup' }));
    await screen.findByText('Importing Jellyfin backup…');
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => stale.resolve({ ...status, running: false, record: null }));
    expect(screen.getByText('Importing Jellyfin backup…')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Imported Jellyfin catalog' })).toBeTruthy();
  });

  it('aborts old requests when the API binding changes and ignores late errors', async () => {
    const pending = deferred<DestinationCatalogStatus>();
    let oldSignal: AbortSignal | undefined;
    const oldApi: Api = async <T,>(_path: string, options?: ApiOptions) => {
      oldSignal = options?.signal;
      return (await pending.promise) as T;
    };
    const newApi: Api = async <T,>() => ({ ...status, record: null, available: false }) as T;
    const notify = vi.fn();
    const view = render(<DestinationCatalogPanel api={oldApi} notify={notify} demo={false} />);
    view.rerender(<DestinationCatalogPanel api={newApi} notify={notify} demo={false} />);
    await screen.findByText('No saved Jellyfin matching catalog');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => pending.reject(new Error('PRIVATE_RAW_ERROR')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('PRIVATE_RAW_ERROR')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('aborts a pending mutation on unmount and does not notify after navigation', async () => {
    const pending = deferred<DestinationCatalogStatus>();
    let signal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method !== 'POST') return status as T;
      signal = options.signal;
      return (await pending.promise) as T;
    };
    const notify = vi.fn();
    const view = render(<DestinationCatalogPanel api={api} notify={notify} demo={false} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Import latest Jellyfin backup' }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ ...status, running: true }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not let a stale mutation release a newer API binding mutation guard', async () => {
    const oldMutation = deferred<DestinationCatalogStatus>();
    const newMutation = deferred<DestinationCatalogStatus>();
    let oldSignal: AbortSignal | undefined;
    let newWrites = 0;
    const oldApi: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method !== 'POST') return status as T;
      oldSignal = options.signal;
      return (await oldMutation.promise) as T;
    };
    const newApi: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method !== 'POST') return status as T;
      newWrites++;
      return (await newMutation.promise) as T;
    };
    const notify = vi.fn();
    const view = render(<DestinationCatalogPanel api={oldApi} notify={notify} demo={false} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Import latest Jellyfin backup' }));
    await screen.findByRole('button', { name: 'Starting import…' });
    view.rerender(<DestinationCatalogPanel api={newApi} notify={notify} demo={false} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import latest Jellyfin backup' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(oldSignal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Import latest Jellyfin backup' }));
    await act(async () => oldMutation.resolve({ ...status, running: true }));
    expect(screen.getByRole('button', { name: 'Starting import…' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Starting import…' }));
    expect(newWrites).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => newMutation.resolve({ ...status, running: true }));
    expect(notify).toHaveBeenCalledOnce();
  });

  it('clears only the derived catalog through DELETE', async () => {
    const calls: Array<{ path: string; options?: ApiOptions }> = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      calls.push({ path, options });
      return {
        ...status,
        ...(options?.method === 'DELETE' ? { record: null, available: false } : {}),
      } as T;
    };
    const notify = vi.fn();
    render(<DestinationCatalogPanel api={api} notify={notify} demo={false} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Clear matching catalog' }));
    await screen.findByText('No saved Jellyfin matching catalog');
    expect(calls.at(-1)?.path).toBe('/api/destination-catalog');
    expect(calls.at(-1)?.options?.method).toBe('DELETE');
    expect(calls.at(-1)?.options?.body).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('Saved Jellyfin matching catalog cleared.');
  });

  it('preserves a pinned catalog when deletion fails and excludes raw exception details', async () => {
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method === 'DELETE') throw new Error('PRIVATE_SQLITE_DETAIL');
      return status as T;
    };
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Clear matching catalog' }));
    await screen.findByText(/An import or migration may still be using it/);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByText('PRIVATE_SQLITE_DETAIL')).toBeNull();
  });

  it('allows recovery from a failed status read without exposing raw failures', async () => {
    let count = 0;
    const api: Api = async <T,>() => {
      if (++count === 1) throw new Error('PRIVATE_NETWORK_DETAIL');
      return status as T;
    };
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText(
      'Jellyfin catalog status could not be loaded. Refresh status to try again.',
    );
    expect(screen.getByText('Import status unavailable')).toBeTruthy();
    expect(screen.queryByText('PRIVATE_NETWORK_DETAIL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps demo mutations disabled while allowing status refresh', async () => {
    const api = vi.fn(async <T,>() => status as T) as Api;
    render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo />);
    await screen.findByRole('table');
    for (const name of ['Import latest Jellyfin backup', 'Clear matching catalog']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
    }
    expect(vi.mocked(api)).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});

it('reports an unexpired record as unavailable when backend binding or file validation fails', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const api: Api = async <T,>() => ({ ...status, usable: false }) as T;
  render(<DestinationCatalogPanel api={api} notify={vi.fn()} demo={false} />);
  await screen.findByText('Saved matching catalog unavailable.');
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByText('Available')).toBeNull();
});
