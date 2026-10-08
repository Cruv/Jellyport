// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiscordMemberPicker from './DiscordMemberPicker';
import type { Api, DiscordMember } from './types';

const alex: DiscordMember = {
  id: '123456789012345678',
  username: 'alex.real',
  display_name: 'Captain Alex',
  nickname: 'The Admiral',
  membership_active: true,
};
const searchResult = (members: DiscordMember[] = [alex], truncated = false) => ({
  members,
  truncated,
});

async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Discord member picker', () => {
  it('waits for interaction, recommends an exact username, and fills the stable ID after selection', async () => {
    const api = vi.fn(async () => searchResult()) as Api;
    const changed = vi.fn();
    function Form() {
      const [value, setValue] = useState<DiscordMember | null>(null);
      return (
        <DiscordMemberPicker
          api={api}
          value={value}
          onChange={(member) => {
            changed(member);
            setValue(member);
          }}
          suggestedQuery="alex.real"
          inputName="discord_user_id"
        />
      );
    }
    const { container } = render(<Form />);
    await debounce();
    expect(api).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByLabelText('Discord member'));
    await debounce();
    expect(api).toHaveBeenCalledWith('/api/discord/members?query=alex.real', {
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByText('Exact username match')).toBeTruthy();
    expect(screen.getByText('Captain Alex')).toBeTruthy();
    expect(screen.getByText('Server nickname: The Admiral')).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[name=discord_user_id]')?.value).toBe(
      '',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select @alex.real' }));
    expect(changed).toHaveBeenCalledWith(alex);
    expect(container.querySelector<HTMLInputElement>('input[name=discord_user_id]')?.value).toBe(
      alex.id,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear Discord member @alex.real' }));
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(container.querySelector<HTMLInputElement>('input[name=discord_user_id]')?.value).toBe(
      '',
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('debounces typing and aborts superseded searches even when the API ignores cancellation', async () => {
    const pending: {
      resolve: (result: ReturnType<typeof searchResult>) => void;
      signal?: AbortSignal;
    }[] = [];
    const api = vi.fn(
      (_path: string, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          pending.push({ resolve, signal: options?.signal });
        }),
    ) as Api;
    const onChange = vi.fn();
    const { unmount } = render(<DiscordMemberPicker api={api} value={null} onChange={onChange} />);
    const input = screen.getByLabelText('Discord member');
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.change(input, { target: { value: 'alex' } });
    await debounce();
    expect(api).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: 'another' } });
    expect(pending[0].signal?.aborted).toBe(true);
    await act(async () => pending[0].resolve(searchResult()));
    expect(screen.queryByRole('button', { name: 'Select @alex.real' })).toBeNull();
    await debounce();
    expect(api).toHaveBeenCalledTimes(2);
    unmount();
    expect(pending[1].signal?.aborted).toBe(true);
    await act(async () => pending[1].resolve(searchResult()));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('requires at least two characters, bounds query input, and encodes searches', async () => {
    const api = vi.fn(async () => searchResult([])) as Api;
    render(<DiscordMemberPicker api={api} value={null} onChange={vi.fn()} />);
    const input = screen.getByLabelText('Discord member') as HTMLInputElement;
    expect(input.maxLength).toBe(64);
    fireEvent.change(input, { target: { value: 'a' } });
    await debounce();
    expect(api).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: ' @alex & crew ' } });
    await debounce();
    expect(api).toHaveBeenCalledWith('/api/discord/members?query=%40alex%20%26%20crew', {
      signal: expect.any(AbortSignal),
    });
    expect(
      screen.getByText('No matching active members. Try their actual Discord username.'),
    ).toBeTruthy();
  });

  it('does not assign display-name matches and hides inactive members by default', async () => {
    const impostor = {
      ...alex,
      id: '223456789012345678',
      username: 'another.user',
      display_name: 'alex.real',
    };
    const inactive = {
      ...alex,
      id: '323456789012345678',
      username: 'expired',
      membership_active: false,
    };
    const api = vi.fn(async () => searchResult([impostor, inactive], true)) as Api;
    const onChange = vi.fn();
    render(
      <DiscordMemberPicker
        api={api}
        value={null}
        onChange={onChange}
        suggestedQuery="alex.real"
        autoSearch
      />,
    );
    await debounce();
    expect(screen.getByRole('button', { name: 'Select @another.user' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select @expired' })).toBeNull();
    expect(screen.queryByText('Exact username match')).toBeNull();
    expect(screen.getByText('More members match. Keep typing to narrow the results.')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('allows inactive members for account mappings and renders names as text', async () => {
    const unsafe = {
      ...alex,
      username: '<script>unsafe()</script>',
      display_name: '<img src=x onerror=unsafe()>',
      membership_active: false,
    };
    const api = vi.fn(async () => searchResult([unsafe])) as Api;
    const { container } = render(
      <DiscordMemberPicker
        api={api}
        value={null}
        onChange={vi.fn()}
        suggestedQuery="unsafe"
        allowInactive
        autoSearch
      />,
    );
    await debounce();
    expect(screen.getByText('@<script>unsafe()</script>')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=unsafe()>')).toBeTruthy();
    expect(screen.getByText('Membership inactive')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows search errors and clears them on a new query', async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connect the Discord bot to search members.'))
      .mockResolvedValue(searchResult()) as Api;
    render(
      <DiscordMemberPicker
        api={api}
        value={null}
        onChange={vi.fn()}
        suggestedQuery="alex"
        autoSearch
      />,
    );
    await debounce();
    expect(screen.getByRole('alert').textContent).toBe(
      'Connect the Discord bot to search members.',
    );
    fireEvent.change(screen.getByLabelText('Discord member'), { target: { value: 'alex.real' } });
    await debounce();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Select @alex.real' })).toBeTruthy();
  });

  it('can retry the same query after a transient search failure', async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord is temporarily unavailable.'))
      .mockResolvedValue(searchResult()) as Api;
    render(
      <DiscordMemberPicker
        api={api}
        value={null}
        onChange={vi.fn()}
        suggestedQuery="alex"
        autoSearch
      />,
    );
    await debounce();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await debounce();
    expect(api).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Select @alex.real' })).toBeTruthy();
  });

  it('aborts pending discovery when an existing member is selected externally', async () => {
    let finish!: (result: ReturnType<typeof searchResult>) => void;
    let signal: AbortSignal | undefined;
    const api = vi.fn(
      (_path: string, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal = options?.signal;
          finish = resolve;
        }),
    ) as Api;
    const onChange = vi.fn();
    const { rerender } = render(
      <DiscordMemberPicker
        api={api}
        value={null}
        onChange={onChange}
        suggestedQuery="alex"
        autoSearch
      />,
    );
    await debounce();
    rerender(<DiscordMemberPicker api={api} value={alex} onChange={onChange} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(searchResult([{ ...alex, username: 'stale.result' }])));
    expect(screen.queryByText('@stale.result')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear Discord member @alex.real' })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('updates untouched name suggestions while preserving a manually chosen search query', async () => {
    const api = vi.fn(async () => searchResult([])) as Api;
    const props = { api, value: null, onChange: vi.fn() };
    const { rerender } = render(<DiscordMemberPicker {...props} suggestedQuery="first" />);
    rerender(<DiscordMemberPicker {...props} suggestedQuery="second" />);
    expect((screen.getByLabelText('Discord member') as HTMLInputElement).value).toBe('second');
    fireEvent.change(screen.getByLabelText('Discord member'), {
      target: { value: 'actual.username' },
    });
    rerender(<DiscordMemberPicker {...props} suggestedQuery="third" />);
    expect((screen.getByLabelText('Discord member') as HTMLInputElement).value).toBe(
      'actual.username',
    );
    await debounce();
    expect(api).toHaveBeenCalledOnce();
  });

  it('does not start discovery or allow a change when disabled', async () => {
    const api = vi.fn(async () => searchResult()) as Api;
    const onChange = vi.fn();
    const { rerender } = render(
      <DiscordMemberPicker
        api={api}
        value={null}
        onChange={onChange}
        suggestedQuery="alex"
        autoSearch
        disabled
      />,
    );
    await debounce();
    expect(api).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Discord member') as HTMLInputElement).disabled).toBe(true);
    rerender(<DiscordMemberPicker api={api} value={alex} onChange={onChange} disabled />);
    expect(
      (screen.getByRole('button', { name: 'Clear Discord member @alex.real' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
