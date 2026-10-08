// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import type { Job, Session, Settings, SetupConnection } from './types';

const session: Session = {
  authenticated: true,
  csrf_token: 'test-csrf',
  demo: false,
  setup_required: false,
  setup_connected: false,
  setup_protection: 'setup_code',
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
        'I inspected this Jellyfin account and approve a new password and template permissions.',
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
      within(dialog).getByText(/Approving this event manually disables access immediately/),
    ).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' }));
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
    fireEvent.change(within(dialog).getAllByLabelText(/Discord recipient/)[1], {
      target: { value: '123456789012345678' },
    });
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

  it('connects Jellyfin with the setup code, filters unsafe templates, and uses the rotated CSRF token to finish', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = connection;
    responses['/api/setup/complete'] = session;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    const code = screen.getByLabelText('One-time setup code') as HTMLInputElement;
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'one-time-code' } });
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    fireEvent.change(password, { target: { value: 'server-admin-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(code.value).toBe('');
    expect(password.value).toBe('');
    await screen.findByText('Choose account permissions');
    expect(screen.queryByRole('option', { name: 'Admin user' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Disabled user' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Member template' })).toBeTruthy();
    expect(requests.some((request) => request.path === '/api/overview')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByText('Everyone’s next chapter.');
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
  });

  it('keeps the setup wizard available after rejected Jellyfin credentials', async () => {
    responses['/api/session'] = { ...setupSession, setup_protection: 'legacy_password' };
    responses['/api/setup/connect'] = {
      detail: 'Jellyfin did not accept that username and password.',
    };
    statuses['/api/setup/connect'] = 401;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    fireEvent.change(screen.getByLabelText('Current Jellyport password'), {
      target: { value: 'old-jellyport-password' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'bad-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    await screen.findByText('Jellyfin did not accept that username and password.');
    expect(screen.getByText('Connect your Jellyfin server')).toBeTruthy();
    expect((screen.getByLabelText('Current Jellyport password') as HTMLInputElement).value).toBe(
      '',
    );
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('resumes connected setup after a reload and refreshes template users without collecting credentials again', async () => {
    responses['/api/session'] = pendingSession;
    responses['/api/setup'] = { ...connection, templates: [] };
    render(<App />);
    await screen.findByText('Create a regular template user in Jellyfin, then refresh this list.');
    expect(screen.queryByLabelText('Jellyfin password')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    responses['/api/setup'] = connection;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh users' }));
    await screen.findByRole('option', { name: 'Member template' });
    expect(
      (screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows the bound Jellyfin connection and refreshes its managed service key without exposing a key input', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Jellyfin service key' }));
    await screen.findByText('Jellyfin service key refreshed.');
    const request = requests.find((value) => value.path === '/api/auth/service-key')!;
    expect(request.options?.method).toBe('POST');
    expect((request.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf');
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
    expect((screen.getByLabelText('One-time setup code') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
    const logout = requests.find((request) => request.path === '/api/logout')!;
    expect(logout.options?.method).toBe('POST');
    expect((logout.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'pending-csrf',
    );
    fireEvent.change(screen.getByLabelText('One-time setup code'), {
      target: { value: 'one-time-code' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Jellyfin password'), {
      target: { value: 'new-admin-password' },
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
    await screen.findByLabelText('One-time setup code');
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByText('Connect your Jellyfin server')).toBeTruthy();
    expect((screen.getByLabelText('Jellyfin password') as HTMLInputElement).value).toBe('');
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
  it('renews an expired anonymous cookie before transmitting setup credentials', async () => {
    responses['/api/session'] = setupSession;
    responses['/api/setup/connect'] = connection;
    render(<App />);
    await screen.findByText('Connect your Jellyfin server');
    responses['/api/session'] = { ...setupSession, csrf_token: 'renewed-setup-csrf' };
    fireEvent.change(screen.getByLabelText('One-time setup code'), {
      target: { value: 'one-time-code' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin server URL'), {
      target: { value: 'http://jellyfin:8096' },
    });
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'admin' } });
    const password = screen.getByLabelText('Jellyfin password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'server-admin-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jellyfin' }));
    expect(password.value).toBe('');
    await screen.findByText('Choose account permissions');
    const connect = requests.find((request) => request.path === '/api/setup/connect')!;
    expect((connect.options?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'renewed-setup-csrf',
    );
  });
});
