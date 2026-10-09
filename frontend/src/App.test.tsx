// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import type { Job, Session, Settings, SetupConnection } from './types';

const session: Session = {
  authenticated: true,
  csrf_token: 'test-csrf',
  demo: false,
  setup_required: false,
  setup_connected: false,
  user: { id: 'admin-id', name: 'jellyfin-admin' },
};
const job: Job = {
  id: 'job-1',
  kind: 'create',
  status: 'completed',
  created_at: '2026-10-07T12:00:00Z',
  results: [
    {
      username: '<script>bad()</script>',
      status: 'created',
      created: true,
      discord_delivery: 'not_requested',
    },
  ],
};
const overview = {
  counts: { emby_users: 1, jellyfin_users: 1, jobs: 1 },
  connections: {
    emby: { connected: true, configured: true },
    jellyfin: { connected: true, configured: true },
    discord: { connected: false },
  },
  recent_jobs: [job],
};
const settings: Settings = {
  emby_url: '',
  emby_api_key_set: true,
  jellyfin_url: '',
  jellyfin_api_key_set: true,
  jellyfin_auth_managed: false,
  jellyfin_public_url: '',
  template_user_id: 'template',
  path_mappings: [],
  discord_enabled: false,
  discord_bot_token_set: false,
  discord_guild_id: '',
  discord_admin_role_id: '',
  discord_member_role_id: '',
  discord_application_id: '',
  discord_subscription_channel_id: '',
  discord_subscription_bot_id: '',
  discord_message_events: false,
  discord_role_events: false,
  auto_provision: false,
  auto_disable: false,
  disable_on_cancel: false,
  bot_invite_url: '',
};
let responses: Record<string, unknown>;
let statuses: Record<string, number>;
let requests: { path: string; options?: RequestInit }[];
beforeEach(() => {
  requests = [];
  statuses = {};
  responses = {
    '/api/session': session,
    '/api/overview': overview,
    '/api/jobs': { jobs: [job] },
    '/api/jobs/job-1': job,
    '/api/jobs/job-1/credentials': {
      credentials: [
        { username: 'alex', password: 'one-time-secret', server_url: 'javascript:alert(1)' },
      ],
    },
    '/api/settings': settings,
    '/api/users': { emby: [], jellyfin: [] },
    '/api/user-mappings': { mappings: [] },
    '/api/account-roles': { roles: [], assignments: [] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      requests.push({ path, options });
      if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
      const value = responses[path];
      const status = statuses[path] || 200;
      if (status >= 200 && status < 300) {
        if (path === '/api/setup/connect')
          responses['/api/session'] = (value as SetupConnection).session;
        else if (['/api/login', '/api/logout', '/api/setup/complete'].includes(path))
          responses['/api/session'] = value;
      }
      return { ok: status >= 200 && status < 300, status, json: async () => value };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function openJob() {
  render(<App />);
  await screen.findByText('Everyone’s next chapter.');
  fireEvent.click(screen.getByRole('button', { name: 'View operation details' }));
  return screen.findByRole('dialog');
}
describe('React account safeguards', () => {
  it('loads editable tier defaults and only saves their definitions without provisioning accounts', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByText('Membership tiers');
    const tiers = screen.getAllByLabelText('Tier name');
    const limits = screen.getAllByLabelText('Account allowance');
    expect(tiers.map((input) => (input as HTMLInputElement).value)).toEqual([
      'Sloop',
      'Brigantine',
      'Galleon',
    ]);
    expect(limits.map((input) => (input as HTMLSelectElement).value)).toEqual(['1', '2', '3']);
    fireEvent.change(tiers[1], { target: { value: 'Brigantine Crew' } });
    fireEvent.change(screen.getAllByLabelText('Subscription plan name')[1], {
      target: { value: 'Brigantine Paid Plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved. Your connections are ready to test.');
    const saved = requests.find(
      (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
    )!;
    expect(JSON.parse(String(saved.options?.body)).membership_tiers[1]).toEqual({
      id: 'brigantine',
      name: 'Brigantine Crew',
      plan_name: 'Brigantine Paid Plan',
      account_limit: 2,
    });
    expect(requests.some((request) => request.path === '/api/memberships/provision')).toBe(false);
  });

  it('clears membership owners and account names when the administrator signs out', async () => {
    responses['/api/memberships'] = {
      memberships: [
        {
          discord_user_id: '123456789012345678',
          base_username: 'private-owner',
          tier_id: 'brigantine',
          account_limit: 2,
          active: true,
          revision: 'revision-1',
          links: [
            {
              discord_user_id: '123456789012345678',
              username: 'private-family-account',
              remote_id: 'jf-1',
              membership_slot: 2,
              disabled_by_jellyport: 0,
              pending_disabled: null,
            },
          ],
        },
      ],
    };
    responses['/api/logout'] = { ...session, authenticated: false, user: undefined };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Memberships' }));
    await screen.findByText('private-family-account');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Jellyfin username');
    expect(screen.queryByText('private-family-account')).toBeNull();
    expect(screen.queryByText('private-owner')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('uses a saved default role for fresh account creation without a fallback template', async () => {
    responses['/api/settings'] = { ...settings, template_user_id: '', default_role_id: 'role-1' };
    responses['/api/accounts'] = job;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alex' } });
    const form = screen.getByLabelText('Username').closest('form')!;
    const submit = within(form).getByRole('button', { name: 'Create account' });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/accounts')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/accounts')!.options?.body),
      ),
    ).toEqual({ username: 'alex' });
  });
  it('loads roles into settings and saves the selected default independently of the template', async () => {
    responses['/api/account-roles'] = {
      roles: [
        {
          id: 'role-1',
          name: 'Crew defaults',
          revision: 'revision-1',
          parameters: { policy: {}, configuration: {}, display: null },
        },
      ],
      assignments: [],
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('option', { name: 'Crew defaults' });
    fireEvent.change(screen.getByLabelText('Default account role'), {
      target: { value: 'role-1' },
    });
    fireEvent.change(screen.getByLabelText('Fallback template user'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved. Your connections are ready to test.');
    const saved = requests.find(
      (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
    )!;
    expect(JSON.parse(String(saved.options?.body))).toMatchObject({
      default_role_id: 'role-1',
      template_user_id: '',
    });
  });
  it('opens account role management from the main navigation', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Account roles' }));
    await screen.findByText('Set the experience once.');
    await screen.findByText('Create an account role');
    expect(requests.some((request) => request.path === '/api/account-roles')).toBe(true);
  });
  it('keeps the saved default selected when role names finish loading later', async () => {
    responses['/api/settings'] = { ...settings, default_role_id: 'role-1' };
    const baseFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let resolveRoles!: (value: unknown) => void;
    vi.mocked(globalThis.fetch).mockImplementation(async (...args) => {
      if (args[0] === '/api/account-roles') {
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((resolve) => {
              resolveRoles = resolve;
            }),
        } as Response;
      }
      return baseFetch(...args);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('option', { name: 'Saved default role' });
    expect((screen.getByLabelText('Default account role') as HTMLSelectElement).value).toBe(
      'role-1',
    );
    await waitFor(() => expect(resolveRoles).toBeTypeOf('function'));
    await act(async () =>
      resolveRoles({ roles: [{ id: 'role-1', name: 'Crew defaults' }], assignments: [] }),
    );
    await screen.findByRole('option', { name: 'Crew defaults' });
    expect((screen.getByLabelText('Default account role') as HTMLSelectElement).value).toBe(
      'role-1',
    );
  });
  it('reveals credentials only after explicit confirmation, renders text safely, and clears secrets on close', async () => {
    let dialog = await openJob();
    expect(within(dialog).getByText('<script>bad()</script>')).toBeTruthy();
    expect(dialog.querySelector('script')).toBeNull();
    expect(requests.some((request) => request.path.endsWith('/credentials'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal new credentials' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reveal new account credentials?')).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith('/credentials'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal credentials' }));
    await screen.findByText('one-time-secret');
    const reveal = requests.find((request) => request.path.endsWith('/credentials'))!;
    expect(reveal.options?.method).toBe('POST');
    expect((reveal.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('one-time-secret')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('does not display late credential responses after the dialog is closed', async () => {
    await openJob();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
    let resolve!: (value: unknown) => void;
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementationOnce(
      async () =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((done) => {
              resolve = done;
            }),
        }) as Response,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reveal credentials' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    resolve({ credentials: [{ username: 'alex', password: 'late-secret' }] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revealing…' })).toBeNull());
    expect(screen.queryByText('late-secret')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('requires inspection and explicit approval before account recovery, and invalidates approval when inputs change', async () => {
    responses['/api/accounts/recovery?username=alex'] = {
      username: 'alex',
      eligible: true,
      reason: 'Tracked incomplete creation',
      target_user_id: 'jf-alex',
    };
    render(<App />);
    await screen.findByText('Everyone’s next chapter.');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Welcome someone new.');
    fireEvent.click(screen.getByText('Recover an interrupted account creation'));
    fireEvent.change(screen.getByLabelText('Account to inspect'), { target: { value: 'alex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    await screen.findByText('alex · Eligible for recovery');
    expect(
      (screen.getByRole('button', { name: 'Recover account' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByLabelText(
        'I inspected this Jellyfin account and approve a new password and account defaults.',
      ),
    );
    expect(
      (screen.getByRole('button', { name: 'Recover account' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.input(screen.getByLabelText('Account to inspect'), {
      target: { value: 'different' },
    });
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/accounts/recover')).toBe(false);
  });
  it('selects a Discord member and fills the fresh account username without typing an ID', async () => {
    responses['/api/discord/members?query=Captain'] = {
      members: [
        {
          id: '123456789012345678',
          username: 'alex.actual',
          display_name: 'Alex',
          nickname: 'Captain Alex',
          membership_active: true,
        },
      ],
      truncated: false,
    };
    responses['/api/accounts'] = job;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.change(await screen.findByLabelText('Discord member (optional)'), {
      target: { value: 'Captain' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select @alex.actual' }));
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('alex.actual');
    fireEvent.click(
      within(screen.getByLabelText('Username').closest('form')!).getByRole('button', {
        name: 'Create account',
      }),
    );
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/accounts')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/accounts')!.options?.body),
      ),
    ).toEqual({
      username: 'alex.actual',
      discord_user_id: '123456789012345678',
    });
  });
  it('invalidates recovery approval when a searched Discord recipient is selected', async () => {
    responses['/api/accounts/recovery?username=alex'] = {
      username: 'alex',
      eligible: true,
      reason: 'Tracked incomplete creation',
      target_user_id: 'jf-alex',
    };
    responses['/api/discord/members?query=alex'] = {
      members: [
        {
          id: '123456789012345678',
          username: 'alex',
          display_name: null,
          nickname: null,
          membership_active: true,
        },
      ],
      truncated: false,
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.click(await screen.findByText('Recover an interrupted account creation'));
    fireEvent.change(screen.getByLabelText('Account to inspect'), { target: { value: 'alex' } });
    fireEvent.focus(screen.getByLabelText('Recovery Discord member (optional)'));
    await screen.findByRole('button', { name: 'Select @alex' });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect account' }));
    await screen.findByText('alex · Eligible for recovery');
    fireEvent.click(
      screen.getByLabelText(
        'I inspected this Jellyfin account and approve a new password and account defaults.',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Select @alex' }));
    expect(screen.queryByRole('button', { name: 'Recover account' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/accounts/recover')).toBe(false);
  });
  it('states that manual cancellation approval disables access immediately before sending the request', async () => {
    const event = {
      id: 'event-1',
      username: 'alex',
      discord_user_id: '123456789012345678',
      action: 'cancel',
      status: 'pending',
      created_at: '2026-10-07T12:00:00Z',
    };
    responses['/api/subscriptions'] = { events: [event] };
    responses['/api/subscriptions/event-1/apply'] = { ...event, status: 'applied' };
    render(<App />);
    await screen.findByText('Everyone’s next chapter.');
    fireEvent.click(screen.getByRole('button', { name: 'Subscriptions' }));
    await screen.findByText('Membership, connected.');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        /Approving this event manually disables all linked account slots immediately/,
      ),
    ).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable linked accounts now' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(true),
    );
  });
  it('clears the authenticated console and private dialogs on a rejected session', async () => {
    await openJob();
    responses['/api/session'] = { ...session, authenticated: false, user: undefined };
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementationOnce(
      async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({ detail: 'Sign in to Jellyport.' }),
        }) as Response,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('<script>bad()</script>')).toBeNull();
  });

  it.each(['network', 'service', 'allocation'] as const)(
    'clears private credentials after a %s logout failure without restoring the old session',
    async (failure) => {
      await openJob();
      fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Reveal credentials' }));
      await screen.findByText('one-time-secret');
      const fetch = vi.mocked(globalThis.fetch);
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (input, options) => {
        if (String(input) === '/api/logout') {
          if (failure === 'network') throw new TypeError('Synthetic connection failure.');
          return {
            ok: false,
            status: failure === 'service' ? 503 : 429,
            json: async () => ({
              detail: failure === 'service' ? 'Service unavailable.' : 'Too many new sessions.',
            }),
          } as Response;
        }
        return original(input, options);
      });
      const previousSessionRequests = requests.filter(
        (request) => request.path === '/api/session',
      ).length;
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await screen.findByText('Welcome back');
      expect(screen.getByRole('alert').textContent).toContain(
        'server sign-out could not be confirmed',
      );
      expect(screen.queryByText('one-time-secret')).toBeNull();
      expect(screen.queryByText('<script>bad()</script>')).toBeNull();
      expect(screen.queryByText('jellyfin-admin')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(requests.filter((request) => request.path === '/api/session')).toHaveLength(
        previousSessionRequests,
      );
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    },
  );

  it('does not restore private dialogs from a credential response arriving after failed logout', async () => {
    await openJob();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal new credentials' }));
    let resolve!: (value: unknown) => void;
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/credentials'))
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((done) => {
              resolve = done;
            }),
        } as Response;
      if (String(input) === '/api/logout') throw new TypeError('Synthetic connection failure.');
      return original(input, options);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal credentials' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    await act(async () => {
      resolve({
        credentials: [{ username: 'late-private-user', password: 'late-private-password' }],
      });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revealing…' })).toBeNull());
    expect(screen.queryByText('late-private-user')).toBeNull();
    expect(screen.queryByText('late-private-password')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Everyone’s next chapter.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'server sign-out could not be confirmed',
    );
  });

  it('requires fresh credential verification after a failed logout even when the server retains its session', async () => {
    await openJob();
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, options) => {
      if (String(input) === '/api/logout') throw new TypeError('Synthetic connection failure.');
      return original(input, options);
    });
    responses['/api/login'] = { detail: 'Incorrect credentials.' };
    statuses['/api/login'] = 401;
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Welcome back');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'incorrect' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Incorrect credentials.'),
    );
    expect(screen.queryByText('Everyone’s next chapter.')).toBeNull();
    expect(screen.queryByText('<script>bad()</script>')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('previews selected users and preserves optional Discord links in a bulk migration', async () => {
    responses['/api/users'] = {
      emby: [
        { Id: 'e-alex', Name: 'alex' },
        { Id: 'e-river', Name: 'river' },
      ],
      jellyfin: [{ Id: 'j-river', Name: 'river' }],
    };
    responses['/api/migrations/preview'] = {
      users: [
        {
          source_user_id: 'e-alex',
          username: 'alex',
          target_exists: false,
          stats: { source_played: 2, matched: 2 },
        },
        {
          source_user_id: 'e-river',
          username: 'river',
          target_exists: true,
          stats: { source_played: 1, matched: 1 },
        },
      ],
    };
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    responses['/api/discord/members?query=river'] = {
      members: [
        {
          id: '123456789012345678',
          username: 'river',
          display_name: 'River Display',
          nickname: 'River Captain',
          membership_active: true,
        },
      ],
      truncated: false,
    };
    render(<App />);
    await screen.findByText('Everyone’s next chapter.');
    fireEvent.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Migrate users' }),
    );
    await screen.findByRole('checkbox', { name: 'Select all visible Emby users' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge into existing account')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'The existing Jellyfin password and account permissions will be preserved.',
      ),
    ).toBeTruthy();
    expect(requests.some((request) => request.path.startsWith('/api/discord/members'))).toBe(false);
    fireEvent.focus(within(dialog).getAllByLabelText('Discord recipient (optional)')[1]);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Select @river' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
    );
    const request = requests.find((value) => value.path === '/api/migrations')!;
    expect(JSON.parse(String(request.options?.body))).toEqual({
      source_user_ids: ['e-alex', 'e-river'],
      discord_recipients: { 'e-river': '123456789012345678' },
    });
  });
  it('shows approved identity exceptions and submits the preview mapping revision with its verified recipient', async () => {
    responses['/api/users'] = { emby: [{ Id: 'complex', Name: 'Mr. Complex !' }], jellyfin: [] };
    responses['/api/migrations/preview'] = {
      users: [
        {
          source_user_id: 'complex',
          source_username: 'Mr. Complex !',
          username: 'simple',
          target_exists: true,
          mapping_id: 'map-1',
          mapping_revision: 'approved-revision',
          discord_user_id: '123456789012345678',
          discord_username: 'discord.original',
          stats: {
            source_played: 2,
            source_favorites: 3,
            source_resume: 1,
            source_playlists: 2,
            matched: 5,
          },
          warnings: ['Some source playlists could not be read.'],
        },
      ],
    };
    responses['/api/migrations'] = { ...job, kind: 'migrate' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate users' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all visible Emby users' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview migration (1)' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Mapped Emby account: Mr. Complex ! → Jellyfin: simple'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Some source playlists could not be read.')).toBeTruthy();
    expect(within(dialog).getByText('Favorites in Emby')).toBeTruthy();
    expect(within(dialog).getByText('Resume positions')).toBeTruthy();
    expect(within(dialog).getByText('Playlists')).toBeTruthy();
    const recipient = dialog.querySelector('input[name="complex"]') as HTMLInputElement;
    expect(recipient.value).toBe('123456789012345678');
    expect(within(dialog).getByText('@discord.original')).toBeTruthy();
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Clear Discord member @discord.original',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start migration' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/migrations')).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((request) => request.path === '/api/migrations')!.options?.body),
      ),
    ).toEqual({
      source_user_ids: ['complex'],
      discord_recipients: { complex: '123456789012345678' },
      mapping_revisions: { complex: 'approved-revision' },
    });
  });
  it('reports detailed migration results and escapes source names and warnings', async () => {
    responses['/api/jobs/job-1'] = {
      ...job,
      kind: 'migrate',
      status: 'partial',
      results: [
        {
          username: 'simple',
          source_username: '<script>source()</script>',
          status: 'partial',
          data: {
            items_updated: 4,
            favorites: 2,
            resume_positions: 1,
            play_counts: 3,
            last_played_dates: 2,
            ratings: 1,
            preferences: ['SubtitleMode'],
            avatar: true,
            playlists_created: 1,
            playlists_existing: 2,
            playlist_items_added: 3,
            playlist_items_skipped: 1,
            playlist_duplicates_skipped: 0,
            failed_items: 0,
            history_dates_missing: 0,
            warnings: ['<img src=x onerror=unsafe()>'],
          },
        },
      ],
    };
    const dialog = await openJob();
    expect(within(dialog).getByText('4 items updated')).toBeTruthy();
    expect(within(dialog).getByText('2 favorites')).toBeTruthy();
    expect(within(dialog).getByText('1 resume positions')).toBeTruthy();
    expect(within(dialog).getByText('1 playlists created')).toBeTruthy();
    expect(within(dialog).getByText('Profile image copied')).toBeTruthy();
    expect(
      within(dialog).getByText('Emby: <script>source()</script> → Jellyfin: simple'),
    ).toBeTruthy();
    expect(within(dialog).getByText('<img src=x onerror=unsafe()>')).toBeTruthy();
    expect(dialog.querySelector('script,img')).toBeNull();
  });
  it('closes mobile navigation when moving to a page and dismisses private dialogs with Escape', async () => {
    await openJob();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByText('Every move, recorded.');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

const anonymous: Session = { ...session, authenticated: false, user: undefined };
const setupSession: Session = { ...anonymous, setup_required: true };
const pendingSession: Session = {
  ...setupSession,
  setup_connected: true,
  csrf_token: 'pending-csrf',
};
const connection: SetupConnection = {
  session: pendingSession,
  server: { url: 'http://jellyfin:8096' },
  templates: [
    { Id: 'admin-id', Name: 'Admin user', Policy: { IsAdministrator: true } },
    { Id: 'disabled', Name: 'Disabled user', Policy: { IsDisabled: true } },
    {
      Id: 'template',
      Name: 'Member template',
      Policy: { IsAdministrator: false, IsDisabled: false },
    },
  ],
  defaults: { template_user_id: 'template', jellyfin_public_url: 'https://media.example.com' },
};

describe('Jellyfin administrator sign-in and setup', () => {
  it('guides secure-cookie HTTP visitors to their HTTPS address without collecting sign-in credentials', async () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    responses['/api/session'] = { ...anonymous, secure_cookie: true };
    render(<App />);
    await screen.findByRole('heading', { name: 'HTTPS is required for sign-in' });
    expect(screen.getByText(/Open your HTTPS reverse-proxy address to continue/)).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin username')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/login')).toBe(false);
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
  });

  it('allows secure-cookie HTTP setup and transitions to HTTPS guidance when setup completes', async () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    responses['/api/session'] = { ...setupSession, secure_cookie: true };
    responses['/api/setup/connect'] = {
      ...connection,
      session: { ...pendingSession, secure_cookie: true },
    };
    responses['/api/setup/complete'] = {
      ...anonymous,
      csrf_token: 'finished-csrf',
      secure_cookie: true,
    };
    render(<App />);
    const apiKey = (await screen.findByLabelText('Jellyfin API key')) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(apiKey, { target: { value: 'local-setup-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(apiKey.value).toBe('');
    await screen.findByText('Choose account permissions');
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByText('Setup complete. Your server connection has been saved.');
    expect(screen.getByRole('heading', { name: 'HTTPS is required for sign-in' })).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin API key')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin username')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/setup/connect')).toBe(true);
    expect(requests.some((request) => request.path === '/api/setup/complete')).toBe(true);
    expect(requests.some((request) => request.path === '/api/login')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('preserves normal administrator sign-in over HTTPS with secure cookies enabled', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    responses['/api/session'] = { ...anonymous, secure_cookie: true };
    responses['/api/login'] = { ...session, secure_cookie: true };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'https-admin-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(password.value).toBe('');
    await screen.findByText('Everyone’s next chapter.');
    const login = requests.find((request) => request.path === '/api/login')!;
    expect(JSON.parse(String(login.options?.body))).toEqual({
      username: 'jellyfin-admin',
      password: 'https-admin-password',
    });
  });

  it('does not transmit a password if refreshed session policy requires HTTPS on an HTTP page', async () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    responses['/api/session'] = anonymous;
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'do-not-send-password' } });
    responses['/api/session'] = { ...anonymous, secure_cookie: true };
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(password.value).toBe('');
    await screen.findByRole('heading', { name: 'HTTPS is required for sign-in' });
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(requests.some((request) => request.path === '/api/login')).toBe(false);
    expect(
      requests.some((request) => String(request.options?.body).includes('do-not-send-password')),
    ).toBe(false);
  });

  it('retries a failed session fetch from the sign-in page', async () => {
    responses['/api/session'] = { detail: 'Jellyport is temporarily unavailable.' };
    statuses['/api/session'] = 503;
    render(<App />);
    await screen.findByRole('button', { name: 'Retry connection' });
    expect(screen.getByRole('alert').textContent).toBe('Jellyport is temporarily unavailable.');
    responses['/api/session'] = anonymous;
    statuses['/api/session'] = 200;
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByLabelText('Jellyfin username');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('signs in with the Jellyfin username and password, clears the form secret, and displays the administrator', async () => {
    responses['/api/session'] = anonymous;
    responses['/api/login'] = session;
    render(<App />);
    await screen.findByText('Welcome back');
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('Jellyfin username'), {
      target: { value: 'jellyfin-admin' },
    });
    fireEvent.change(password, { target: { value: 'my-jellyfin-password!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(password.value).toBe('');
    await screen.findByText('Everyone’s next chapter.');
    expect(screen.getByText('jellyfin-admin')).toBeTruthy();
    const login = requests.find((request) => request.path === '/api/login')!;
    expect(JSON.parse(String(login.options?.body))).toEqual({
      username: 'jellyfin-admin',
      password: 'my-jellyfin-password!',
    });
    expect((login.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps sign-in errors inline and clears rejected passwords', async () => {
    responses['/api/session'] = anonymous;
    responses['/api/login'] = { detail: 'Only Jellyfin administrators can sign in.' };
    statuses['/api/login'] = 403;
    render(<App />);
    await screen.findByText('Welcome back');
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'member' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'rejected-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Only Jellyfin administrators can sign in.',
    );
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
  });

  it('connects with a pre-created API key, filters unsafe templates, and finishes at administrator sign-in', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = connection;
    responses['/api/setup/complete'] = { ...anonymous, csrf_token: 'finished-csrf' };
    responses['/api/login'] = session;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    const apiKey = screen.getByLabelText('Jellyfin API key') as HTMLInputElement;
    expect(apiKey.type).toBe('password');
    expect([...apiKey.form!.querySelectorAll('input')].map((field) => field.name)).toEqual([
      'jellyfin_url',
      'api_key',
    ]);
    expect(screen.queryByLabelText('Jellyfin username')).toBeNull();
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect((screen.getByLabelText('Jellyfin server URL') as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(apiKey, { target: { value: 'pre-created-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(apiKey.value).toBe('');
    await screen.findByText('Choose account permissions');
    expect(screen.queryByRole('option', { name: 'Admin user' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Disabled user' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Member template' })).toBeTruthy();
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect(JSON.parse(String(connect.options?.body))).toEqual({
      jellyfin_url: 'http://jellyfin:8096',
      api_key: 'pre-created-api-key',
    });
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByText(
      'Setup complete. Sign in with your Jellyfin administrator account to continue.',
    );
    expect(screen.getByText('Welcome back')).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin API key')).toBeNull();
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
    const complete = requests.find((request) => request.path === '/api/setup/complete')!;
    expect(JSON.parse(String(complete.options?.body))).toEqual({
      template_user_id: 'template',
      jellyfin_public_url: 'https://media.example.com',
    });
    expect((complete.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'pending-csrf',
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'admin-login-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Everyone’s next chapter.');
    const login = requests.find((request) => request.path === '/api/login')!;
    expect(JSON.parse(String(login.options?.body))).toEqual({
      username: 'admin',
      password: 'admin-login-password',
    });
    expect((login.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'finished-csrf',
    );
  });

  it('keeps the setup wizard available after a rejected Jellyfin API key and clears it', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = {
      detail: 'Jellyfin did not accept that API key.',
    };
    statuses['/api/setup/connect'] = 401;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin API key'), {
      target: { value: 'bad-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Jellyfin did not accept that API key.');
    expect(screen.getByText('Connect your Jellyfin server')).toBeTruthy();
    expect((screen.getByLabelText('Jellyfin API key') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
  it('prefills and locks the connected server during guided setup for an existing workspace', async () => {
    const storedUrl = 'http://existing-jellyfin:8096';
    responses['/api/session'] = { ...setupSession, setup_server_url: storedUrl };
    responses['/api/setup/connect'] = { ...connection, server: { url: storedUrl } };
    render(<App />);
    const server = (await screen.findByLabelText('Jellyfin server URL')) as HTMLInputElement;
    expect(server.value).toBe(storedUrl);
    expect(server.readOnly).toBe(true);
    expect(
      screen.getByText('Use a key from the Jellyfin server already connected to this workspace.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Jellyfin API key'), {
      target: { value: 'existing-server-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect(JSON.parse(String(connect.options?.body))).toEqual({
      jellyfin_url: storedUrl,
      api_key: 'existing-server-api-key',
    });
  });

  it('resumes connected setup after a reload and refreshes template users without collecting credentials again', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = { ...connection, templates: [] };
    render(<App />);
    await screen.findByText(
      'No regular template users are available. You can finish setup and configure an account role later.',
    );
    expect(screen.queryByLabelText('Jellyfin API key')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    responses['/api/setup'] = connection;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh users' }));
    await screen.findByRole('option', { name: 'Member template' });
    expect(
      (screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('replaces the key for the bound Jellyfin connection and immediately clears the masked input', async () => {
    responses['/api/settings'] = {
      ...settings,
      jellyfin_url: 'http://jellyfin:8096',
      jellyfin_auth_managed: true,
    };
    responses['/api/auth/service-key'] = responses['/api/settings'];
    render(<App />);
    await screen.findByText('Everyone’s next chapter.');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByText('Set your course.');
    const server = document.querySelector<HTMLInputElement>('#setting-jellyfin_url')!;
    expect(server.readOnly).toBe(true);
    expect(document.querySelector('#setting-jellyfin_api_key')).toBeNull();
    const keyField = screen.getByLabelText('Replacement Jellyfin API key') as HTMLInputElement;
    expect(keyField.type).toBe('password');
    expect(keyField.value).toBe('');
    fireEvent.change(keyField, { target: { value: 'replacement-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace Jellyfin API key' }));
    expect(keyField.value).toBe('');
    await screen.findByText('Jellyfin API key replaced.');
    const request = requests.find((value) => value.path === '/api/auth/service-key')!;
    expect(request.options?.method).toBe('POST');
    expect(JSON.parse(String(request.options?.body))).toEqual({ api_key: 'replacement-api-key' });
    expect((request.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('reconnects an unfinished setup using logout and the new setup session CSRF token', async () => {
    const restartedSession = { ...setupSession, csrf_token: 'restarted-csrf' };
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = connection;
    responses['/api/logout'] = restartedSession;
    responses['/api/setup/connect'] = connection;
    render(<App />);
    await screen.findByText('Choose account permissions');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Jellyfin' }));
    await screen.findByText('Connect your Jellyfin server');
    expect((screen.getByLabelText('Jellyfin API key') as HTMLInputElement).value).toBe('');
    const logout = requests.find((request) => request.path === '/api/logout')!;
    expect(logout.options?.method).toBe('POST');
    expect((logout.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'pending-csrf',
    );
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin API key'), {
      target: { value: 'new-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect((connect.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'restarted-csrf',
    );
  });
  it('rediscovers an expired pending cookie before sending a protected setup request', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = connection;
    responses['/api/setup/complete'] = { detail: 'Setup session expired. Connect Jellyfin again.' };
    statuses['/api/setup/complete'] = 403;
    render(<App />);
    await screen.findByText('Choose account permissions');
    responses['/api/session'] = { ...setupSession, csrf_token: 'fresh-csrf' };
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByLabelText('Jellyfin server URL');
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByText('Connect your Jellyfin server')).toBeTruthy();
    expect((screen.getByLabelText('Jellyfin API key') as HTMLInputElement).value).toBe('');
    expect(requests.some((request) => request.path === '/api/setup/complete')).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe(
      'Setup session expired. Connect Jellyfin again.',
    );
  });
  it('refreshes an expired setup cookie before reconnect logout and uses the new CSRF token', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = connection;
    responses['/api/logout'] = { ...setupSession, csrf_token: 'logout-csrf' };
    render(<App />);
    await screen.findByText('Choose account permissions');
    responses['/api/session'] = { ...setupSession, csrf_token: 'renewed-csrf' };
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Jellyfin' }));
    await screen.findByText('Connect your Jellyfin server');
    const logout = requests.find((request) => request.path === '/api/logout')!;
    expect((logout.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'renewed-csrf',
    );
  });
  it('renews an expired anonymous cookie before transmitting the setup API key', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = connection;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    responses['/api/session'] = { ...setupSession, csrf_token: 'renewed-setup-csrf' };
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    const apiKey = screen.getByLabelText('Jellyfin API key') as HTMLInputElement;
    fireEvent.change(apiKey, { target: { value: 'server-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(apiKey.value).toBe('');
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect((connect.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'renewed-setup-csrf',
    );
  });
  it('clears an unsubmitted setup API key when the sign-in component unmounts', async () => {
    responses['/api/session'] = setupSession;
    const view = render(<App />);
    const keyField = (await screen.findByLabelText('Jellyfin API key')) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'unsubmitted-api-key' } });
    view.unmount();
    expect(keyField.value).toBe('');
    expect(requests.some((request) => request.path === '/api/setup/connect')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('clears rejected replacement keys without altering the bound server', async () => {
    responses['/api/settings'] = {
      ...settings,
      jellyfin_url: 'http://jellyfin:8096',
      jellyfin_auth_managed: true,
    };
    responses['/api/auth/service-key'] = { detail: 'Jellyfin did not accept that API key.' };
    statuses['/api/auth/service-key'] = 400;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'rejected-replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace Jellyfin API key' }));
    expect(keyField.value).toBe('');
    await screen.findByText('Jellyfin did not accept that API key.');
    expect(screen.getByText('Set your course.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect((screen.getByLabelText('Replacement Jellyfin API key') as HTMLInputElement).value).toBe(
      '',
    );
    expect(requests.filter((request) => request.path === '/api/auth/service-key')).toHaveLength(1);
    expect(
      requests.some(
        (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
      ),
    ).toBe(false);
  });
  it('omits replacement keys from ordinary settings saves and clears the field', async () => {
    responses['/api/settings'] = {
      ...settings,
      jellyfin_url: 'http://jellyfin:8096',
      jellyfin_auth_managed: true,
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'not-for-settings-save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(keyField.value).toBe('');
    await screen.findByText('Settings saved. Your connections are ready to test.');
    const request = requests.find(
      (value) => value.path === '/api/settings' && value.options?.method === 'PUT',
    )!;
    expect(String(request.options?.body)).not.toContain('not-for-settings-save');
    expect(JSON.parse(String(request.options?.body))).not.toHaveProperty('api_key');
    expect(requests.some((value) => value.path === '/api/auth/service-key')).toBe(false);
  });
  it('aborts replacement requests and clears any unsubmitted key when leaving settings', async () => {
    responses['/api/settings'] = { ...settings, jellyfin_auth_managed: true };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'pending-replacement-key' } });
    let signal: AbortSignal | undefined;
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path === '/api/auth/service-key') {
          signal = options?.signal || undefined;
          return new Promise(() => {});
        }
        return original(path, options);
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace Jellyfin API key' }));
    expect(keyField.value).toBe('');
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(screen.queryByText('Jellyfin API key replaced.')).toBeNull();
  });
  it('clears an unsubmitted replacement key when leaving Settings', async () => {
    responses['/api/settings'] = { ...settings, jellyfin_auth_managed: true };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const keyField = (await screen.findByLabelText(
      'Replacement Jellyfin API key',
    )) as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'unsubmitted-replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await waitFor(() => expect(keyField.value).toBe(''));
    expect(requests.some((request) => request.path === '/api/auth/service-key')).toBe(false);
  });
});
