// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AuthScreen from './AuthScreen';
import type { Api, Session } from './types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const session = {
  authenticated: false,
  csrf_token: 'synthetic',
  setup_required: false,
  setup_connected: false,
} as Session;
function auth(current = session) {
  return render(
    <AuthScreen session={current} initialError="" api={vi.fn() as Api} onSession={vi.fn()} />,
  );
}
describe('phone identity entry', () => {
  it('keeps username autofill while preventing capitalization, autocorrection and spell checking', () => {
    auth();
    const username = screen.getByLabelText('Jellyfin username');
    expect(username.getAttribute('autocomplete')).toBe('username');
    expect(username.getAttribute('autocapitalize')).toBe('none');
    expect(username.getAttribute('autocorrect')).toBe('off');
    expect(username.getAttribute('spellcheck')).toBe('false');
    expect(screen.getByLabelText('Jellyfin password').getAttribute('autocomplete')).toBe(
      'current-password',
    );
    expect(document.activeElement).toBe(username);
  });
  it.each([430, 956])(
    'does not open the keyboard automatically on a touch phone at width %s',
    (width) => {
      vi.stubGlobal('innerWidth', width);
      vi.stubGlobal('matchMedia', () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      auth();
      expect(document.activeElement).not.toBe(screen.getByLabelText('Jellyfin username'));
    },
  );
  it.each(['', 'http://jellyfin:8096'])(
    'does not autofocus setup URL or secret fields on phones (linked=%s)',
    (url) => {
      vi.stubGlobal('innerWidth', 430);
      auth({ ...session, setup_required: true, setup_server_url: url });
      expect(document.activeElement).not.toBe(screen.getByLabelText('Jellyfin server URL'));
      expect(document.activeElement).not.toBe(screen.getByLabelText('Jellyfin API key'));
    },
  );
});
