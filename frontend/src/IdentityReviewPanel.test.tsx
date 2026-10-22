// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import IdentityReviewPanel, { StripeIdentityAccountReview } from './IdentityReviewPanel';
import type {
  IdentityReviewApplyResult,
  IdentityReviewRow,
  IdentityReviewSnapshot,
} from '../../server/identity-review-types';
import type { Api, ApiOptions } from './types';

const source = { available: true, complete: true, updated_at: '2026-10-22T01:00:00Z' };
function directory(count = 1): IdentityReviewSnapshot {
  const rows: IdentityReviewRow[] = Array.from({ length: count }, (_, index) => {
    const account = {
      kind: 'emby' as const,
      id: `emby_synthetic_${index}`,
      name: `synthetic.member${index}`,
      disabled: false,
      family: false,
      administrator: false,
      owner_discord_id: null,
      slot: null,
    };
    return {
      id: `member:${index}`,
      member: {
        id: `${123456789012340000n + BigInt(index)}`,
        username: `synthetic.member${index}`,
        roles: [],
      },
      member_candidates: [],
      customers: [
        {
          id: `cus_synthetic${index}`,
          name: `Synthetic customer ${index}`,
          email: `synthetic${index}@example.test`,
          linked_discord_id: null,
          proposed_discord_id: null,
          statuses: ['active'],
          tier_id: 'sloop',
          active_subscription: true,
        },
      ],
      confirmed_accounts: [],
      suggestions: [{ account, reason: 'Unique exact Discord username', reliable: true }],
      gaps: ['active_subscription_no_media'],
      exception: null,
      reliable: true,
      conflict: null,
    };
  });
  return {
    revision: 'directory-revision-1',
    generated_at: '2026-10-22T01:00:00Z',
    expires_at: '2026-10-22T01:05:00Z',
    sources: { discord: source, emby: source, jellyfin: source, stripe: source },
    rows,
    accounts: rows.flatMap((row) => row.suggestions.map(({ account }) => account)),
    summary: {
      members: count,
      unlinked_accounts: count,
      suggestions: count,
      gaps: count,
      acknowledged: 0,
    },
  };
}
const saved: IdentityReviewApplyResult = {
  approved: 1,
  roles: { status: 'updated', updated: 1, failed: 0 },
  warnings: [],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function page(
  value = directory(),
  extra: {
    active?: boolean;
    demo?: boolean;
    tasks?: Array<IdentityReviewApplyResult['roles'] & { task_id: string; created_at: string }>;
  } = {},
  respond?: Api,
) {
  const api = vi.fn(async <T,>(path: string, options?: ApiOptions) => {
    if (path === '/api/identity-review/roles') return { tasks: extra.tasks || [] } as T;
    if (respond) return respond<T>(path, options);
    return (path === '/api/identity-review/apply' ? saved : value) as T;
  }) as Api;
  const notify = vi.fn();
  const props = { api, notify, demo: false, ...extra };
  return { ...render(<IdentityReviewPanel {...props} />), api, notify, props };
}
const calls = (api: Api, path: string) =>
  (api as ReturnType<typeof vi.fn>).mock.calls.filter(([value]) => value === path);
async function openFirst() {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Review associations' }))[0]);
  return screen.getByRole('dialog');
}

describe('reviewed identity matching and access gaps', () => {
  it('reads only while active, never posts on load, and stores no private directory drafts', async () => {
    const p = page(directory(), { active: false });
    expect(p.api).not.toHaveBeenCalled();
    p.rerender(<IdentityReviewPanel {...p.props} active />);
    await screen.findByText('@synthetic.member0');
    expect(p.api).toHaveBeenCalledTimes(2);
    expect(p.api).toHaveBeenCalledWith('/api/identity-review', { signal: expect.any(AbortSignal) });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('lets an administrator explicitly approve 227 exact matches in one bounded, paginated review', async () => {
    const value = directory(227);
    const p = page(value);
    await screen.findByText('1–25 of 227');
    expect(screen.getAllByRole('article')).toHaveLength(25);
    fireEvent.click(
      screen.getByRole('button', { name: 'Select all reliable matches (up to 250)' }),
    );
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review 227 selected identities' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve selected identity links?' });
    expect(within(dialog).getByText('1–10 of 227')).toBeTruthy();
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(10);
    expect(within(dialog).getByText(/Emby-only members stay Emby-only/)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve 227 identities & update roles' }),
    );
    await waitFor(() => expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1));
    const request = calls(p.api, '/api/identity-review/apply')[0][1]!.body;
    expect(request.revision).toBe('directory-revision-1');
    expect(request.selections).toHaveLength(227);
    expect(request.selections[0]).toEqual({
      row_id: value.rows[0].id,
      discord_user_id: value.rows[0].member!.id,
      stripe_customer_ids: ['cus_synthetic0'],
      accounts: [{ kind: 'emby', id: 'emby_synthetic_0', slot: 1 }],
    });
    expect(
      request.selections.every((item: { accounts: { kind: string }[] }) =>
        item.accounts.every((account) => account.kind === 'emby'),
      ),
    ).toBe(true);
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.every(
        ([path]) => !/migrat|\/memberships\/apply|\/users\/create/.test(path),
      ),
    ).toBe(true);
  });

  it('clears hidden selections when filtering and excludes ambiguous suggestions from bulk approval', async () => {
    const value = directory(26);
    value.rows[0].reliable = false;
    value.rows[0].conflict = 'More than one possible owner.';
    const p = page(value);
    await screen.findByText('1–25 of 26');
    expect(screen.queryByLabelText('Select suggested links for @synthetic.member0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select reliable matches on this page' }));
    expect(screen.getByRole('button', { name: 'Review 24 selected identities' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.change(screen.getByLabelText('Find people or accounts'), {
      target: { value: 'synthetic.member25' },
    });
    expect(screen.getByText('1–1 of 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review 0 selected identities' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(0);
  });

  it('reconciles an existing Stripe identity with only Emby and updates roles without requiring Jellyfin', async () => {
    const value = directory();
    value.rows[0].customers[0].linked_discord_id = value.rows[0].member!.id;
    const p = page(value);
    const dialog = await openFirst();
    expect(within(dialog).getByLabelText('Emby · synthetic.member0')).toHaveProperty(
      'checked',
      true,
    );
    expect(
      within(dialog).getByText(/Leave Jellyfin unselected for Emby-only members/),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith(
        '1 identity approved. Discord organization roles updated.',
        false,
      ),
    );
    expect(calls(p.api, '/api/identity-review/apply')[0][1]!.body.selections[0].accounts).toEqual([
      { kind: 'emby', id: 'emby_synthetic_0', slot: 1 },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('includes Discord-only people and records an exception with a private note without granting access', async () => {
    const value = directory();
    value.rows[0] = {
      ...value.rows[0],
      customers: [],
      suggestions: [],
      gaps: ['discord_without_media', 'discord_without_active_subscription'],
      reliable: false,
    };
    const p = page(value);
    await screen.findByText('@synthetic.member0');
    fireEvent.change(screen.getByLabelText('Review view'), { target: { value: 'discord-only' } });
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText('Gap review exception'), {
      target: { value: 'non_media' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    expect(within(dialog).getByRole('alert').textContent).toContain('Add a private note');
    fireEvent.change(within(dialog).getByLabelText('Private approval note'), {
      target: { value: 'Approved community-only access.' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    await waitFor(() => expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1));
    expect(calls(p.api, '/api/identity-review/apply')[0][1]!.body.selections[0]).toEqual({
      row_id: value.rows[0].id,
      discord_user_id: value.rows[0].member!.id,
      stripe_customer_ids: [],
      accounts: [],
      exception: { kind: 'non_media', note: 'Approved community-only access.' },
    });
  });

  it('can annotate an account with no Discord owner without inventing membership or ownership', async () => {
    const value = directory();
    value.rows[0] = { ...value.rows[0], member: null, customers: [], reliable: false };
    value.rows[0].suggestions[0].reliable = false;
    const p = page(value);
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText('Gap review exception'), {
      target: { value: 'complimentary' },
    });
    fireEvent.change(within(dialog).getByLabelText('Private approval note'), {
      target: { value: 'Family account managed by the administrator.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save review annotation' }));
    await waitFor(() => expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1));
    const selection = calls(p.api, '/api/identity-review/apply')[0][1]!.body.selections[0];
    expect(selection.discord_user_id).toBe('');
    expect(selection.accounts).toEqual([]);
    expect(selection.stripe_customer_ids).toEqual([]);
    expect(selection).not.toHaveProperty('family');
  });

  it('adds an optional existing Jellyfin account manually and keeps account slots separate', async () => {
    const value = directory();
    value.accounts.push({
      ...value.accounts[0],
      kind: 'jellyfin',
      id: 'jf_other',
      name: 'simplified_name',
      slot: null,
    });
    const p = page(value);
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText('Available account'), {
      target: { value: 'jellyfin:jf_other' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account to review' }));
    expect(within(dialog).getByLabelText('Jellyfin · simplified_name')).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    await waitFor(() => expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1));
    expect(
      calls(p.api, '/api/identity-review/apply')[0][1]!.body.selections[0].accounts,
    ).toHaveLength(2);
  });

  it('warns about incomplete data and keeps saved links distinct from failed role updates', async () => {
    const value = directory();
    value.sources.stripe = { available: false, complete: false, updated_at: null };
    const p = page(
      value,
      {},
      async <T,>(path: string) =>
        (path === '/api/identity-review/apply'
          ? {
              ...saved,
              roles: { status: 'failed', updated: 0, failed: 1 },
              warnings: ['Organization role update could not finish.'],
            }
          : value) as T,
    );
    await screen.findByText(/Missing records are not evidence/);
    const dialog = await openFirst();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    await screen.findByText('Organization role update could not finish.');
    expect(p.notify).toHaveBeenCalledWith(
      expect.stringContaining('Discord role updates need attention'),
      true,
    );
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
  });

  it('does not replay an uncertain or stale approval, exposes no raw errors, and needs refresh before retry', async () => {
    const value = directory();
    const p = page(value, {}, async <T,>(path: string) => {
      if (path === '/api/identity-review/apply') throw new Error('PRIVATE_STRIPE_DATA');
      return value as T;
    });
    const dialog = await openFirst();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    await screen.findByText(/Approval could not be confirmed/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE_STRIPE_DATA');
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh directory' }));
    await screen.findByText('@synthetic.member0');
    expect(calls(p.api, '/api/identity-review/refresh')[0][1]!.method).toBe('POST');
  });

  it('aborts reads and ignores late private responses when leaving the screen', async () => {
    let finish!: (value: IdentityReviewSnapshot) => void;
    let signal!: AbortSignal;
    const p = page(directory(), {}, async <T,>(_path: string, options?: ApiOptions) => {
      signal = options!.signal!;
      return new Promise<IdentityReviewSnapshot>((resolve) => {
        finish = resolve;
      }) as Promise<T>;
    });
    p.rerender(<IdentityReviewPanel {...p.props} active={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(directory()));
    expect(screen.queryByText('@synthetic.member0')).toBeNull();
    expect(p.notify).not.toHaveBeenCalled();
  });

  it('the inline Stripe flow offers media confirmation for an already-approved customer link', async () => {
    const value = directory();
    value.rows[0].customers[0].linked_discord_id = value.rows[0].member!.id;
    const api = vi.fn(
      async <T,>(path: string) => (path === '/api/identity-review/apply' ? saved : value) as T,
    ) as Api;
    const onApplied = vi.fn();
    render(
      <StripeIdentityAccountReview
        api={api}
        notify={vi.fn()}
        demo={false}
        customerId="cus_synthetic0"
        member={{
          id: value.rows[0].member!.id,
          username: 'synthetic.member0',
          display_name: null,
          nickname: null,
          membership_active: null,
        }}
        onApplied={onApplied}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('Link existing accounts; Jellyfin is optional');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve identity & update roles' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(
      calls(api, '/api/identity-review/apply')[0][1]!.body.selections[0].stripe_customer_ids,
    ).toEqual(['cus_synthetic0']);
  });

  it('cancels a bulk review without saving and rejects duplicate same-server slots locally', async () => {
    const value = directory();
    value.accounts.push({ ...value.accounts[0], id: 'emby_second', name: 'different_media_name' });
    const p = page(value);
    await screen.findByText('@synthetic.member0');
    fireEvent.click(screen.getByRole('button', { name: 'Select reliable matches on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected identity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel bulk review' }));
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(0);
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText('Available account'), {
      target: { value: 'emby:emby_second' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account to review' }));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    expect(within(dialog).getByRole('alert').textContent).toContain('different slot');
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(0);
  });

  it('cannot bulk-select occupied slots or a row with contradictory ownership', async () => {
    const value = directory();
    value.rows[0].confirmed_accounts.push({
      ...value.accounts[0],
      id: 'already_owned',
      name: 'existing_name',
      owner_discord_id: value.rows[0].member!.id,
      slot: 1,
    });
    value.accounts.push(value.rows[0].confirmed_accounts[0]);
    const p = page(value);
    await screen.findByText('@synthetic.member0');
    expect(
      screen.queryByRole('button', { name: 'Select all reliable matches (up to 250)' }),
    ).toBeNull();
    expect(screen.queryByLabelText('Select suggested links for @synthetic.member0')).toBeNull();
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(0);
  });

  it('preserves previously confirmed accounts and hides conflicting accounts from manual selection', async () => {
    const value = directory();
    value.rows[0].confirmed_accounts = [
      { ...value.accounts[0], owner_discord_id: value.rows[0].member!.id, slot: 1 },
    ];
    value.rows[0].suggestions = [];
    value.accounts.push({
      ...value.accounts[0],
      id: 'conflicted',
      name: 'conflicting_name',
      ownership_conflict: true,
    });
    page(value);
    const dialog = await openFirst();
    expect(
      within(dialog).getByLabelText('Emby · synthetic.member0 · Already confirmed'),
    ).toHaveProperty('disabled', true);
    expect(within(dialog).queryByRole('option', { name: 'Emby · conflicting_name' })).toBeNull();
  });

  it('clears a standalone exception without making a Discord owner mandatory or changing access', async () => {
    const value = directory();
    value.rows[0] = {
      ...value.rows[0],
      member: null,
      customers: [],
      suggestions: [],
      exception: {
        kind: 'approved',
        note: 'Reviewed synthetic exception.',
        approved_at: '2026-10-22T01:00:00Z',
      },
    };
    const p = page(value);
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText('Gap review exception'), {
      target: { value: 'none' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save review annotation' }));
    await waitFor(() => expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1));
    expect(calls(p.api, '/api/identity-review/apply')[0][1]!.body.selections[0]).toEqual({
      row_id: value.rows[0].id,
      discord_user_id: '',
      stripe_customer_ids: [],
      accounts: [],
      exception: null,
    });
  });

  it('shows annotation-only completion without claiming that it synchronized Discord roles', async () => {
    const value = directory();
    value.rows[0].customers = [];
    value.rows[0].suggestions = [];
    const p = page(
      value,
      {},
      async <T,>(path: string) =>
        (path === '/api/identity-review/apply'
          ? { ...saved, roles: { status: 'not_requested', updated: 0, failed: 0 } }
          : value) as T,
    );
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText('Gap review exception'), {
      target: { value: 'non_media' },
    });
    fireEvent.change(within(dialog).getByLabelText('Private approval note'), {
      target: { value: 'Approved community access.' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
    );
    await screen.findByText('Review annotation saved; account access and Discord roles unchanged.');
    expect(p.notify).toHaveBeenCalledWith(
      'Review annotation saved; account access and Discord roles unchanged.',
      false,
    );
  });

  it('polls a queued durable role job to completion without replaying identity approval', async () => {
    const value = directory();
    let polls = 0;
    const queued: IdentityReviewApplyResult = {
      ...saved,
      roles: { status: 'queued', task_id: 'synthetic-role-job', updated: 0, failed: 0 },
    };
    const p = page(value, {}, async <T,>(path: string) => {
      if (path === '/api/identity-review/apply') return queued as T;
      if (path === '/api/identity-review/roles/synthetic-role-job')
        return {
          ...queued.roles,
          status: ++polls === 1 ? 'queued' : 'updated',
          updated: polls === 1 ? 0 : 1,
        } as T;
      return value as T;
    });
    const dialog = await openFirst();
    vi.useFakeTimers();
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
      ),
    );
    expect(p.notify).toHaveBeenCalledWith(
      '1 identity approved. Discord organization roles are updating in the background.',
      false,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(polls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(polls).toBe(2);
    expect(
      screen.getByText('1 identity approved. Discord organization roles updated.'),
    ).toBeTruthy();
    expect(p.notify).toHaveBeenCalledWith(
      '1 identity approved. Discord organization roles updated.',
      false,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(polls).toBe(2);
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
  });

  it('reports a failed queued role job while preserving the already-approved identity', async () => {
    const value = directory();
    const queued: IdentityReviewApplyResult = {
      ...saved,
      roles: { status: 'queued', task_id: 'synthetic-failed-role-job', updated: 0, failed: 0 },
    };
    const p = page(value, {}, async <T,>(path: string) => {
      if (path === '/api/identity-review/apply') return queued as T;
      if (path === '/api/identity-review/roles/synthetic-failed-role-job')
        return {
          ...queued.roles,
          status: 'failed',
          failed: 1,
          message: 'Check organization role permissions.',
        } as T;
      return value as T;
    });
    const dialog = await openFirst();
    vi.useFakeTimers();
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByText('Check organization role permissions.')).toBeTruthy();
    expect(p.notify).toHaveBeenLastCalledWith(
      expect.stringContaining('1 identity approved. Discord role updates need attention.'),
      true,
    );
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
  });

  it('aborts queued-role polling on navigation, ignores a late response, and never retries a mutation', async () => {
    const value = directory();
    const queued: IdentityReviewApplyResult = {
      ...saved,
      roles: { status: 'queued', task_id: 'synthetic-late-role-job', updated: 0, failed: 0 },
    };
    let finish!: (roles: IdentityReviewApplyResult['roles']) => void;
    let signal!: AbortSignal;
    const p = page(value, {}, async <T,>(path: string, options?: ApiOptions) => {
      if (path === '/api/identity-review/apply') return queued as T;
      if (path === '/api/identity-review/roles/synthetic-late-role-job') {
        signal = options!.signal!;
        return new Promise<IdentityReviewApplyResult['roles']>((resolve) => {
          finish = resolve;
        }) as Promise<T>;
      }
      return value as T;
    });
    const dialog = await openFirst();
    vi.useFakeTimers();
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    p.rerender(<IdentityReviewPanel {...p.props} active={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ ...queued.roles, status: 'updated', updated: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls(p.api, '/api/identity-review/roles/synthetic-late-role-job')).toHaveLength(1);
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
    expect(p.notify).not.toHaveBeenCalledWith(
      '1 identity approved. Discord organization roles updated.',
      false,
    );
  });

  it('bounds queued-role monitoring at five minutes while leaving the durable job running', async () => {
    const value = directory();
    const queued: IdentityReviewApplyResult = {
      ...saved,
      roles: { status: 'queued', task_id: 'synthetic-long-role-job', updated: 0, failed: 0 },
    };
    let signal!: AbortSignal;
    const p = page(value, {}, async <T,>(path: string, options?: ApiOptions) => {
      if (path === '/api/identity-review/apply') return queued as T;
      if (path === '/api/identity-review/roles/synthetic-long-role-job') {
        signal = options!.signal!;
        return new Promise<T>(() => {});
      }
      return value as T;
    });
    const dialog = await openFirst();
    vi.useFakeTimers();
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(signal.aborted).toBe(true);
    expect(
      screen.getByText(
        'Role updates continue on the server. Refresh the directory later to check their status.',
      ),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(calls(p.api, '/api/identity-review/roles/synthetic-long-role-job')).toHaveLength(1);
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
  });

  it('backs off failed progress reads without exposing raw errors or relabeling the saved job as failed', async () => {
    const value = directory();
    const queued: IdentityReviewApplyResult = {
      ...saved,
      roles: { status: 'queued', task_id: 'synthetic-offline-role-job', updated: 0, failed: 0 },
    };
    const p = page(value, {}, async <T,>(path: string) => {
      if (path === '/api/identity-review/apply') return queued as T;
      if (path === '/api/identity-review/roles/synthetic-offline-role-job')
        throw new Error('PRIVATE_ROLE_RESPONSE');
      return value as T;
    });
    const dialog = await openFirst();
    vi.useFakeTimers();
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Approve identity & update roles' }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(calls(p.api, '/api/identity-review/roles/synthetic-offline-role-job')).toHaveLength(3);
    expect(
      screen.getByText(
        'Role progress could not be refreshed. The saved job continues on the server; refresh later to check it.',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('PRIVATE_ROLE_RESPONSE');
    expect(p.notify).toHaveBeenLastCalledWith(
      'Discord role progress could not be refreshed. The saved job will continue in the background.',
      true,
    );
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(1);
  });

  it('loads recent queued and failed role jobs after reload using read-only requests without names', async () => {
    const tasks = [
      {
        status: 'queued' as const,
        task_id: 'synthetic-recent-queued',
        created_at: '2026-10-22T01:00:00Z',
        updated: 2,
        failed: 0,
      },
      {
        status: 'failed' as const,
        task_id: 'synthetic-recent-failed',
        created_at: '2026-10-22T00:00:00Z',
        updated: 1,
        failed: 1,
      },
    ];
    const p = page(directory(), { tasks });
    await screen.findByText('Recent Discord role updates · 1 updating · 1 need attention');
    expect(screen.getByText('Updating in background')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh role updates' }));
    await waitFor(() => expect(calls(p.api, '/api/identity-review/roles')).toHaveLength(2));
    expect(calls(p.api, '/api/identity-review/apply')).toHaveLength(0);
    expect(
      (p.api as ReturnType<typeof vi.fn>).mock.calls.every(([, options]) => !options?.method),
    ).toBe(true);
    expect(document.body.textContent).not.toContain('synthetic-recent-queued');
  });
});
