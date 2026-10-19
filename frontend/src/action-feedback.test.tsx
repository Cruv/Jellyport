// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UserDirectoryPage from './UserDirectoryPage';
import MembershipsPage from './MembershipsPage';
import AccountRolesPage from './AccountRolesPage';
import type { Api, ApiOptions, Notify, Settings } from './types';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/');
});

const settings = { discord_enabled: false } as Settings;
const cases = [
  {
    name: 'users',
    button: 'Refresh',
    success: 'Users refreshed.',
    render: (api: Api, notify: Notify) => (
      <UserDirectoryPage api={api} notify={notify} settings={settings} navigate={vi.fn()} />
    ),
  },
  {
    name: 'memberships',
    button: 'Refresh',
    success: 'Memberships refreshed.',
    render: (api: Api, notify: Notify) => (
      <MembershipsPage api={api} notify={notify} settings={settings} created={vi.fn()} />
    ),
  },
  {
    name: 'roles',
    button: 'Refresh roles',
    success: 'Account roles refreshed.',
    render: (api: Api, notify: Notify) => (
      <AccountRolesPage
        api={api}
        notify={notify}
        users={{ emby: [], jellyfin: [] }}
        created={vi.fn()}
      />
    ),
  },
];
const response = (path: string) => {
  if (path === '/api/user-directory') return { users: [] };
  if (path === '/api/memberships') return { memberships: [] };
  if (path === '/api/user-mappings') return { mappings: [] };
  if (path === '/api/account-roles') return { roles: [], assignments: [] };
  throw new Error(`Unexpected synthetic request: ${path}`);
};

describe.each(cases)('$name explicit refresh feedback', (item) => {
  it('keeps initial reads silent, exposes pending state, and acknowledges a completed refresh once', async () => {
    let manual = false;
    const pending: Array<() => void> = [];
    const api = vi.fn(async (path: string) => {
      if (manual) await new Promise<void>((resolve) => pending.push(resolve));
      return response(path);
    }) as Api;
    const notify = vi.fn();
    render(item.render(api, notify));
    const button = screen.getByRole('button', { name: item.button });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(notify).not.toHaveBeenCalled();
    manual = true;
    fireEvent.click(button);
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(notify).not.toHaveBeenCalled();
    await act(async () => pending.forEach((resolve) => resolve()));
    await waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(item.success));
    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('reports a manual refresh failure without claiming success', async () => {
    let failing = false;
    const api: Api = async <T,>(path: string) => {
      if (failing) throw new Error('Synthetic refresh unavailable.');
      return response(path) as T;
    };
    const notify = vi.fn();
    render(item.render(api, notify));
    const button = screen.getByRole('button', { name: item.button });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    failing = true;
    fireEvent.click(button);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledExactlyOnceWith('Synthetic refresh unavailable.', true),
    );
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Synthetic refresh unavailable.',
    );
  });

  it('aborts a pending refresh on unmount and ignores its late outcome', async () => {
    let manual = false;
    const pending: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      if (manual) {
        signals.push(options!.signal!);
        await new Promise<void>((resolve) => pending.push(resolve));
      }
      return response(path) as T;
    };
    const notify = vi.fn();
    const view = render(item.render(api, notify));
    const button = screen.getByRole('button', { name: item.button });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    manual = true;
    fireEvent.click(button);
    expect(signals.length).toBeGreaterThan(0);
    view.unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => pending.forEach((resolve) => resolve()));
    expect(notify).not.toHaveBeenCalled();
  });
});
