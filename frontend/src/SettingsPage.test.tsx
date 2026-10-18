// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, type ReactNode } from 'react';
import SettingsPage from './SettingsPage';
import { DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE } from '../../server/credential-message';
import type { Api, ApiOptions, Settings } from './types';

vi.mock('./SourceSnapshotsPanel', () => ({
  default: () => (
    <form aria-label="Backup import schedule">
      <button type="submit">Save import schedule</button>
    </form>
  ),
}));
vi.mock('./DestinationCatalogPanel', () => ({
  default: () => <button type="button">Import Jellyfin backup</button>,
}));
vi.mock('./AdminAlertsPanel', () => ({ default: () => null }));

const oldSettings: Settings = {
  emby_url: '',
  emby_api_key_set: false,
  jellyfin_url: 'https://jellyfin.example.test',
  jellyfin_api_key_set: true,
  jellyfin_auth_managed: false,
  jellyfin_public_url: 'https://real-public.example.test',
  template_user_id: '',
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

function EditOnCommit({ children, edit }: { children: ReactNode; edit: () => void }) {
  useLayoutEffect(() => {
    edit();
  }, [edit]);
  return children;
}

function page(settings: Settings = oldSettings, respond?: Api, editOnCommit?: () => void) {
  const requests: { path: string; options?: ApiOptions }[] = [];
  const api = vi.fn(async (path: string, options?: ApiOptions) => {
    requests.push({ path, options });
    if (path === '/api/account-roles') return { roles: [] };
    if (path === '/api/jobs/retention' && options?.method !== 'PUT')
      return {
        retention_days: 0,
        interval_seconds: 60,
        batch_limit: 100,
        last_run_at: null,
        last_removed: 0,
        last_kept: 0,
        error: null,
      };
    if (respond) return respond(path, options);
    if (path === '/api/settings' && options?.method === 'PUT') return {};
    throw new Error(`Unexpected request: ${path}`);
  }) as Api;
  const notify = vi.fn();
  const refresh = vi.fn(async () => {});
  const props = { settings, users: { emby: [], jellyfin: [] }, demo: false, api, notify, refresh };
  const node = <SettingsPage {...props} />;
  const result = render(
    editOnCommit ? <EditOnCommit edit={editOnCommit}>{node}</EditOnCommit> : node,
  );
  return { ...result, requests, notify, refresh, props };
}

function submit() {
  fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!);
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', window.location.pathname);
});

function settingsTab(name: string) {
  fireEvent.click(
    within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name }),
  );
}
function passwordPage(...args: Parameters<typeof page>) {
  const result = page(...args);
  settingsTab('Account defaults');
  fireEvent.click(screen.getByRole('tab', { name: 'Passwords & messages' }));
  fireEvent.click(screen.getByText('Preview new account message'));
  return result;
}

