// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MigrationPreviewDialog from './MigrationPreviewDialog';
import type { Api, MigrationOwnerMembership, PreviewUser } from './types';

afterEach(cleanup);
const owner = '123456789012345678';
const users: PreviewUser[] = [
  { source_user_id: 'source-a', username: 'first-personal-name', target_exists: false, stats: {} },
  { source_user_id: 'source-b', username: 'unrelated-custom-name', target_exists: true, stats: {} },
];
function entitlement(
  id = owner,
  account_limit = 3,
  overrides: Partial<MigrationOwnerMembership> = {},
): MigrationOwnerMembership {
  return {
    review_token: `membership-review-${id}`,
    discord_user_id: id,
    status: 'active',
    source: 'stripe',
    tier_id: 'galleon',
    tier_name: 'Galleon',
    account_limit,
    allowed_slots: Array.from({ length: account_limit }, (_, index) => index + 1),
    message: 'The current verified subscription covers these accounts. It is applied on approval.',
    ...overrides,
  };
}
function setup(rows: PreviewUser[] = users, pending = false, apiOverride?: Api) {
  const startMigration = vi.fn((event) => event.preventDefault());
  const api =
    apiOverride ||
    (vi.fn(async (path, options) =>
      String(path).endsWith('/membership')
        ? entitlement((options?.body as { discord_user_id: string }).discord_user_id)
        : { members: [], truncated: false },
    ) as Api);
  const rendered = render(
    <MigrationPreviewDialog
      review={{ previewId: 'review-synthetic', preview: { users: rows } }}
      api={api}
      close={vi.fn()}
      refreshPreview={vi.fn()}
      startMigration={startMigration}
      busy={new Set(pending ? ['migration'] : [])}
    />,
  );
  return {
    startMigration,
    api,
    ...rendered,
    form: document.querySelector<HTMLFormElement>('#migration-preview-form')!,
  };
}
function manualOwners() {
  for (const input of screen.getAllByLabelText('Discord recipient ID (advanced)'))
    fireEvent.change(input, { target: { value: owner } });
}

