// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, act } from 'react';
import BotMessageHistoryPanel, { DiscordDeliverySummary } from './BotMessageHistoryPanel';
import type { Api } from './types';
import type { BotMessageHistory } from '../../server/bot-messages';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const message: BotMessageHistory = {
  id: 'message_1',
  kind: 'credentials',
  recipient_id: '123456789012345678',
  recipient_username: 'household.owner',
  account_username: 'household.owner_2',
  membership_slot: 2,
  content:
    'Your account: household.owner\\_2\nPassword: EXAMPLE-password-42\n<script>literal only</script>',
  status: 'sent',
  created_at: '2026-10-23T12:00:00.000Z',
  sent_at: '2026-10-23T12:00:01.000Z',
  message_id: '234567890123456789',
};
describe('administrator bot message history', () => {
  it('loads delivery records on request and keeps legacy message bodies out of the report', async () => {
    const api = vi.fn(async () => ({ messages: [message] })) as Api;
    const first = render(
      <StrictMode>
        <BotMessageHistoryPanel jobId="job_1" api={api} />
      </StrictMode>,
    );
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View bot messages' }));
    await screen.findByText('household.owner_2 · Slot 2');
    expect(
      screen.getByRole('article', { name: 'Message for household.owner_2' }).querySelector('pre'),
    ).toBeNull();
    expect(first.container.querySelector('script')).toBeNull();
    expect(screen.getByText(/@household.owner/)).toBeTruthy();
    expect(screen.queryByText(/EXAMPLE-password-42/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bot messages' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(api)
        .mock.calls.every(
          ([path, options]) => path === '/api/jobs/job_1/messages' && !options?.method,
        ),
    ).toBe(true);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
  it.each([
    ['uncertain', 'Check whether they got the DM'],
    ['failed', 'DM failed'],
    ['pending', 'DM pending'],
  ] as const)('shows one useful status for a %s attempt', async (status, label) => {
    render(
      <BotMessageHistoryPanel
        jobId="job_1"
        api={vi.fn(async () => ({ messages: [{ ...message, status }] })) as Api}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View bot messages' }));
    const row = await screen.findByRole('article', { name: 'Message for household.owner_2' });
    expect(row.querySelector('p')?.textContent).toContain(label);
    expect(row.querySelectorAll('p')).toHaveLength(1);
    expect(screen.queryByText(/EXAMPLE-password-42/)).toBeNull();
  });
  it('asks for confirmation of receipt without promising credentials are still available', () => {
    render(
      <DiscordDeliverySummary
        result={{
          discord_delivery: { status: 'failed' },
          delivery_error: 'Credentials remain available for one-time reveal for 24 hours.',
        }}
      />,
    );
    expect(screen.getByText('Check whether they got the Discord DM.')).toBeTruthy();
    expect(screen.queryByText(/24 hours/)).toBeNull();
  });
  it('aborts a pending private read on close and ignores a late response', async () => {
    let reply!: (value: { messages: BotMessageHistory[] }) => void;
    const api = vi.fn(
      (_path, _options) =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    ) as Api;
    const view = render(<BotMessageHistoryPanel jobId="job_1" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'View bot messages' }));
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    reply({ messages: [message] });
    await Promise.resolve();
    expect(screen.queryByText(message.content)).toBeNull();
  });
  it('shows an empty history and permits a failed read to be retried', async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error('sensitive upstream detail'))
      .mockResolvedValueOnce({ messages: [] }) as Api;
    render(<BotMessageHistoryPanel jobId="job_1" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'View bot messages' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('sensitive upstream detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View bot messages' }));
    await screen.findByText('No Discord DMs recorded.');
  });
  it('clears the previous job and aborts its pending private read when the selected operation changes', async () => {
    let reply!: (value: { messages: BotMessageHistory[] }) => void;
    const api = vi.fn(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    ) as Api;
    const view = render(<BotMessageHistoryPanel jobId="job_1" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'View bot messages' }));
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    view.rerender(<BotMessageHistoryPanel jobId="job_2" api={api} />);
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'View bot messages' })).toBeTruthy();
    await act(async () => {
      reply({ messages: [message] });
    });
    expect(screen.queryByRole('article')).toBeNull();
  });
});
