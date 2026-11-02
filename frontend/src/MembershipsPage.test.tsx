// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MembershipsPage from './MembershipsPage';
import {
  defaultMembershipTiers,
  type Api,
  type ApiOptions,
  type Job,
  type Membership,
  type Settings,
} from './types';

vi.mock('./IdentityReviewPanel', () => ({
  MemberIdentityAccountReview: ({
    member,
    onApplied,
    onCancel,
  }: {
    member: { username: string };
    onApplied: (value: unknown) => void;
    onCancel: () => void;
  }) => (
    <section aria-label="Inline relationships">
      <p>Reviewed owner @{member.username}</p>
      <button onClick={() => onApplied({ approved: 1 })}>Confirm selected existing accounts</button>
      <button onClick={onCancel}>Return without changes</button>
    </section>
  ),
}));
const ownerId = '123456789012345678';
const member = {
  id: ownerId,
  username: 'Jim',
  display_name: 'Captain Jim',
  nickname: null,
  membership_active: true,
};
const membership: Membership = {
  discord_user_id: ownerId,
  base_username: 'Jim',
  tier_id: 'galleon',
  account_limit: 3,
  active: true,
  revision: 'membership-revision-1',
  links: [1, 2, 3].map((slot) => ({
    discord_user_id: ownerId,
    username: slot === 1 ? 'Jim' : `Jim_${slot}`,
    remote_id: `jellyfin-${slot}`,
    membership_slot: slot,
    disabled_by_jellyport: 0,
    pending_disabled: null,
  })),
};
const job: Job = {
  id: 'membership-job-1',
  kind: 'membership',
  status: 'queued',
  created_at: '2026-11-02T12:00:00Z',
};
const settings = { membership_tiers: defaultMembershipTiers } as Settings;
type Plan = {
  discord_user_id: string;
  username: string;
  access_mode: string;
  tier_id: string;
  account_limit: number;
  provision_jellyfin: boolean;
  accounts: Array<{
    slot: number;
    username: string;
    action: string;
    kind: string;
    target_user_id?: string;
  }>;
  warnings: string[];
  policy_only: boolean;
  review_token: string;
  expires_at: string;
};
type Request = { path: string; options?: ApiOptions };
const writes = (requests: Request[]) =>
  requests.filter(
    ({ path, options }) => options?.method && path !== '/api/memberships/workflow/review',
  );
const checks = (requests: Request[]) =>
  requests.filter(({ path }) => path === '/api/memberships/workflow/review');
