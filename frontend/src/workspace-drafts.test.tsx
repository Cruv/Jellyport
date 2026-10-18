// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceDraftProvider, useWorkspaceDraftState } from './workspace-drafts';
import UserMappingsPage from './UserMappingsPage';
import AccountRolesPage from './AccountRolesPage';
import MembershipsPage from './MembershipsPage';
import UserDirectoryPage from './UserDirectoryPage';
import type { Api, ApiOptions, Settings, UserMapping, Users } from './types';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});

function Counter({ leave }: { leave?: () => void }) {
  const [count, setCount] = useWorkspaceDraftState('counter', () => 0);
  return (
    <button
      onClick={() => {
        setCount((value) => value + 1);
        setCount((value) => value + 1);
        leave?.();
      }}
    >
      Count {count}
    </button>
  );
}

function workspace(node: ReactNode) {
  const tree = (child: ReactNode, key = 'session-one') => (
    <StrictMode>
      <WorkspaceDraftProvider key={key}>{child}</WorkspaceDraftProvider>
    </StrictMode>
  );
  const view = render(tree(node));
  return {
    hide: () => view.rerender(tree(null)),
    show: () => view.rerender(tree(node)),
    newSession: () => view.rerender(tree(node, 'session-two')),
  };
}

describe('authenticated workspace editor memory', () => {
  it('retains input even if the same event unmounts the editor before its update renders', () => {
    let hide!: () => void;
    const view = workspace(<Counter leave={() => hide()} />);
    hide = view.hide;
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    expect(screen.queryByRole('button')).toBeNull();
    act(() => view.show());
    expect(screen.getByRole('button', { name: 'Count 2' })).toBeTruthy();
  });

  it('stores functional updates before unmount, restores them only in the same workspace, and never serializes them', () => {
    const view = workspace(<Counter />);
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    expect(screen.getByRole('button', { name: 'Count 2' })).toBeTruthy();
    act(() => view.hide());
    act(() => view.show());
    expect(screen.getByRole('button', { name: 'Count 2' })).toBeTruthy();
    act(() => view.newSession());
    expect(screen.getByRole('button', { name: 'Count 0' })).toBeTruthy();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.hash).toBe('');
    expect(window.history.state).toBeNull();
  });

  it('falls back to ordinary isolated component state when no workspace provider is present', () => {
    const first = render(<Counter />);
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    expect(screen.getByRole('button', { name: 'Count 2' })).toBeTruthy();
    first.unmount();
    render(<Counter />);
    expect(screen.getByRole('button', { name: 'Count 0' })).toBeTruthy();
  });
});

const users: Users = {
  emby: [{ Id: 'e-complex', Name: 'Complex Source !' }],
  jellyfin: [
    { Id: 'j-target', Name: 'Simplified', Policy: { IsAdministrator: false, IsDisabled: false } },
    { Id: 'j-template', Name: 'Template', Policy: { IsAdministrator: false, IsDisabled: false } },
  ],
};
const mapping: UserMapping = {
  id: 'mapping-one',
  source_user_id: 'e-complex',
  source_username: 'Complex Source !',
  target_user_id: 'j-target',
  target_username: 'Simplified',
  discord_user_id: null,
  discord_username: null,
  revision: 'mapping-revision',
};
const parameters = {
  policy: { EnableRemoteAccess: false },
  configuration: { AudioLanguagePreference: 'en' },
  display: { CustomPrefs: { homesection0: 'resume' } },
};
const role = {
  id: 'role-one',
  name: 'Members',
  revision: 'role-revision',
  parameters,
  updated_at: '2026-10-01T00:00:00Z',
};
const owner = {
  id: '123456789012345678',
  username: 'Crew',
  display_name: null,
  nickname: null,
  membership_active: true,
};
const membership = {
  discord_user_id: owner.id,
  base_username: owner.username,
  tier_id: 'galleon',
  account_limit: 3,
  active: true,
  revision: 'member-revision',
  links: [],
};
const settings = {
  discord_enabled: true,
  discord_emby_role_id: 'emby-tag',
  discord_jellyfin_role_id: 'jf-tag',
  discord_auto_role_sync: false,
} as Settings;

function dependencies() {
  let currentRole = role;
  const requests: Array<{ path: string; options?: ApiOptions }> = [];
  const api = vi.fn(async (path: string, options?: ApiOptions) => {
    requests.push({ path, options });
    if (path === '/api/account-roles') return { roles: [currentRole], assignments: [] };
    if (path === '/api/account-roles/import')
      return { parameters, warnings: ['Synthetic import note'] };
    if (path === '/api/memberships') return { memberships: [membership] };
    if (path === '/api/user-mappings') return { mappings: [] };
    if (path === '/api/user-directory') return { users: [] };
    if (path === '/api/discord/tag-roles')
      return {
        can_manage_roles: true,
        roles: [
          { id: 'emby-tag', name: 'Emby tag', manageable: true },
          { id: 'jf-tag', name: 'Jellyfin tag', manageable: true },
        ],
      };
    throw new Error(`Unexpected fixture request ${path}`);
  }) as Api;
  return {
    api,
    notify: vi.fn(),
    created: vi.fn(),
    refresh: vi.fn(async () => {}),
    requests,
    changeRole: () => {
      currentRole = { ...role, revision: 'new-server-revision' };
    },
  };
}

