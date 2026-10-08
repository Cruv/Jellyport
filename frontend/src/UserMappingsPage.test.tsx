// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import UserMappingsPage from './UserMappingsPage';
import App from './App';
import type { Api, ApiOptions, UserMapping, Users } from './types';

const users: Users = {
  emby: [
    { Id: 'emby-complex', Name: 'Mr. Complex Name !' },
    { Id: 'emby-alex', Name: 'alex.old' },
  ],
  jellyfin: [
    { Id: 'jf-simple', Name: 'SimpleName', Policy: { IsAdministrator: false, IsDisabled: false } },
    { Id: 'jf-admin', Name: 'administrator', Policy: { IsAdministrator: true } },
  ],
};
const mapping: UserMapping = {
  id: 'mapping-1',
  source_user_id: 'emby-complex',
  source_username: 'Mr. Complex Name !',
  target_user_id: 'jf-simple',
  target_username: 'SimpleName',
  discord_user_id: null,
  discord_username: 'actual.discord.name',
  revision: 'revision-1',
};

function page(mappings: UserMapping[] = [], customApi?: Api) {
  const requests: { path: string; options?: ApiOptions }[] = [];
  const api =
    customApi ||
    (vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      return mapping;
    }) as Api);
  const notify = vi.fn();
  const refresh = vi.fn(async () => {});
  const view = render(
    <UserMappingsPage
      mappings={mappings}
      users={users}
      api={api}
      notify={notify}
      refresh={refresh}
    />,
  );
  return { ...view, requests, api, notify, refresh };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Manual user mappings', () => {
  it('assigns a second account slot to the same Discord owner without inventing another identity', async () => {
    const { requests } = page();
    fireEvent.change(screen.getByLabelText('Emby account'), { target: { value: 'emby-alex' } });
    expect((screen.getByLabelText('Membership account slot') as HTMLSelectElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText(/Discord user ID/), {
      target: { value: '123456789012345678' },
    });
    fireEvent.change(screen.getByLabelText('Membership account slot'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options?.body).toMatchObject({
      discord_user_id: '123456789012345678',
      membership_slot: 2,
      source_user_id: 'emby-alex',
    });
  });

  it('shows an existing third slot and preserves it when the mapping is edited', async () => {
    const { requests } = page([
      { ...mapping, discord_user_id: '123456789012345678', membership_slot: 3 },
    ]);
    expect(screen.getByText(/Account slot 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit mapping for Mr. Complex Name !' }));
    expect((screen.getByLabelText('Membership account slot') as HTMLSelectElement).value).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options?.body).toMatchObject({ membership_slot: 3 });
  });

  it('searches Discord members and saves the selected stable identity without manually entering an ID', async () => {
    const requests: { path: string; options?: ApiOptions }[] = [];
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      if (path.startsWith('/api/discord/members?'))
        return {
          members: [
            {
              id: '123456789012345678',
              username: 'actual.discord.name',
              display_name: 'Friendly Alias',
              nickname: null,
              membership_active: true,
            },
          ],
          truncated: false,
        };
      return mapping;
    }) as Api;
    const { refresh } = page([], api);
    fireEvent.change(screen.getByLabelText('Emby account'), { target: { value: 'emby-complex' } });
    fireEvent.change(screen.getByLabelText('New Jellyfin username'), {
      target: { value: 'SimpleName' },
    });
    expect(requests).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Discord member'), {
      target: { value: 'Friendly Alias' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @actual.discord.name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(requests[0].path).toBe('/api/discord/members?query=Friendly%20Alias');
    expect(requests[1]).toEqual({
      path: '/api/user-mappings',
      options: {
        method: 'POST',
        body: {
          source_user_id: 'emby-complex',
          target_user_id: null,
          target_username: 'SimpleName',
          discord_username: 'actual.discord.name',
          discord_user_id: '123456789012345678',
        },
      },
    });
  });

  it('shows a saved Discord member immediately and allows the administrator to unlink it', async () => {
    const item = { ...mapping, discord_user_id: '123456789012345678' };
    const { requests } = page([item]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit mapping for Mr. Complex Name !' }));
    expect(screen.getByText('Membership checked when submitted.')).toBeTruthy();
    expect(requests).toHaveLength(0);
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear Discord member @actual.discord.name' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options?.body).toEqual({
      id: 'mapping-1',
      source_user_id: 'emby-complex',
      target_user_id: 'jf-simple',
      discord_username: null,
      discord_user_id: null,
    });
  });

  it('saves a simpler destination name and an optional Discord label without creating or messaging an account', async () => {
    const { requests, refresh } = page();
    fireEvent.change(screen.getByLabelText('Emby account'), { target: { value: 'emby-complex' } });
    fireEvent.change(screen.getByLabelText('New Jellyfin username'), {
      target: { value: 'SimpleName' },
    });
    fireEvent.change(screen.getByLabelText(/Discord username/), {
      target: { value: 'actual.discord.name' },
    });
    expect(screen.getByText(/Without a user ID, this is an unverified label/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(requests).toEqual([
      {
        path: '/api/user-mappings',
        options: {
          method: 'POST',
          body: {
            source_user_id: 'emby-complex',
            target_user_id: null,
            target_username: 'SimpleName',
            discord_username: 'actual.discord.name',
            discord_user_id: null,
          },
        },
      },
    ]);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('selects an existing destination without sending a replacement name or password and excludes administrators', async () => {
    const { requests } = page();
    fireEvent.change(screen.getByLabelText('Emby account'), { target: { value: 'emby-alex' } });
    fireEvent.change(screen.getByLabelText('Jellyfin destination'), {
      target: { value: 'jf-simple' },
    });
    expect(screen.queryByLabelText('New Jellyfin username')).toBeNull();
    expect(
      within(screen.getByLabelText('Jellyfin destination')).queryByText('administrator'),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText(/Discord user ID/), {
      target: { value: '123456789012345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options?.body).toEqual({
      source_user_id: 'emby-alex',
      target_user_id: 'jf-simple',
      discord_username: null,
      discord_user_id: '123456789012345678',
    });
  });

  it('renders names as text and edits the selected mapping explicitly', async () => {
    const name = '<script>unsafe()</script>';
    const item = {
      ...mapping,
      source_username: name,
      discord_username: '<img src=x onerror=unsafe()>',
    };
    const { container, requests } = page([item]);
    expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=unsafe()>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Edit mapping for ${name}` }));
    expect((screen.getByLabelText('Emby account') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Discord username/), {
      target: { value: 'renamed.label' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options?.body).toEqual({
      id: 'mapping-1',
      source_user_id: 'emby-complex',
      target_user_id: 'jf-simple',
      discord_user_id: null,
      discord_username: 'renamed.label',
    });
  });

  it('retains a mapping and shows the error when deletion fails', async () => {
    const api = vi.fn(async () => {
      throw new Error('A queued migration still uses this mapping.');
    }) as Api;
    const { refresh, notify } = page([mapping], api);
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping for Mr. Complex Name !' }));
    const dialog = await screen.findByRole('dialog');
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove mapping' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(screen.getByText('A queued migration still uses this mapping.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Edit mapping for Mr. Complex Name !' }),
    ).toBeTruthy();
    expect(api).toHaveBeenCalledWith('/api/user-mappings/mapping-1', { method: 'DELETE' });
    expect(refresh).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a pending save response after the page is unmounted', async () => {
    let finish!: (value: UserMapping) => void;
    const api = vi.fn(
      () =>
        new Promise<UserMapping>((resolve) => {
          finish = resolve;
        }),
    ) as Api;
    const { unmount, notify, refresh } = page([], api);
    fireEvent.change(screen.getByLabelText('Emby account'), { target: { value: 'emby-alex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    unmount();
    finish(mapping);
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('loads mappings from the console navigation and clears them on sign-out', async () => {
    const authenticated = {
      authenticated: true,
      csrf_token: 'csrf-test',
      demo: false,
      setup_required: false,
      setup_connected: false,
      user: { id: 'admin', name: 'Administrator' },
    };
    const responses: Record<string, unknown> = {
      '/api/session': authenticated,
      '/api/overview': {
        counts: { emby_users: 2, jellyfin_users: 2, jobs: 0 },
        connections: { emby: {}, jellyfin: {}, discord: {} },
        recent_jobs: [],
      },
      '/api/users': users,
      '/api/user-mappings': { mappings: [mapping] },
      '/api/logout': { ...authenticated, authenticated: false, user: undefined },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => ({
        ok: true,
        status: 200,
        json: async () => responses[path] ?? {},
      })),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'User mappings' }));
    await screen.findByText('Connect the right accounts.');
    expect(screen.getByText('actual.discord.name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Jellyfin username');
    expect(screen.queryByText('actual.discord.name')).toBeNull();
    expect(screen.queryByText('Connect the right accounts.')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
