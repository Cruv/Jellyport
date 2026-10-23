// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import AccountNamingPanel from './AccountNamingPanel';
import type { AccountNaming } from '../../server/account-naming';
afterEach(cleanup);
function Editor() {
  const [value, setValue] = useState<AccountNaming>({});
  return <AccountNamingPanel value={value} onChange={setValue} />;
}
it('previews primary/additional formats, handles multiline aliases and resets defaults without a request', () => {
  render(<Editor />);
  expect(screen.getByText('example_user · example_user_2 · example_user_3')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Primary account format'), {
    target: { value: 'media-{username}' },
  });
  fireEvent.change(screen.getByLabelText('Additional account format'), {
    target: { value: 'media-{username}-profile{slot}' },
  });
  fireEvent.change(screen.getByLabelText('Legacy additional account formats'), {
    target: { value: '{username}_{slot}\n\n{username}-old{slot}\n' },
  });
  expect(
    screen.getByText(
      'media-example_user · media-example_user-profile2 · media-example_user-profile3',
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Restore naming defaults' }));
  expect(screen.getByText('example_user · example_user_2 · example_user_3')).toBeTruthy();
});
it('shows actionable invalid format errors and preserves an editable draft', () => {
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('Additional account format'), {
    target: { value: '{username}/{slot}' },
  });
  expect(screen.getByRole('status').textContent).toContain('slashes');
  expect((screen.getByLabelText('Additional account format') as HTMLInputElement).value).toBe(
    '{username}/{slot}',
  );
});
