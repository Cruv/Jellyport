// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DailyImportSchedule from './DailyImportSchedule';
import type { ImportScheduleConfig } from './types';
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
