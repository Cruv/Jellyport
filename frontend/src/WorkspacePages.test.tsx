// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AccountsPage,
  ActivityPage,
  MigratePage,
  OverviewPage,
  SubscriptionsPage,
} from './WorkspacePages';
import type {
  Api,
  ApiOptions,
  Job,
  Overview,
  Recovery,
  Settings,
  SubscriptionEvent,
} from './types';

const settings = { default_role_id: 'family-default' } as Settings;
const overview = {
  counts: { emby_users: 2, jellyfin_users: 1, jobs: 1 },
  recent_jobs: [],
  connections: {
    emby: { connected: true, configured: true },
    jellyfin: { connected: true, configured: true },
    discord: { connected: false },
  },
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
  it('creates an independent account without requiring a Discord identity', async () => {
    const api = vi.fn(async () => job) as Api;
    const { created } = page(api);
    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(job));
    expect(api).toHaveBeenCalledWith(
      '/api/accounts',
      expect.objectContaining({
        method: 'POST',
        body: { username: 'Child', discord_user_id: undefined },
      }),
    );
  });

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

describe('Workspace navigation and migration controls', () => {
  it('makes the overview task actions direct and keeps server readiness visible', () => {
    const navigate = vi.fn();
    render(
      <OverviewPage overview={overview} navigate={navigate} openJob={vi.fn()} refresh={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(screen.getByText('Servers are ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Create an account/ }));
    expect(navigate).toHaveBeenCalledWith('accounts');
    fireEvent.click(screen.getByRole('button', { name: /Review subscriptions/ }));
    expect(navigate).toHaveBeenCalledWith('subscriptions');
  });

  it('keeps migration review explicit and snapshot controls available beside user selection', () => {
    const preview = vi.fn();
    const navigate = vi.fn();
    const select = vi.fn();
    const setUseSnapshots = vi.fn();
    const props = {
      users: {
        emby: [
          { Id: 'source-one', Name: 'MemberOne' },
          { Id: 'source-two', Name: 'MemberTwo' },
        ],
        jellyfin: [{ Id: 'target-one', Name: 'MemberOne' }],
      },
      overview,
      selected: new Set(['source-two']),
      select,
      search: 'MemberOne',
      setSearch: vi.fn(),
      preview,
      useSnapshots: true,
      setUseSnapshots,
      busy: false,
      navigate,
    };
    const { rerender } = render(<MigratePage {...props} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Migrate users' })).toBeTruthy();
    expect(screen.getByText(/missing or expired snapshots stop the preview/)).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible Emby users' }));
    expect(select).toHaveBeenCalledWith(new Set(['source-two', 'source-one']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use saved Emby snapshot' }));
    expect(setUseSnapshots).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'User mappings' }));
    expect(navigate).toHaveBeenCalledWith('mappings');
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (1)' }));
    expect(preview).toHaveBeenCalledOnce();

    rerender(<MigratePage {...props} busy />);
    expect(
      (screen.getByRole('button', { name: 'Preparing review…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Use saved Emby snapshot' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it('opens the selected operation from the activity table', () => {
    const openJob = vi.fn();
    render(<ActivityPage jobs={[job]} navigate={vi.fn()} openJob={openJob} refresh={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View operation details' }));
    expect(openJob).toHaveBeenCalledWith(job.id);
  });

  it('keeps subscription review and ignore separate and disables both during a request', () => {
    const event: SubscriptionEvent = {
      id: 'subscription-one',
      action: 'subscribe',
      status: 'pending',
      username: 'MemberOne',
      created_at: '2026-10-08T12:00:00Z',
    };
    const review = vi.fn();
    const ignore = vi.fn();
    const props = {
      events: [event],
      navigate: vi.fn(),
      openJob: vi.fn(),
      refresh: vi.fn(),
      review,
      ignore,
      busy: false,
    };
    const { rerender } = render(<SubscriptionsPage {...props} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Subscriptions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(review).toHaveBeenCalledWith(event);
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(ignore).toHaveBeenCalledWith(event);
    rerender(<SubscriptionsPage {...props} busy />);
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Ignore' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
