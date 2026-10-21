// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StripeIntegrationPanel, {
  type StripeIntegrationStatus,
  type StripeSubscriptionReview,
} from './StripeIntegrationPanel';
import type { Api, ApiOptions } from './types';

const initial: StripeIntegrationStatus = {
  configured: false,
  mode: null,
  review_only: true,
  revision: 'revision-1',
  running: false,
  sync_enabled: false,
  last_sync: null,
  last_error: null,
  subscription_count: 0,
  linked_customer_count: 0,
  price_tiers: [],
  hints: [],
};
const connected: StripeIntegrationStatus = {
  ...initial,
  configured: true,
  mode: 'test',
  last_sync: '2026-10-20T01:00:00Z',
  subscription_count: 1,
};
const row: StripeSubscriptionReview = {
  subscription_id: 'sub_synthetic',
  customer_id: 'cus_synthetic',
  customer_name: 'Synthetic member',
  customer_email: 'synthetic@example.test',
  status: 'active',
  collection_method: 'charge_automatically',
  pause_collection: false,
  cancel_at_period_end: true,
  current_period_end: '2026-11-20T01:00:00Z',
  prices: [{ id: 'price_synthetic', product_id: 'prod_synthetic', name: 'Sloop' }],
  proposed_discord_id: '123456789012345678',
  identity_source: 'Checkout metadata',
  linked_discord_id: null,
  linked_discord_username: null,
  tier_id: null,
};
const discordMember = {
  id: '123456789012345678',
  username: 'synthetic.member',
  display_name: 'Synthetic member',
  nickname: null,
  membership_active: false,
};
const tiers = [{ id: 'sloop', name: 'Sloop', plan_name: 'Sloop Plan', account_limit: 1 }];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function page(
  status = initial,
  rows = [row],
  respond?: Api,
  extra: { active?: boolean; demo?: boolean } = {},
) {
  const api = vi.fn(async <T,>(path: string, options?: ApiOptions) => {
    if (respond) return respond<T>(path, options);
    if (path === '/api/stripe/subscriptions')
      return { revision: status.revision, subscriptions: rows } as T;
    if (path.startsWith('/api/discord/members?'))
      return { members: [discordMember], truncated: false } as T;
    return status as T;
  }) as Api;
  const notify = vi.fn();
  const props = { api, notify, demo: false, tiers, ...extra };
  return { ...render(<StripeIntegrationPanel {...props} />), api, notify, props };
}
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const save = () => fireEvent.submit(screen.getByRole('form', { name: 'Stripe connection' }));

