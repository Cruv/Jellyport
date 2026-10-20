// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AccountCloneDialog, { AccountRenameDialog } from './AccountCloneDialog';
import type { DirectoryAccount } from './types';

const accounts: DirectoryAccount[] = [
  {
    id: 'kids-id',
    name: 'Kids',
    disabled: false,
    protected: false,
    profile: {
      family: true,
      owner_name: 'Private owner',
      notes: 'Private notes',
      revision: 'revision',
    },
  },
  { id: 'second-id', name: 'Second', disabled: false, protected: false },
];
afterEach(cleanup);
function clone() {
  const submit = vi.fn(),
    close = vi.fn(),
    prepare = vi.fn(),
    edit = vi.fn();
  const props = {
    accounts,
    existingUsernames: ['Kids', 'Second', 'Existing'],
    busy: false,
    error: '',
    review: null,
    submit,
    close,
    prepare,
    edit,
  };
  return { ...render(<AccountCloneDialog {...props} />), props, submit, close, prepare, edit };
}
function serverReview(p: ReturnType<typeof clone>) {
  const request = p.prepare.mock.calls.at(-1)![0];
  const review = {
    id: 'server-review-token',
    source_user_id: request.source_user_id,
    source_username: request.expected_source_username,
    accounts: request.accounts,
    warnings: [],
    expires_at: '2026-10-20T16:00:00Z',
  };
  p.rerender(<AccountCloneDialog {...p.props} review={review} />);
  return review;
}
function names(first = 'ChildOne', second = 'ChildTwo') {
  fireEvent.change(screen.getByLabelText('New username 1'), { target: { value: first } });
  fireEvent.change(screen.getByLabelText('New username 2'), { target: { value: second } });
}

