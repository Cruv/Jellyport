// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountsPage } from './WorkspacePages';
import type { Api, ApiOptions, Job, Overview, Recovery, Settings } from './types';

const settings = { default_role_id: 'family-default' } as Settings;
const overview = {
  connections: { jellyfin: { connected: true }, discord: { connected: false } },
} as Overview;
const job = {
  id: 'family-job',
  status: 'queued',
  kind: 'account',
  created_at: '2026-10-08T12:00:00Z',
} as Job;
function page(api: Api) {
  const created = vi.fn();
  const notify = vi.fn();
  return {
    ...render(
      <AccountsPage
        settings={settings}
        overview={overview}
        api={api}
        created={created}
        notify={notify}
        navigate={vi.fn()}
      />,
    ),
    created,
    notify,
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Account page request lifecycle', () => {
  it('ignores a deferred account creation result after navigation away instead of opening a global job', async () => {
    let finish!: (value: Job) => void;
    let signal!: AbortSignal;
    const api = vi.fn(async (_path: string, options?: ApiOptions) => {
      signal = options!.signal!;
      return new Promise<Job>((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, created, notify } = page(api);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(job));
    expect(created).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a deferred recovery result after leaving the page', async () => {
    let finish!: (value: Job) => void;
    const recovery: Recovery = {
      username: 'Child',
      eligible: true,
      target_user_id: 'jf-child',
      reason: 'Tracked incomplete creation.',
    };
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/api/accounts/recovery?')) return recovery;
      return new Promise<Job>((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, created, notify } = page(api);
    fireEvent.change(screen.getByLabelText('Account to inspect'), { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    fireEvent.click(
      await screen.findByLabelText(
        'I inspected this Jellyfin account and approve a new password and account defaults.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recover account' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    unmount();
    await act(async () => finish(job));
    expect(created).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
