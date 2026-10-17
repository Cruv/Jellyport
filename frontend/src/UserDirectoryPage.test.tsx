// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import UserDirectoryPage from './UserDirectoryPage';
import type { Api, ApiOptions, DirectoryUser, Settings } from './types';

const discordId = '123456789012345678';
const users: DirectoryUser[] = [
  {
    id: 'family',
    emby: [
      {
        id: 'emby-family',
        name: 'Family',
        disabled: false,
        protected: false,
        profile: {
          family: true,
          owner_name: 'Jordan',
          notes: 'Emby account details',
          revision: 'emby-profile-revision',
        },
      },
    ],
    jellyfin: [
      {
        id: 'jf-family',
        name: 'Family',
        disabled: false,
        protected: false,
        profile: {
          family: true,
          owner_name: 'Sam',
          notes: 'Private family details',
          revision: 'jf-profile-revision',
        },
      },
    ],
    discord_user_id: discordId,
    discord_username: 'family_owner',
    access_mode: 'complimentary',
    account_limit: 2,
    protected: false,
    family: true,
  },
  {
    id: 'child',
    emby: [],
    jellyfin: [{ id: 'jf-child', name: 'Child', disabled: false, protected: false }],
    discord_user_id: null,
    discord_username: null,
    access_mode: 'standalone',
    account_limit: null,
    protected: false,
    requires_review: true,
  },
  {
    id: 'legacy',
    emby: [{ id: 'emby-legacy', name: 'Legacy', disabled: false, protected: false }],
    jellyfin: [],
    discord_user_id: null,
    discord_username: null,
    access_mode: 'unlinked',
    account_limit: null,
    protected: false,
  },
  {
    id: 'admin',
    emby: [],
    jellyfin: [{ id: 'jf-admin', name: 'Admin', disabled: false, protected: true }],
    discord_user_id: null,
    discord_username: null,
    access_mode: 'unlinked',
    account_limit: null,
    protected: true,
  },
];
const settings = {
  discord_enabled: true,
  discord_emby_role_id: 'role-emby',
  discord_jellyfin_role_id: 'role-jellyfin',
  discord_auto_role_sync: false,
  discord_emby_only_role: true,
} as Settings;
function page(custom?: Api, values = settings) {
  const requests: { path: string; options?: ApiOptions }[] = [];
  const api =
    custom ||
    (vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      if (path === '/api/user-directory') return { users };
      if (path.startsWith('/api/discord/members?'))
        return {
          members: [
            {
              id: discordId,
              username: 'family_owner',
              display_name: null,
              nickname: null,
              membership_active: false,
            },
          ],
          truncated: false,
        };
      if (path === '/api/accounts/link') return {};
      if (path === '/api/account-profiles') return {};
      if (path === '/api/accounts/access') return {};
      if (path === '/api/discord/tag-roles')
        return {
          can_manage_roles: true,
          roles: [
            { id: 'role-emby', name: 'Emby only', manageable: true },
            { id: 'role-jellyfin', name: 'Jellyfin', manageable: true },
            { id: 'role-admin', name: 'Administrator', manageable: false },
          ],
        };
      if (path === '/api/discord/tags/preview')
        return {
          token: 'review-token',
          changes: [
            {
              discord_user_id: discordId,
              username: 'family_owner',
              add: ['role-jellyfin'],
              remove: ['role-emby'],
            },
          ],
          unchanged: 2,
          unlinked: 1,
        };
      if (path === '/api/discord/tags/apply') return { updated: 1, failed: 0 };
      if (path === '/api/settings') return {};
      throw new Error(`Unexpected request ${path}`);
    }) as Api);
  const notify = vi.fn();
  const navigate = vi.fn();
  return {
    ...render(
      <UserDirectoryPage settings={values} api={api} notify={notify} navigate={navigate} />,
    ),
    requests,
    notify,
    navigate,
  };
}
async function accountAction(name: string) {
  const username = name.slice(name.lastIndexOf(' for ') + 5);
  fireEvent.click(await screen.findByRole('button', { name: `Manage ${username}` }));
  return screen.getByRole('button', { name });
}
function organization() {
  fireEvent.click(screen.getByRole('tab', { name: 'Discord organization' }));
  fireEvent.click(screen.getByRole('button', { name: 'Configure roles' }));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('User directory and Discord organization', () => {
  const largeDirectory = (count = 103): DirectoryUser[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `member-${index + 1}`,
      emby: [],
      jellyfin: [
        {
          id: `jf-member-${index + 1}`,
          name: `Member ${String(index + 1).padStart(3, '0')}`,
          disabled: false,
          protected: false,
        },
      ],
      discord_user_id: null,
      discord_username: null,
      access_mode: 'standalone',
      account_limit: null,
      protected: false,
    }));

  it('bounds large directories to one page and resets pagination when filters or row size change', async () => {
    const api = vi.fn(async () => ({ users: largeDirectory() })) as Api;
    page(api);
    const table = await screen.findByRole('table', {
      name: 'Media accounts and confirmed ownership',
    });
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByText('1–25 of 103')).toBeTruthy();
    expect(screen.queryByText('Member 026')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Member 026')).toBeTruthy();
    expect(screen.queryByText('Member 001')).toBeNull();
    expect(screen.getByText('26–50 of 103')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'Member 10' } });
    expect(screen.getByText('1–4 of 4')).toBeTruthy();
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Member 001')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Users per page'), { target: { value: '10' } });
    expect(screen.getByText('1–10 of 103')).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('clamps the current page after refresh removes users without showing an empty page', async () => {
    let values = largeDirectory();
    const api = vi.fn(async () => ({ users: values })) as Api;
    page(api);
    await screen.findByText('Member 001');
    for (let index = 0; index < 4; index++)
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('101–103 of 103')).toBeTruthy();
    values = largeDirectory(30);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('26–30 of 30');
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(screen.getByText('Member 026')).toBeTruthy();
    expect(screen.queryByText('Member 101')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('keeps directory filters and unsaved organization settings when switching task tabs', async () => {
    const { requests } = page();
    await screen.findByText('Child');
    expect(screen.queryByRole('heading', { name: 'Discord organization roles' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Access policy' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'Child' } });
    organization();
    await screen.findByLabelText('Emby-only role');
    fireEvent.click(
      screen.getByLabelText('Reserve the Emby role for owners who have only Emby accounts'),
    );
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Directory/ }));
    expect(screen.getByLabelText('Search users')).toHaveProperty('value', 'Child');
    expect(screen.getByText('Child')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Discord organization' }));
    expect(
      screen.getByLabelText('Reserve the Emby role for owners who have only Emby accounts'),
    ).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Preview role changes' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(requests.filter((entry) => entry.options?.method)).toHaveLength(0);
    expect(requests.filter((entry) => entry.path === '/api/user-directory')).toHaveLength(1);
  });

  it('opens one compact management disclosure at a time and closes it with Escape without changing accounts', async () => {
    const { requests } = page();
    const childButton = await screen.findByRole('button', { name: 'Manage Child' });
    expect(screen.queryByRole('button', { name: 'Manage account access for Child' })).toBeNull();
    fireEvent.click(childButton);
    expect(childButton).toHaveProperty('ariaExpanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Manage Family' }));
    expect(screen.queryByRole('button', { name: 'Manage account access for Child' })).toBeNull();
    const familyAction = screen.getByRole('button', { name: 'Manage account access for Family' });
    familyAction.focus();
    fireEvent.keyDown(familyAction, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Manage account access for Family' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage Family' }));
    expect(requests.filter((entry) => entry.options?.method)).toHaveLength(0);
  });

  it('reviews and updates the exact account selected on a later page', async () => {
    const requests: { path: string; options?: ApiOptions }[] = [];
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      return path === '/api/user-directory' ? { users: largeDirectory() } : {};
    }) as Api;
    const { notify } = page(api);
    await screen.findByText('Member 001');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(await accountAction('Manage account access for Member 026'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Media account')).toHaveProperty(
      'value',
      JSON.stringify(['jellyfin', 'jf-member-26']),
    );
    expect(requests.filter((entry) => entry.options?.method)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable selected account' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(requests.find((entry) => entry.path === '/api/accounts/access')?.options?.body).toEqual({
      kind: 'jellyfin',
      user_id: 'jf-member-26',
      disabled: true,
      expected_username: 'Member 026',
      expected_profile_revision: '',
    });
  });

  it('prioritizes account review and the directory before optional access guidance', async () => {
    page();
    const warning = await screen.findByText('1 user needs review');
    const directory = screen.getByRole('table', { name: 'Media accounts and confirmed ownership' });
    const guidance = screen.getByText('Discord and subscriptions are optional.');
    expect(
      warning.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      directory.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByText('About family accounts and account ownership'));
    expect(screen.getByRole('button', { name: 'Memberships' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show users needing review' })).toBeTruthy();
  });

  it('shows the filtered result count and clears all filters without requesting the servers again', async () => {
    const { requests } = page();
    await screen.findByText('Showing 4 of 4 users');
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy();
    expect(
      screen.getByRole('table', { name: 'Media accounts and confirmed ownership' }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'Child' } });
    fireEvent.change(screen.getByLabelText('Server presence'), { target: { value: 'jellyfin' } });
    fireEvent.change(screen.getByLabelText('Account review'), { target: { value: 'review' } });
    expect(screen.getByText('Showing 1 of 4 users')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Showing 4 of 4 users')).toBeTruthy();
    expect(screen.getByLabelText('Search users')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Server presence')).toHaveProperty('value', 'all');
    expect(screen.getByLabelText('Account review')).toHaveProperty('value', 'all');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('keeps manual account creation reachable when the directory cannot load', async () => {
    const api = vi.fn(async () => {
      throw new Error('The Emby server is unavailable.');
    }) as Api;
    const { navigate } = page(api);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Create Jellyfin account' }));
    expect(navigate).toHaveBeenCalledWith('accounts');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/user-directory', {
      signal: expect.any(AbortSignal),
    });
  });

  it('shows standalone family accounts and filters server presence and access independently', async () => {
    page();
    await accountAction('Link Discord owner for Child');
    expect(screen.queryByRole('button', { name: 'Link Discord owner for Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage account access for Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Family and owner notes for Admin' })).toBeNull();
    expect(screen.getByText('Complimentary · Both servers')).toBeTruthy();
    expect(screen.getByText('Independent · Jellyfin only')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Server presence'), { target: { value: 'emby' } });
    expect(screen.getByText('Legacy')).toBeTruthy();
    expect(screen.queryByText('Child')).toBeNull();
    fireEvent.change(screen.getByLabelText('Server presence'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    expect(screen.getByText('@family_owner')).toBeTruthy();
    expect(screen.queryByText('Legacy')).toBeNull();
  });

  it.each(['emby', 'jellyfin'] as const)(
    'allows exact-account family and access review when the matching %s account is protected',
    async (protectedKind) => {
      const editableKind = protectedKind === 'emby' ? 'jellyfin' : 'emby';
      const row: DirectoryUser = {
        id: 'same-name-pair',
        emby: [
          {
            id: 'emby-shared',
            name: 'Shared',
            disabled: false,
            protected: protectedKind === 'emby',
          },
        ],
        jellyfin: [
          {
            id: 'jellyfin-shared',
            name: 'Shared',
            disabled: false,
            protected: protectedKind === 'jellyfin',
          },
        ],
        discord_user_id: null,
        discord_username: null,
        access_mode: 'standalone',
        account_limit: null,
        protected: true,
        requires_review: true,
      };
      const requests: { path: string; options?: ApiOptions }[] = [];
      const api = vi.fn(async (path: string, options?: ApiOptions) => {
        requests.push({ path, options });
        return path === '/api/user-directory' ? { users: [row] } : {};
      }) as Api;
      const { notify } = page(api);
      fireEvent.click(await accountAction('Family and owner notes for Shared'));
      let dialog = screen.getByRole('dialog');
      let selector = within(dialog).getByLabelText('Media account');
      expect(within(selector).getAllByRole('option')).toHaveLength(1);
      expect(selector).toHaveProperty(
        'value',
        JSON.stringify([editableKind, `${editableKind}-shared`]),
      );
      fireEvent.click(within(dialog).getByLabelText('Family account'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save family and owner notes' }));
      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(
        requests.find((entry) => entry.path === '/api/account-profiles')?.options?.body,
      ).toEqual({
        kind: editableKind,
        user_id: `${editableKind}-shared`,
        family: true,
        owner_name: '',
        notes: '',
        expected_revision: '',
      });
      fireEvent.click(await accountAction('Manage account access for Shared'));
      dialog = screen.getByRole('dialog');
      selector = within(dialog).getByLabelText('Media account');
      expect(within(selector).getAllByRole('option')).toHaveLength(1);
      expect(selector).toHaveProperty(
        'value',
        JSON.stringify([editableKind, `${editableKind}-shared`]),
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable selected account' }));
      await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
      expect(
        requests.find((entry) => entry.path === '/api/accounts/access')?.options?.body,
      ).toEqual({
        kind: editableKind,
        user_id: `${editableKind}-shared`,
        disabled: true,
        expected_username: 'Shared',
        expected_profile_revision: '',
      });
    },
  );

  it('confirms an exact existing account ID and a queried non-paying Discord owner without changing passwords', async () => {
    const { requests, notify } = page();
    fireEvent.click(await accountAction('Link Discord owner for Child'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Discord member'), {
      target: { value: 'family_owner' },
    });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Select @family_owner' }));
    fireEvent.change(within(dialog).getByLabelText('Owner’s account slot'), {
      target: { value: '2' },
    });
    expect(requests.filter((entry) => entry.options?.method)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm account owner' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(requests.filter((entry) => entry.options?.method)).toEqual([
      {
        path: '/api/accounts/link',
        options: expect.objectContaining({
          method: 'POST',
          body: { discord_user_id: discordId, jellyfin_user_id: 'jf-child', membership_slot: 2 },
        }),
      },
    ]);
  });

  it('filters family owners and searches owner names without exposing private notes in the directory', async () => {
    page();
    await screen.findByText('Owner: Sam');
    expect(screen.getByText('Family accounts', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText('Private family details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
    fireEvent.change(screen.getByLabelText('Family accounts'), { target: { value: 'family' } });
    expect(screen.getByText('@family_owner')).toBeTruthy();
    expect(screen.queryByText('Child')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'Jordan' } });
    expect(screen.getByText('@family_owner')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Family accounts'), { target: { value: 'other' } });
    expect(screen.queryByText('@family_owner')).toBeNull();
  });

  it('highlights unlinked non-family accounts for review without proposing automatic disablement', async () => {
    page();
    await screen.findByText('1 user needs review');
    expect(screen.getByText(/They will not be automatically disabled/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show users needing review' }));
    expect(screen.getByLabelText('Account review')).toHaveProperty('value', 'review');
    expect(screen.getByText('Child')).toBeTruthy();
    expect(screen.queryByText('@family_owner')).toBeNull();
    expect(screen.queryByText('Legacy')).toBeNull();
    fireEvent.change(screen.getByLabelText('Account review'), { target: { value: 'all' } });
    expect(screen.getByText('Legacy')).toBeTruthy();
  });

  it('edits only the selected account family flag even when another account in the row is family', async () => {
    const values = users.map((user) =>
      user.id === 'family'
        ? {
            ...user,
            jellyfin: user.jellyfin.map((account) => ({
              ...account,
              profile: { ...account.profile!, family: false },
            })),
          }
        : user,
    );
    page(vi.fn(async () => ({ users: values })) as Api);
    fireEvent.click(await accountAction('Family and owner notes for Family'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Family account')).toHaveProperty('checked', false);
    fireEvent.change(within(dialog).getByLabelText('Media account'), {
      target: { value: JSON.stringify(['emby', 'emby-family']) },
    });
    expect(within(dialog).getByLabelText('Family account')).toHaveProperty('checked', true);
  });

  it('saves private metadata for the selected exact server account with its revision', async () => {
    const { requests, notify } = page();
    fireEvent.click(await accountAction('Family and owner notes for Family'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Owner name')).toHaveProperty('value', 'Sam');
    expect(within(dialog).getByLabelText('Private owner notes')).toHaveProperty(
      'value',
      'Private family details',
    );
    expect(within(dialog).getByLabelText('Family account')).toHaveProperty('checked', true);
    expect(within(dialog).getByText(/This flag applies only to the selected account/)).toBeTruthy();
    expect(within(dialog).getByText(/Never sent to Discord/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Media account'), {
      target: { value: JSON.stringify(['emby', 'emby-family']) },
    });
    expect(within(dialog).getByLabelText('Owner name')).toHaveProperty('value', 'Jordan');
    expect(within(dialog).getByLabelText('Private owner notes')).toHaveProperty(
      'value',
      'Emby account details',
    );
    fireEvent.change(within(dialog).getByLabelText('Private owner notes'), {
      target: { value: 'Shared with Jordan’s family' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save family and owner notes' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Family flag and private owner notes saved.'),
    );
    expect(requests.filter((entry) => entry.options?.method)).toEqual([
      {
        path: '/api/account-profiles',
        options: expect.objectContaining({
          method: 'POST',
          body: {
            kind: 'emby',
            user_id: 'emby-family',
            family: true,
            owner_name: 'Jordan',
            notes: 'Shared with Jordan’s family',
            expected_revision: 'emby-profile-revision',
          },
        }),
      },
    ]);
  });

  it('marks an independent child account as family without requiring a Discord owner', async () => {
    const { requests, notify } = page();
    fireEvent.click(await accountAction('Family and owner notes for Child'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Discord member')).toBeNull();
    expect(within(dialog).getByText(/No Discord membership or payment is required/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Owner name')).toHaveProperty('maxLength', 120);
    expect(within(dialog).getByLabelText('Private owner notes')).toHaveProperty('maxLength', 2000);
    fireEvent.click(within(dialog).getByLabelText('Family account'));
    fireEvent.change(within(dialog).getByLabelText('Owner name'), { target: { value: 'Alex' } });
    fireEvent.change(within(dialog).getByLabelText('Private owner notes'), {
      target: { value: 'Kid’s account' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save family and owner notes' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(requests.find((entry) => entry.path === '/api/account-profiles')?.options?.body).toEqual(
      {
        kind: 'jellyfin',
        user_id: 'jf-child',
        family: true,
        owner_name: 'Alex',
        notes: 'Kid’s account',
        expected_revision: '',
      },
    );
  });

  it('removes a family flag without requesting subscription management', async () => {
    const { requests, notify } = page();
    fireEvent.click(await accountAction('Family and owner notes for Family'));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(/Removing the family flag does not disable the account/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('Family account'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save family and owner notes' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    const mutations = requests.filter((entry) => entry.options?.method);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].path).toBe('/api/account-profiles');
    expect(mutations[0].options?.body).toMatchObject({ family: false });
  });

  it('shows a rejected stale profile save without discarding private drafts', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/user-directory') return { users };
      throw new Error('Account profile changed. Refresh and review the latest details.');
    }) as Api;
    const { notify } = page(api);
    fireEvent.click(await accountAction('Family and owner notes for Child'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Private owner notes'), {
      target: { value: 'My unsaved private note' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save family and owner notes' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'Account profile changed. Refresh and review the latest details.',
    );
    expect(within(dialog).getByLabelText('Private owner notes')).toHaveProperty(
      'value',
      'My unsaved private note',
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('aborts profile saves on unmount and ignores late success callbacks', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const api = vi.fn((path: string, options?: ApiOptions) => {
      if (path === '/api/user-directory') return Promise.resolve({ users });
      signal = options!.signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, notify } = page(api);
    fireEvent.click(await accountAction('Family and owner notes for Child'));
    fireEvent.click(screen.getByRole('button', { name: 'Save family and owner notes' }));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({}));
    expect(notify).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('requires explicit account access review and disables only the selected exact account', async () => {
    const { requests, notify } = page();
    fireEvent.click(await accountAction('Manage account access for Family'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Currently enabled.')).toBeTruthy();
    expect(
      within(dialog).getByText(
        /watch history, favorites, playlists, and preferences are preserved/,
      ),
    ).toBeTruthy();
    expect(requests.filter((entry) => entry.options?.method)).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Media account'), {
      target: { value: JSON.stringify(['emby', 'emby-family']) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable selected account' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Account disabled. Its password and media data are preserved.',
      ),
    );
    expect(requests.filter((entry) => entry.options?.method)).toEqual([
      {
        path: '/api/accounts/access',
        options: expect.objectContaining({
          method: 'POST',
          body: {
            kind: 'emby',
            user_id: 'emby-family',
            disabled: true,
            expected_username: 'Family',
            expected_profile_revision: 'emby-profile-revision',
          },
        }),
      },
    ]);
  });

  it('reviews enabling disabled accounts and prevents unchanged access requests', async () => {
    const requests: { path: string; options?: ApiOptions }[] = [];
    const values = users.map((user) =>
      user.id === 'child'
        ? { ...user, jellyfin: user.jellyfin.map((account) => ({ ...account, disabled: true })) }
        : user,
    );
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      return path === '/api/user-directory' ? { users: values } : {};
    }) as Api;
    const { notify } = page(api);
    fireEvent.click(await accountAction('Manage account access for Child'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Currently disabled.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Access change')).toHaveProperty('value', 'enable');
    fireEvent.change(within(dialog).getByLabelText('Access change'), {
      target: { value: 'disable' },
    });
    expect(within(dialog).getByRole('button', { name: 'Disable selected account' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(within(dialog).getByLabelText('Access change'), {
      target: { value: 'enable' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable selected account' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(requests.find((entry) => entry.path === '/api/accounts/access')?.options?.body).toEqual({
      kind: 'jellyfin',
      user_id: 'jf-child',
      disabled: false,
      expected_username: 'Child',
      expected_profile_revision: '',
    });
  });

  it('aborts access changes on unmount and ignores late completion', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const api = vi.fn((path: string, options?: ApiOptions) => {
      if (path === '/api/user-directory') return Promise.resolve({ users });
      signal = options!.signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, notify } = page(api);
    fireEvent.click(await accountAction('Manage account access for Child'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable selected account' }));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({}));
    expect(notify).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('previews organization role additions and removals before applying only the review token', async () => {
    const { requests, notify } = page();
    organization();
    const previewButton = await screen.findByRole('button', { name: 'Preview role changes' });
    expect(
      screen
        .getAllByRole('option', { name: 'Administrator · unavailable' })
        .every((option) => (option as HTMLOptionElement).disabled),
    ).toBe(true);
    expect(
      screen.getByLabelText('Automatically keep organization roles up to date'),
    ).toHaveProperty('checked', false);
    fireEvent.click(previewButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add: Jellyfin')).toBeTruthy();
    expect(within(dialog).getByText('Remove: Emby only')).toBeTruthy();
    expect(requests.some((entry) => entry.path.endsWith('/apply'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply role changes' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('1 Discord members updated.', false));
    expect(requests.find((entry) => entry.path.endsWith('/apply'))?.options?.body).toEqual({
      token: 'review-token',
    });
  });

  it('defaults to tagging every server when no exclusive preference is saved', async () => {
    page(undefined, { ...settings, discord_emby_only_role: undefined });
    organization();
    expect(await screen.findByLabelText('Emby account role')).toBeTruthy();
    expect(
      screen.getByLabelText('Reserve the Emby role for owners who have only Emby accounts'),
    ).toHaveProperty('checked', false);
  });

  it('requires saving edited role settings before preview and sends only organization settings', async () => {
    const { requests } = page();
    organization();
    await screen.findByLabelText('Emby-only role');
    fireEvent.click(
      screen.getByLabelText('Reserve the Emby role for owners who have only Emby accounts'),
    );
    expect(screen.getByRole('button', { name: 'Preview role changes' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save organization settings' }));
    await waitFor(() =>
      expect(requests.find((entry) => entry.path === '/api/settings')).toBeTruthy(),
    );
    expect(requests.find((entry) => entry.path === '/api/settings')?.options?.body).toEqual({
      discord_emby_role_id: 'role-emby',
      discord_jellyfin_role_id: 'role-jellyfin',
      discord_auto_role_sync: false,
      discord_emby_only_role: false,
    });
  });

  it('aborts directory reads on unmount and ignores late private data', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const api = vi.fn((_path: string, options?: ApiOptions) => {
      signal = options!.signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, notify } = page(api);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ users }));
    expect(screen.queryByText('@family_owner')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
  it('offers the server-provided permission update link when the bot cannot manage roles', async () => {
    const invite =
      'https://discord.com/oauth2/authorize?client_id=123456789012345678&permissions=268504064&scope=bot%20applications.commands';
    const api = vi.fn(async (path: string) =>
      path === '/api/user-directory' ? { users } : { roles: [], can_manage_roles: false },
    ) as Api;
    const { rerender, notify, navigate } = page(api, {
      ...settings,
      bot_organization_invite_url: invite,
    });
    organization();
    const link = await screen.findByRole('link', { name: 'Update bot permissions' });
    expect(link.getAttribute('href')).toBe(invite);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    rerender(
      <UserDirectoryPage
        settings={{ ...settings, bot_organization_invite_url: 'javascript:alert(1)' }}
        api={api}
        notify={notify}
        navigate={navigate}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Update bot permissions' })).toBeNull();
  });
  it('reports confirmed former Discord members skipped by the organization preview', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/user-directory') return { users };
      if (path === '/api/discord/tag-roles') return { roles: [], can_manage_roles: true };
      return {
        token: 'review-former-member',
        changes: [],
        unchanged: 2,
        unlinked: 0,
        unavailable: 1,
      };
    }) as Api;
    page(api);
    organization();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview role changes' }));
    expect(
      await screen.findByText(
        '0 members with changes · 2 unchanged · 0 unlinked accounts skipped · 1 no longer in Discord',
      ),
    ).toBeTruthy();
  });
});