describe('Settings layout and navigation', () => {
  it.each([
    {
      name: 'server URL field',
      route: '#/settings/media/jellyfin',
      id: 'setting-jellyfin_public_url',
      value: 'https://synthetic-first-edit.example.test',
      settings: oldSettings,
      saved: { jellyfin_public_url: 'https://synthetic-first-edit.example.test' },
    },
    {
      name: 'Discord toggle',
      route: '#/settings/discord/connection',
      id: 'setting-discord_enabled',
      value: true,
      settings: oldSettings,
      saved: { discord_enabled: true },
    },
    {
      name: 'cleared saved default role',
      route: '#/settings/accounts/permissions',
      id: 'setting-default_role_id',
      value: '',
      settings: { ...oldSettings, default_role_id: 'saved-role' },
      saved: { default_role_id: '' },
    },
    {
      name: 'cleared saved fallback template',
      route: '#/settings/accounts/permissions',
      id: 'setting-template_user_id',
      value: '',
      settings: { ...oldSettings, template_user_id: 'saved-template' },
      saved: { template_user_id: '' },
    },
    {
      name: 'password length',
      route: '#/settings/accounts/passwords',
      id: 'setting-password_length',
      value: '18',
      settings: oldSettings,
      saved: { password_length: 18 },
    },
    {
      name: 'disabled password ambiguity preference',
      route: '#/settings/accounts/passwords',
      id: 'setting-password_exclude_ambiguous',
      value: false,
      settings: oldSettings,
      saved: { password_exclude_ambiguous: false },
    },
    {
      name: 'credential message',
      route: '#/settings/accounts/passwords',
      id: 'setting-credential_message_template',
      value: 'Welcome {username}\nPassword: {password}\nOpen {server_url}',
      settings: oldSettings,
      saved: {
        credential_message_template: 'Welcome {username}\nPassword: {password}\nOpen {server_url}',
      },
    },
    {
      name: 'replacement source secret',
      route: '#/settings/media/emby',
      id: 'setting-emby_api_key',
      value: 'synthetic-unsaved-first-edit',
      settings: oldSettings,
      saved: { emby_api_key: 'synthetic-unsaved-first-edit' },
    },
  ])('keeps a $name edited before passive synchronization', async (fixture) => {
    window.history.replaceState(null, '', fixture.route);
    const p = page(fixture.settings, undefined, () => {
      const element = document.getElementById(fixture.id)!;
      if (typeof fixture.value === 'boolean') fireEvent.click(element);
      else fireEvent.change(element, { target: { value: fixture.value } });
    });
    const field = document.getElementById(fixture.id)!;
    expect(field.isConnected).toBe(true);
    expect(field).toHaveProperty(
      typeof fixture.value === 'boolean' ? 'checked' : 'value',
      fixture.value,
    );
    expect(screen.getByText('Unsaved changes · save all settings together.')).toBeTruthy();
    expect(p.requests.filter((request) => request.options?.method)).toEqual([]);
    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(
      p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
    ).toMatchObject(fixture.saved);
  });

  it.each(['add mapping', 'remove mapping', 'reset message'] as const)(
    'retains an explicit %s action before passive synchronization',
    async (action) => {
      window.history.replaceState(
        null,
        '',
        action === 'reset message' ? '#/settings/accounts/passwords' : '#/settings/media/paths',
      );
      const savedMappings = [{ source: '/source/kept', target: '/media/kept' }];
      const p = page(
        {
          ...oldSettings,
          path_mappings: savedMappings,
          credential_message_template: 'Custom {username} {password} {server_url}',
        },
        undefined,
        () =>
          fireEvent.click(
            screen.getByRole('button', {
              name:
                action === 'add mapping'
                  ? 'Add mapping'
                  : action === 'remove mapping'
                    ? 'Remove path mapping'
                    : 'Reset message to default',
            }),
          ),
      );
      let expected: Record<string, unknown>;
      if (action === 'reset message') {
        expect(screen.getByLabelText('New account message')).toHaveProperty(
          'value',
          DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
        );
        expected = { credential_message_template: DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE };
      } else if (action === 'remove mapping') {
        expect(screen.queryAllByLabelText('Emby path prefix')).toHaveLength(0);
        expected = { path_mappings: [] };
      } else {
        expect(screen.getAllByLabelText('Emby path prefix')).toHaveLength(2);
        fireEvent.change(screen.getAllByLabelText('Emby path prefix')[1], {
          target: { value: '/source/new' },
        });
        fireEvent.change(screen.getAllByLabelText('Jellyfin path prefix')[1], {
          target: { value: '/media/new' },
        });
        expected = {
          path_mappings: [...savedMappings, { source: '/source/new', target: '/media/new' }],
        };
      }
      expect(screen.getByText('Unsaved changes · save all settings together.')).toBeTruthy();
      expect(p.requests.filter((request) => request.options?.method)).toEqual([]);
      submit();
      await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
      expect(
        p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
      ).toMatchObject(expected);
    },
  );

  it('edits and removes repeated path and tier rows without saving or changing the surviving rows', async () => {
    const p = page({
      ...oldSettings,
      path_mappings: [
        { source: '/discarded', target: '/discarded-target' },
        { source: '/source/movies', target: '/media/movies' },
      ],
      membership_tiers: [
        { id: 'one', name: 'One', plan_name: 'One plan', account_limit: 1 },
        { id: 'two', name: 'Two', plan_name: 'Two plan', account_limit: 2 },
      ],
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Path mapping' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove path mapping' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    fireEvent.change(screen.getAllByLabelText('Emby path prefix')[1], {
      target: { value: ' /source/shows ' },
    });
    fireEvent.change(screen.getAllByLabelText('Jellyfin path prefix')[1], {
      target: { value: ' /media/shows ' },
    });
    settingsTab('Automation');
    fireEvent.click(screen.getByRole('button', { name: 'Remove tier One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add tier' }));
    const newTier = screen.getByRole('group', { name: 'Tier 2' });
    fireEvent.change(within(newTier).getByLabelText('Stable tier ID'), {
      target: { value: 'three' },
    });
    fireEvent.change(within(newTier).getByLabelText('Tier name'), {
      target: { value: ' Three ' },
    });
    fireEvent.change(within(newTier).getByLabelText('Subscription plan name'), {
      target: { value: ' Three plan ' },
    });
    fireEvent.change(within(newTier).getByLabelText('Account allowance'), {
      target: { value: '3' },
    });
    expect(screen.getAllByLabelText('Emby path prefix')[0]).toHaveProperty(
      'value',
      '/source/movies',
    );
    fireEvent.change(screen.getByLabelText('Edit membership tier'), { target: { value: '0' } });
    expect(
      within(screen.getByRole('group', { name: 'Tier 1' })).getByLabelText('Stable tier ID'),
    ).toHaveProperty('value', 'two');
    expect(p.requests.filter((request) => request.options?.method)).toHaveLength(0);

    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(
      p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
    ).toMatchObject({
      path_mappings: [
        { source: '/source/movies', target: '/media/movies' },
        { source: '/source/shows', target: '/media/shows' },
      ],
      membership_tiers: [
        { id: 'two', name: 'Two', plan_name: 'Two plan', account_limit: 2 },
        { id: 'three', name: 'Three', plan_name: 'Three plan', account_limit: 3 },
      ],
    });
  });

  it('tests saved connections without submitting unsaved server details or credentials', async () => {
    const p = page(
      oldSettings,
      vi.fn(async (path: string) => {
        if (path === '/api/connections/test')
          return {
            connections: { emby: { configured: true, connected: true, name: 'Saved source' } },
          };
        if (path === '/api/settings') return {};
        throw new Error(`Unexpected request: ${path}`);
      }) as Api,
    );
    const source = screen.getByRole('region', { name: 'Media servers' });
    const sourceUrl = within(source).getAllByLabelText('Server URL')[0];
    const key = within(source).getAllByLabelText(/API key/)[0];
    fireEvent.change(sourceUrl, { target: { value: 'https://draft.example.test' } });
    fireEvent.change(key, { target: { value: 'synthetic-unsaved-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved connections' }));
    await screen.findByText('Saved source');
    expect(p.requests.filter((request) => request.options?.method)).toEqual([
      { path: '/api/connections/test', options: { method: 'POST', body: {} } },
    ]);
    expect(sourceUrl).toHaveProperty('value', 'https://draft.example.test');
    expect(key).toHaveProperty('value', 'synthetic-unsaved-secret');
    expect(p.refresh).not.toHaveBeenCalled();
    expect(p.notify).not.toHaveBeenCalled();
    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(
      p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
    ).toMatchObject({
      emby_url: 'https://draft.example.test',
      emby_api_key: 'synthetic-unsaved-secret',
    });
  });

  it('retains edited settings after a rejected save and retries only when requested', async () => {
    let attempts = 0;
    const p = page(
      oldSettings,
      vi.fn(async () => {
        if (++attempts === 1) throw new Error('The source connection could not be verified.');
        return {};
      }) as Api,
    );
    fireEvent.change(screen.getByLabelText('Generated password length'), {
      target: { value: '18' },
    });
    submit();
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith('The source connection could not be verified.', true),
    );
    expect(screen.getByLabelText('Generated password length')).toHaveProperty('value', '18');
    expect(p.refresh).not.toHaveBeenCalled();
    expect(attempts).toBe(1);
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', false);
    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
    expect(
      p.requests
        .filter((request) => request.options?.method === 'PUT')
        .map((request) => (request.options?.body as { password_length: number }).password_length),
    ).toEqual([18, 18]);
  });

  it('shows one focused view and preserves unsaved fields and secrets across every tab', async () => {
    const p = page();
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Emby · source server' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Jellyfin · destination server' })).toBeNull();
    const sourceUrl = screen.getByLabelText('Server URL', { selector: '#setting-emby_url' });
    const key = screen.getByLabelText('API key', { selector: '#setting-emby_api_key' });
    fireEvent.change(sourceUrl, { target: { value: 'https://source.example.test' } });
    fireEvent.change(key, { target: { value: 'synthetic-unsaved-secret' } });
    settingsTab('Account defaults');
    fireEvent.click(screen.getByRole('tab', { name: 'Passwords & messages' }));
    const length = screen.getByLabelText('Generated password length');
    fireEvent.change(length, { target: { value: '18' } });
    expect(screen.queryByRole('heading', { name: 'Emby · source server' })).toBeNull();
    for (const name of ['Discord', 'Automation', 'Saved history', 'Servers']) {
      settingsTab(name);
      expect(screen.getAllByRole('tabpanel')).toHaveLength(2);
    }
    expect(window.location.hash).toBe('#/settings/media/emby');
    expect(sourceUrl.isConnected).toBe(true);
    expect(sourceUrl).toHaveProperty('value', 'https://source.example.test');
    expect(key).toHaveProperty('value', 'synthetic-unsaved-secret');
    expect(length.isConnected).toBe(true);
    expect(length).toHaveProperty('value', '18');
    expect(p.requests.filter((request) => request.options?.method)).toHaveLength(0);
    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(
      p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
    ).toMatchObject({
      emby_url: 'https://source.example.test',
      emby_api_key: 'synthetic-unsaved-secret',
      password_length: 18,
    });
  });

  it('keeps independent history forms outside settings and displays one backup source at a time', () => {
    page();
    const settingsForm = screen.getByRole('button', { name: 'Save settings' }).closest('form');
    settingsTab('Saved history');
    const schedule = screen.getByRole('form', { name: 'Backup import schedule' });
    expect(settingsForm).toHaveProperty('hidden', true);
    expect(settingsForm?.contains(schedule)).toBe(false);
    expect(screen.getByRole('button', { name: 'Save import schedule' }).closest('form')).toBe(
      schedule,
    );
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import Jellyfin backup' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Jellyfin catalog' }));
    expect(screen.getByRole('button', { name: 'Import Jellyfin backup' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save import schedule' })).toBeNull();
    expect(schedule.isConnected).toBe(true);
    expect(screen.getByText(/Import actions and schedules save independently/)).toBeTruthy();
  });

  it('saves activity retention independently and keeps both retention and server drafts across tabs', async () => {
    const p = page(oldSettings, async <T,>(path: string, options?: ApiOptions) =>
      path === '/api/jobs/retention'
        ? ({
            retention_days: (options?.body as { retention_days: number }).retention_days,
            interval_seconds: 60,
            batch_limit: 100,
            last_run_at: null,
            last_removed: 0,
            last_kept: 0,
            error: null,
          } as T)
        : ({} as T),
    );
    const settingsForm = screen.getByRole('button', { name: 'Save settings' }).closest('form');
    const sourceUrl = screen.getByLabelText('Server URL', { selector: '#setting-emby_url' });
    fireEvent.change(sourceUrl, { target: { value: 'https://draft.example.test' } });
    settingsTab('Activity');
    await screen.findByText('Automatic cleanup off');
    const form = screen.getByRole('form', { name: 'Activity retention' });
    expect(settingsForm).toHaveProperty('hidden', true);
    expect(settingsForm?.contains(form)).toBe(false);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable automatic activity cleanup' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60' } });
    settingsTab('Servers');
    expect(settingsForm).toHaveProperty('hidden', false);
    expect(sourceUrl).toHaveProperty('value', 'https://draft.example.test');
    settingsTab('Activity');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save activity retention' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(screen.getByRole('spinbutton')).toHaveProperty('value', '60');
    fireEvent.click(screen.getByRole('button', { name: 'Save activity retention' }));
    await waitFor(() => expect(p.notify).toHaveBeenCalledWith('Automatic activity cleanup saved.'));
    expect(p.requests.filter((request) => request.options?.method === 'PUT')).toEqual([
      expect.objectContaining({
        path: '/api/jobs/retention',
        options: expect.objectContaining({ body: { retention_days: 60 } }),
      }),
    ]);
    settingsTab('Servers');
    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    const saved = p.requests.find(
      (request) => request.path === '/api/settings' && request.options?.method === 'PUT',
    );
    expect(saved?.options?.body).toMatchObject({ emby_url: 'https://draft.example.test' });
    expect(saved?.options?.body).not.toHaveProperty('retention_days');
  });

  it.each([
    ['media', 'Servers', 'Emby · source server'],
    ['accounts', 'Account defaults', 'New account permissions'],
    ['discord', 'Discord', 'Discord · optional'],
    ['automation', 'Automation', 'Membership tiers'],
    ['history', 'Saved history', null],
    ['activity', 'Activity', null],
  ])('opens the %s bookmarked tab', (hash, label, heading) => {
    window.history.replaceState(null, '', `#settings-${hash}`);
    page();
    expect(
      within(screen.getByRole('tablist', { name: 'Settings sections' }))
        .getByRole('tab', { name: label })
        .getAttribute('aria-selected'),
    ).toBe('true');
    if (heading) expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  });

  it.each([
    ['#setting-discord_application_id', 'not-numeric', 'Discord', 'Bot connection'],
    ['#membership-tier-id-0', '', 'Automation', 'Membership tiers'],
    ['#membership-tier-name-1', '', 'Automation', 'Membership tiers'],
    ['#setting-jellyfin_public_url', 'not-a-url', 'Servers', 'Jellyfin'],
  ])(
    'reveals and focuses the invalid hidden field %s without saving',
    async (selector, value, main, sub) => {
      const p = page();
      const field = p.container.querySelector<HTMLInputElement>(selector)!;
      fireEvent.change(field, { target: { value } });
      submit();
      await waitFor(() => expect(document.activeElement).toBe(field));
      expect(screen.getByRole('tab', { name: main, selected: true })).toBeTruthy();
      expect(screen.getByRole('tab', { name: sub, selected: true })).toBeTruthy();
      expect(p.notify).toHaveBeenCalledWith(expect.any(String), true);
      expect(p.requests.some((request) => request.options?.method === 'PUT')).toBe(false);
      expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty(
        'disabled',
        false,
      );
    },
  );

  it('focuses an invalid field on repeated saves even when its tab is already visible', async () => {
    const p = page();
    const field = p.container.querySelector<HTMLInputElement>('#setting-emby_url')!;
    fireEvent.change(field, { target: { value: 'invalid-url' } });
    const save = screen.getByRole('button', { name: 'Save settings' });
    for (let attempt = 0; attempt < 2; attempt++) {
      save.focus();
      submit();
      await waitFor(() => expect(document.activeElement).toBe(field));
    }
    expect(p.notify).toHaveBeenCalledTimes(2);
    expect(p.requests.some((request) => request.options?.method === 'PUT')).toBe(false);
  });
});

