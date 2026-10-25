// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import MigrationPreviewDialog from './MigrationPreviewDialog';
import type { Api, PreviewUser } from './types';

afterEach(cleanup);
const owner = '123456789012345678';
const users: PreviewUser[] = [
  { source_user_id: 'source-a', username: 'first-personal-name', target_exists: false, stats: {} },
  { source_user_id: 'source-b', username: 'unrelated-custom-name', target_exists: true, stats: {} },
];
function setup(rows: PreviewUser[] = users, pending = false) {
  const startMigration = vi.fn((event) => event.preventDefault());
  render(
    <MigrationPreviewDialog
      review={{ previewId: 'review-synthetic', preview: { users: rows } }}
      api={vi.fn(async () => ({ members: [], truncated: false })) as Api}
      close={vi.fn()}
      refreshPreview={vi.fn()}
      startMigration={startMigration}
      busy={new Set(pending ? ['migration'] : [])}
    />,
  );
  return {
    startMigration,
    form: document.querySelector<HTMLFormElement>('#migration-preview-form')!,
  };
}
function manualOwners() {
  for (const input of screen.getAllByLabelText('Discord recipient ID (advanced)'))
    fireEvent.change(input, { target: { value: owner } });
}

describe('reviewed migration account slots', () => {
  it('requires distinct reviewed slots when arbitrary account names share one manually confirmed owner', () => {
    const { startMigration, form } = setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    manualOwners();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(
      screen
        .getByLabelText('Membership account slot for first-personal-name')
        .getAttribute('aria-invalid'),
    ).toBe('true');
    fireEvent.submit(form);
    expect(startMigration).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Membership account slot for unrelated-custom-name'), {
      target: { value: '2' },
    });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    const submitted = new FormData(form);
    expect(submitted.get('slot-source-a')).toBe('1');
    expect(submitted.get('slot-source-b')).toBe('2');
    fireEvent.submit(form);
    expect(startMigration).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('dialog')).getByText('unrelated-custom-name')).toBeTruthy();
    expect(screen.getByText(/account names stay unchanged/)).toBeTruthy();
  });

  it('allows the same slot for different Discord owners and exposes slot 3', () => {
    setup();
    const inputs = screen.getAllByLabelText('Discord recipient ID (advanced)');
    fireEvent.change(inputs[0], { target: { value: owner } });
    fireEvent.change(inputs[1], { target: { value: '234567890123456789' } });
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.change(screen.getByLabelText('Membership account slot for unrelated-custom-name'), {
      target: { value: '3' },
    });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('clears a collision when the manually entered owner is cleared without submitting ownership', () => {
    const { form } = setup();
    manualOwners();
    fireEvent.change(screen.getAllByLabelText('Discord recipient ID (advanced)')[1], {
      target: { value: '' },
    });
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(new FormData(form).has('slot-source-b')).toBe(false);
  });

  it.each(['mapping', 'approved', 'numbered_suggestion'] as const)(
    'keeps %s ownership fixed and out of manually assigned slots',
    (owner_basis) => {
      const { form } = setup([
        {
          ...users[0],
          discord_user_id: owner,
          discord_username: 'household_owner',
          membership_slot: 2,
          owner_basis,
        },
      ]);
      expect(
        screen.getByLabelText('Membership account slot for first-personal-name'),
      ).toHaveProperty('disabled', true);
      expect(
        screen.getByRole('button', { name: 'Clear Discord member @household_owner' }),
      ).toHaveProperty('disabled', true);
      expect(new FormData(form).has('slot-source-a')).toBe(false);
      expect(screen.getByText(/Change a confirmed slot through User mappings/)).toBeTruthy();
    },
  );

  it('keeps an ownerless custom mapping editable without changing its destination name', () => {
    const { form } = setup([
      {
        ...users[0],
        mapping_id: 'ownerless-map',
        source_username: 'source-custom',
        username: 'destination-custom',
        membership_slot: 2,
      },
    ]);
    fireEvent.change(screen.getByLabelText('Discord recipient ID (advanced)'), {
      target: { value: owner },
    });
    const slot = screen.getByLabelText('Membership account slot for destination-custom');
    expect(slot).toHaveProperty('disabled', false);
    expect(new FormData(form).get('slot-source-a')).toBe('2');
    expect(
      screen.getByText('Mapped Emby account: source-custom → Jellyfin: destination-custom'),
    ).toBeTruthy();
  });

  it('freezes reviewed recipients and slots while acceptance is pending', () => {
    setup([{ ...users[0], discord_user_id: owner, discord_username: 'household_owner' }], true);
    expect(
      screen.getByRole('button', { name: 'Clear Discord member @household_owner' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Membership account slot for first-personal-name')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Starting migration…' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('protects history-only users from recipient and slot controls', () => {
    setup([
      {
        ...users[0],
        history_only: true,
        target_exists: true,
        discord_user_id: owner,
        membership_slot: 2,
      },
    ]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Advanced Discord details')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start migration' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
