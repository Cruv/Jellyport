// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImportStatus, useImportClock, useImportWorkflow } from './ImportWorkflow';
import type { Api, ApiOptions, ImportWorkflowStatus, Notify } from './types';

const idle: ImportWorkflowStatus = {
  running: false,
  last_attempt_at: null,
  last_finished_at: null,
  last_outcome: null,
  next_run_at: null,
  last_error: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function Harness({
  api,
  active = true,
  notify = vi.fn(),
}: {
  api: Api;
  active?: boolean;
  notify?: Notify;
}) {
  const workflow = useImportWorkflow<ImportWorkflowStatus>({
    api,
    active,
    demo: false,
    notify,
    path: '/api/import-test',
    statusError: 'Status refresh failed.',
  });
  return (
    <>
      <ImportStatus
        status={workflow.status}
        loading={workflow.loading}
        starting={workflow.busy === 'import'}
        initialLabel="Loading import status…"
        runningLabel="Import running…"
        progressLabel="Import progress"
        summary="Saved data available"
        error={workflow.error}
        stale={workflow.stale}
        uncertain={workflow.uncertain}
      />
      <button onClick={() => void workflow.load()} disabled={workflow.loading || !!workflow.busy}>
        Refresh status
      </button>
      <button
        onClick={() =>
          void workflow.change(
            'import',
            { method: 'POST' },
            'Import accepted.',
            'Import start request failed.',
          )
        }
        disabled={
          !!workflow.busy || workflow.uncertain || workflow.stale || !!workflow.status?.running
        }
      >
        Import
      </button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared import lifecycle', () => {
  it('uses native indeterminate progress for loading, starting and running; completion is reported separately', async () => {
    const read = deferred<ImportWorkflowStatus>(),
      start = deferred<ImportWorkflowStatus>();
    let reads = 0;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method) return (await start.promise) as T;
      return (++reads === 1 ? await read.promise : { ...idle, last_outcome: 'succeeded' }) as T;
    };
    render(<Harness api={api} />);
    const progress = screen.getByRole('progressbar', { name: 'Import progress' });
    expect(progress.className).toBe('');
    expect(progress.hasAttribute('value')).toBe(false);
    await act(async () => read.resolve(idle));
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByText('Starting import…')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
    await act(async () => start.resolve({ ...idle, running: true, last_outcome: 'running' }));
    expect(screen.getByText('Import running…')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await act(async () => {});
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('requires a successful status reconciliation before retrying an uncertain start', async () => {
    let reads = 0,
      writes = 0;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method) {
        writes++;
        throw new Error('PRIVATE_BACKUP_PATH');
      }
      if (++reads === 2) throw new Error('PRIVATE_NETWORK_DETAIL');
      return idle as T;
    };
    render(<Harness api={api} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await act(async () => {});
    expect(screen.getByText(/start request may have been accepted/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await act(async () => {});
    expect(screen.getByText(/Showing the last known status/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(writes).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', false);
    expect(screen.queryByText(/PRIVATE_/)).toBeNull();
  });

  it('does not poll hidden panels, refreshes on return, and never replays an import', async () => {
    vi.useFakeTimers();
    let reads = 0,
      writes = 0;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      options?.method ? writes++ : reads++;
      return { ...idle, running: true } as T;
    };
    const view = render(<Harness api={api} active={false} />);
    await act(async () => {});
    expect(reads).toBe(0);
    view.rerender(<Harness api={api} />);
    await act(async () => {});
    expect(reads).toBe(1);
    view.rerender(<Harness api={api} active={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(1);
    view.rerender(<Harness api={api} />);
    await act(async () => {});
    expect(reads).toBe(2);
    expect(writes).toBe(0);
  });

  it('does not interrupt a slow manual status refresh with a scheduled poll', async () => {
    vi.useFakeTimers();
    const pending = deferred<ImportWorkflowStatus>();
    let reads = 0;
    let signal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (++reads === 1) return { ...idle, running: true } as T;
      signal = options?.signal;
      return (await pending.promise) as T;
    };
    render(<Harness api={api} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(reads).toBe(2);
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve({ ...idle, last_outcome: 'succeeded' }));
    expect(screen.getByText('Completed')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(reads).toBe(2);
  });

  it('keeps pending mutation ownership across hiding, and blocks duplicates on return', async () => {
    const start = deferred<ImportWorkflowStatus>();
    let signal: AbortSignal | undefined,
      writes = 0;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (!options?.method) return idle as T;
      writes++;
      signal = options.signal;
      return (await start.promise) as T;
    };
    const notify = vi.fn();
    const view = render(<Harness api={api} notify={notify} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    view.rerender(<Harness api={api} active={false} notify={notify} />);
    expect(signal?.aborted).toBe(false);
    view.rerender(<Harness api={api} notify={notify} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(writes).toBe(1);
    await act(async () => start.resolve({ ...idle, running: true }));
    expect(notify).toHaveBeenCalledOnce();
  });

  it('survives StrictMode effect replay and aborts stale initial reads', async () => {
    const pending = deferred<ImportWorkflowStatus>();
    const signals: AbortSignal[] = [];
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      signals.push(options!.signal!);
      return (await pending.promise) as T;
    };
    render(
      <StrictMode>
        <Harness api={api} />
      </StrictMode>,
    );
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    await act(async () => pending.resolve(idle));
    expect(screen.getByText('Saved data available')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('truthful import status', () => {
  it.each([
    { total: 100, processed: 34 },
    { total: 0, processed: 0 },
    { total: 100, processed: 101 },
  ])('uses only valid measured counts: %j', (measured) => {
    render(
      <ImportStatus
        status={{ ...idle, running: true }}
        loading={false}
        starting={false}
        initialLabel="Loading"
        runningLabel="Running"
        progressLabel="Progress"
        summary="Ready"
        error=""
        stale={false}
        uncertain={false}
        measured={measured}
      />,
    );
    const progress = screen.getByRole('progressbar');
    if (measured.total === 100 && measured.processed === 34) {
      expect(progress.getAttribute('value')).toBe('34');
      expect(progress.getAttribute('max')).toBe('100');
    } else expect(progress.hasAttribute('value')).toBe(false);
  });
  it('shows a failed or interrupted attempt separately from retained saved data', () => {
    render(
      <ImportStatus
        status={{
          ...idle,
          last_outcome: 'interrupted',
          last_error: 'Import interrupted.',
          last_finished_at: 'invalid',
        }}
        loading={false}
        starting={false}
        initialLabel="Loading"
        runningLabel="Running"
        progressLabel="Progress"
        summary="Saved data available"
        error=""
        stale={false}
        uncertain={false}
      />,
    );
    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(screen.getByText('Saved data available')).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
  });
  it('expires multiple records at their own deadlines without additional API reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-18T04:00:00Z');
    const deadlines = ['2026-10-18T04:00:01Z', '2026-10-18T04:00:02Z', '2026-10-18T04:00:03Z'];
    function Clock() {
      const now = useImportClock(deadlines, true);
      return <p>{deadlines.filter((value) => Date.parse(value) > now).length} current</p>;
    }
    render(<Clock />);
    expect(screen.getByText('3 current')).toBeTruthy();
    for (const remaining of [2, 1, 0]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByText(`${remaining} current`)).toBeTruthy();
    }
  });
});
