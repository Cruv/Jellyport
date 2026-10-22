// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  navigateWorkspace,
  parseWorkspaceRoute,
  useRouteTab,
  useWorkspaceRoute,
  workspaceRouteHash,
  type WorkspaceRoute,
} from './routing';

beforeEach(() => window.history.replaceState(null, '', window.location.pathname));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', window.location.pathname);
});
function Route() {
  const value = useWorkspaceRoute();
  return <output aria-label="Route">{workspaceRouteHash(value)}</output>;
}
function UserTabs() {
  const [tab, change] = useRouteTab('users');
  return (
    <>
      <output aria-label="User tab">{tab}</output>
      <input aria-label="Local draft" defaultValue="" />
      <button onClick={() => change('organization')}>Organization</button>
      <button onClick={() => change('directory')}>Directory</button>
      <button
        onClick={() => {
          change((current) => (current === 'directory' ? 'organization' : 'directory'));
          change((current) => (current === 'directory' ? 'organization' : 'directory'));
        }}
      >
        Toggle twice
      </button>
      <button onClick={() => change('synthetic-private-record')}>Invalid tab</button>
    </>
  );
}

describe('allowlisted structural workspace routes', () => {
  it.each([
    'overview',
    'users',
    'migrate',
    'mappings',
    'roles',
    'accounts',
    'memberships',
    'activity',
  ])('round trips the %s page without including record state', (page) => {
    const route = parseWorkspaceRoute(`#/${page}`);
    expect(route.page).toBe(page);
    expect(workspaceRouteHash(route)).toBe(`#/${page}`);
  });
  it.each([
    ['#/users/organization', 'users', 'organization'],
    ['#/mappings/editor', 'mappings', 'editor'],
    ['#/roles/editor', 'roles', 'editor'],
    ['#/roles/apply', 'roles', 'apply'],
    ['#/accounts/recover', 'accounts', 'recover'],
  ])('round trips selected structural tab %s', (hash, page, tab) => {
    expect(parseWorkspaceRoute(hash)).toEqual({ page, tab });
    expect(workspaceRouteHash(parseWorkspaceRoute(hash))).toBe(hash);
  });
  it.each([
    ['#/memberships/accounts/list', 'accounts', 'list'],
    ['#/memberships/accounts/editor', 'accounts', 'editor'],
    ['#/memberships/events/review', 'events', 'review'],
    ['#/memberships/events/history', 'events', 'history'],
    ['#/memberships/events/all', 'events', 'all'],
  ])('round trips unified membership task %s', (hash, tab, subtab) => {
    expect(parseWorkspaceRoute(hash)).toEqual({ page: 'memberships', tab, subtab });
    expect(workspaceRouteHash(parseWorkspaceRoute(hash))).toBe(hash);
  });
  it.each([
    ['#/subscriptions', '#/memberships/events/review'],
    ['#/subscriptions/history', '#/memberships/events/history'],
    ['#/subscriptions/all', '#/memberships/events/all'],
    ['#/memberships/editor', '#/memberships/accounts/editor'],
    ['#/memberships/list', '#/memberships/accounts/list'],
  ])('restores legacy membership bookmark %s as %s', (old, canonical) => {
    expect(workspaceRouteHash(parseWorkspaceRoute(old))).toBe(canonical);
  });
  it.each([
    ['media', 'emby'],
    ['media', 'jellyfin'],
    ['media', 'paths'],
    ['accounts', 'permissions'],
    ['accounts', 'passwords'],
    ['discord', 'connection'],
    ['discord', 'alerts'],
    ['automation', 'tiers'],
    ['automation', 'rules'],
    ['history', 'emby'],
    ['history', 'jellyfin'],
  ])('round trips Settings %s / %s', (tab, subtab) => {
    const hash = `#/settings/${tab}/${subtab}`;
    expect(parseWorkspaceRoute(hash)).toEqual({ page: 'settings', tab, subtab });
    expect(workspaceRouteHash(parseWorkspaceRoute(hash))).toBe(hash);
  });
  it.each(['media', 'accounts', 'discord', 'automation', 'history', 'activity'])(
    'restores legacy Settings bookmark %s',
    (tab) => {
      const route = parseWorkspaceRoute(`#settings-${tab}`);
      expect(route).toMatchObject({ page: 'settings', tab });
      expect(workspaceRouteHash(route)).toMatch(new RegExp(`^#/settings/${tab}(?:/|$)`));
    },
  );
  it.each([
    '',
    '#workspace-content',
    '#/unknown',
    '#/activity/record/extra/segment',
    '#/%61ctivity',
    '#/' + 'x'.repeat(200),
  ])('safely falls back for an unknown or unsupported fragment %s', (hash) => {
    expect(parseWorkspaceRoute(hash)).toEqual({ page: 'overview' });
  });
  it('drops unknown tabs, sub-tabs, IDs and action fragments instead of preserving them in the URL', () => {
    expect(workspaceRouteHash(parseWorkspaceRoute('#/users/private-username'))).toBe('#/users');
    expect(workspaceRouteHash(parseWorkspaceRoute('#/settings/history/private-api-key'))).toBe(
      '#/settings/history/emby',
    );
    expect(workspaceRouteHash(parseWorkspaceRoute('#/roles/apply/private-account-id'))).toBe(
      '#/roles/apply',
    );
    expect(workspaceRouteHash(parseWorkspaceRoute('#/accounts/delete'))).toBe('#/accounts');
    expect(
      workspaceRouteHash({
        page: 'activity',
        tab: 'private-record-id',
        subtab: 'private-password',
      }),
    ).toBe('#/activity');
  });
});

