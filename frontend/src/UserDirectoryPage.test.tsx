// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import UserDirectoryPage from './UserDirectoryPage';
import type { Api, ApiOptions, DirectoryUser, Settings } from './types';

const discordId = '123456789012345678';
const users: DirectoryUser[] = [
  {
    id: 'family',
    emby: [{ id: 'emby-family', name: 'Family', disabled: false }],
    jellyfin: [{ id: 'jf-family', name: 'Family', disabled: false }],
    discord_user_id: discordId,
    discord_username: 'family_owner',
    access_mode: 'complimentary',
    account_limit: 2,
    protected: false,
  },
  {
    id: 'child',
    emby: [],
    jellyfin: [{ id: 'jf-child', name: 'Child', disabled: false }],
    discord_user_id: null,
    discord_username: null,
    access_mode: 'standalone',
    account_limit: null,
    protected: false,
  },
  {
    id: 'legacy',
    emby: [{ id: 'emby-legacy', name: 'Legacy', disabled: false }],
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
    jellyfin: [{ id: 'jf-admin', name: 'Admin', disabled: false }],
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('User directory and Discord organization', () => {
  it('shows standalone family accounts and filters server presence and access independently', async () => {
    page();
    await screen.findByRole('button', { name: 'Link Discord owner for Child' });
    expect(screen.queryByRole('button', { name: 'Link Discord owner for Admin' })).toBeNull();
    expect(screen.getByText('Complimentary · Both servers')).toBeTruthy();
    expect(screen.getByText('Independent · Jellyfin only')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Server presence'), { target: { value: 'emby' } });
    expect(screen.getByText('Legacy')).toBeTruthy();
    expect(screen.queryByText('Child')).toBeNull();
    fireEvent.change(screen.getByLabelText('Server presence'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    expect(screen.getByText('@family_owner')).toBeTruthy();
    expect(screen.queryByText('Legacy')).toBeNull();
  });

  it('confirms an exact existing account ID and a queried non-paying Discord owner without changing passwords', async () => {
    const { requests, notify } = page();
    fireEvent.click(await screen.findByRole('button', { name: 'Link Discord owner for Child' }));
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

  it('previews organization role additions and removals before applying only the review token', async () => {
    const { requests, notify } = page();
    fireEvent.click(screen.getByRole('button', { name: 'Configure roles' }));
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

  it('requires saving edited role settings before preview and sends only organization settings', async () => {
    const { requests } = page();
    fireEvent.click(screen.getByRole('button', { name: 'Configure roles' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Configure roles' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Configure roles' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview role changes' }));
    expect(
      await screen.findByText(
        '0 members with changes · 2 unchanged · 0 unlinked accounts skipped · 1 no longer in Discord',
      ),
    ).toBeTruthy();
  });
});
