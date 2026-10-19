// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JellyfinBackupRetention from './JellyfinBackupRetention';
import { WorkspaceDraftProvider } from './workspace-drafts';
import type { JellyfinBackupCleanupStatus, JellyfinBackupRetentionConfig } from './types';

const status: JellyfinBackupCleanupStatus = {
  config: { enabled: false, keep: 7, revision: 'retention-one' },
  supported: false,
  running: false,
  owned_backups: 0,
  last_run_at: null,
  last_outcome: null,
  last_deleted: 0,
  error: null,
};
afterEach(cleanup);
function page(overrides: Partial<Parameters<typeof JellyfinBackupRetention>[0]> = {}) {
  const onSave = vi.fn(async ({ enabled, keep }) => ({
    enabled,
    keep,
    revision: 'retention-two',
  }));
  const props = { status, busy: false, disabled: false, onSave, ...overrides };
  return { ...render(<JellyfinBackupRetention {...props} />), props, onSave: props.onSave };
}
const enable = () =>
  fireEvent.click(screen.getByLabelText('Enable automatic Jellyfin backup cleanup'));
const count = () => screen.getByLabelText('Jellyport-created backups to keep') as HTMLInputElement;
const save = () =>
  fireEvent.submit(screen.getByRole('form', { name: 'Jellyfin backup retention', hidden: true }));

describe('Scoped Jellyfin backup retention', () => {
  it('starts disabled with seven suggested backups and makes no request from reading settings', () => {
    const p = page();
    expect(screen.getByLabelText('Enable automatic Jellyfin backup cleanup')).toHaveProperty(
      'checked',
      false,
    );
    expect(count()).toHaveProperty('value', '7');
    expect(count()).toHaveProperty('disabled', true);
    expect(p.onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Manual backups and existing untracked archives are preserved/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Only future backups whose creation and successful import/),
    ).toBeTruthy();
    expect(screen.getByText(/Keep Emby backups read-only/)).toBeTruthy();
  });

  it('sends only the independent retention configuration and expected revision', async () => {
    const p = page();
    enable();
    fireEvent.change(count(), { target: { value: '14' } });
    save();
    await waitFor(() => expect(p.onSave).toHaveBeenCalledOnce());
    expect(p.onSave).toHaveBeenCalledWith({
      enabled: true,
      keep: 14,
      expected_revision: 'retention-one',
    });
    expect(count().value).toBe('14');
  });

  it('can disable cleanup while preserving the preferred retention count', async () => {
    const p = page({
      status: { ...status, config: { ...status.config, enabled: true, keep: 14 } },
    });
    enable();
    save();
    await waitFor(() =>
      expect(p.onSave).toHaveBeenCalledWith({
        enabled: false,
        keep: 14,
        expected_revision: 'retention-one',
      }),
    );
    expect(count().value).toBe('14');
  });

  it.each(['0', '101', '-1', '1.5', '1e2', ''])('rejects an invalid retained count %s', (keep) => {
    const p = page();
    enable();
    fireEvent.change(count(), { target: { value: keep } });
    save();
    expect(screen.getByRole('alert').textContent).toBe(
      'Choose a whole number of backups from 1 to 100.',
    );
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it.each(['1', '100'])('accepts the boundary count %s', async (keep) => {
    const p = page();
    enable();
    fireEvent.change(count(), { target: { value: keep } });
    save();
    await waitFor(() =>
      expect(p.onSave).toHaveBeenCalledWith({
        enabled: true,
        keep: Number(keep),
        expected_revision: 'retention-one',
      }),
    );
  });

  it('preserves the draft while cleanup status is refreshed and requires reloading a changed saved revision', () => {
    const p = page();
    enable();
    fireEvent.change(count(), { target: { value: '14' } });
    p.rerender(<JellyfinBackupRetention {...p.props} status={{ ...status, owned_backups: 5 }} />);
    expect(count().value).toBe('14');
    p.rerender(
      <JellyfinBackupRetention
        {...p.props}
        status={{ ...status, config: { enabled: true, keep: 30, revision: 'other-admin' } }}
      />,
    );
    expect(count().value).toBe('14');
    save();
    expect(p.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('saved backup cleanup setting changed');
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved cleanup', hidden: true }));
    expect(count().value).toBe('30');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['rejected', 'undefined'] as const)(
    'keeps the draft after a %s save without leaking raw errors',
    async (failure) => {
      const p = page({
        onSave: vi.fn(async () => {
          if (failure === 'rejected') throw new Error('PRIVATE_PATH_AND_TOKEN');
          return undefined;
        }),
      });
      enable();
      fireEvent.change(count(), { target: { value: '14' } });
      save();
      await screen.findByRole('alert');
      expect(count().value).toBe('14');
      expect(screen.getByRole('alert').textContent).toContain('Your changes are kept');
      expect(screen.queryByText('PRIVATE_PATH_AND_TOKEN')).toBeNull();
    },
  );

  it.each(['disabled', 'busy', 'running'] as const)(
    'prevents %s form mutations and duplicate submission',
    (condition) => {
      const p = page({
        disabled: condition === 'disabled',
        busy: condition === 'busy',
        status: { ...status, running: condition === 'running' },
      });
      save();
      expect(p.onSave).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Enable automatic Jellyfin backup cleanup')).toHaveProperty(
        'disabled',
        true,
      );
    },
  );

  it('deduplicates pending saves and ignores a response superseded by a draft reload', async () => {
    let finish!: (value: JellyfinBackupRetentionConfig) => void;
    const p = page({
      onSave: vi.fn(
        () =>
          new Promise<JellyfinBackupRetentionConfig>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    enable();
    save();
    save();
    expect(p.onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved cleanup', hidden: true }));
    await act(async () => finish({ enabled: true, keep: 14, revision: 'retention-two' }));
    expect(count().value).toBe('7');
    expect(screen.getByLabelText('Enable automatic Jellyfin backup cleanup')).toHaveProperty(
      'checked',
      false,
    );
  });

  it('preserves a private unsaved draft across tab unmounts in the same workspace', () => {
    const props = { status, disabled: false, busy: false, onSave: vi.fn() };
    const view = (shown: boolean) => (
      <WorkspaceDraftProvider>
        {shown && <JellyfinBackupRetention {...props} />}
      </WorkspaceDraftProvider>
    );
    const p = render(view(true));
    enable();
    fireEvent.change(count(), { target: { value: '21' } });
    p.rerender(view(false));
    p.rerender(view(true));
    expect(count().value).toBe('21');
    expect(screen.getByLabelText('Enable automatic Jellyfin backup cleanup')).toHaveProperty(
      'checked',
      true,
    );
  });

  it('shows cleanup results independently and renders only generic safe failure details', () => {
    page({
      status: {
        ...status,
        last_run_at: '2026-01-02T03:00:00Z',
        last_outcome: 'failed',
        last_deleted: 2,
        error: 'PRIVATE_PATH_AND_TOKEN',
      },
    });
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/2 backups removed/)).toBeTruthy();
    expect(screen.getByText('Jellyfin backup cleanup could not finish.')).toBeTruthy();
    expect(screen.queryByText('PRIVATE_PATH_AND_TOKEN')).toBeNull();
  });
});