describe('New account password and message settings', () => {
  it('defaults older settings to 12 characters, ambiguous-character exclusion, and a fictional preview', async () => {
    const p = passwordPage();
    expect((screen.getByLabelText('Generated password length') as HTMLInputElement).value).toBe(
      '12',
    );
    expect((screen.getByLabelText('Avoid ambiguous characters') as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText('New account message') as HTMLTextAreaElement).value).toBe(
      DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
    );
    const preview = screen.getByLabelText('New account message preview');
    expect(preview.textContent).toContain('Username: example_user');
    expect(preview.textContent).toContain('Password: B7mQ4rX9sT6v');
    expect(preview.textContent).toContain('https://jellyfin.example.com');
    expect(preview.textContent).not.toContain(oldSettings.jellyfin_public_url);
    expect(p.requests.every((request) => !request.path.includes('credentials'))).toBe(true);

    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(
      p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
    ).toMatchObject({
      password_length: 12,
      password_exclude_ambiguous: true,
      credential_message_template: DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
    });
  });

  it('saves selected values and preserves the exact multiline template through a refreshed response', async () => {
    const p = passwordPage();
    const template =
      'Welcome aboard, {username}!\n\nOpen {server_url}\nYour password: {password}\n';
    fireEvent.change(screen.getByLabelText('Generated password length'), {
      target: { value: '16' },
    });
    fireEvent.click(screen.getByLabelText('Avoid ambiguous characters'));
    fireEvent.change(screen.getByLabelText('New account message'), { target: { value: template } });
    expect(screen.getByLabelText('New account message preview').textContent).toContain(
      'Welcome aboard, example_user!',
    );
    submit();
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(
      p.requests.find((request) => request.options?.method === 'PUT')?.options?.body,
    ).toMatchObject({
      password_length: 16,
      password_exclude_ambiguous: false,
      credential_message_template: template,
    });
    const savedSettings = {
      ...oldSettings,
      password_length: 16,
      password_exclude_ambiguous: false,
      credential_message_template: template,
    };
    p.rerender(<SettingsPage {...p.props} settings={savedSettings} />);
    expect((screen.getByLabelText('Generated password length') as HTMLInputElement).value).toBe(
      '16',
    );
    expect((screen.getByLabelText('Avoid ambiguous characters') as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByLabelText('New account message') as HTMLTextAreaElement).value).toBe(
      template,
    );
  });

  it('adopts a newer saved response and resets only the local message until Save settings is used', () => {
    const p = passwordPage({
      ...oldSettings,
      password_length: 20,
      password_exclude_ambiguous: false,
      credential_message_template: 'Hi {username}\n{password}\n{server_url}',
    });
    p.rerender(
      <SettingsPage
        {...p.props}
        settings={{
          ...oldSettings,
          password_length: 14,
          password_exclude_ambiguous: true,
          credential_message_template: '{server_url}\nUser: {username}\nPass: {password}',
        }}
      />,
    );
    expect((screen.getByLabelText('Generated password length') as HTMLInputElement).value).toBe(
      '14',
    );
    expect((screen.getByLabelText('Avoid ambiguous characters') as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset message to default' }));
    expect((screen.getByLabelText('New account message') as HTMLTextAreaElement).value).toBe(
      DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
    );
    expect((screen.getByLabelText('Generated password length') as HTMLInputElement).value).toBe(
      '14',
    );
    expect(p.requests.some((request) => request.options?.method === 'PUT')).toBe(false);
  });

  it.each(['', '11', '65', '12.5'])(
    'rejects invalid password length %j before saving',
    async (value) => {
      const p = passwordPage();
      fireEvent.change(screen.getByLabelText('Generated password length'), { target: { value } });
      submit();
      await waitFor(() =>
        expect(p.notify).toHaveBeenCalledWith(
          'Password length must be a whole number from 12 to 64.',
          true,
        ),
      );
      expect(p.requests.some((request) => request.options?.method === 'PUT')).toBe(false);
    },
  );

  it.each([
    '{username} {password}',
    '{username} {password} {server_url} {unknown}',
    '{username} {password} {server_url}\u0000',
    '{username} {password} {server_url}' + 'x'.repeat(1200),
  ])('rejects an invalid message and bounds its preview before saving', async (template) => {
    const p = passwordPage();
    fireEvent.change(screen.getByLabelText('New account message'), { target: { value: template } });
    expect(
      within(screen.getByLabelText('New account message preview')).getByRole('alert'),
    ).toBeTruthy();
    expect(screen.getByLabelText('New account message preview').textContent!.length).toBeLessThan(
      500,
    );
    submit();
    await waitFor(() => expect(p.notify).toHaveBeenCalledWith(expect.any(String), true));
    expect(p.requests.some((request) => request.options?.method === 'PUT')).toBe(false);
  });

  it('renders HTML, Markdown, and URLs as plain text without executing or linking them', () => {
    const p = passwordPage();
    const template =
      '<script>alert(1)</script> **{username}**\n{password}\n{server_url}\njavascript:alert(2)';
    fireEvent.change(screen.getByLabelText('New account message'), { target: { value: template } });
    const preview = screen.getByLabelText('New account message preview');
    expect(preview.textContent).toContain('<script>alert(1)</script> **example_user**');
    expect(preview.textContent).toContain('javascript:alert(2)');
    expect(preview.querySelector('script, a')).toBeNull();
    expect(p.requests.every((request) => request.path === '/api/account-roles')).toBe(true);
  });
});

describe('Settings draft and submission safeguards', () => {
  it('keeps dirty server/password/message/default drafts when newer settings arrive', () => {
    const p = passwordPage({ ...oldSettings, default_role_id: 'old-role' });
    fireEvent.change(screen.getByLabelText('Generated password length'), {
      target: { value: '22' },
    });
    fireEvent.change(screen.getByLabelText('New account message'), {
      target: { value: 'Draft {username}: {password} {server_url}' },
    });
    settingsTab('Servers');
    fireEvent.change(document.getElementById('setting-emby_url')!, {
      target: { value: 'http://draft-source.example.test' },
    });
    p.rerender(
      <SettingsPage
        {...p.props}
        settings={{
          ...oldSettings,
          emby_url: 'http://newer-source.example.test',
          password_length: 30,
          credential_message_template: 'Newer {username} {password} {server_url}',
          default_role_id: 'new-role',
        }}
      />,
    );
    expect((document.getElementById('setting-emby_url') as HTMLInputElement).value).toBe(
      'http://draft-source.example.test',
    );
    settingsTab('Account defaults');
    expect((screen.getByLabelText('Default account role') as HTMLSelectElement).value).toBe(
      'old-role',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Passwords & messages' }));
    expect((screen.getByLabelText('Generated password length') as HTMLInputElement).value).toBe(
      '22',
    );
    expect((screen.getByLabelText('New account message') as HTMLTextAreaElement).value).toBe(
      'Draft {username}: {password} {server_url}',
    );
    expect(p.requests.filter((r) => r.options?.method === 'PUT')).toHaveLength(0);
  });
  it('allows one settings submission at a time and protects submitted fields while pending', async () => {
    let finish!: (value: unknown) => void;
    const p = page(oldSettings, (async (path: string, options?: ApiOptions) => {
      if (path === '/api/settings' && options?.method === 'PUT')
        return new Promise<unknown>((resolve) => {
          finish = resolve;
        });
      throw new Error('Unexpected request');
    }) as Api);
    fireEvent.change(document.getElementById('setting-emby_url')!, {
      target: { value: 'http://saved-source.example.test' },
    });
    const form = screen.getByRole('button', { name: 'Save settings' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        p.requests.filter((r) => r.path === '/api/settings' && r.options?.method === 'PUT'),
      ).toHaveLength(1),
    );
    expect(
      (document.getElementById('setting-emby_url') as HTMLInputElement).closest('fieldset')!
        .disabled,
    ).toBe(true);
    finish({});
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', false);
  });
});
