// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import ActivityRetentionPanel from './ActivityRetentionPanel';
import type { ActivityRetentionStatus, Api, ApiOptions } from './types';

const off: ActivityRetentionStatus = {
  retention_days: 0,
  interval_seconds: 60,
  batch_limit: 100,
  last_run_at: null,
  last_removed: 0,
  last_kept: 0,
  error: null,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function page(respond?: Api, props?: { active?: boolean; demo?: boolean }) {
  const api = vi.fn(async <T,>(path: string, options?: ApiOptions) => {
    if (respond) return respond<T>(path, options);
    return {
      ...off,
      retention_days:
        options?.method === 'PUT' ? (options.body as { retention_days: number }).retention_days : 0,
    } as T;
  }) as Api;
  const notify = vi.fn();
  const value = { api, notify, demo: false, ...props };
  return { ...render(<ActivityRetentionPanel {...value} />), api, notify, props: value };
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save activity retention' }));
const enable = () =>
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable automatic activity cleanup' }));
const days = () =>
  screen.getByRole('spinbutton', { name: 'Keep reports for this many days' }) as HTMLInputElement;

describe('Independent activity retention', () => {
  it('starts off with a 30-day suggestion and never enables cleanup from a read', async () => {
    const p = page();
    await screen.findByText('Automatic cleanup off');
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
    expect(days()).toHaveProperty('value', '30');
    expect(days()).toHaveProperty('disabled', true);
    expect(p.api).toHaveBeenCalledOnce();
    expect(screen.getByText(/at most 100 reports per pass/)).toBeTruthy();
    expect(screen.getByText(/Active work, pending credentials, recovery records/)).toBeTruthy();
  });

  it('saves only the retention setting and turns it off without discarding the preferred days', async () => {
    const p = page();
    await screen.findByText('Automatic cleanup off');
    enable();
    fireEvent.change(days(), { target: { value: '14' } });
    save();
    await waitFor(() => expect(p.notify).toHaveBeenCalledWith('Automatic activity cleanup saved.'));
    expect(p.api).toHaveBeenCalledWith(
      '/api/jobs/retention',
      expect.objectContaining({
        method: 'PUT',
        body: { retention_days: 14 },
        signal: expect.any(AbortSignal),
      }),
    );
    enable();
    save();
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith('Automatic activity cleanup turned off.'),
    );
    expect(p.api).toHaveBeenLastCalledWith(
      '/api/jobs/retention',
      expect.objectContaining({ method: 'PUT', body: { retention_days: 0 } }),
    );
    expect(days()).toHaveProperty('value', '14');
  });

  it.each(['0', '-1', '1.5', '3651', '1e2', ''])(
    'rejects invalid enabled retention %s before sending a mutation',
    async (value) => {
      const p = page();
      await screen.findByText('Automatic cleanup off');
      enable();
      fireEvent.change(days(), { target: { value } });
      save();
      expect(screen.getByRole('alert').textContent).toBe(
        'Enter a whole number of days from 1 to 3,650.',
      );
      expect(p.api).toHaveBeenCalledOnce();
      expect(days().getAttribute('aria-invalid')).toBe('true');
    },
  );

  it.each(['1', '3650'])('accepts the supported boundary of %s days', async (value) => {
    const p = page();
    await screen.findByText('Automatic cleanup off');
    enable();
    fireEvent.change(days(), { target: { value } });
    save();
    await waitFor(() => expect(p.notify).toHaveBeenCalledOnce());
    expect(p.api).toHaveBeenLastCalledWith(
      '/api/jobs/retention',
      expect.objectContaining({ body: { retention_days: Number(value) } }),
    );
  });

  it('keeps the draft during status refresh and after a failed save, with a safe retry', async () => {
    let failing = true;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method === 'PUT' && failing) throw new Error('PRIVATE_INTERNAL_PATH');
      return { ...off, retention_days: options?.method === 'PUT' ? 45 : 7 } as T;
    };
    const p = page(api);
    await screen.findByText('Clear reports older than 7 days');
    fireEvent.change(days(), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save activity retention' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(days().value).toBe('45');
    save();
    await screen.findByRole('alert');
    expect(screen.queryByText('PRIVATE_INTERNAL_PATH')).toBeNull();
    expect(days().value).toBe('45');
    expect(p.notify.mock.calls).toEqual([
      ['Activity retention status refreshed.'],
      [
        'Activity retention could not be saved. Your changes are kept; retry saving or refresh status to verify the current setting.',
        true,
      ],
    ]);
    failing = false;
    save();
    await waitFor(() =>
      expect(p.notify).toHaveBeenLastCalledWith('Automatic activity cleanup saved.'),
    );
    expect(screen.getByText('Clear reports older than 45 days')).toBeTruthy();
  });

  it('shows load failures without assuming cleanup is off and supports status retry', async () => {
    let failing = true;
    const p = page(async <T,>() => {
      if (failing) throw new Error('PRIVATE_LOAD_DETAIL');
      return { ...off, retention_days: 90 } as T;
    });
    await screen.findByRole('alert');
    expect(screen.queryByText('Automatic cleanup off')).toBeNull();
    expect(screen.queryByText('PRIVATE_LOAD_DETAIL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save activity retention' })).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('Clear reports older than 90 days');
    expect(p.notify).toHaveBeenCalledExactlyOnceWith('Activity retention status refreshed.');
  });

  it('loads only while active and retains a draft across Settings tabs', async () => {
    const p = page(undefined, { active: false });
    expect(p.api).not.toHaveBeenCalled();
    p.rerender(<ActivityRetentionPanel {...p.props} active />);
    await screen.findByText('Automatic cleanup off');
    enable();
    fireEvent.change(days(), { target: { value: '60' } });
    p.rerender(<ActivityRetentionPanel {...p.props} active={false} />);
    p.rerender(<ActivityRetentionPanel {...p.props} active />);
    await waitFor(() => expect(p.api).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(days()).toHaveProperty('disabled', false));
    expect(days().value).toBe('60');
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
  });

  it.each(['load', 'save'] as const)(
    'aborts pending %s on navigation and ignores late results',
    async (kind) => {
      let finish!: (value: ActivityRetentionStatus) => void;
      let signal!: AbortSignal;
      const p = page(async <T,>(_path: string, options?: ApiOptions) => {
        if (kind === 'save' && options?.method !== 'PUT') return off as T;
        signal = options!.signal!;
        return (await new Promise<ActivityRetentionStatus>((resolve) => {
          finish = resolve;
        })) as T;
      });
      if (kind === 'save') {
        await screen.findByText('Automatic cleanup off');
        enable();
        save();
      }
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      p.unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => finish({ ...off, retention_days: 30 }));
      expect(p.notify).not.toHaveBeenCalled();
    },
  );

  it('aborts a save when leaving the Activity tab, preserves its draft, and allows a fresh retry', async () => {
    let finish!: (value: ActivityRetentionStatus) => void;
    let signal!: AbortSignal;
    let attempts = 0;
    const p = page(async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method !== 'PUT') return off as T;
      attempts++;
      if (attempts > 1) return { ...off, retention_days: 30 } as T;
      signal = options.signal!;
      return (await new Promise<ActivityRetentionStatus>((resolve) => {
        finish = resolve;
      })) as T;
    });
    await screen.findByText('Automatic cleanup off');
    enable();
    save();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    p.rerender(<ActivityRetentionPanel {...p.props} active={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ ...off, retention_days: 30 }));
    expect(p.notify).not.toHaveBeenCalled();
    p.rerender(<ActivityRetentionPanel {...p.props} active />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save activity retention' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
    expect(days().value).toBe('30');
    save();
    await waitFor(() => expect(p.notify).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
  });

  it('deduplicates pending saves and prevents refreshing over a mutation', async () => {
    let finish!: (value: ActivityRetentionStatus) => void;
    const p = page(async <T,>(_path: string, options?: ApiOptions) =>
      options?.method === 'PUT'
        ? ((await new Promise<ActivityRetentionStatus>((resolve) => {
            finish = resolve;
          })) as T)
        : (off as T),
    );
    await screen.findByText('Automatic cleanup off');
    enable();
    const form = screen.getByRole('form', { name: 'Activity retention' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(p.api).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Refresh status' })).toHaveProperty('disabled', true);
    await act(async () => finish({ ...off, retention_days: 30 }));
    expect(p.notify).toHaveBeenCalledOnce();
  });

  it('shows aggregate automatic results and hides internal errors and unrelated user details', async () => {
    page(
      async <T,>() =>
        ({
          ...off,
          retention_days: 30,
          last_run_at: '2026-10-17T05:00:00Z',
          last_removed: 100,
          last_kept: 2,
          error: '/private/report-path',
          username: 'PRIVATE_USERNAME',
          job_ids: ['PRIVATE_JOB_ID'],
        }) as T,
    );
    await screen.findByText('Reports cleared: 100');
    expect(screen.getByText('Protected reports kept: 2')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Automatic cleanup could not finish');
    expect(screen.queryByText(/PRIVATE_USERNAME|PRIVATE_JOB_ID|private\/report-path/)).toBeNull();
  });

  it('keeps the demo read-only', async () => {
    const p = page(undefined, { demo: true });
    await screen.findByText('Automatic cleanup off');
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save activity retention' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Activity retention' }));
    expect(p.api).toHaveBeenCalledOnce();
  });

  it('handles StrictMode effect replay and later saves', async () => {
    const notify = vi.fn();
    const api: Api = async <T,>(_path: string, options?: ApiOptions) =>
      ({ ...off, retention_days: options?.method === 'PUT' ? 30 : 0 }) as T;
    render(
      <StrictMode>
        <ActivityRetentionPanel api={api} notify={notify} demo={false} />
      </StrictMode>,
    );
    await screen.findByText('Automatic cleanup off');
    enable();
    save();
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  });
});
