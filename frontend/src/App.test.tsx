// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import type { Job, Settings } from './types';

const session = { authenticated: true, csrf_token: 'test-csrf', demo: false };
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
let requests: { path: string; options?: RequestInit }[];
beforeEach(() => {
  requests = [];
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
      return { ok: true, status: 200, json: async () => value };
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