describe('reviewed migration account slots', () => {
  it.each(['active', 'complimentary'] as const)(
    'can select an owner without a subscriber Discord role and use their verified %s allowance',
    async (status) => {
      const api = vi.fn(async (path, options) =>
        String(path).endsWith('/membership')
          ? entitlement((options?.body as { discord_user_id: string }).discord_user_id, 3, {
              status,
              source: status === 'complimentary' ? 'saved' : 'stripe',
              tier_name: status === 'complimentary' ? 'Complimentary' : 'Galleon',
            })
          : {
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
            },
      ) as Api;
      const { form, startMigration } = setup([users[0]], false, api);
      fireEvent.change(screen.getByLabelText('Discord recipient (optional)'), {
        target: { value: 'crew_owner' },
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Select @crew_owner' }));
      await screen.findByText(
        `${status === 'complimentary' ? 'Complimentary' : 'Galleon'} · 3 accounts`,
      );
      expect(screen.getByLabelText('Discord recipient ID (advanced)')).toHaveProperty('value', '');
      expect(new FormData(form).get('source-a')).toBe(owner);
      fireEvent.change(screen.getByLabelText('Membership account slot for first-personal-name'), {
        target: { value: '3' },
      });
      expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
        'disabled',
        false,
      );
      expect(screen.queryByText('Membership is not currently active.')).toBeNull();
      fireEvent.submit(form);
      expect(startMigration).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledTimes(2);
    },
  );

  it('requires distinct reviewed slots when arbitrary account names share one manually confirmed owner', async () => {
    const { startMigration, form } = setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    manualOwners();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(
      screen
        .getByLabelText('Membership account slot for first-personal-name')
        .getAttribute('aria-invalid'),
    ).toBe('true');
    fireEvent.submit(form);
    expect(startMigration).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Membership account slot for unrelated-custom-name'), {
      target: { value: '2' },
    });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    const submitted = new FormData(form);
    expect(submitted.get('slot-source-a')).toBe('1');
    expect(submitted.get('slot-source-b')).toBe('2');
    fireEvent.submit(form);
    expect(startMigration).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('dialog')).getByText('unrelated-custom-name')).toBeTruthy();
    expect(screen.getByText(/account names stay unchanged/)).toBeTruthy();
  });

  it('allows the same slot for different Discord owners and exposes slot 3', async () => {
    setup();
    const inputs = screen.getAllByLabelText('Discord recipient ID (advanced)');
    fireEvent.change(inputs[0], { target: { value: owner } });
    fireEvent.change(inputs[1], { target: { value: '234567890123456789' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.change(screen.getByLabelText('Membership account slot for unrelated-custom-name'), {
      target: { value: '3' },
    });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('clears a collision when the manually entered owner is cleared without submitting ownership', async () => {
    const { form } = setup();
    manualOwners();
    fireEvent.change(screen.getAllByLabelText('Discord recipient ID (advanced)')[1], {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(new FormData(form).has('slot-source-b')).toBe(false);
  });

  it.each(['mapping', 'approved', 'numbered_suggestion'] as const)(
    'keeps %s ownership fixed and out of manually assigned slots',
    (owner_basis) => {
      const { form } = setup([
        {
          ...users[0],
          discord_user_id: owner,
          discord_username: 'household_owner',
          membership_slot: 2,
          owner_basis,
        },
      ]);
      expect(
        screen.getByLabelText('Membership account slot for first-personal-name'),
      ).toHaveProperty('disabled', true);
      expect(
        screen.getByRole('button', { name: 'Clear Discord member @household_owner' }),
      ).toHaveProperty('disabled', true);
      expect(new FormData(form).has('slot-source-a')).toBe(false);
      expect(screen.getByText(/Change a confirmed slot through User mappings/)).toBeTruthy();
    },
  );

  it('keeps an ownerless custom mapping editable without changing its destination name', async () => {
    const { form } = setup([
      {
        ...users[0],
        mapping_id: 'ownerless-map',
        source_username: 'source-custom',
        username: 'destination-custom',
        membership_slot: 2,
      },
    ]);
    fireEvent.change(screen.getByLabelText('Discord recipient ID (advanced)'), {
      target: { value: owner },
    });
    const slot = screen.getByLabelText('Membership account slot for destination-custom');
    await waitFor(() => expect(slot).toHaveProperty('disabled', false));
    expect(slot).toHaveProperty('disabled', false);
    expect(new FormData(form).get('slot-source-a')).toBe('2');
    expect(
      screen.getByText('Mapped Emby account: source-custom → Jellyfin: destination-custom'),
    ).toBeTruthy();
  });

  it('freezes reviewed recipients and slots while acceptance is pending', () => {
    setup([{ ...users[0], discord_user_id: owner, discord_username: 'household_owner' }], true);
    expect(
      screen.getByRole('button', { name: 'Clear Discord member @household_owner' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Membership account slot for first-personal-name')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Starting migration…' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('protects history-only users from recipient and slot controls', () => {
    const { api } = setup([
      {
        ...users[0],
        history_only: true,
        target_exists: true,
        discord_user_id: owner,
        membership_slot: 2,
      },
    ]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Advanced Discord details')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(api).not.toHaveBeenCalled();
  });

  it('resolves one Galleon allowance for three arbitrarily named accounts and applies no client tier', async () => {
    const rows = [...users, { ...users[0], source_user_id: 'source-c', username: 'third-custom' }];
    const { api, form, startMigration } = setup(rows);
    manualOwners();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      true,
    );
    await waitFor(() => expect(screen.getAllByText('Galleon · 3 accounts')).toHaveLength(3));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/migrations/preview/review-synthetic/membership', {
      method: 'POST',
      body: { discord_user_id: owner },
      signal: expect.any(AbortSignal),
    });
    fireEvent.change(screen.getByLabelText('Membership account slot for unrelated-custom-name'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Membership account slot for third-custom'), {
      target: { value: '3' },
    });
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    expect([...new FormData(form).keys()].some((name) => /tier|allowance/.test(name))).toBe(false);
    expect(new FormData(form).getAll(`membership-review-${owner}`)).toEqual([
      `membership-review-${owner}`,
    ]);
    fireEvent.submit(form);
    expect(startMigration).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('waits for membership resolution and ignores the picker’s active role as a tier', async () => {
    let resolve!: (value: MigrationOwnerMembership) => void;
    const api = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ) as Api;
    const { startMigration, form } = setup(
      [
        {
          ...users[0],
          discord_user_id: owner,
          discord_username: 'crew_owner',
          membership_slot: 3,
        },
      ],
      false,
      api,
    );
    expect(screen.getByRole('status').textContent).toContain('Checking this Discord owner');
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.submit(form);
    expect(startMigration).not.toHaveBeenCalled();
    await act(async () => resolve(entitlement(owner, 1, { tier_name: 'Sloop', tier_id: 'sloop' })));
    expect(screen.getByText('Sloop · 1 account')).toBeTruthy();
    const slot = screen.getByLabelText('Membership account slot for first-personal-name');
    expect(slot).toHaveProperty('value', '3');
    expect(within(slot).getByRole('option', { name: 'Account 3' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('alert').textContent).toContain('not covered');
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it.each(['inactive', 'held'] as const)(
    'keeps %s membership blocked without changing a locked owner or slot',
    async (status) => {
      const api = vi.fn(async () => entitlement(owner, 0, { status, account_limit: null })) as Api;
      setup(
        [
          {
            ...users[0],
            discord_user_id: owner,
            discord_username: 'crew_owner',
            membership_slot: 2,
            owner_basis: 'approved',
          },
        ],
        false,
        api,
      );
      await screen.findByText(
        status === 'held' ? 'Membership needs review' : 'Membership inactive',
      );
      const slot = screen.getByLabelText('Membership account slot for first-personal-name');
      expect(slot).toHaveProperty('value', '2');
      expect(slot).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(api).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves legacy single-account approval but clearly disables unverified extra slots', async () => {
    const api = vi.fn(async () =>
      entitlement(owner, 1, {
        status: 'unlinked',
        source: 'legacy',
        tier_id: null,
        tier_name: null,
        account_limit: null,
        message:
          'No saved membership was found. One manually approved account is allowed; extra slots need a verified membership.',
      }),
    ) as Api;
    setup([users[0]], false, api);
    fireEvent.change(screen.getByLabelText('Discord recipient ID (advanced)'), {
      target: { value: owner },
    });
    await screen.findByText('No saved membership');
    expect(screen.getByText(/extra slots need a verified membership/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    const slot = screen.getByLabelText('Membership account slot for first-personal-name');
    expect(within(slot).getByRole('option', { name: 'Account 2' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('distinguishes an unlinked Stripe identity from missing saved membership and preserves the server explanation', async () => {
    const message =
      'Approve this Discord member’s Stripe customer link to find their paid tier automatically.';
    const api = vi.fn(async () =>
      entitlement(owner, 1, {
        status: 'unlinked',
        source: 'stripe',
        tier_id: null,
        tier_name: null,
        account_limit: null,
        message,
      }),
    ) as Api;
    setup([users[0]], false, api);
    fireEvent.change(screen.getByLabelText('Discord recipient ID (advanced)'), {
      target: { value: owner },
    });
    await screen.findByText('Stripe identity not linked');
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText('No saved membership')).toBeNull();
    expect(screen.queryByText(/no (?:active )?subscription/i)).toBeNull();
  });

  it('keeps complimentary allowances usable without billing or role assumptions', async () => {
    const api = vi.fn(async () =>
      entitlement(owner, 2, {
        status: 'complimentary',
        source: 'saved',
        tier_name: 'Family',
        tier_id: 'complimentary',
        message: 'Complimentary access remains managed by an administrator.',
      }),
    ) as Api;
    setup([users[0]], false, api);
    fireEvent.change(screen.getByLabelText('Discord recipient ID (advanced)'), {
      target: { value: owner },
    });
    await screen.findByText('Family · 2 accounts');
    fireEvent.change(screen.getByLabelText('Membership account slot for first-personal-name'), {
      target: { value: '2' },
    });
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('allows an inline retry after a failed lookup and never submits before that succeeds', async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error('Billing could not be checked.'))
      .mockResolvedValue(entitlement()) as Api;
    const { form, startMigration } = setup([users[0]], false, api);
    fireEvent.change(screen.getByLabelText('Discord recipient ID (advanced)'), {
      target: { value: owner },
    });
    await screen.findByText('Billing could not be checked.');
    fireEvent.submit(form);
    expect(startMigration).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Check membership again for first-personal-name' }),
    );
    await screen.findByText('Galleon · 3 accounts');
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('aborts removed owners and ignores a stale lookup after a different owner is selected', async () => {
    const resolvers = new Map<string, (value: MigrationOwnerMembership) => void>();
    const signals = new Map<string, AbortSignal>();
    const api = vi.fn((_path, options) => {
      const id = (options?.body as { discord_user_id: string }).discord_user_id;
      signals.set(id, options!.signal!);
      return new Promise((resolve) => resolvers.set(id, resolve));
    }) as Api;
    const { unmount } = setup([users[0]], false, api);
    const input = screen.getByLabelText('Discord recipient ID (advanced)');
    fireEvent.change(input, { target: { value: owner } });
    const other = '234567890123456789';
    fireEvent.change(input, { target: { value: other } });
    expect(signals.get(owner)?.aborted).toBe(true);
    await act(async () =>
      resolvers.get(other)!(entitlement(other, 2, { tier_name: 'Brigantine' })),
    );
    expect(screen.getByText('Brigantine · 2 accounts')).toBeTruthy();
    await act(async () => resolvers.get(owner)!(entitlement()));
    expect(screen.queryByText('Galleon · 3 accounts')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.change(input, { target: { value: owner } });
    expect(api).toHaveBeenCalledTimes(3);
    unmount();
    expect(signals.get(owner)?.aborted).toBe(true);
  });

  it('retains an in-flight lookup when another distinct owner is added', async () => {
    const api = vi.fn(() => new Promise(() => {})) as Api;
    setup(users, false, api);
    const inputs = screen.getAllByLabelText('Discord recipient ID (advanced)');
    fireEvent.change(inputs[0], { target: { value: owner } });
    fireEvent.change(inputs[1], { target: { value: '234567890123456789' } });
    expect(api).toHaveBeenCalledTimes(2);
    const first = vi.mocked(api).mock.calls[0][1]!.signal!;
    expect(first.aborted).toBe(false);
  });
});
