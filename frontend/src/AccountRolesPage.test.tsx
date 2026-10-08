// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AccountRolesPage from './AccountRolesPage';
import type {
  AccountRole,
  Api,
  ApiOptions,
  Job,
  RoleAssignment,
  RoleParameters,
  Users,
} from './types';

const parameters: RoleParameters = {
  policy: { EnableRemoteAccess: true, EnableContentDownloading: false },
  configuration: { AudioLanguagePreference: 'eng', EnableNextEpisodeAutoPlay: true },
  display: { CustomPrefs: { homesection0: 'resume', homesection1: 'nextup' } },
};
const role = {
  id: 'role-1',
  name: 'Crew',
  revision: 'role-revision-1',
  server_url: 'http://jellyfin:8096',
  server_id: 'server-1',
  parameters,
  updated_at: '2026-10-08T12:00:00.000Z',
} as AccountRole;
const assignment = {
  user_id: 'jellyfin-alex',
  username: 'alex',
  role_id: role.id,
  revision: 'assignment-1',
  applied_revision: null,
  server_url: role.server_url,
  server_id: role.server_id,
  updated_at: role.updated_at,
} as RoleAssignment;
const users: Users = {
  emby: [],
  jellyfin: [
    { Id: 'jellyfin-alex', Name: 'alex', Policy: { IsAdministrator: false, IsDisabled: false } },
    { Id: 'jellyfin-sam', Name: 'sam', Policy: { IsAdministrator: false, IsDisabled: false } },
    {
      Id: 'jellyfin-template',
      Name: 'Template',
      Policy: { IsAdministrator: false, IsDisabled: false },
    },
    {
      Id: 'jellyfin-admin',
      Name: 'Administrator',
      Policy: { IsAdministrator: true, IsDisabled: false },
    },
    {
      Id: 'jellyfin-disabled',
      Name: 'Disabled',
      Policy: { IsAdministrator: false, IsDisabled: true },
    },
    { Id: 'jellyfin-unknown', Name: 'Unknown policy' },
  ],
};
const queued: Job = {
  id: 'job-1',
  kind: 'apply_role',
  status: 'queued',
  created_at: role.updated_at,
};

function page(customApi?: Api, defaultRoleId?: string, customUsers: Users = users) {
  const requests: { path: string; options?: ApiOptions }[] = [];
  let roles = [role];
  let assignments: RoleAssignment[] = [assignment];
  const api =
    customApi ||
    (vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      if (path === '/api/account-roles' && !options?.method) return { roles, assignments };
      if (path === '/api/account-roles/import')
        return { parameters, warnings: ['Client-local theme settings are not copied.'] };
      if (path === '/api/account-roles' && options?.method === 'POST') {
        const body = options.body as { id?: string; name: string; parameters: RoleParameters };
        const saved = {
          ...role,
          id: body.id || 'role-new',
          name: body.name,
          parameters: body.parameters,
          revision: 'role-revision-2',
        };
        roles = body.id ? [saved] : [...roles, saved];
        return saved;
      }
      if (path === '/api/account-roles/assign') {
        const body = options?.body as { user_ids: string[]; role_id: string };
        assignments = body.user_ids.map((id) => ({
          ...assignment,
          user_id: id,
          role_id: body.role_id,
        }));
        return {};
      }
      if (path === '/api/account-roles/unassign') {
        assignments = [];
        return {};
      }
      if (path === '/api/account-roles/apply') return queued;
      if (options?.method === 'DELETE') {
        roles = [];
        return {};
      }
      throw new Error(`Unexpected request ${path}`);
    }) as Api);
  const notify = vi.fn();
  const created = vi.fn();
  const view = render(
    <AccountRolesPage
      users={customUsers}
      api={api}
      notify={notify}
      created={created}
      templateUserId="jellyfin-template"
      defaultRoleId={defaultRoleId}
    />,
  );
  return { ...view, api, requests, notify, created };
}
const mutations = (requests: { path: string; options?: ApiOptions }[]) =>
  requests.filter((request) => Boolean(request.options?.method));