describe('editor drafts across page unmount and refresh', () => {
  it('restores mapping input but never restores a remove confirmation, and explicit cancel clears the remembered editor', async () => {
    window.history.replaceState(null, '', '#/mappings');
    const p = dependencies();
    const view = workspace(<UserMappingsPage mappings={[mapping]} users={users} {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit mapping for Complex Source !' }));
    fireEvent.change(screen.getByLabelText(/Discord username/), {
      target: { value: 'synthetic.private.draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping for Complex Source !' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => view.hide());
    act(() => view.show());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText(/Discord username/)).toHaveProperty(
      'value',
      'synthetic.private.draft',
    );
    expect(screen.getByLabelText('Emby account')).toHaveProperty('value', 'e-complex');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    act(() => view.hide());
    act(() => view.show());
    fireEvent.click(screen.getByRole('tab', { name: 'Add mapping' }));
    expect(screen.getByLabelText('Emby account')).toHaveProperty('value', '');
    expect(screen.getByLabelText(/Discord username/)).toHaveProperty('value', '');
    expect(p.requests.filter(({ options }) => options?.method)).toEqual([]);
    expect(window.location.hash).not.toContain('synthetic.private');
  });

  it('restores copied role parameters and dirty metadata while a fresh server revision still blocks application', async () => {
    window.history.replaceState(null, '', '#/roles');
    const p = dependencies();
    const view = workspace(<AccountRolesPage users={users} {...p} templateUserId="j-template" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit role Members' }));
    fireEvent.change(screen.getByLabelText('Role name'), {
      target: { value: 'Unsubmitted role draft' },
    });
    fireEvent.change(screen.getByLabelText('Copy settings from'), {
      target: { value: 'j-template' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await screen.findByText('Synthetic import note');
    p.changeRole();
    act(() => view.hide());
    act(() => view.show());
    await screen.findByLabelText('Role name');
    expect(screen.getByLabelText('Role name')).toHaveProperty('value', 'Unsubmitted role draft');
    expect(screen.getByLabelText('Copy settings from')).toHaveProperty('value', 'j-template');
    expect(screen.getByText('Synthetic import note')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace saved role' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Apply role' }));
    expect(screen.getByText(/Save your changes or reload the saved role/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(p.requests.filter(({ options }) => options?.method).map(({ path }) => path)).toEqual([
      '/api/account-roles/import',
    ]);
  });

  it('restores the membership owner and policy input, without replaying or restoring its unsubmitted approval', async () => {
    window.history.replaceState(null, '', '#/memberships');
    const p = dependencies();
    const view = workspace(<MembershipsPage settings={settings} {...p} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Crew' }));
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    fireEvent.change(screen.getByLabelText('Complimentary account allowance'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => view.hide());
    act(() => view.show());
    await screen.findByRole('button', { name: 'Clear Discord member @Crew' });
    expect(screen.getByLabelText('Access policy')).toHaveProperty('value', 'complimentary');
    expect(screen.getByLabelText('Complimentary account allowance')).toHaveProperty('value', '2');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(p.requests.filter(({ options }) => options?.method)).toEqual([]);
    act(() => view.newSession());
    await screen.findByLabelText('Discord member');
    expect(screen.queryByRole('button', { name: 'Clear Discord member @Crew' })).toBeNull();
  });

  it('retains an organization draft after a fresh role read without restoring an approval or writing settings', async () => {
    window.history.replaceState(null, '', '#/users/organization');
    const p = dependencies();
    const view = workspace(<UserDirectoryPage settings={settings} {...p} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure roles' }));
    fireEvent.click(
      await screen.findByLabelText('Automatically keep organization roles up to date'),
    );
    expect(screen.getByRole('button', { name: 'Save organization settings' })).toHaveProperty(
      'disabled',
      false,
    );
    act(() => view.hide());
    act(() => view.show());
    fireEvent.click(await screen.findByRole('button', { name: 'Configure roles' }));
    await waitFor(() =>
      expect(
        screen.getByLabelText('Automatically keep organization roles up to date'),
      ).toHaveProperty('checked', true),
    );
    expect(screen.getByRole('button', { name: 'Save organization settings' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Preview role changes' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(p.requests.filter(({ options }) => options?.method)).toEqual([]);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});
