// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SettingsPage from './SettingsPage';
import { DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE } from '../../server/credential-message';
import type { Api, ApiOptions, Settings } from './types';

vi.mock('./SourceSnapshotsPanel', () => ({ default: () => null }));
vi.mock('./DestinationCatalogPanel', () => ({ default: () => null }));
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

function page(settings: Settings = oldSettings) {
  const requests: { path: string; options?: ApiOptions }[] = [];
  const api = vi.fn(async (path: string, options?: ApiOptions) => {
    requests.push({ path, options });
    if (path === '/api/account-roles') return { roles: [] };
    if (path === '/api/settings' && options?.method === 'PUT') return {};
    throw new Error(`Unexpected request: ${path}`);
  }) as Api;
  const notify = vi.fn();
  const refresh = vi.fn(async () => {});
  const props = { settings, users: { emby: [], jellyfin: [] }, demo: false, api, notify, refresh };
  const result = render(<SettingsPage {...props} />);
  return { ...result, requests, notify, refresh, props };
}

function submit() {
  fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!);
}

afterEach(cleanup);

describe('New account password and message settings', () => {
  it('defaults older settings to 12 characters, ambiguous-character exclusion, and a fictional preview', async () => {
    const p = page();
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
    const p = page();
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
    const p = page({
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
      const p = page();
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
    const p = page();
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
    const p = page();
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