function fixture(
  options: {
    members?: Membership[];
    plan?: (body: any, value: Plan) => Plan | Promise<Plan>;
    accept?: (body: any, signal: AbortSignal) => unknown | Promise<unknown>;
    access?: (body: any) => unknown | Promise<unknown>;
    read?: (signal: AbortSignal) => unknown | Promise<unknown>;
    initialMember?: { id: string; username: string };
    handoffKey?: number;
  } = {},
) {
  const members = options.members ?? [structuredClone(membership)];
  const requests: Request[] = [];
  let sequence = 0;
  const api = vi.fn(async (path: string, config?: ApiOptions) => {
    requests.push({ path, options: config });
    if (path === '/api/memberships')
      return options.read ? options.read(config!.signal!) : { memberships: members };
    if (path.startsWith('/api/discord/members?')) return { members: [member], truncated: false };
    if (path === '/api/memberships/workflow/review') {
      const body = config!.body as any;
      const saved = members.find((value) => value.discord_user_id === body.discord_user_id);
      const tier = defaultMembershipTiers.find((value) => value.id === body.tier_id);
      const limit = body.account_limit ?? tier?.account_limit ?? 1;
      const accounts = body.provision_jellyfin
        ? Array.from({ length: Math.max(limit, saved?.links.length ?? 0) }, (_, index) => {
            const slot = index + 1;
            const link = saved?.links.find((value) => value.membership_slot === slot);
            return {
              slot,
              username: link?.username || (slot === 1 ? 'Jim' : `Jim_${slot}`),
              kind: 'jellyfin',
              action: slot > limit ? 'disable' : link ? 'manage' : 'create',
              ...(link ? { target_user_id: link.remote_id } : {}),
            };
          })
        : (saved?.links ?? []).map((link) => ({
            slot: link.membership_slot,
            username: link.username,
            kind: 'jellyfin',
            action: link.membership_slot > limit ? 'disable' : 'manage',
            target_user_id: link.remote_id,
          }));
      const plan: Plan = {
        ...body,
        username: saved?.base_username || 'Jim',
        tier_id: body.tier_id || 'complimentary',
        account_limit: limit,
        accounts,
        warnings: [],
        policy_only: !accounts.length,
        review_token: `review-${++sequence}`,
        expires_at: new Date(Date.now() + 300000).toISOString(),
      };
      return options.plan ? options.plan(body, plan) : plan;
    }
    if (path === '/api/memberships/workflow/accept')
      return options.accept
        ? options.accept(config!.body, config!.signal!)
        : { membership: members[0] || membership, job };
    if (path === '/api/memberships/access')
      return options.access
        ? options.access(config!.body)
        : { ...membership, ...(config!.body as object) };
    throw new Error(`Unexpected request ${path}`);
  }) as Api;
  const notify = vi.fn();
  const created = vi.fn();
  const props = {
    settings,
    api,
    notify,
    created,
    initialMember: options.initialMember,
    handoffKey: options.handoffKey,
  };
  return { ...render(<MembershipsPage {...props} />), props, requests, api, notify, created };
}
async function manage() {
  fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
}
async function ready() {
  const button = await screen.findByRole('button', { name: 'Review membership update' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  return button;
}
async function chooseNew() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Discord member' }), {
    target: { value: 'Captain Jim' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Select @Jim' }));
}
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', window.location.pathname);
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe('membership task workflow', () => {
  it('restores an empty editor without selecting a private owner or starting a check', async () => {
    window.history.replaceState(null, '', '#/memberships/accounts/editor');
    const f = fixture();
    await waitFor(() =>
      expect(screen.getByLabelText('Access policy')).toHaveProperty('disabled', false),
    );
    expect(screen.getByRole('searchbox', { name: 'Discord member' })).toHaveProperty('value', '');
    expect(checks(f.requests)).toEqual([]);
    expect(writes(f.requests)).toEqual([]);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('retains the selected policy through history navigation and discards its identity on a reload', async () => {
    window.history.replaceState(null, '', '#/memberships/accounts/list');
    const first = fixture();
    await manage();
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    act(() => window.history.back());
    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: /Managed memberships/ }).getAttribute('aria-selected'),
      ).toBe('true'),
    );
    act(() => window.history.forward());
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Manage member' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'brigantine');
    first.unmount();
    fixture();
    expect(await screen.findByRole('searchbox', { name: 'Discord member' })).toHaveProperty(
      'value',
      '',
    );
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('pages and filters members without losing a selected policy', async () => {
    const members = Array.from({ length: 56 }, (_, index) => ({
      ...membership,
      discord_user_id: `${123456789012340000n + BigInt(index)}`,
      base_username: `Crew ${index}`,
      links: [],
    }));
    fixture({ members });
    await screen.findByText('1–25 of 56');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find memberships' }), {
      target: { value: 'Crew 55' },
    });
    expect(screen.getByText('1–1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage membership for Crew 55' }));
    expect(screen.getByRole('heading', { name: '@Crew 55' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Managed memberships/ }));
    expect(screen.getByRole('searchbox', { name: 'Find memberships' })).toHaveProperty(
      'value',
      'Crew 55',
    );
  });

  it('checks requirements before enabling final review and reuses the saved exact owner', async () => {
    let resolve!: (plan: Plan) => void;
    const f = fixture({
      plan: (_body, plan) =>
        new Promise<Plan>((done) => {
          resolve = () => done(plan);
        }),
    });
    await manage();
    expect(screen.getByText('Checking account requirements before review…')).toBeTruthy();
    expect(screen.queryByRole('searchbox', { name: 'Discord member' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Checking requirements…' })).toHaveProperty(
      'disabled',
      true,
    );
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    await act(async () => resolve({} as Plan));
    await ready();
    expect(writes(f.requests)).toHaveLength(0);
    expect(checks(f.requests)[0].options!.body).toMatchObject({
      discord_user_id: ownerId,
      expected_revision: membership.revision,
    });
    expect(f.requests.some(({ path }) => path === '/api/user-mappings')).toBe(false);
  });

  it('shows a missing prerequisite before final confirmation while preserving the editable draft', async () => {
    const f = fixture({
      plan: () => {
        throw new Error('Choose an account role before creating accounts.');
      },
    });
    await manage();
    fireEvent.click(screen.getByLabelText('Enable Jellyfin account provisioning'));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    await screen.findByText('Choose an account role before creating accounts.');
    expect(screen.getByRole('button', { name: 'Review membership update' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'brigantine');
    expect(screen.getByRole('button', { name: 'Save access policy' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(writes(f.requests)).toEqual([]);
  });

  it('saves a complimentary policy independently of mapping, media defaults or an unavailable account plan', async () => {
    const f = fixture({
      plan: () => {
        throw new Error('Media server unavailable.');
      },
    });
    await manage();
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    fireEvent.change(screen.getByLabelText('Complimentary account allowance'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save access policy' }));
    await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
    expect(writes(f.requests)[0]).toMatchObject({
      path: '/api/memberships/access',
      options: {
        body: {
          discord_user_id: ownerId,
          access_mode: 'complimentary',
          account_limit: 2,
          provision_jellyfin: true,
          expected_revision: membership.revision,
        },
      },
    });
    expect(f.created).not.toHaveBeenCalled();
  });

  it('keeps a rejected policy editable and retries only the explicit policy save', async () => {
    let attempt = 0;
    const f = fixture({
      access: (body) => {
        if (!attempt++) throw new Error('Policy changed. Review before retrying.');
        return { ...membership, ...body };
      },
    });
    await manage();
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save access policy' }));
    await screen.findByText('Policy changed. Review before retrying.');
    expect(screen.getByLabelText('Access policy')).toHaveProperty('value', 'complimentary');
    fireEvent.click(screen.getByRole('button', { name: 'Save access policy' }));
    await waitFor(() => expect(writes(f.requests)).toHaveLength(2));
    expect(writes(f.requests).every(({ path }) => path === '/api/memberships/access')).toBe(true);
    expect(f.created).not.toHaveBeenCalled();
  });

  it('defaults a new member to Jellyfin opt-out and does not create an account on policy save', async () => {
    const f = fixture({ members: [] });
    await chooseNew();
    expect(screen.getByLabelText('Enable Jellyfin account provisioning')).toHaveProperty(
      'checked',
      false,
    );
    await ready();
    expect(
      screen.getByText('Policy-only update: no media account or identity mapping is required.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save access policy' }));
    await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
    expect(writes(f.requests)[0].path).toBe('/api/memberships/access');
    expect((writes(f.requests)[0].options!.body as any).provision_jellyfin).toBe(false);
    expect(f.created).not.toHaveBeenCalled();
  });

  it('uses checked server names instead of generating assumptions from the Discord username', async () => {
    const f = fixture({
      members: [],
      plan: (_body, plan) => ({
        ...plan,
        accounts: [1, 2, 3].map((slot) => ({
          slot,
          username: ['SimplifiedJim', 'FamilyJim', 'Cabin'][slot - 1],
          kind: 'jellyfin',
          action: 'manage',
          target_user_id: `j-${slot}`,
        })),
        policy_only: false,
      }),
    });
    await chooseNew();
    fireEvent.click(screen.getByLabelText('Enable Jellyfin account provisioning'));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'galleon' } });
    fireEvent.click(await ready());
    const dialog = screen.getByRole('dialog');
    for (const name of ['SimplifiedJim', 'FamilyJim', 'Cabin'])
      expect(within(dialog).getByText(name)).toBeTruthy();
    expect(within(dialog).queryByText('Jim_2')).toBeNull();
    expect(writes(f.requests)).toEqual([]);
  });

  it('requires explicit final confirmation for three slots and submits only the retained server token', async () => {
    const f = fixture({ members: [] });
    await chooseNew();
    fireEvent.click(screen.getByLabelText('Enable Jellyfin account provisioning'));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'galleon' } });
    fireEvent.click(await ready());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Jim_2')).toBeTruthy();
    expect(within(dialog).getByText('Jim_3')).toBeTruthy();
    expect(writes(f.requests)).toEqual([]);
    const token = (await Promise.resolve(checks(f.requests).at(-1)))!;
    expect(token.options!.body).toMatchObject({
      discord_user_id: ownerId,
      tier_id: 'galleon',
      provision_jellyfin: true,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Queue membership update' }));
    await waitFor(() => expect(f.created).toHaveBeenCalledWith(job));
    expect(writes(f.requests)).toHaveLength(1);
    expect(writes(f.requests)[0]).toMatchObject({
      path: '/api/memberships/workflow/accept',
      options: { body: { review_token: expect.stringMatching(/^review-/) } },
    });
    expect(Object.keys(writes(f.requests)[0].options!.body as object)).toEqual(['review_token']);
  });

  it('cancels without writing and checks the changed allowance before reopening final review', async () => {
    const f = fixture();
    await manage();
    fireEvent.click(await ready());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(writes(f.requests)).toEqual([]);
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    fireEvent.click(await ready());
    expect(within(screen.getByRole('dialog')).getByText('Jim_3')).toBeTruthy();
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Disable this account outside the allowance and preserve its data.',
      ),
    ).toBeTruthy();
    expect((checks(f.requests).at(-1)!.options!.body as any).tier_id).toBe('brigantine');
    expect(writes(f.requests)).toEqual([]);
  });

  it('reviews a downgrade with saved custom account names and protected Family outcomes', async () => {
    const value = structuredClone(membership);
    value.links[0].username = 'Jim-Captain';
    value.links[1].username = 'FamilyCabin';
    fixture({
      members: [value],
      plan: (_body, plan) => ({
        ...plan,
        accounts: plan.accounts.map((account) =>
          account.slot === 2 ? { ...account, action: 'family_preserved' } : account,
        ),
      }),
    });
    await manage();
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'sloop' } });
    fireEvent.click(await ready());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Jim-Captain')).toBeTruthy();
    expect(within(dialog).getByText('FamilyCabin')).toBeTruthy();
    expect(within(dialog).getByText('Preserve this manually flagged Family account.')).toBeTruthy();
  });

  it('blocks an inactive paid membership before confirmation instead of silently reactivating it', async () => {
    const f = fixture({
      members: [{ ...membership, active: false }],
      plan: (body, plan) => {
        if (body.access_mode === 'subscription')
          throw new Error(
            'The subscription is inactive. Verify current billing or explicitly choose complimentary access.',
          );
        return plan;
      },
    });
    await manage();
    await screen.findByText(
      'The subscription is inactive. Verify current billing or explicitly choose complimentary access.',
    );
    expect(screen.getByRole('button', { name: 'Review membership update' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(writes(f.requests)).toEqual([]);
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    await ready();
    expect((checks(f.requests).at(-1)!.options!.body as any).access_mode).toBe('complimentary');
  });

  it('omits an empty legacy revision from the read-only plan request', async () => {
    const f = fixture({ members: [{ ...membership, revision: '' }] });
    await manage();
    await ready();
    expect(checks(f.requests)[0].options!.body).not.toHaveProperty('expected_revision');
  });

  it('aborts an initial membership read on unmount and ignores its late private result', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const f = fixture({
      read: (current) => {
        signal = current;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    f.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ memberships: [membership] }));
    expect(screen.queryByText('Jim')).toBeNull();
    expect(f.created).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('aborts a pending account check and ignores its stale response after the allowance changes', async () => {
    let finish!: () => void;
    const f = fixture({
      plan: (body, plan) =>
        body.tier_id === 'galleon'
          ? new Promise((resolve) => {
              finish = () => resolve(plan);
            })
          : plan,
    });
    await manage();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const firstSignal = checks(f.requests)[0].options!.signal!;
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'sloop' } });
    await ready();
    expect(firstSignal.aborted).toBe(true);
    await act(async () => finish());
    fireEvent.click(await ready());
    expect(within(screen.getByRole('dialog')).getByText(/Sloop/)).toBeTruthy();
    expect((checks(f.requests).at(-1)!.options!.body as any).tier_id).toBe('sloop');
  });

  it('aborts a pending accept response on unmount without opening Activity or showing credentials', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const f = fixture({
      accept: (_body, current) => {
        signal = current;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await manage();
    fireEvent.click(await ready());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    f.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ membership, job }));
    expect(f.created).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('discards an unconfirmed accept token, keeps the policy draft and checks current state before retry', async () => {
    let attempts = 0;
    const f = fixture({
      accept: () => {
        if (!attempts++) throw new Error('The membership changed. Check current requirements.');
        return { membership, job };
      },
    });
    await manage();
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    fireEvent.click(await ready());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await screen.findByText('The membership changed. Check current requirements.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'brigantine');
    expect(f.created).not.toHaveBeenCalled();
    fireEvent.click(await ready());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(f.created).toHaveBeenCalledOnce());
    expect((writes(f.requests)[0].options!.body as any).review_token).not.toBe(
      (writes(f.requests)[1].options!.body as any).review_token,
    );
  });

  it('invalidates an open review after setup changes and checks the preserved draft again', async () => {
    let changed = false;
    const f = fixture({
      plan: (_body, plan) => ({ ...plan, account_limit: changed ? 2 : plan.account_limit }),
    });
    await manage();
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'sloop' } });
    fireEvent.click(await ready());
    changed = true;
    f.rerender(
      <MembershipsPage
        {...f.props}
        settings={{
          ...settings,
          membership_tiers: defaultMembershipTiers.map((tier) =>
            tier.id === 'sloop' ? { ...tier, account_limit: 2 } : tier,
          ),
        }}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'sloop');
    expect(writes(f.requests)).toEqual([]);
    fireEvent.click(await ready());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
    expect(Object.keys(writes(f.requests)[0].options!.body as object)).toEqual(['review_token']);
  });

  it.each(['wrong-owner', 'wrong-allowance', 'missing-expiry'])(
    'rejects an incomplete or mismatched server plan before confirmation (%s)',
    async (problem) => {
      const f = fixture({
        plan: (_body, plan) => ({
          ...plan,
          ...(problem === 'wrong-owner'
            ? { discord_user_id: '223456789012345678' }
            : problem === 'wrong-allowance'
              ? { account_limit: 1 }
              : { expires_at: '' }),
        }),
      });
      await manage();
      await screen.findByText('The account review was incomplete. Check requirements again.');
      expect(screen.getByRole('button', { name: 'Review membership update' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(writes(f.requests)).toEqual([]);
    },
  );

  it('disables an expired final token while keeping the policy draft available for a fresh review', async () => {
    const f = fixture();
    await manage();
    await ready();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    act(() => vi.advanceTimersByTime(300001));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByText('Refresh this account review')).toBeTruthy();
    expect(writes(f.requests)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Check current requirements' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'galleon');
  });

  it('accepts an opted-out Emby-only policy review with no media job', async () => {
    const f = fixture({
      members: [{ ...membership, links: [], provision_jellyfin: false }],
      accept: () => ({
        membership: { ...membership, links: [], provision_jellyfin: false },
        job: null,
      }),
    });
    await manage();
    fireEvent.click(await ready());
    expect(
      within(screen.getByRole('dialog')).getByText(
        /without creating, migrating, enabling or disabling media accounts/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Save reviewed access policy',
      }),
    );
    await waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith(
        'Access policy saved. Existing media accounts are unchanged.',
      ),
    );
    expect(f.created).not.toHaveBeenCalled();
    expect(writes(f.requests)).toHaveLength(1);
  });

  it('can manage existing Jellyfin accounts without opting into missing-account creation', async () => {
    const f = fixture({
      members: [{ ...membership, links: membership.links.slice(0, 1), provision_jellyfin: false }],
    });
    await manage();
    await ready();
    expect((checks(f.requests).at(-1)!.options!.body as any).provision_jellyfin).toBe(false);
    fireEvent.click(await ready());
    expect(within(screen.getByRole('dialog')).getAllByRole('article')).toHaveLength(1);
  });

  it('saves complimentary policy and account changes in one accepted workflow rather than two partial writes', async () => {
    const f = fixture();
    await manage();
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    fireEvent.change(screen.getByLabelText('Complimentary account allowance'), {
      target: { value: '2' },
    });
    fireEvent.click(await ready());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(f.created).toHaveBeenCalledOnce());
    expect(writes(f.requests).map(({ path }) => path)).toEqual([
      '/api/memberships/workflow/accept',
    ]);
    expect((checks(f.requests).at(-1)!.options!.body as any).account_limit).toBe(2);
  });

  it('opens an exact selected owner handoff once and keeps later policy edits', async () => {
    const f = fixture({ initialMember: { id: ownerId, username: 'Jim' }, handoffKey: 1 });
    await ready();
    expect(screen.getByRole('tab', { name: 'Manage member' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    f.rerender(<MembershipsPage {...f.props} handoffKey={1} />);
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'brigantine');
    expect(screen.queryByRole('searchbox', { name: 'Discord member' })).toBeNull();
    expect(writes(f.requests)).toEqual([]);
  });

  it('resolves relationships inline then returns to the same owner and unsaved policy', async () => {
    const f = fixture();
    await manage();
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review existing account links' }));
    expect(screen.getByRole('region', { name: 'Inline relationships' })).toBeTruthy();
    expect(screen.getByText('Reviewed owner @Jim')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selected existing accounts' }));
    await ready();
    expect(screen.getByLabelText('Membership tier')).toHaveProperty('value', 'brigantine');
    expect(screen.queryByRole('searchbox', { name: 'Discord member' })).toBeNull();
    expect(writes(f.requests)).toEqual([]);
  });
});
