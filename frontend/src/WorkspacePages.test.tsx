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

  it('submits account creation only once while pending and clears the username after success', async () => {
    let finish!: (value: Job) => void;
    const api = vi.fn(
      async () =>
        new Promise<Job>((resolve) => {
          finish = resolve;
        }),
    ) as Api;
    const { created, notify } = page(api);
    const username = screen.getByLabelText('Username') as HTMLInputElement;
    fireEvent.change(username, { target: { value: '  Child  ' } });
    const form = username.closest('form')!;
    fireEvent.submit(form);
    // A repeated form submit must be guarded independently of the disabled button.
    fireEvent.submit(form);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(
      '/api/accounts',
      expect.objectContaining({ body: { username: 'Child', discord_user_id: undefined } }),
    );
    expect(
      (screen.getByRole('button', { name: 'Creating account…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => finish(job));
    expect(created).toHaveBeenCalledExactlyOnceWith(job);
    expect(notify).toHaveBeenCalledExactlyOnceWith('Account creation started.');
    expect(username.value).toBe('');
  });

  it('preserves account input after a failed request and allows one explicit retry', async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic service unavailable.'))
      .mockResolvedValueOnce(job) as Api;
    const { created, notify } = page(api);
    const username = screen.getByLabelText('Username') as HTMLInputElement;
    fireEvent.change(username, { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Synthetic service unavailable.', true),
    );
    expect(created).not.toHaveBeenCalled();
    expect(username.value).toBe('Child');
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith(job));
    expect(api).toHaveBeenCalledTimes(2);
    expect(username.value).toBe('');
  });

  it('rejects whitespace-only account names before sending a request', () => {
    const api = vi.fn() as Api;
    const { created } = page(api);
    const username = screen.getByLabelText('Username');
    fireEvent.change(username, { target: { value: '   ' } });
    fireEvent.submit(username.closest('form')!);
    expect(api).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(username);
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

  it('discards a pending inspection if the account name changes and requires a new inspection', async () => {
    let finish!: (value: Recovery) => void;
    const api = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Promise<Recovery>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({
        username: 'River',
        eligible: false,
        reason: 'No tracked incomplete creation.',
      }) as Api;
    const { created } = page(api);
    const username = screen.getByLabelText('Account to inspect');
    fireEvent.change(username, { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    fireEvent.input(username, { target: { value: 'River' } });
    await act(async () =>
      finish({
        username: 'Child',
        eligible: true,
        target_user_id: 'jf-child',
        reason: 'Tracked incomplete creation.',
      }),
    );
    expect(screen.queryByText('Child · Eligible for recovery')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    await screen.findByText('River · Recovery unavailable');
    expect(api).toHaveBeenLastCalledWith(
      '/api/accounts/recovery?username=River',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
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

  it('deselects only visible migration users and retains hidden selections without mutating the input', () => {
    const selected = new Set(['source-one', 'source-two', 'source-hidden']);
    const select = vi.fn();
    const props = {
      users: {
        emby: [
          { Id: 'source-one', Name: 'CrewOne' },
          { Id: 'source-two', Name: 'CrewTwo' },
          { Id: 'source-hidden', Name: 'Family' },
        ],
        jellyfin: [],
      },
      overview,
      selected,
      select,
      search: '  cReW  ',
      setSearch: vi.fn(),
      preview: vi.fn(),
      useSnapshots: true,
      setUseSnapshots: vi.fn(),
      busy: false,
      navigate: vi.fn(),
    };
    const { rerender } = render(<MigratePage {...props} />);
    const all = screen.getByRole('checkbox', {
      name: 'Select all visible Emby users',
    }) as HTMLInputElement;
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(select).toHaveBeenLastCalledWith(new Set(['source-hidden']));
    expect([...selected]).toEqual(['source-one', 'source-two', 'source-hidden']);
    expect(screen.queryByRole('checkbox', { name: 'Select Family' })).toBeNull();

    rerender(<MigratePage {...props} selected={new Set(['source-one', 'source-hidden'])} />);
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CrewOne' }));
    expect(select).toHaveBeenLastCalledWith(new Set(['source-hidden']));

    rerender(<MigratePage {...props} search="no matches" />);
    expect(screen.getByText('No matching users')).toBeTruthy();
    expect(props.preview).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(select).toHaveBeenLastCalledWith(new Set());
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
