// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { JobProgressDetails, JobsTable } from './components';
import type { Job, JobProgress } from './types';

const running: Job = {
  id: 'bulk-migration',
  kind: 'migrate',
  status: 'running',
  created_at: '2026-10-08T12:00:00Z',
  started_at: '2026-10-08T12:01:00Z',
  updated_at: '2026-10-08T12:01:00Z',
  progress: { processed: 12, total: 100 },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Migration item progress and timing', () => {
  it('labels watched-only item progress without claiming favorites are being migrated', () => {
    render(
      <JobProgressDetails
        job={{
          ...running,
          migration_scope: 'watched_only',
          progress: {
            processed: 0,
            total: 1,
            current_user: 'alex',
            phase: 'transferring_history',
            items_processed: 20,
            items_total: 100,
            items_updated: 10,
          },
        }}
      />,
    );
    expect(screen.getByText(/Migrating watched status/)).toBeTruthy();
    expect(screen.queryByText(/Migrating watch history and favorites/)).toBeNull();
    expect(screen.getByText('20 of 100 matched items checked · 10 updated')).toBeTruthy();
  });
  it('separates account progress from checked and updated history items', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:19:24Z'));
    render(
      <JobProgressDetails
        job={{
          ...running,
          progress: {
            processed: 12,
            total: 100,
            current_user: 'alex',
            phase: 'transferring_history',
            items_processed: 8320,
            items_total: 14510,
            items_updated: 1804,
          },
        }}
      />,
    );
    expect(screen.getByText('12 of 100 accounts processed')).toBeTruthy();
    expect(screen.getByText('Elapsed 18m 24s')).toBeTruthy();
    expect(screen.getByText('8,320 of 14,510 matched items checked · 1,804 updated')).toBeTruthy();
    expect(screen.getByText('alex ·')).toBeTruthy();
    expect(screen.getByText(/Migrating watch history and favorites/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Operation progress' })).toHaveProperty(
      'value',
      12,
    );
    expect(screen.getByRole('progressbar', { name: 'History item progress' })).toHaveProperty(
      'value',
      8320,
    );
    expect(screen.getByRole('progressbar', { name: 'History item progress' })).toHaveProperty(
      'max',
      14510,
    );
  });

  it.each([
    ['reading_source', 'Reading Emby library'],
    ['preparing_account', 'Preparing Jellyfin account'],
    ['reading_target', 'Reading Jellyfin library'],
    ['transferring_history', 'Migrating watch history and favorites'],
    ['transferring_playlists', 'Migrating playlists'],
    ['delivering_credentials', 'Delivering account credentials'],
  ] as Array<[NonNullable<JobProgress['phase']>, string]>)(
    'uses a clear label for %s without inventing item totals',
    (phase, label) => {
      render(
        <JobProgressDetails
          job={{
            ...running,
            progress: { processed: 0, total: 1, current_user: '<script>alex()</script>', phase },
          }}
        />,
      );
      expect(screen.getByText(label, { exact: false })).toBeTruthy();
      expect(screen.queryByRole('progressbar', { name: 'History item progress' })).toBeNull();
      expect(screen.queryByText(/items checked/)).toBeNull();
      expect(document.querySelector('script')).toBeNull();
    },
  );

  it('advances checked-item progress even when no additional writes were needed', () => {
    const view = render(
      <JobProgressDetails
        job={{
          ...running,
          progress: {
            processed: 0,
            total: 1,
            phase: 'transferring_history',
            items_processed: 10,
            items_total: 100,
            items_updated: 2,
          },
        }}
      />,
    );
    view.rerender(
      <JobProgressDetails
        job={{
          ...running,
          progress: {
            processed: 0,
            total: 1,
            phase: 'transferring_history',
            items_processed: 80,
            items_total: 100,
            items_updated: 2,
          },
        }}
      />,
    );
    expect(screen.getByText('80 of 100 matched items checked · 2 updated')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'History item progress' })).toHaveProperty(
      'value',
      80,
    );
    expect(screen.getByRole('progressbar', { name: 'Operation progress' })).toHaveProperty(
      'value',
      0,
    );
  });

  it('advances elapsed time on render during a long library read without a new checkpoint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:01:05Z'));
    const view = render(<JobProgressDetails job={running} />);
    expect(screen.getByText('Elapsed 5s')).toBeTruthy();
    vi.setSystemTime(new Date('2026-10-08T12:02:05Z'));
    view.rerender(<JobProgressDetails job={running} />);
    expect(screen.getByText('Elapsed 1m 5s')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('freezes completed elapsed time at finished_at instead of a later checkpoint or wall clock', () => {
    render(
      <JobProgressDetails
        job={{
          ...running,
          status: 'completed',
          finished_at: '2026-10-08T13:03:04Z',
          updated_at: '2026-10-08T15:00:00Z',
          progress: { processed: 100, total: 100 },
        }}
      />,
    );
    expect(screen.getByText('Elapsed 1h 2m 4s')).toBeTruthy();
    expect(screen.getByText('100 of 100 accounts processed')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('uses the terminal checkpoint when a historical job has no finished_at', () => {
    render(
      <JobProgressDetails
        job={{ ...running, status: 'interrupted', updated_at: '2026-10-08T12:01:40Z' }}
      />,
    );
    expect(screen.getByText('Elapsed 40s')).toBeTruthy();
  });

  it('clamps clock skew and omits invalid timing instead of showing negative or NaN elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const view = render(<JobProgressDetails job={running} />);
    expect(screen.getByText('Elapsed 0s')).toBeTruthy();
    view.rerender(<JobProgressDetails job={{ ...running, started_at: 'invalid' }} />);
    expect(screen.queryByText(/Elapsed/)).toBeNull();
  });

  it('keeps older jobs usable when item progress and timing fields are absent', () => {
    render(
      <JobProgressDetails
        job={{
          id: 'legacy',
          kind: 'create',
          status: 'running',
          created_at: running.created_at,
          progress: 45,
        }}
      />,
    );
    expect(
      screen.getByText('The operation is running. Progress updates automatically.'),
    ).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Operation progress' })).toHaveProperty(
      'value',
      45,
    );
    expect(screen.queryByText(/Elapsed/)).toBeNull();
    expect(screen.queryByText(/items checked/)).toBeNull();
  });

  it('counts processed accounts in Activity instead of treating a running result as complete', () => {
    render(
      <JobsTable
        jobs={[
          {
            ...running,
            progress: { processed: 1, total: 100 },
            results: [
              { username: 'done', status: 'completed' },
              { username: 'in-progress', status: 'running' },
            ],
          },
          {
            id: 'legacy',
            kind: 'create',
            status: 'completed',
            created_at: running.created_at,
            results: [{ username: 'older', status: 'completed' }],
          },
        ]}
        openJob={() => {}}
        migrate={() => {}}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByRole('cell', { name: '1 / 100' })).toBeTruthy();
    expect(within(rows[2]).getByRole('cell', { name: '1' })).toBeTruthy();
  });
});