async function selectRole() {
  await screen.findByLabelText('Saved role');
  fireEvent.change(screen.getByLabelText('Saved role'), { target: { value: role.id } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('Account roles', () => {
  it('copies supported settings into a new saved role without changing Jellyfin accounts', async () => {
    const { requests, notify, created } = page();
    await screen.findByLabelText('Saved role');
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Movie night' } });
    const source = screen.getByLabelText('Copy settings from');
    expect(within(source).getByText('Template (template)')).toBeTruthy();
    expect(within(source).queryByText('Administrator')).toBeNull();
    expect(within(source).queryByText('Disabled')).toBeNull();
    expect(within(source).queryByText('Unknown policy')).toBeNull();
    fireEvent.change(source, { target: { value: 'jellyfin-template' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await screen.findByText('Client-local theme settings are not copied.');
    expect(screen.getByText('Enable Content Downloading')).toBeTruthy();
    expect(screen.getByText('homesection0: resume; homesection1: nextup')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save new role' }));
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(
      mutations(requests).map(({ path, options }) => ({
        path,
        method: options?.method,
        body: options?.body,
      })),
    ).toEqual([
      { path: '/api/account-roles/import', method: 'POST', body: { user_id: 'jellyfin-template' } },
      { path: '/api/account-roles', method: 'POST', body: { name: 'Movie night', parameters } },
    ]);
    expect(created).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('reimports a different account into an existing role using the saved revision', async () => {
    const { requests, created } = page();
    await selectRole();
    fireEvent.change(screen.getByLabelText('Copy settings from'), {
      target: { value: 'jellyfin-sam' },
    });
    expect(screen.queryByText('Enable Content Downloading')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Replace saved role' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await screen.findByText('Client-local theme settings are not copied.');
    fireEvent.click(screen.getByRole('button', { name: 'Replace saved role' }));
    await waitFor(() => expect(mutations(requests)).toHaveLength(2));
    expect(mutations(requests)[1].options?.body).toEqual({
      id: role.id,
      revision: role.revision,
      name: 'Crew',
      parameters,
    });
    expect(created).not.toHaveBeenCalled();
    expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(false);
  });

  it('assigns a role separately and only applies explicitly reviewed setting groups', async () => {
    const { requests, created, notify } = page();
    await selectRole();
    expect(screen.queryByRole('checkbox', { name: /^Template/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Administrator/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Disabled/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Unknown policy/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^sam/ }));
    expect(
      (screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Assign role' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Role assigned. Use Review changes to update Jellyfin settings.',
      ),
    );
    expect(mutations(requests)).toHaveLength(1);
    expect(mutations(requests)[0].options?.body).toEqual({
      role_id: role.id,
      role_revision: role.revision,
      user_ids: ['jellyfin-sam'],
    });
    expect(created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Account preferences/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Home and display preferences/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('sam')).toBeTruthy();
    expect(within(dialog).getByText('Account preferences')).toBeTruthy();
    expect(within(dialog).getByText('Home and display preferences')).toBeTruthy();
    expect(within(dialog).queryByText('Permissions')).toBeNull();
    expect(mutations(requests)).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply settings' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(queued));
    expect(mutations(requests)[1]).toMatchObject({
      path: '/api/account-roles/apply',
      options: {
        method: 'POST',
        body: {
          role_id: role.id,
          role_revision: role.revision,
          user_ids: ['jellyfin-sam'],
          sections: ['configuration', 'display'],
        },
      },
    });
  });

  it('selects no setting groups by default and blocks applying unassigned accounts', async () => {
    page();
    await selectRole();
    fireEvent.click(screen.getByRole('checkbox', { name: /^alex/ }));
    expect(
      (screen.getByRole('checkbox', { name: /^Permissions/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Permissions/ }));
    expect(
      (screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /^sam/ }));
    expect(
      (screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText('Assign this role to every selected account before applying settings.'),
    ).toBeTruthy();
  });

  it('requires reloading a role that changed during editing instead of silently applying the new revision', async () => {
    let loads = 0;
    const api = vi.fn(async (path: string) => {
      if (path === '/api/account-roles')
        return {
          roles: [{ ...role, revision: ++loads === 1 ? role.revision : 'changed-revision' }],
          assignments: [assignment],
        };
      throw new Error('Unexpected mutation');
    }) as Api;
    page(api);
    await selectRole();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh roles' }));
    expect(await screen.findByText(/This role changed after you opened it/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Replace saved role' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved role' }));
    expect(screen.queryByText(/This role changed after you opened it/)).toBeNull();
  });

  it('keeps a failed apply review open with the server error and does not create a job callback', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/account-roles') return { roles: [role], assignments: [assignment] };
      throw new Error('This role changed. Review the current role and try again.');
    }) as Api;
    const { created } = page(api);
    await selectRole();
    fireEvent.click(screen.getByRole('checkbox', { name: /^alex/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Account preferences/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply settings' }),
    );
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });

  it('renders names and preferences as escaped text and never stores snapshots in browser storage', async () => {
    const unsafe = '<img src=x onerror=unsafe()>';
    const api = vi.fn(async () => ({
      roles: [
        {
          ...role,
          name: unsafe,
          parameters: { ...parameters, configuration: { AudioLanguagePreference: unsafe } },
        },
      ],
      assignments: [],
    })) as Api;
    const { container } = page(api);
    await selectRole();
    expect(screen.getAllByText(unsafe).length).toBeGreaterThan(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('aborts loading on unmount and ignores a late response', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const api = vi.fn((_path: string, options?: ApiOptions) => {
      signal = options!.signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, notify, created } = page(api);
    expect(screen.getByText('Loading account roles…')).toBeTruthy();
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ roles: [role], assignments: [] }));
    expect(notify).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect(screen.queryByText('Crew')).toBeNull();
  });

  it('aborts a pending apply on sign-out or navigation and suppresses late callbacks', async () => {
    let finish!: (value: Job) => void;
    let signal!: AbortSignal;
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      if (path === '/api/account-roles') return { roles: [role], assignments: [assignment] };
      signal = options!.signal!;
      return new Promise<Job>((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, notify, created } = page(api);
    await selectRole();
    fireEvent.click(screen.getByRole('checkbox', { name: /^alex/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Account preferences/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply settings' }),
    );
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(queued));
    expect(created).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('shows assignment application status and preserves settings when a role is unassigned', async () => {
    const { requests, notify } = page();
    await selectRole();
    expect(screen.getByText('Crew · Not fully applied')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /^alex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Unassign role' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Roles unassigned. Jellyfin settings were preserved.'),
    );
    expect(mutations(requests)).toHaveLength(1);
    expect(mutations(requests)[0]).toMatchObject({
      path: '/api/account-roles/unassign',
      options: { body: { user_ids: ['jellyfin-alex'] } },
    });
  });

  it('protects default and assigned roles from removal', async () => {
    page(undefined, role.id);
    await selectRole();
    expect(
      (screen.getByRole('button', { name: 'Remove role' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText('Unassign this role and change the default in Settings before removing it.'),
    ).toBeTruthy();
  });

  it('caps bulk selection at 100 accounts and sends only the selected batch', async () => {
    const manyUsers: Users = {
      emby: [],
      jellyfin: Array.from({ length: 101 }, (_, index) => ({
        Id: `bulk-${index}`,
        Name: `member${index}`,
        Policy: { IsAdministrator: false, IsDisabled: false },
      })),
    };
    const { requests, notify } = page(undefined, undefined, manyUsers);
    await selectRole();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select up to 100 visible accounts' }));
    expect(screen.getByText('100 selected')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: /^member100/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Assign role' }));
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const body = mutations(requests)[0].options?.body as { user_ids: string[] };
    expect(body.user_ids).toHaveLength(100);
    expect(body.user_ids).not.toContain('bulk-100');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText('0 selected')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: /^member100/ }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('aborts an import on unmount and discards its late settings snapshot', async () => {
    let finish!: (value: { parameters: RoleParameters; warnings: string[] }) => void;
    let signal!: AbortSignal;
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      if (path === '/api/account-roles') return { roles: [role], assignments: [] };
      signal = options!.signal!;
      return new Promise<{ parameters: RoleParameters; warnings: string[] }>((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, notify, created } = page(api);
    await screen.findByLabelText('Saved role');
    fireEvent.change(screen.getByLabelText('Copy settings from'), {
      target: { value: 'jellyfin-template' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ parameters, warnings: ['Late private settings'] }));
    expect(screen.queryByText('Late private settings')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
