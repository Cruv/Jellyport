// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MembershipsPage from './MembershipsPage';
import {
  defaultMembershipTiers,
  type Api,
  type ApiOptions,
  type Job,
  type Membership,
  type Settings,
} from './types';

const ownerId = '123456789012345678';
const member = {
  id: ownerId,
  username: 'Jim',
  display_name: 'Captain Jim',
  nickname: null,
  membership_active: true,
};
const membership: Membership = {
  discord_user_id: ownerId,
  base_username: 'Jim',
  tier_id: 'galleon',
  account_limit: 3,
  active: true,
  revision: 'membership-revision-1',
  links: [1, 2, 3].map((slot) => ({
    discord_user_id: ownerId,
    username: slot === 1 ? 'Jim' : `Jim_${slot}`,
    remote_id: `jellyfin-${slot}`,
    membership_slot: slot,
    disabled_by_jellyport: 0,
    pending_disabled: null,
  })),
};
const job: Job = {
  id: 'membership-job-1',
  kind: 'membership',
  status: 'queued',
  created_at: '2026-10-08T12:00:00Z',
};
const settings = { membership_tiers: defaultMembershipTiers } as Settings;

function page(memberships: Membership[] = [], customApi?: Api) {
  const requests: { path: string; options?: ApiOptions }[] = [];
  const api =
    customApi ||
    (vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      if (path === '/api/memberships') return { memberships };
      if (path === '/api/user-mappings') return { mappings: [] };
      if (path.startsWith('/api/discord/members?')) return { members: [member], truncated: false };
      if (path === '/api/memberships/provision') return job;
      throw new Error(`Unexpected request ${path}`);
    }) as Api);
  const notify = vi.fn();
  const created = vi.fn();
  const view = render(
    <MembershipsPage settings={settings} api={api} notify={notify} created={created} />,
  );
  return { ...view, api, requests, notify, created };
}
const mutations = (requests: { path: string; options?: ApiOptions }[]) =>
  requests.filter((request) => request.options?.method);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('Discord membership account allowances', () => {
  it('reviews approved mapping names before provisioning a member whose server username was simplified', async () => {
    const mapped = ['SimplifiedJim', 'FamilyJim'].map((username, index) => ({
      id: `mapping-${index + 1}`,
      source_user_id: `emby-${index + 1}`,
      source_username: index === 0 ? 'Jim!' : 'Jim!_2',
      target_user_id: null,
      target_username: username,
      discord_user_id: ownerId,
      discord_username: 'Jim',
      membership_slot: index + 1,
      revision: `mapping-revision-${index + 1}`,
    }));
    const api = vi.fn(async (path: string) => {
      if (path === '/api/memberships') return { memberships: [] };
      if (path === '/api/user-mappings') return { mappings: mapped };
      if (path.startsWith('/api/discord/members?')) return { members: [member], truncated: false };
      throw new Error(`Unexpected request ${path}`);
    }) as Api;
    page([], api);
    await screen.findByText('Give each member their account allowance.');
    fireEvent.change(screen.getByLabelText('Discord member'), { target: { value: 'Jim' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @Jim' }));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'galleon' } });
    expect(screen.getByText('SimplifiedJim, FamilyJim, SimplifiedJim_3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('SimplifiedJim')).toBeTruthy();
    expect(within(dialog).getByText('FamilyJim')).toBeTruthy();
    expect(within(dialog).getByText('SimplifiedJim_3')).toBeTruthy();
  });

  it('queries the Discord owner and requires review before provisioning all three Galleon slots', async () => {
    const { requests, created } = page();
    await screen.findByText('Give each member their account allowance.');
    fireEvent.change(screen.getByLabelText('Discord member'), { target: { value: 'Captain Jim' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @Jim' }));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'galleon' } });
    expect(screen.getByText('Jim, Jim_2, Jim_3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Jim_2')).toBeTruthy();
    expect(within(dialog).getByText('Jim_3')).toBeTruthy();
    expect(mutations(requests)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Queue membership update' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(job));
    expect(mutations(requests)[0]).toMatchObject({
      path: '/api/memberships/provision',
      options: {
        method: 'POST',
        body: {
          discord_user_id: ownerId,
          tier_id: 'galleon',
          expected_account_limit: 3,
          expected_usernames: ['Jim', 'Jim_2', 'Jim_3'],
        },
      },
    });
    expect(Object.keys(mutations(requests)[0].options?.body as object)).toEqual([
      'discord_user_id',
      'tier_id',
      'expected_account_limit',
      'expected_usernames',
    ]);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('reviews a downgrade with saved custom account names and submits the membership revision', async () => {
    const custom = {
      ...membership,
      links: membership.links.map((link) =>
        link.membership_slot === 2 ? { ...link, username: 'Jim_family' } : link,
      ),
    };
    const { requests } = page([custom]);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'sloop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        'Disable these accounts outside the new allowance and keep all their data:',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Jim_family')).toBeTruthy();
    expect(within(dialog).getByText('Jim_3')).toBeTruthy();
    expect(mutations(requests)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Queue membership update' }));
    await waitFor(() => expect(mutations(requests)).toHaveLength(1));
    expect(mutations(requests)[0].options?.body).toEqual({
      discord_user_id: ownerId,
      tier_id: 'sloop',
      expected_account_limit: 1,
      expected_usernames: ['Jim'],
      expected_revision: membership.revision,
    });
  });

  it('explains reactivation and only restores accounts disabled by Jellyport', async () => {
    page([
      {
        ...membership,
        active: false,
        tier_id: 'sloop',
        account_limit: 1,
        links: membership.links.map((link) => ({
          ...link,
          disabled_by_jellyport: link.membership_slot > 1 ? 1 : 0,
        })),
      },
    ]);
    await screen.findByText('Inactive membership');
    fireEvent.click(screen.getByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.change(screen.getByLabelText('Membership tier'), { target: { value: 'brigantine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        'This update marks the membership active again and restores eligible accounts.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Re-enable the preserved account if Jellyport disabled it/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Accounts disabled outside Jellyport require your review/),
    ).toBeTruthy();
  });

  it('omits a blank legacy revision when enrolling an existing primary account', async () => {
    const { requests } = page([
      {
        ...membership,
        revision: '',
        tier_id: 'sloop',
        account_limit: 1,
        links: [membership.links[0]],
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(mutations(requests)).toHaveLength(1));
    expect(mutations(requests)[0].options?.body).toEqual({
      discord_user_id: ownerId,
      tier_id: 'sloop',
      expected_account_limit: 1,
      expected_usernames: ['Jim'],
    });
  });

  it('aborts private membership reads when unmounted and ignores their late responses', async () => {
    let resolve!: (value: unknown) => void;
    let signal!: AbortSignal;
    const api = vi.fn(async (_path: string, options?: ApiOptions) => {
      if (_path === '/api/user-mappings') return { mappings: [] };
      signal = options!.signal!;
      return new Promise((finish) => {
        resolve = finish;
      });
    }) as Api;
    const { unmount, created, notify } = page([], api);
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ memberships: [membership] }));
    expect(screen.queryByText('Jim')).toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('aborts a pending provision response on unmount without reopening jobs or notifications', async () => {
    let finish!: (value: Job) => void;
    let signal!: AbortSignal;
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      if (path === '/api/memberships') return { memberships: [membership] };
      if (path === '/api/user-mappings') return { mappings: [] };
      signal = options!.signal!;
      return new Promise<Job>((resolve) => {
        finish = resolve;
      });
    }) as Api;
    const { unmount, created, notify } = page([], api);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(job));
    expect(created).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps a rejected update review open without showing credentials or claiming success', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/memberships') return { memberships: [membership] };
      if (path === '/api/user-mappings') return { mappings: [] };
      throw new Error('Membership changed. Refresh and review again.');
    }) as Api;
    const { created } = page([], api);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveProperty(
      'textContent',
      'Membership changed. Refresh and review again.',
    );
    expect(created).not.toHaveBeenCalled();
  });

  it('submits the reviewed allowance and names when tier settings change before confirmation', async () => {
    let submitted: unknown;
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      if (path === '/api/memberships')
        return { memberships: [{ ...membership, tier_id: 'sloop', account_limit: 1 }] };
      if (path === '/api/user-mappings') return { mappings: [] };
      submitted = options?.body;
      throw new Error('The tier allowance changed. Refresh and review again.');
    }) as Api;
    const { rerender, notify, created } = page([], api);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    rerender(
      <MembershipsPage
        settings={{
          ...settings,
          membership_tiers: defaultMembershipTiers.map((tier) =>
            tier.id === 'sloop' ? { ...tier, account_limit: 3 } : tier,
          ),
        }}
        api={api}
        notify={notify}
        created={created}
      />,
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveProperty(
      'textContent',
      'The tier allowance changed. Refresh and review again.',
    );
    expect(submitted).toEqual({
      discord_user_id: ownerId,
      tier_id: 'sloop',
      expected_account_limit: 1,
      expected_usernames: ['Jim'],
      expected_revision: membership.revision,
    });
    expect(created).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('saves complimentary access for a non-paying member without creating or modifying media accounts', async () => {
    const requests: { path: string; options?: ApiOptions }[] = [];
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      if (path === '/api/memberships') return { memberships: [] };
      if (path === '/api/user-mappings') return { mappings: [] };
      if (path.startsWith('/api/discord/members?'))
        return { members: [{ ...member, membership_active: false }], truncated: false };
      if (path === '/api/memberships/access')
        return {
          ...membership,
          access_mode: 'complimentary',
          account_limit: 2,
          tier_id: 'complimentary',
        };
      throw new Error(`Unexpected request ${path}`);
    }) as Api;
    const { notify, created } = page([], api);
    await screen.findByText('Give each member their account allowance.');
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    fireEvent.change(screen.getByLabelText('Discord member'), { target: { value: 'Jim' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @Jim' }));
    expect(screen.getByLabelText('Access policy')).toHaveProperty('value', 'complimentary');
    fireEvent.change(screen.getByLabelText('Complimentary account allowance'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save access policy' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Access policy saved. Media accounts have not been changed.',
      ),
    );
    expect(mutations(requests)).toEqual([
      {
        path: '/api/memberships/access',
        options: expect.objectContaining({
          method: 'POST',
          body: { discord_user_id: ownerId, access_mode: 'complimentary', account_limit: 2 },
        }),
      },
    ]);
    expect(created).not.toHaveBeenCalled();
  });

  it('saves a reviewed complimentary policy before queuing accounts using the newly saved revision', async () => {
    const requests: { path: string; options?: ApiOptions }[] = [];
    const api = vi.fn(async (path: string, options?: ApiOptions) => {
      requests.push({ path, options });
      if (path === '/api/memberships') return { memberships: [membership] };
      if (path === '/api/user-mappings') return { mappings: [] };
      if (path === '/api/memberships/access')
        return {
          ...membership,
          access_mode: 'complimentary',
          account_limit: 1,
          tier_id: 'complimentary',
          revision: 'free-revision',
        };
      if (path === '/api/memberships/provision') return job;
      throw new Error(`Unexpected request ${path}`);
    }) as Api;
    const { created } = page([], api);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage membership for Jim' }));
    fireEvent.change(screen.getByLabelText('Access policy'), {
      target: { value: 'complimentary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review membership update' }));
    expect(mutations(requests)).toHaveLength(0);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue membership update' }),
    );
    await waitFor(() => expect(created).toHaveBeenCalledWith(job));
    expect(mutations(requests).map((entry) => entry.path)).toEqual([
      '/api/memberships/access',
      '/api/memberships/provision',
    ]);
    expect(mutations(requests)[1].options?.body).toEqual({
      discord_user_id: ownerId,
      tier_id: 'complimentary',
      expected_account_limit: 1,
      expected_usernames: ['Jim'],
      expected_revision: 'free-revision',
    });
  });
});