describe('Stripe integration settings', () => {
  it('loads only when active, explains exact read permissions, and keeps account automation off', async () => {
    const p = page(initial, [], undefined, { active: false });
    expect(p.api).not.toHaveBeenCalled();
    p.rerender(<StripeIntegrationPanel {...p.props} active />);
    await screen.findByText('Not connected');
    expect(p.api).toHaveBeenCalledOnce();
    expect(p.api).toHaveBeenCalledWith('/api/stripe/status', {
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByRole('button', { name: 'Test & sync Stripe' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Refresh billing every 15 minutes')).toHaveProperty(
      'checked',
      false,
    );
    expect(
      screen.getByText(/Customers, Products, Prices, Subscriptions, and Checkout Sessions/),
    ).toBeTruthy();
    expect(screen.getByText(/Syncing and approving identity links do not create/)).toBeTruthy();
    expect(screen.getByLabelText('Restricted Stripe API key')).toHaveProperty('type', 'password');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('submits a restricted key once, clears the field, and omits a blank replacement', async () => {
    let status = initial;
    const p = page(initial, [], async <T,>(path: string, options?: ApiOptions) => {
      if (path === '/api/stripe/config') status = { ...connected, revision: 'revision-2' };
      return status as T;
    });
    await screen.findByText('Not connected');
    const field = screen.getByLabelText('Restricted Stripe API key') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'rk_test_synthetic_only' } });
    save();
    expect(field.value).toBe('');
    await waitFor(() => expect(p.notify).toHaveBeenCalledOnce());
    expect(p.api).toHaveBeenLastCalledWith(
      '/api/stripe/config',
      expect.objectContaining({
        method: 'POST',
        body: {
          api_key: 'rk_test_synthetic_only',
          sync_enabled: false,
          expected_revision: 'revision-1',
          price_tiers: [],
        },
      }),
    );
    save();
    await waitFor(() => expect(p.notify).toHaveBeenCalledTimes(2));
    expect(p.api).toHaveBeenLastCalledWith(
      '/api/stripe/config',
      expect.objectContaining({
        body: { sync_enabled: false, expected_revision: 'revision-2', price_tiers: [] },
      }),
    );
    expect(document.body.textContent).not.toContain('rk_test_synthetic_only');
  });

  it('rejects full-access keys locally and clears an unsaved key when leaving the panel', async () => {
    const p = page();
    await screen.findByText('Not connected');
    const field = screen.getByLabelText('Restricted Stripe API key') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'sk_test_synthetic_only' } });
    save();
    expect(field.value).toBe('');
    expect(screen.getByRole('alert').textContent).toContain('Use a restricted Stripe key');
    expect(p.api).toHaveBeenCalledOnce();
    fireEvent.change(field, { target: { value: 'rk_test_unsaved_synthetic_only' } });
    p.rerender(<StripeIntegrationPanel {...p.props} active={false} />);
    expect(field.value).toBe('');
  });

  it('starts one background sync and polls status without posting another sync', async () => {
    let running = false;
    const p = page(connected, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/sync') running = true;
      return { ...connected, running } as T;
    });
    await screen.findByText('Test restricted key saved');
    vi.useFakeTimers();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Test & sync Stripe' })),
    );
    expect(screen.getByText('Reading Stripe subscriptions…')).toBeTruthy();
    expect(p.api).toHaveBeenCalledWith(
      '/api/stripe/sync',
      expect.objectContaining({ method: 'POST', body: {} }),
    );
    expect(p.notify).toHaveBeenCalledWith(
      'Stripe sync started. No media accounts will be changed.',
    );
    expect(screen.getByRole('button', { name: 'Test & sync Stripe' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === '/api/stripe/status',
      ),
    ).toHaveLength(2);
    p.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === '/api/stripe/status',
      ),
    ).toHaveLength(2);
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === '/api/stripe/sync',
      ),
    ).toHaveLength(1);
  });

  it('requires a reviewed disconnect and clears the key, customer rows, and sync draft', async () => {
    let status = { ...connected, sync_enabled: true };
    const p = page(status, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/subscriptions')
        return { revision: status.revision, subscriptions: status.configured ? [row] : [] } as T;
      if (path === '/api/stripe/disconnect') status = { ...initial, revision: 'revision-2' };
      return status as T;
    });
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    await screen.findByRole('button', { name: 'Review Discord link' });
    tab('Connection');
    const key = screen.getByLabelText(/Restricted Stripe API key/) as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'rk_test_unsaved_synthetic_only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Stripe…' }));
    expect(screen.getByRole('dialog', { name: 'Disconnect Stripe?' })).toBeTruthy();
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.every(
        ([path]) => path !== '/api/stripe/disconnect',
      ),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect and clear billing data' }));
    await screen.findByText('Not connected');
    expect(p.api).toHaveBeenCalledWith(
      '/api/stripe/disconnect',
      expect.objectContaining({ method: 'POST', body: { expected_revision: 'revision-1' } }),
    );
    expect(p.notify).toHaveBeenCalledWith(
      'Stripe disconnected. Saved billing data and identity links cleared.',
    );
    expect(key.value).toBe('');
    expect(screen.getByLabelText('Refresh billing every 15 minutes')).toHaveProperty(
      'checked',
      false,
    );
    expect(document.body.textContent).not.toContain('synthetic@example.test');
    expect(screen.queryByRole('dialog')).toBeNull();
    tab('Review links');
    expect(screen.queryByRole('button', { name: 'Review Discord link' })).toBeNull();
    expect(screen.getByText('Save a restricted key and run a sync first.')).toBeTruthy();
  });

  it('bounds a large subscription directory and resets pagination when searching or filtering', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      ...row,
      customer_name: `Synthetic member ${index}`,
      subscription_id: `sub_synthetic_${index}`,
      customer_id: `cus_synthetic_${index}`,
    }));
    page({ ...connected, subscription_count: rows.length }, rows);
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    await screen.findByText('1–5 of 26');
    expect(screen.getAllByRole('article')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('6–10 of 26')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search subscriptions'), {
      target: { value: 'member 25' },
    });
    expect(screen.getByText('1–1 of 1')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Identity links'), { target: { value: 'linked' } });
    expect(screen.getByText('No subscriptions match this view.')).toBeTruthy();
  });

  it('requires a selected current Discord member and explicit approval before linking', async () => {
    const p = page(connected);
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    await screen.findByRole('button', { name: 'Review Discord link' });
    expect(screen.getByText('Discord candidate available')).toBeTruthy();
    expect(screen.queryByText(/Unconfirmed Discord candidate:/)).toBeNull();
    expect(screen.queryByText(/Current billing period ends:/)).toBeNull();
    expect(within(screen.getByRole('article')).queryByText(row.proposed_discord_id!)).toBeNull();
    expect(within(screen.getByRole('article')).queryByText('Stripe record identifiers')).toBeNull();
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.every(([, options]) => !options?.method),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Review Discord link' }));
    expect(screen.getByRole('dialog', { name: 'Approve Discord identity' })).toHaveProperty(
      'ariaModal',
      'true',
    );
    expect(
      within(screen.getByRole('dialog', { name: 'Approve Discord identity' })).getByText(
        /Unconfirmed Discord candidate:/,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('dialog', { name: 'Approve Discord identity' })).getByText(
        /Current billing period ends:/,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('dialog', { name: 'Approve Discord identity' })).getByText(
        'Stripe record identifiers',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve customer link' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(screen.getByLabelText('Discord member'), {
      target: { value: 'synthetic.member' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @synthetic.member' }));
    expect(screen.getByText('Membership is not currently active.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve customer link' }));
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith(
        'Stripe customer linked to the selected Discord member.',
      ),
    );
    expect(p.api).toHaveBeenCalledWith(
      '/api/stripe/links',
      expect.objectContaining({
        method: 'POST',
        body: {
          customer_id: row.customer_id,
          discord_user_id: discordMember.id,
          expected_revision: 'revision-1',
        },
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Approve Discord identity' })).toBeNull();
  });

  it('shows safe link failures inside the review dialog and hides it on navigation', async () => {
    const p = page(connected, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/subscriptions')
        return { revision: connected.revision, subscriptions: [row] } as T;
      if (path.startsWith('/api/discord/members?'))
        return { members: [discordMember], truncated: false } as T;
      if (path === '/api/stripe/links') throw new Error('PRIVATE_LINK_RESPONSE');
      return connected as T;
    });
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    fireEvent.click(await screen.findByRole('button', { name: 'Review Discord link' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve Discord identity' });
    fireEvent.change(within(dialog).getByLabelText('Discord member'), {
      target: { value: 'synthetic.member' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Select @synthetic.member' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve customer link' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The Stripe action could not be completed.');
    expect(document.body.textContent).not.toContain('PRIVATE_LINK_RESPONSE');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    p.rerender(<StripeIntegrationPanel {...p.props} active={false} />);
    expect(screen.queryByRole('dialog', { name: 'Approve Discord identity' })).toBeNull();
  });

  it('resolves a metadata candidate without manual Discord ID entry and still requires approval', async () => {
    const p = page(connected, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/subscriptions')
        return { revision: connected.revision, subscriptions: [row] } as T;
      if (path === '/api/stripe/resolve-candidate')
        return { member: { ...discordMember, membership_active: null } } as T;
      return connected as T;
    });
    await screen.findByText('Test restricted key saved');
    expect(screen.getByText(/Replacing the key clears cached billing data/)).toBeTruthy();
    tab('Review links');
    fireEvent.click(await screen.findByRole('button', { name: 'Review Discord link' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve Discord identity' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Find suggested Discord member' }));
    await within(dialog).findByText('@synthetic.member');
    expect(p.api).toHaveBeenCalledWith(
      '/api/stripe/resolve-candidate',
      expect.objectContaining({
        method: 'POST',
        body: { customer_id: row.customer_id, expected_revision: connected.revision },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(within(dialog).getByRole('button', { name: 'Approve customer link' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(within(dialog).getByText(/Subscription ownership remains unconfirmed/)).toBeTruthy();
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.some(
        ([path]) => path === '/api/stripe/links' || path.startsWith('/api/discord/members?'),
      ),
    ).toBe(false);
    expect(p.notify).toHaveBeenCalledWith(
      'Suggested Discord member found. Confirm ownership before approving the link.',
    );
  });

  it.each(['failed', 'unexpected'] as const)(
    'keeps a %s candidate resolution unselected and never approves it',
    async (mode) => {
      const p = page(connected, [row], async <T,>(path: string) => {
        if (path === '/api/stripe/subscriptions')
          return { revision: connected.revision, subscriptions: [row] } as T;
        if (path === '/api/stripe/resolve-candidate') {
          if (mode === 'failed') throw new Error('PRIVATE_CANDIDATE_RESPONSE');
          return { member: { ...discordMember, id: '223456789012345678' } } as T;
        }
        return connected as T;
      });
      await screen.findByText('Test restricted key saved');
      tab('Review links');
      fireEvent.click(await screen.findByRole('button', { name: 'Review Discord link' }));
      const dialog = screen.getByRole('dialog', { name: 'Approve Discord identity' });
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Find suggested Discord member' }),
      );
      expect((await within(dialog).findByRole('alert')).textContent).toContain(
        'The suggested Discord member could not be resolved.',
      );
      expect(within(dialog).queryByText('@synthetic.member')).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Approve customer link' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(document.body.textContent).not.toContain('PRIVATE_CANDIDATE_RESPONSE');
      expect(
        (p.api as ReturnType<typeof vi.fn>).mock.calls.some(
          ([path]) => path === '/api/stripe/links',
        ),
      ).toBe(false);
    },
  );

  it('aborts candidate lookup and ignores its result after leaving and reopening the review', async () => {
    let finish!: (value: { member: typeof discordMember }) => void;
    let signal!: AbortSignal;
    const p = page(connected, [row], async <T,>(path: string, options?: ApiOptions) => {
      if (path === '/api/stripe/subscriptions')
        return { revision: connected.revision, subscriptions: [row] } as T;
      if (path === '/api/stripe/resolve-candidate') {
        signal = options!.signal!;
        return new Promise<{ member: typeof discordMember }>((resolve) => {
          finish = resolve;
        }) as Promise<T>;
      }
      return connected as T;
    });
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    fireEvent.click(await screen.findByRole('button', { name: 'Review Discord link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find suggested Discord member' }));
    expect(signal.aborted).toBe(false);
    p.rerender(<StripeIntegrationPanel {...p.props} active={false} />);
    expect(signal.aborted).toBe(true);
    p.rerender(<StripeIntegrationPanel {...p.props} active />);
    await act(async () => finish({ member: discordMember }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Find suggested Discord member' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    const dialog = screen.getByRole('dialog', { name: 'Approve Discord identity' });
    expect(within(dialog).queryByText('@synthetic.member')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Approve customer link' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.some(([path]) => path === '/api/stripe/links'),
    ).toBe(false);
    expect(p.notify).not.toHaveBeenCalled();
  });

  it('does not silently approve a stale review or overwrite a draft after a refresh', async () => {
    let revision = 'revision-1';
    page(connected, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/subscriptions') return { revision, subscriptions: [row] } as T;
      return { ...connected, revision } as T;
    });
    await screen.findByText('Test restricted key saved');
    fireEvent.click(screen.getByLabelText('Refresh billing every 15 minutes'));
    tab('Review links');
    await screen.findByRole('button', { name: 'Review Discord link' });
    fireEvent.click(screen.getByRole('button', { name: 'Review Discord link' }));
    revision = 'revision-2';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText(/Billing data changed during this review/);
    expect(screen.getByRole('button', { name: 'Approve customer link' })).toHaveProperty(
      'disabled',
      true,
    );
    tab('Connection');
    expect(screen.getByLabelText('Refresh billing every 15 minutes')).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft to saved Stripe settings' }));
    expect(screen.getByLabelText('Refresh billing every 15 minutes')).toHaveProperty(
      'checked',
      false,
    );
  });

  it('freezes the subscription-list revision rather than a newer status response', async () => {
    const p = page(connected, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/subscriptions')
        return {
          revision: 'older-list-revision',
          subscriptions: [{ ...row, pause_collection: true, collection_method: 'send_invoice' }],
        } as T;
      return { ...connected, revision: 'newer-status-revision' } as T;
    });
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    fireEvent.click(await screen.findByRole('button', { name: 'Review Discord link' }));
    expect(screen.getByText(/Payment collection paused/)).toBeTruthy();
    expect(screen.getByText(/Invoice billing/)).toBeTruthy();
    expect(screen.getByText(/Billing data changed during this review/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve customer link' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.every(([, options]) => !options?.method),
    ).toBe(true);
  });

  it('hides raw failures, does not loop failed reads, and allows a manual retry', async () => {
    let fail = true;
    const p = page(connected, [row], async <T,>(path: string) => {
      if (path === '/api/stripe/subscriptions') {
        if (fail) throw new Error('PRIVATE_KEY_OR_CUSTOMER_DETAIL');
        return { revision: connected.revision, subscriptions: [row] } as T;
      }
      return connected as T;
    });
    await screen.findByText('Test restricted key saved');
    tab('Review links');
    await screen.findByRole('alert');
    const count = (p.api as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(p.api).toHaveBeenCalledTimes(count);
    expect(document.body.textContent).not.toContain('PRIVATE_KEY_OR_CUSTOMER_DETAIL');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByRole('button', { name: 'Review Discord link' });
  });

  it('aborts outstanding work and ignores late results after navigation', async () => {
    let finish!: (status: StripeIntegrationStatus) => void;
    let signal!: AbortSignal;
    const p = page(initial, [], async <T,>(_path: string, options?: ApiOptions) => {
      signal = options!.signal!;
      return new Promise<StripeIntegrationStatus>((resolve) => {
        finish = resolve;
      }) as Promise<T>;
    });
    expect(signal.aborted).toBe(false);
    p.rerender(<StripeIntegrationPanel {...p.props} active={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(connected));
    expect(screen.queryByText('Test restricted key saved')).toBeNull();
    expect(p.notify).not.toHaveBeenCalled();
  });

  it('documents the supported trusted MEE6 identity message without claiming a Stripe match', async () => {
    page();
    await screen.findByText('Not connected');
    tab('MEE6 identity hints');
    expect(screen.getByText('JELLYPORT_IDENTITY_V1 discord={user.id}')).toBeTruthy();
    expect(screen.getByText(/A role announcement cannot identify a Stripe customer/)).toBeTruthy();
    expect(screen.getByText(/actual announcing bot’s ID/)).toBeTruthy();
  });
});
