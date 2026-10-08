// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminAlertsPanel, { type AdminAlertStatus } from './AdminAlertsPanel';
import type { Api, ApiOptions } from './types';

afterEach(cleanup);
const enabled: AdminAlertStatus = {
  enabled: true,
  revision: 'reviewed-generation',
  recipient_username: 'captain',
  recipient_id: '123456789',
  last_sent_at: null,
  last_error: null,
  pending_count: 2,
};

describe('private admin alert settings', () => {
  it('captures identity through Discord and stops only the reviewed recipient generation', async () => {
    const calls: Array<{ path: string; options?: ApiOptions }> = [];
    const api: Api = async <T,>(path: string, options?: ApiOptions) => {
      calls.push({ path, options });
      return (
        options?.method === 'POST'
          ? { ...enabled, enabled: false, revision: null, recipient_username: null }
          : enabled
      ) as T;
    };
    const notify = vi.fn();
    render(<AdminAlertsPanel api={api} notify={notify} demo={false} />);
    await screen.findByText('Private DMs enabled for @captain');
    expect(screen.getByText('2 pending notices')).toBeTruthy();
    expect(screen.getByText('/jellyport alerts action:enable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop admin DMs' }));
    await screen.findByText('Private admin DMs are off');
    expect(calls[1]).toMatchObject({
      path: '/api/discord/admin-alerts/disable',
      options: { method: 'POST', body: { expected_revision: 'reviewed-generation' } },
    });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('shows private delivery problems and pending work without exposing raw request errors', async () => {
    let fail = false;
    const api: Api = async <T,>() => {
      if (fail) throw new Error('PRIVATE-ERROR-TOKEN');
      return { ...enabled, last_error: 'Private admin DM could not be delivered.' } as T;
    };
    render(<AdminAlertsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Private admin DM could not be delivered.');
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/PRIVATE-ERROR-TOKEN/)).toBeNull();
  });

  it('aborts a stop request on logout and ignores its late response', async () => {
    let complete!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const api: Api = async <T,>(_path: string, options?: ApiOptions) => {
      if (options?.method !== 'POST') return enabled as T;
      signal = options.signal;
      return (await new Promise<unknown>((resolve) => (complete = resolve))) as T;
    };
    const notify = vi.fn();
    const view = render(<AdminAlertsPanel api={api} notify={notify} demo={false} />);
    await screen.findByText('Private DMs enabled for @captain');
    fireEvent.click(screen.getByRole('button', { name: 'Stop admin DMs' }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal!.aborted).toBe(true);
    await act(async () => complete({ ...enabled, enabled: false }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('allows an administrator to stop a paused configuration after a server change', async () => {
    const api: Api = async <T,>(_path: string, options?: ApiOptions) =>
      ({
        ...enabled,
        enabled: false,
        revision: options?.method === 'POST' ? null : 'paused-generation',
        recipient_username: null,
        recipient_id: null,
        last_error: options?.method === 'POST' ? null : 'The linked server changed.',
      }) as T;
    render(<AdminAlertsPanel api={api} notify={vi.fn()} demo={false} />);
    await screen.findByText('Private admin DMs are paused');
    fireEvent.click(screen.getByRole('button', { name: 'Stop admin DMs' }));
    await screen.findByText('Private admin DMs are off');
  });
});