describe('Account cloning review', () => {
  it('requires an explicit review and copies only the chosen new account intent', () => {
    const p = clone();
    expect(screen.getByLabelText('Mark the new accounts as family')).toHaveProperty(
      'checked',
      true,
    );
    names(' FirstChild ', 'SecondChild');
    const body = screen.getByRole('dialog').querySelector('.modal-body')!;
    body.scrollTop = 300;
    fireEvent.click(screen.getByRole('button', { name: 'Review clone' }));
    expect(p.submit).not.toHaveBeenCalled();
    expect(p.prepare).toHaveBeenCalledExactlyOnceWith({
      source_user_id: 'kids-id',
      expected_source_username: 'Kids',
      accounts: [
        { username: 'FirstChild', family: true },
        { username: 'SecondChild', family: true },
      ],
    });
    const review = serverReview(p);
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 120;
    p.rerender(<AccountCloneDialog {...p.props} review={review} />);
    expect(body.scrollTop).toBe(120);
    expect(screen.getByRole('heading', { name: 'Review account clones' })).toBeTruthy();
    expect(screen.getByText('kids-id')).toBeTruthy();
    expect(screen.getByText('FirstChild · Family, SecondChild · Family')).toBeTruthy();
    expect(screen.queryByText('Private owner')).toBeNull();
    expect(screen.queryByText('Private notes')).toBeNull();
    expect(
      screen.getByText(/Resume positions, favorites, playlists, passwords, Discord links/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 accounts' }));
    expect(p.submit).toHaveBeenCalledExactlyOnceWith('server-review-token');
  });

  it('allows one through ten new accounts and preserves drafts when returning from review', () => {
    const p = clone();
    names();
    fireEvent.click(screen.getByRole('button', { name: 'Remove new account 2' }));
    expect(screen.queryByLabelText('New username 2')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove new account 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review clone' }));
    serverReview(p);
    expect(screen.getByRole('button', { name: 'Create 1 account' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(p.edit).toHaveBeenCalledTimes(1);
    p.rerender(<AccountCloneDialog {...p.props} />);
    expect(screen.getByLabelText('New username 1')).toHaveProperty('value', 'ChildOne');
    for (let i = 1; i < 10; i++)
      fireEvent.click(screen.getByRole('button', { name: 'Add another account' }));
    expect(screen.getByLabelText('New username 10')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add another account' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(p.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['Child', ' child ', 'Give each new account a different username.'],
    [
      'existing',
      'Other',
      'A Jellyfin account already uses one of these usernames. Choose new usernames.',
    ],
    [
      'Kids',
      'Other',
      'A Jellyfin account already uses one of these usernames. Choose new usernames.',
    ],
    ['Bad\u0001Name', 'Other', 'Enter a username of 1–64 characters for each new account.'],
    ['A'.repeat(65), 'Other', 'Enter a username of 1–64 characters for each new account.'],
  ])('rejects invalid or conflicting names %s / %s before review', (first, second, detail) => {
    const p = clone();
    names(first, second);
    fireEvent.submit(screen.getByRole('button', { name: 'Review clone' }).closest('form')!);
    expect(screen.getByRole('alert').textContent).toBe(detail);
    expect(p.submit).not.toHaveBeenCalled();
  });

  it('reviews the exact source selected and follows its family flag with an explicit override', () => {
    const p = clone();
    names();
    fireEvent.change(screen.getByLabelText('Source Jellyfin account'), {
      target: { value: 'second-id' },
    });
    expect(screen.getByLabelText('Mark the new accounts as family')).toHaveProperty(
      'checked',
      false,
    );
    fireEvent.click(screen.getByLabelText('Mark the new accounts as family'));
    fireEvent.click(screen.getByRole('button', { name: 'Review clone' }));
    serverReview(p);
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 accounts' }));
    expect(p.prepare).toHaveBeenCalledExactlyOnceWith({
      source_user_id: 'second-id',
      expected_source_username: 'Second',
      accounts: [
        { username: 'ChildOne', family: true },
        { username: 'ChildTwo', family: true },
      ],
    });
    expect(p.submit).toHaveBeenCalledExactlyOnceWith('server-review-token');
  });

  it('blocks dismissal and duplicate submission while starting and retains review on rejection', () => {
    const p = clone();
    names();
    fireEvent.click(screen.getByRole('button', { name: 'Review clone' }));
    const review = serverReview(p);
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 accounts' }));
    p.rerender(<AccountCloneDialog {...p.props} review={review} busy />);
    expect(screen.getByRole('button', { name: 'Starting clone…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.close).not.toHaveBeenCalled();
    p.rerender(
      <AccountCloneDialog
        {...p.props}
        review={review}
        error="The source account changed. Refresh and try again."
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('source account changed');
    expect(screen.getByText('ChildOne · Family, ChildTwo · Family')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 accounts' }));
    expect(p.submit).toHaveBeenCalledTimes(2);
  });

  it('dismisses without issuing an account operation', () => {
    const p = clone();
    names();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.close).toHaveBeenCalledTimes(1);
    expect(p.submit).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe('Rename an existing Jellyfin account', () => {
  it('sends only the exact existing account identity and new username', () => {
    const submit = vi.fn();
    render(
      <AccountRenameDialog
        accounts={accounts}
        existingUsernames={['Kids', 'Second']}
        busy={false}
        error=""
        recovery={{ user_id: 'kids-id', pending: null }}
        inspect={vi.fn()}
        close={vi.fn()}
        submit={submit}
      />,
    );
    fireEvent.change(screen.getByLabelText('New sign-in username'), {
      target: { value: ' FirstChild ' },
    });
    expect(
      screen.getByText(
        /account ID, password, permissions, preferences, and watch history stay the same/,
      ),
    ).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rename account' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      user_id: 'kids-id',
      expected_username: 'Kids',
      username: 'FirstChild',
    });
  });

  it('clears rename intent when selecting another exact account and rejects existing names', () => {
    const submit = vi.fn();
    const inspect = vi.fn();
    const view = render(
      <AccountRenameDialog
        accounts={accounts}
        existingUsernames={['Kids', 'Second']}
        busy={false}
        error=""
        recovery={{ user_id: 'kids-id', pending: null }}
        inspect={inspect}
        close={vi.fn()}
        submit={submit}
      />,
    );
    fireEvent.change(screen.getByLabelText('New sign-in username'), {
      target: { value: 'Second' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename account' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'A Jellyfin account already uses this username.',
    );
    fireEvent.change(screen.getByLabelText('Existing Jellyfin account'), {
      target: { value: 'second-id' },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith('second-id');
    view.rerender(
      <AccountRenameDialog
        accounts={accounts}
        existingUsernames={['Kids', 'Second']}
        busy={false}
        error=""
        recovery={{ user_id: 'second-id', pending: null }}
        inspect={inspect}
        close={vi.fn()}
        submit={submit}
      />,
    );
    expect(screen.getByLabelText('New sign-in username')).toHaveProperty('value', '');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('New sign-in username'), {
      target: { value: 'Second' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename account' }));
    expect(screen.getByRole('alert').textContent).toBe('Choose a different username.');
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'shows previous rename intent and only confirms when exact readback allows it (%s)',
    (canConfirm) => {
      const submit = vi.fn(),
        inspect = vi.fn();
      const pending = {
        user_id: 'kids-id',
        expected_username: 'Kids',
        username: 'FirstChild',
        can_confirm: canConfirm,
      };
      render(
        <AccountRenameDialog
          accounts={accounts}
          existingUsernames={['Kids', 'FirstChild']}
          busy={false}
          error=""
          recovery={{ user_id: 'kids-id', pending }}
          inspect={inspect}
          close={vi.fn()}
          submit={submit}
        />,
      );
      expect(screen.queryByLabelText('New sign-in username')).toBeNull();
      expect(screen.getByText('Kids', { selector: 'dd' })).toBeTruthy();
      expect(screen.getByText('FirstChild', { selector: 'dd' })).toBeTruthy();
      const confirm = screen.getByRole('button', { name: 'Confirm previous rename' });
      expect(confirm).toHaveProperty('disabled', !canConfirm);
      fireEvent.click(confirm);
      if (canConfirm)
        expect(submit).toHaveBeenCalledExactlyOnceWith({
          user_id: 'kids-id',
          expected_username: 'Kids',
          username: 'FirstChild',
        });
      else expect(submit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Check status again' }));
      expect(inspect).toHaveBeenCalledExactlyOnceWith('kids-id');
    },
  );

  it('keeps rename disabled until recovery status is known and supports a failed-read retry', () => {
    const inspect = vi.fn();
    render(
      <AccountRenameDialog
        accounts={accounts}
        existingUsernames={['Kids']}
        busy={false}
        error="Could not verify the account."
        recovery={undefined}
        inspect={inspect}
        close={vi.fn()}
        submit={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('New sign-in username')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename account' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Could not verify the account.');
    fireEvent.click(screen.getByRole('button', { name: 'Check rename status' }));
    expect(inspect).toHaveBeenCalledExactlyOnceWith('kids-id');
  });
});
