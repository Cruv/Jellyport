// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MigrationPreviewDialog from './MigrationPreviewDialog';
import type {
  Api,
  MigrationBillingInventory,
  MigrationOwnerMembership,
  PreviewUser,
} from './types';

afterEach(cleanup);
const owner = '123456789012345678';
const other = '234567890123456789';
const rows: PreviewUser[] = [
  { source_user_id: 'source-a', username: 'personal-name', target_exists: false, stats: null },
  {
    source_user_id: 'source-b',
    username: 'other-name',
    target_exists: true,
    target_user_id: 'j-other',
    stats: null,
  },
];
function entitlement(
  id = owner,
  overrides: Partial<MigrationOwnerMembership> = {},
): MigrationOwnerMembership {
  return {
    discord_user_id: id,
    review_token: `proof-${id}`,
    status: 'active',
    source: 'stripe',
    tier_id: 'galleon',
    tier_name: 'Galleon',
    account_limit: 3,
    allowed_slots: [1, 2, 3],
    existing_member: null,
    occupied_slots: [],
    message: 'Verified paid membership. Only reviewed accounts are migrated.',
    ...overrides,
  };
}
const inventory: MigrationBillingInventory = {
  available: true,
  message: 'Choose the customer belonging to this member.',
  next_cursor: null,
  last_sync: '2026-01-01T00:00:00Z',
  tiers: [
    { id: 'sloop', name: 'Sloop', account_limit: 1 },
    { id: 'galleon', name: 'Galleon', account_limit: 3 },
  ],
  customers: [
    {
      id: 'cus_crew',
      name: 'Synthetic Crew',
      email: 'crew@example.test',
      linked_discord_id: null,
      linked_username: null,
      suggested: true,
      prices: [{ price_id: 'price_crew', name: 'Crew plan', tier_id: null }],
    },
  ],
};
function fixtureApi(membership: MigrationOwnerMembership = entitlement()) {
  return vi.fn(async (path: string, options?: { body?: unknown }) => {
    if (path.endsWith('/membership'))
      return {
        ...membership,
        discord_user_id: (options?.body as { discord_user_id: string }).discord_user_id,
      };
    if (path.endsWith('/billing')) return inventory;
    if (path === '/api/users')
      return {
        jellyfin: [
          {
            Id: 'j-alias',
            Name: 'Destination alias',
            Policy: { IsAdministrator: false, IsDisabled: false },
          },
          {
            Id: 'template',
            Name: 'Template',
            Policy: { IsAdministrator: false, IsDisabled: false },
          },
          { Id: 'j-admin', Name: 'Admin', Policy: { IsAdministrator: true, IsDisabled: false } },
          {
            Id: 'j-disabled',
            Name: 'Disabled',
            Policy: { IsAdministrator: false, IsDisabled: true },
          },
        ],
      };
    if (path.endsWith('/account'))
      return {
        ...(options?.body as object),
        target_username: 'Destination alias',
        review_token: 'target-proof',
      };
    if (path.startsWith('/api/discord/members'))
      return {
        members: [
          {
            id: owner,
            username: 'crew_owner',
            display_name: null,
            nickname: null,
            membership_active: false,
          },
        ],
        truncated: false,
      };
    throw new Error(`Unexpected request: ${path}`);
  }) as Api;
}
function setup(
  users = rows,
  api = fixtureApi(),
  pending = false,
  templateUserId: string | null = 'template',
) {
  const startMigration = vi.fn((event) => event.preventDefault());
  const close = vi.fn();
  const rendered = render(
    <MigrationPreviewDialog
      review={{ previewId: 'review-synthetic', preview: { users } }}
      api={api}
      close={close}
      refreshPreview={vi.fn()}
      startMigration={startMigration}
      busy={new Set(pending ? ['migration'] : [])}
      templateUserId={templateUserId || undefined}
    />,
  );
  return {
    ...rendered,
    api,
    close,
    startMigration,
    form: document.querySelector<HTMLFormElement>('#migration-preview-form')!,
  };
}
function assign(id = owner) {
  fireEvent.change(screen.getByLabelText('Discord owner ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: 'Assign owner to selected accounts' }));
}
async function billing() {
  fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
  await screen.findByText('Galleon · 3 accounts');
}
async function accounts() {
  await billing();
  fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
  await screen.findByLabelText('Jellyfin destination for personal-name');
}
function review() {
  fireEvent.click(screen.getByRole('button', { name: 'Next: Review' }));
}
function chooseCustomer() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Stripe customer Synthetic Crew' }));
  fireEvent.change(screen.getByLabelText('Membership tier for Crew plan'), {
    target: { value: 'galleon' },
  });
  fireEvent.click(screen.getByLabelText(`I confirm these Stripe customers belong to @${owner}`));
}

describe('migration setup wizard', () => {
  it('groups three arbitrary names under one searched owner without requiring a Discord subscriber role', async () => {
    const users = [...rows, { ...rows[0], source_user_id: 'source-c', username: 'third-name' }];
    const { api, form, startMigration } = setup(users);
    expect(screen.getByRole('heading', { name: 'Choose account owners' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Discord owner'), { target: { value: 'crew_owner' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @crew_owner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign owner to selected accounts' }));
    await accounts();
    expect(screen.getByLabelText('Membership account slot for personal-name')).toHaveProperty(
      'value',
      '1',
    );
    expect(screen.getByLabelText('Membership account slot for other-name')).toHaveProperty(
      'value',
      '2',
    );
    expect(screen.getByLabelText('Membership account slot for third-name')).toHaveProperty(
      'value',
      '3',
    );
    expect(screen.getAllByText('Galleon · 3 accounts')).toHaveLength(1);
    review();
    expect(screen.getAllByText('@crew_owner')).toHaveLength(1);
    expect(new FormData(form).get('source-a')).toBe(owner);
    expect(new FormData(form).get('slot-source-c')).toBe('3');
    expect(new FormData(form).getAll(`membership-review-${owner}`)).toEqual([`proof-${owner}`]);
    expect([...new FormData(form).keys()].some((name) => /tier|allowance/.test(name))).toBe(false);
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/membership'))).toHaveLength(
      1,
    );
    fireEvent.submit(form);
    expect(startMigration).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('third-name')).toHaveLength(2);
  });
  it('blocks form submission until the final review and retains selections when going back', async () => {
    const { form, startMigration } = setup();
    assign();
    fireEvent.submit(form);
    expect(startMigration).not.toHaveBeenCalled();
    await accounts();
    fireEvent.change(screen.getByLabelText('Membership account slot for other-name'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    expect(screen.getByLabelText('Membership account slot for other-name')).toHaveProperty(
      'value',
      '3',
    );
    review();
    fireEvent.submit(form);
    expect(startMigration).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('a native Next click reaches final review without submitting or starting a migration', async () => {
    const { startMigration } = setup([rows[0]]);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    await act(async () => {
      screen.getByRole<HTMLButtonElement>('button', { name: 'Next: Review' }).click();
    });
    expect(screen.getByRole('heading', { name: 'Final migration review' })).toBeTruthy();
    expect(startMigration).not.toHaveBeenCalled();
    await act(async () => {
      screen.getByRole<HTMLButtonElement>('button', { name: 'Start migration' }).click();
    });
    expect(startMigration).toHaveBeenCalledTimes(1);
  });
  it('suggests distinct free slots without taking a slot owned by an account outside the batch', async () => {
    setup(
      rows,
      fixtureApi(
        entitlement(owner, { occupied_slots: [{ slot: 1, emby_user_id: 'outside-batch' }] }),
      ),
    );
    assign();
    await accounts();
    expect(screen.getByLabelText('Membership account slot for personal-name')).toHaveProperty(
      'value',
      '2',
    );
    expect(screen.getByLabelText('Membership account slot for other-name')).toHaveProperty(
      'value',
      '3',
    );
  });
  it('keeps manually chosen duplicate slots visible and blocks the review until fixed', async () => {
    setup();
    assign();
    await accounts();
    fireEvent.change(screen.getByLabelText('Membership account slot for other-name'), {
      target: { value: '1' },
    });
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Next: Review' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Membership account slot for other-name'), {
      target: { value: '2' },
    });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
  it.each(['mapping', 'approved', 'numbered_suggestion'] as const)(
    'preserves %s ownership and its locked slot',
    async (owner_basis) => {
      const { form } = setup([
        {
          ...rows[0],
          discord_user_id: owner,
          discord_username: 'crew_owner',
          membership_slot: 2,
          owner_basis,
        },
      ]);
      expect(screen.getByRole('checkbox', { name: 'Assign personal-name' })).toHaveProperty(
        'disabled',
        true,
      );
      await accounts();
      expect(screen.getByLabelText('Membership account slot for personal-name')).toHaveProperty(
        'disabled',
        true,
      );
      expect(screen.getByLabelText('Membership account slot for personal-name')).toHaveProperty(
        'value',
        '2',
      );
      expect(new FormData(form).has('slot-source-a')).toBe(false);
    },
  );
  it('keeps an ownerless saved alias mapping editable for ownership while preserving its target', async () => {
    setup([
      {
        ...rows[0],
        mapping_id: 'mapping-a',
        source_username: 'Emby alias',
        username: 'Destination alias',
        membership_slot: 2,
      },
    ]);
    assign();
    await billing();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    expect(screen.queryByLabelText('Jellyfin destination for Emby alias')).toBeNull();
    expect(screen.getByLabelText('Membership account slot for Destination alias')).toHaveProperty(
      'value',
      '2',
    );
    expect(screen.getByText(/Saved user mapping/)).toBeTruthy();
  });
  it('allows independent accounts without billing and protected accounts directly at final review', async () => {
    const first = setup([rows[0]]);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    await screen.findByLabelText('Jellyfin destination for personal-name');
    review();
    expect(vi.mocked(first.api).mock.calls.some(([path]) => path.endsWith('/membership'))).toBe(
      false,
    );
    fireEvent.submit(first.form);
    expect(first.startMigration).toHaveBeenCalledTimes(1);
    first.unmount();
    const protectedAccount = setup([
      { ...rows[0], history_only: true, target_exists: true, discord_user_id: owner },
    ]);
    expect(screen.getByRole('heading', { name: 'Final migration review' })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.submit(protectedAccount.form);
    expect(protectedAccount.startMigration).toHaveBeenCalledTimes(1);
    expect(protectedAccount.api).not.toHaveBeenCalled();
  });
  it('waits for a membership lookup and offers an inline retry after failure', async () => {
    const fallback = fixtureApi();
    let attempts = 0;
    const api = vi.fn(async (path, options) => {
      if (String(path).endsWith('/membership') && ++attempts === 1)
        throw new Error('Billing is temporarily unavailable.');
      return fallback(path, options);
    }) as Api;
    setup(rows, api);
    assign();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    await screen.findByText('Billing is temporarily unavailable.');
    expect(screen.getByRole('button', { name: 'Next: Accounts' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: `Check membership again for ${owner}` }));
    await screen.findByText('Galleon · 3 accounts');
    expect(screen.getByRole('button', { name: 'Next: Accounts' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  it.each(['inactive', 'held'] as const)(
    'does not replace a saved %s policy from Stripe',
    async (status) => {
      setup(
        [rows[0]],
        fixtureApi(
          entitlement(owner, {
            source: 'saved',
            status,
            allowed_slots: [],
            account_limit: 0,
            existing_member: {
              active: false,
              held: status === 'held',
              access_mode: 'subscription',
              account_limit: 3,
              tier_id: 'galleon',
            },
          }),
        ),
      );
      assign();
      fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
      await screen.findByText(
        status === 'held' ? 'Membership needs review' : 'Membership inactive',
      );
      expect(screen.getByRole('button', { name: 'Next: Accounts' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(screen.queryByRole('region', { name: `Stripe billing for ${owner}` })).toBeNull();
      expect(screen.queryByLabelText('Search Stripe customers')).toBeNull();
    },
  );
  it('reuses complimentary access without requiring any Stripe customer link', async () => {
    const api = fixtureApi(
      entitlement(owner, {
        source: 'saved',
        status: 'complimentary',
        tier_name: 'Family',
        existing_member: {
          active: true,
          held: false,
          access_mode: 'complimentary',
          account_limit: 3,
          tier_id: 'family',
        },
      }),
    );
    setup(rows, api);
    assign();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    await screen.findByText('Family · 3 accounts');
    expect(screen.queryByLabelText('Search Stripe customers')).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/billing'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    review();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('can explicitly approve a new complimentary allowance inside the wizard without saving a policy early', async () => {
    const fallback = fixtureApi();
    const api = vi.fn(async (path, options) => {
      if (path.endsWith('/membership')) {
        const body = options?.body as { complimentary?: { account_limit: number } };
        return body.complimentary
          ? entitlement(owner, {
              status: 'complimentary',
              source: 'saved',
              tier_name: null,
              account_limit: body.complimentary.account_limit,
              review_token: 'complimentary-proof',
              message: 'Complimentary access is managed by an administrator.',
            })
          : entitlement(owner, {
              status: 'unavailable',
              source: 'legacy',
              account_limit: null,
              allowed_slots: [1],
            });
      }
      return fallback(path, options);
    }) as Api;
    const { form, startMigration } = setup(rows, api);
    assign();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Access source')).toHaveProperty('disabled', false),
    );
    fireEvent.change(screen.getByLabelText('Access source'), {
      target: { value: 'complimentary' },
    });
    fireEvent.change(screen.getByLabelText('Complimentary account allowance'), {
      target: { value: '3' },
    });
    expect(screen.getByRole('button', { name: 'Confirm complimentary access' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(
      screen.getByLabelText(`I approve complimentary, administrator-managed access for @${owner}`),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm complimentary access' }));
    await screen.findByText('Complimentary · 3 accounts');
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]?.body).toEqual({
      discord_user_id: owner,
      complimentary: { account_limit: 3 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    review();
    expect(new FormData(form).get(`membership-review-${owner}`)).toBe('complimentary-proof');
    expect(
      [...new FormData(form).keys()].some((key) => /complimentary|account_limit/.test(key)),
    ).toBe(false);
    expect(startMigration).not.toHaveBeenCalled();
  });
  it('prepares a customer link and missing price mapping inline, requiring ownership confirmation and final approval', async () => {
    const fallback = fixtureApi();
    const api = vi.fn(async (path, options) => {
      if (String(path).endsWith('/membership')) {
        const body = options?.body as { billing?: unknown };
        return body.billing
          ? entitlement(owner, {
              review_token: 'onboarding-proof',
              billing_changes: {
                customer_links: [
                  { customer_id: 'cus_crew', name: 'Synthetic Crew', email: 'crew@example.test' },
                ],
                price_mappings: [
                  {
                    price_id: 'price_crew',
                    price_name: 'Crew plan',
                    tier_id: 'galleon',
                    tier_name: 'Galleon',
                  },
                ],
              },
            })
          : entitlement(owner, {
              status: 'unlinked',
              tier_name: null,
              account_limit: null,
              allowed_slots: [1],
              message:
                'Approve this Discord member’s Stripe customer link to find their paid tier automatically.',
            });
      }
      return fallback(path, options);
    }) as Api;
    const { form, startMigration } = setup(rows, api);
    assign();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    await screen.findByText('Stripe identity not linked');
    await screen.findByRole('checkbox', { name: 'Stripe customer Synthetic Crew' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stripe customer Synthetic Crew' }));
    fireEvent.change(screen.getByLabelText('Membership tier for Crew plan'), {
      target: { value: 'galleon' },
    });
    expect(
      screen.getByRole('button', { name: 'Confirm billing & check membership' }),
    ).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(`I confirm these Stripe customers belong to @${owner}`));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm billing & check membership' }));
    await screen.findByText('Galleon · 3 accounts');
    expect(
      vi
        .mocked(api)
        .mock.calls.find(
          ([path, options]) =>
            path.endsWith('/membership') && (options?.body as { billing?: unknown })?.billing,
        )?.[1]?.body,
    ).toEqual({
      discord_user_id: owner,
      billing: {
        customer_ids: ['cus_crew'],
        price_tiers: [{ price_id: 'price_crew', tier_id: 'galleon' }],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    review();
    expect(screen.getByText(/Link Stripe customer: Synthetic Crew/)).toBeTruthy();
    expect(screen.getByText(/This price mapping applies globally/)).toBeTruthy();
    expect(new FormData(form).get(`membership-review-${owner}`)).toBe('onboarding-proof');
    expect(
      [...new FormData(form).values()].some(
        (value) => value === 'cus_crew' || value === 'price_crew',
      ),
    ).toBe(false);
    expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith('/api/stripe/'))).toBe(false);
    expect(startMigration).not.toHaveBeenCalled();
    fireEvent.submit(form);
    expect(startMigration).toHaveBeenCalledTimes(1);
  });
  it('keeps known customer links and price mappings confirmed and blocks customers belonging to someone else', async () => {
    const fallback = fixtureApi();
    const data = structuredClone(inventory);
    data.customers[0].linked_discord_id = owner;
    data.customers[0].prices[0].tier_id = 'galleon';
    data.customers.push({
      ...data.customers[0],
      id: 'cus_other',
      name: 'Other customer',
      linked_discord_id: other,
      linked_username: 'someone_else',
    });
    const api = vi.fn(async (path, options) =>
      path.endsWith('/billing') ? data : fallback(path, options),
    ) as Api;
    setup(rows, api);
    assign();
    await billing();
    fireEvent.click(screen.getByRole('button', { name: 'Review Stripe customer links' }));
    const customer = await screen.findByRole('checkbox', {
      name: 'Stripe customer Synthetic Crew',
    });
    expect(customer).toHaveProperty('checked', true);
    expect(customer).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: 'Stripe customer Other customer' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByLabelText('Membership tier for Crew plan')).toBeNull();
    expect(screen.queryByText(/I confirm these Stripe customers/)).toBeNull();
  });
  it('supports read-only inventory refresh and bounded search without navigating away', async () => {
    const api = fixtureApi(entitlement(owner, { status: 'unlinked', allowed_slots: [1] }));
    setup(rows, api);
    assign();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    await screen.findByLabelText('Search Stripe customers');
    fireEvent.change(screen.getByLabelText('Search Stripe customers'), {
      target: { value: 'crew@example.test' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh Stripe customers' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Stripe customers' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.some(
            ([path, options]) =>
              path.endsWith('/billing') && (options?.body as { refresh?: boolean })?.refresh,
          ),
      ).toBe(true),
    );
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]?.body).toEqual({
      discord_user_id: owner,
      query: 'crew@example.test',
      refresh: true,
    });
    expect(window.location.hash).toBe('');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('preserves billing selections in memory across Back and clears them on cancel/unmount', async () => {
    const api = fixtureApi(entitlement(owner, { status: 'unlinked', allowed_slots: [1] }));
    const first = setup(rows, api);
    assign();
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    await screen.findByRole('checkbox', { name: 'Stripe customer Synthetic Crew' });
    chooseCustomer();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    expect(screen.getByRole('checkbox', { name: 'Stripe customer Synthetic Crew' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByLabelText('Membership tier for Crew plan')).toHaveProperty(
      'value',
      'galleon',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(first.close).toHaveBeenCalledTimes(1);
    first.unmount();
    setup(rows, api);
    expect(screen.getByRole('heading', { name: 'Choose account owners' })).toBeTruthy();
    expect(screen.getByLabelText('Discord owner ID')).toHaveProperty('value', '');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('ignores a stale membership response after another owner replaces it', async () => {
    const resolvers = new Map<string, (value: MigrationOwnerMembership) => void>();
    const signals = new Map<string, AbortSignal>();
    const api = vi.fn((_path, options) => {
      const id = (options?.body as { discord_user_id: string }).discord_user_id;
      signals.set(id, options!.signal!);
      return new Promise((resolve) => resolvers.set(id, resolve));
    }) as Api;
    setup(rows, api);
    assign();
    assign(other);
    expect(signals.get(owner)?.aborted).toBe(true);
    await act(async () =>
      resolvers.get(other)!(entitlement(other, { tier_name: 'Current owner tier' })),
    );
    await act(async () =>
      resolvers.get(owner)!(entitlement(owner, { tier_name: 'Stale private tier' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next: Billing' }));
    expect(screen.getByText('Current owner tier · 3 accounts')).toBeTruthy();
    expect(screen.queryByText('Stale private tier · 3 accounts')).toBeNull();
  });
  it('reviews an existing Jellyfin target inline and submits only its opaque account proof', async () => {
    const { api, form } = setup([rows[0]]);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    const target = await screen.findByLabelText('Jellyfin destination for personal-name');
    await waitFor(() => expect(target).toHaveProperty('disabled', false));
    expect(within(target).queryByRole('option', { name: 'Admin' })).toBeNull();
    expect(within(target).queryByRole('option', { name: 'Template' })).toBeNull();
    expect(within(target).queryByRole('option', { name: 'Disabled' })).toBeNull();
    fireEvent.change(target, { target: { value: 'j-alias' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next: Review' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    review();
    expect(screen.getByText('Destination alias')).toBeTruthy();
    expect(new FormData(form).get('account-review-source-a')).toBe('target-proof');
    expect(
      vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/account'))?.[1]?.body,
    ).toEqual({ source_user_id: 'source-a', target_user_id: 'j-alias' });
  });
  it('uses server template metadata when Settings has not been opened in this session', async () => {
    const fallback = fixtureApi();
    const api = vi.fn(async (path, options) =>
      path === '/api/users'
        ? {
            ...(await fallback<{ jellyfin: unknown[] }>(path, options)),
            template_user_id: 'template',
          }
        : fallback(path, options),
    ) as Api;
    setup([rows[0]], api, false, null);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    const target = await screen.findByLabelText('Jellyfin destination for personal-name');
    await waitFor(() => expect(target).toHaveProperty('disabled', false));
    expect(within(target).queryByRole('option', { name: 'Template' })).toBeNull();
    expect(within(target).getByRole('option', { name: 'Destination alias' })).toBeTruthy();
  });
  it('keeps an invalid destination visible and blocks approval until the reviewed default is restored', async () => {
    const fallback = fixtureApi();
    const api = vi.fn(async (path, options) => {
      if (path.endsWith('/account')) throw new Error('Destination is already owned.');
      return fallback(path, options);
    }) as Api;
    setup([rows[0]], api);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Accounts' }));
    const target = await screen.findByLabelText('Jellyfin destination for personal-name');
    await waitFor(() => expect(target).toHaveProperty('disabled', false));
    fireEvent.change(target, { target: { value: 'j-alias' } });
    await screen.findByText('Destination is already owned.');
    expect(screen.getByRole('button', { name: 'Next: Review' })).toHaveProperty('disabled', true);
    fireEvent.change(target, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Next: Review' })).toHaveProperty('disabled', false);
  });
  it('freezes owner controls during pending acceptance', () => {
    setup(rows, fixtureApi(), true);
    expect(screen.getByLabelText('Discord owner ID')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Next: Accounts' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
  });
});
