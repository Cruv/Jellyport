// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DailyImportSchedule from './DailyImportSchedule';
import type { DestinationCatalogConfig, ImportScheduleConfig } from './types';
import { WorkspaceDraftProvider } from './workspace-drafts';

const config: ImportScheduleConfig = {
  enabled: false,
  hour: 3,
  minute: 0,
  time_zone: 'UTC',
  revision: 'synthetic-revision-1',
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('shared daily import schedule editor', () => {
  it('keeps fresh-backup creation absent from source import and capture schedules', () => {
    const view = render(
      <DailyImportSchedule id="source" config={config} busy="" demo={false} onSave={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/Create a fresh Jellyfin backup/)).toBeNull();
    view.rerender(
      <DailyImportSchedule
        id="source"
        config={{ ...config, scope: 'watched_only' }}
        busy=""
        demo={false}
        capture
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/Create a fresh Jellyfin backup/)).toBeNull();
  });
  it('defaults older Jellyfin schedules to import-only and explicitly saves the opt-in independently', async () => {
    const save = vi.fn(async (input) => ({ ...input, revision: 'synthetic-revision-2' }));
    const view = render(
      <DailyImportSchedule
        id="jellyfin"
        config={config}
        busy=""
        demo={false}
        createBackup
        onSave={save}
      />,
    );
    const checkbox = screen.getByLabelText(
      'Create a fresh Jellyfin backup before each scheduled import',
    );
    expect(checkbox).toHaveProperty('checked', false);
    expect(screen.getByText(/Scheduled workflow:/).textContent).toContain(
      'Import an existing completed Jellyfin backup.',
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    await act(async () => {});
    expect(save).toHaveBeenLastCalledWith({
      enabled: false,
      hour: 3,
      minute: 0,
      time_zone: 'UTC',
      create_backup: false,
      expected_revision: config.revision,
    });
    view.rerender(
      <DailyImportSchedule
        id="jellyfin"
        config={{ ...config, revision: 'synthetic-revision-2', create_backup: false }}
        busy=""
        demo={false}
        createBackup
        onSave={save}
      />,
    );
    fireEvent.click(checkbox);
    expect(screen.getByText('Unsaved schedule changes.')).toBeTruthy();
    expect(screen.getByText(/Creating it uses the live Jellyfin database/)).toBeTruthy();
    expect(screen.getByText(/Scheduled workflow:/).textContent).toContain(
      'Import an existing completed Jellyfin backup.',
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    await act(async () => {});
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ create_backup: true, expected_revision: 'synthetic-revision-2' }),
    );
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('retains the fresh-backup draft through remount and revision conflicts, then reloads the saved choice', () => {
    const save = vi.fn();
    function Workspace({
      visible,
      current = config,
    }: {
      visible: boolean;
      current?: DestinationCatalogConfig;
    }) {
      return (
        <WorkspaceDraftProvider>
          {visible && (
            <DailyImportSchedule
              id="jellyfin"
              config={current}
              busy=""
              demo={false}
              createBackup
              onSave={save}
            />
          )}
        </WorkspaceDraftProvider>
      );
    }
    const view = render(<Workspace visible />);
    fireEvent.click(screen.getByLabelText(/Create a fresh Jellyfin backup/));
    view.rerender(<Workspace visible={false} />);
    const changed = { ...config, create_backup: false, revision: 'synthetic-revision-2' };
    view.rerender(<Workspace visible current={changed} />);
    expect(screen.getByLabelText(/Create a fresh Jellyfin backup/)).toHaveProperty('checked', true);
    expect(screen.getByText('Unsaved schedule changes.')).toBeTruthy();
    expect(screen.getByText(/The saved schedule changed/)).toBeTruthy();
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved schedule' }));
    expect(screen.getByLabelText(/Create a fresh Jellyfin backup/)).toHaveProperty(
      'checked',
      false,
    );
    expect(screen.queryByText('Unsaved schedule changes.')).toBeNull();
  });
  it('preserves a later fresh-backup edit when an earlier save returns and recognizes disabling it as dirty', async () => {
    let resolve!: (value: DestinationCatalogConfig) => void;
    const save = vi.fn(() => new Promise<DestinationCatalogConfig>((done) => (resolve = done)));
    const enabled = { ...config, create_backup: true };
    render(
      <DailyImportSchedule
        id="jellyfin"
        config={enabled}
        busy=""
        demo={false}
        createBackup
        onSave={save}
      />,
    );
    expect(screen.getByText(/Scheduled workflow:/).textContent).toContain(
      'Create a fresh Jellyfin backup, then import it after it finishes.',
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    fireEvent.click(screen.getByLabelText(/Create a fresh Jellyfin backup/));
    expect(screen.getByText('Unsaved schedule changes.')).toBeTruthy();
    await act(async () => resolve({ ...enabled, revision: 'synthetic-revision-2' }));
    expect(screen.getByLabelText(/Create a fresh Jellyfin backup/)).toHaveProperty(
      'checked',
      false,
    );
    expect(screen.getByText('Unsaved schedule changes.')).toBeTruthy();
  });
  it.each([
    { busy: 'schedule', demo: false },
    { busy: '', demo: true },
  ])('disables the Jellyfin backup opt-in while busy or in demo mode (%s)', ({ busy, demo }) => {
    render(
      <DailyImportSchedule
        id="jellyfin"
        config={config}
        busy={busy}
        demo={demo}
        createBackup
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Create a fresh Jellyfin backup/)).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('retains only unsubmitted schedule inputs across page remount, rechecks revision, and clears them with the workspace', () => {
    const save = vi.fn();
    function Workspace({
      visible,
      current = config,
    }: {
      visible: boolean;
      current?: ImportScheduleConfig;
    }) {
      return (
        <WorkspaceDraftProvider>
          {visible && (
            <DailyImportSchedule
              id="schedule"
              config={current}
              busy=""
              demo={false}
              onSave={save}
            />
          )}
        </WorkspaceDraftProvider>
      );
    }
    const view = render(<Workspace visible />);
    fireEvent.click(screen.getByLabelText('Enable daily backup import'));
    fireEvent.change(screen.getByLabelText('Import time'), { target: { value: '04:20' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/London' } });
    view.rerender(<Workspace visible={false} />);
    const changed = { ...config, hour: 5, revision: 'synthetic-revision-2' };
    view.rerender(<Workspace visible current={changed} />);
    expect(screen.getByLabelText('Enable daily backup import')).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '04:20');
    expect(screen.getByLabelText('Time zone')).toHaveProperty('value', 'Europe/London');
    expect(screen.getByText(/The saved schedule changed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save import schedule' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(save).not.toHaveBeenCalled();
    view.unmount();
    render(<Workspace visible current={changed} />);
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '05:00');
    expect(screen.getByLabelText('Enable daily backup import')).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Time zone')).toHaveProperty('value', 'UTC');
    expect(save).not.toHaveBeenCalled();
  });
  it('saves independently with explicit time zone and a revision; does not import', async () => {
    const save = vi.fn(async (input) => ({ ...input, revision: 'synthetic-revision-2' }));
    render(
      <DailyImportSchedule
        id="schedule"
        config={config}
        nextRun={null}
        busy=""
        demo={false}
        onSave={save}
      />,
    );
    const disclosure = screen
      .getByText('Daily schedule', { selector: 'summary' })
      .closest('details')!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText('Daily schedule', { selector: 'summary' }));
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(/None — schedule is off/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Enable daily backup import'));
    fireEvent.change(screen.getByLabelText('Import time'), { target: { value: '04:15' } });
    fireEvent.change(screen.getByLabelText('Time zone'), {
      target: { value: ' America/New_York ' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    await act(async () => {});
    expect(save).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      hour: 4,
      minute: 15,
      time_zone: 'America/New_York',
      expected_revision: 'synthetic-revision-1',
    });
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '04:15');
  });
  it('keeps a dirty draft through polling and closing, and requires explicit reload after a revision conflict', () => {
    const save = vi.fn();
    const view = render(
      <DailyImportSchedule id="schedule" config={config} busy="" demo={false} onSave={save} />,
    );
    fireEvent.change(screen.getByLabelText('Import time'), { target: { value: '04:20' } });
    fireEvent.click(screen.getByText('Daily schedule', { selector: 'summary' }));
    fireEvent.click(screen.getByText('Daily schedule', { selector: 'summary' }));
    view.rerender(
      <DailyImportSchedule
        id="schedule"
        config={{ ...config, hour: 5, revision: 'synthetic-revision-2' }}
        busy=""
        demo={false}
        onSave={save}
      />,
    );
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '04:20');
    expect(screen.getByText(/The saved schedule changed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save import schedule' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved schedule' }));
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '05:00');
    expect(save).not.toHaveBeenCalled();
  });
  it('validates a time and IANA zone before sending anything, retains failed-save drafts and permits retry', async () => {
    const save = vi.fn(async () => undefined);
    render(
      <DailyImportSchedule id="schedule" config={config} busy="" demo={false} onSave={save} />,
    );
    fireEvent.change(screen.getByLabelText('Import time'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    expect(screen.getByText(/Choose a daily time/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Import time'), { target: { value: '04:20' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'invalid/zone' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
    expect(screen.getByText(/Enter a valid IANA time zone/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } });
    for (let i = 0; i < 2; i++) {
      fireEvent.submit(screen.getByRole('form', { name: 'Backup import schedule' }));
      await act(async () => {});
    }
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Import time')).toHaveProperty('value', '04:20');
  });
  it('displays saved next-run time in its configured zone and accurately labels catch-up work due', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-18T08:10:00Z'));
    const time = '2026-10-18T08:00:00Z';
    const zone = 'America/New_York';
    render(
      <DailyImportSchedule
        id="schedule"
        config={{ ...config, enabled: true, time_zone: zone, hour: 4 }}
        nextRun={time}
        busy=""
        demo={false}
        onSave={vi.fn()}
      />,
    );
    const formatted = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(time));
    expect(screen.getByText(/Due — waiting to start/).textContent).toContain(
      `${formatted} (${zone})`,
    );
    expect(screen.getByText('Daily at 04:00 (America/New_York)')).toBeTruthy();
  });
  it('keeps capture terminology and scope, and disables all changes during saves and demo mode', async () => {
    const save = vi.fn();
    const source = { ...config, scope: 'watched_only' as const };
    const view = render(
      <DailyImportSchedule
        id="schedule"
        config={source}
        busy=""
        demo={false}
        capture
        onSave={save}
      />,
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Database capture schedule' }));
    await act(async () => {});
    expect(save).toHaveBeenCalledWith({
      enabled: false,
      hour: 3,
      minute: 0,
      time_zone: 'UTC',
      scope: 'watched_only',
      expected_revision: config.revision,
    });
    view.rerender(
      <DailyImportSchedule
        id="schedule"
        config={source}
        busy="schedule"
        demo={false}
        capture
        onSave={save}
      />,
    );
    expect(screen.getByRole('button', { name: 'Saving schedule…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Capture time')).toHaveProperty('disabled', true);
    view.rerender(
      <DailyImportSchedule id="schedule" config={source} busy="" demo capture onSave={save} />,
    );
    expect(screen.getByLabelText('Enable daily database capture')).toHaveProperty('disabled', true);
    fireEvent.submit(screen.getByRole('form', { name: 'Database capture schedule' }));
    expect(save).toHaveBeenCalledOnce();
  });
});