describe('browser route ownership and lifecycle', () => {
  it('canonicalizes legacy bookmarks with replacement and adds no extra Back entry', () => {
    window.history.replaceState(null, '', '#settings-history');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<Route />);
    expect(window.location.hash).toBe('#/settings/history/emby');
    expect(replace).toHaveBeenCalledWith(null, '', '#/settings/history/emby');
    expect(push).not.toHaveBeenCalled();
    expect(window.history.state).toBeNull();
  });
  it('restores tab selections through Back and Forward while keeping drafts only in the current mounted form', async () => {
    window.history.replaceState(null, '', '#/users');
    render(
      <>
        <Route />
        <UserTabs />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Local draft'), {
      target: { value: 'synthetic-private-draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    expect(window.location.hash).toBe('#/users/organization');
    expect(screen.getByLabelText('User tab').textContent).toBe('organization');
    await act(async () => window.history.back());
    await waitFor(() => expect(screen.getByLabelText('User tab').textContent).toBe('directory'));
    await act(async () => window.history.forward());
    await waitFor(() => expect(screen.getByLabelText('User tab').textContent).toBe('organization'));
    expect(screen.getByLabelText('Local draft')).toHaveProperty('value', 'synthetic-private-draft');
    expect(window.location.hash).not.toContain('private');
    expect(window.history.state).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('does not create duplicate history entries when selecting the current page or tab', () => {
    window.history.replaceState(null, '', '#/users');
    const push = vi.spyOn(window.history, 'pushState');
    render(<UserTabs />);
    fireEvent.click(screen.getByRole('button', { name: 'Directory' }));
    act(() => navigateWorkspace({ page: 'users' }));
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Invalid tab' }));
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/users');
  });
  it('supports functional tab updates without putting editor state into browser history', () => {
    window.history.replaceState(null, '', '#/users');
    render(<UserTabs />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle twice' }));
    expect(screen.getByLabelText('User tab').textContent).toBe('directory');
    expect(window.location.hash).toBe('#/users');
  });
  it('responds to external hash changes and ignores legacy skip anchors during an active page', () => {
    window.history.replaceState(null, '', '#/activity');
    render(<Route />);
    window.history.replaceState(null, '', '#workspace-content');
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByLabelText('Route').textContent).toBe('#/activity');
    window.history.replaceState(null, '', '#/settings/discord/alerts');
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByLabelText('Route').textContent).toBe('#/settings/discord/alerts');
  });
  it('removes route listeners across StrictMode restarts and unmount', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <StrictMode>
        <Route />
        <UserTabs />
      </StrictMode>,
    );
    unmount();
    expect(removed).toHaveBeenCalledWith('popstate', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('hashchange', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('jellyport:routechange', expect.any(Function));
    const before = window.location.hash;
    window.history.replaceState(null, '', '#/activity');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(window.location.hash).toBe('#/activity');
    expect(before).toBe('#/overview');
  });
  it('accepts only allowlisted structural values when application callers supply a route', () => {
    render(<Route />);
    act(() =>
      navigateWorkspace({
        page: 'private-user',
        tab: 'private-token',
      } as unknown as WorkspaceRoute),
    );
    expect(window.location.hash).toBe('#/overview');
    expect(window.history.state).toBeNull();
  });
});
