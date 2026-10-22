// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MemberManagementPage from './MemberManagementPage';
import { useWorkspaceRoute } from './routing';
import { defaultMembershipTiers, type Api, type Settings } from './types';

vi.mock('./IdentityReviewPanel', () => ({
  default: () => (
    <section aria-label="Identity review">
      <h2>Identity links and access gaps</h2>
    </section>
  ),
}));
const settings = { membership_tiers: defaultMembershipTiers } as Settings;
function page() {
  const api = vi.fn(async (path: string) => {
    if (path === '/api/memberships') return { memberships: [] };
    if (path === '/api/user-mappings') return { mappings: [] };
    throw new Error(`Unexpected request ${path}`);
  }) as Api;
  const review = vi.fn();
  function Workspace() {
    useWorkspaceRoute();
    return (
      <MemberManagementPage
        settings={settings}
        api={api}
        notify={vi.fn()}
        created={vi.fn()}
        demo={false}
        events={[
          {
            id: 'event',
            action: 'subscribe',
            username: 'synthetic-member',
            status: 'pending',
            created_at: '2026-10-22T12:00:00Z',
          },
        ]}
        refresh={vi.fn()}
        navigate={vi.fn()}
        openJob={vi.fn()}
        review={review}
        ignore={vi.fn()}
        busy={false}
      />
    );
  }
  render(<Workspace />);
  return { api, review };
}
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('unified membership workspace', () => {
  it('keeps identities, access and subscription events under one page heading', async () => {
    window.history.replaceState(null, '', '#/memberships');
    page();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Identity review' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Accounts & access' }));
    await screen.findByText('Give each member their account allowance.');
    expect(window.location.hash).toBe('#/memberships/accounts/list');
    fireEvent.click(screen.getByRole('tab', { name: 'Add member' }));
    expect(window.location.hash).toBe('#/memberships/accounts/editor');
    expect(screen.getByLabelText('Enable Jellyfin account provisioning')).toHaveProperty(
      'checked',
      false,
    );
    fireEvent.click(screen.getByRole('tab', { name: /^Events/ }));
    expect(window.location.hash).toBe('#/memberships/events/review');
    expect(screen.getByText('synthetic-member')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { level: 1, name: 'Subscriptions' })).toBeNull();
  });
  it('opens existing subscriptions bookmarks on the events tab without applying any event', async () => {
    window.history.replaceState(null, '', '#/subscriptions/history');
    const { api, review } = page();
    await waitFor(() => expect(window.location.hash).toBe('#/memberships/events/history'));
    expect(screen.getByRole('tab', { name: 'Processed' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: /^Events/ }).getAttribute('aria-selected')).toBe('true');
    expect(review).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});
