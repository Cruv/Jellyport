import { describe, expect, it } from 'vitest';
import {
  dailyImportSchedule,
  ImportCoordinator,
  validateDailyImportConfig,
  type DailyImportConfig,
} from '../server/daily-import-schedule.js';

const config: DailyImportConfig = {
  enabled: true,
  hour: 3,
  minute: 0,
  time_zone: 'Etc/UTC',
  revision: 'synthetic-revision',
};
const schedule = (now: string, overrides: Partial<DailyImportConfig> = {}, claim?: string) =>
  dailyImportSchedule({ ...config, ...overrides }, claim, Date.parse(now));

describe('daily import wall-clock scheduling', () => {
  it('starts disabled and exposes no execution time', () => {
    expect(schedule('2026-10-09T03:00:00Z', { enabled: false })).toEqual({
      due: null,
      next_run_at: null,
    });
  });
  it.each([
    ['2026-10-09T02:59:59.999Z', false, '2026-10-09T03:00:00.000Z'],
    ['2026-10-09T03:00:00.000Z', true, '2026-10-09T03:00:00.000Z'],
    ['2026-10-09T03:59:59.999Z', true, '2026-10-09T03:00:00.000Z'],
    ['2026-10-09T04:00:00.000Z', false, '2026-10-10T03:00:00.000Z'],
  ])('uses a strict one-hour catch-up window at %s', (now, due, next) => {
    const result = schedule(now);
    expect(result.due !== null).toBe(due);
    expect(result.next_run_at).toBe(next);
  });
  it('claims an occurrence by local date across repeated ticks or restart', () => {
    expect(schedule('2026-10-09T03:05:00Z', {}, '2026-10-09')).toEqual({
      due: null,
      next_run_at: '2026-10-10T03:00:00.000Z',
    });
  });
  it('catches up across midnight without confusing the next night', () => {
    expect(schedule('2026-10-10T00:10:00Z', { hour: 23, minute: 30 })).toEqual({
      due: { date: '2026-10-09', at: '2026-10-09T23:30:00.000Z' },
      next_run_at: '2026-10-09T23:30:00.000Z',
    });
    expect(
      schedule('2026-10-10T00:10:00Z', { hour: 23, minute: 30 }, '2026-10-09').next_run_at,
    ).toBe('2026-10-10T23:30:00.000Z');
  });
  it('skips a missing spring-forward time rather than importing at an invented time', () => {
    const zone = { hour: 2, minute: 30, time_zone: 'America/New_York' };
    expect(schedule('2026-03-08T06:59:00Z', zone)).toEqual({
      due: null,
      next_run_at: '2026-03-09T06:30:00.000Z',
    });
    expect(schedule('2026-03-08T07:00:00Z', zone).due).toBeNull();
    expect(schedule('2026-03-08T07:30:00Z', zone).due).toBeNull();
  });
  it('chooses the first fall-back occurrence and never catches up twice', () => {
    const zone = { hour: 1, minute: 30, time_zone: 'America/New_York' };
    expect(schedule('2026-11-01T05:30:00Z', zone).due).toEqual({
      date: '2026-11-01',
      at: '2026-11-01T05:30:00.000Z',
    });
    expect(schedule('2026-11-01T06:00:00Z', zone).due?.at).toBe('2026-11-01T05:30:00.000Z');
    expect(schedule('2026-11-01T06:30:00Z', zone).due).toBeNull();
    expect(schedule('2026-11-01T06:30:00Z', zone, '2026-11-01').next_run_at).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });
  it.each([
    ['Asia/Kathmandu', '2026-10-09T21:15:00.000Z'],
    ['Pacific/Chatham', '2026-10-09T13:15:00.000Z'],
    ['America/St_Johns', '2026-10-09T05:30:00.000Z'],
  ])('supports non-hour offsets in %s', (time_zone, expected) => {
    expect(schedule('2026-10-09T00:00:00Z', { time_zone }).next_run_at).toBe(expected);
  });
  it.each([
    { hour: 24 },
    { minute: -1 },
    { hour: 1.5 },
    { enabled: 'true' },
    { time_zone: 'Invalid/Zone' },
    { time_zone: '' },
    { time_zone: null },
  ])('rejects invalid schedule %j', (override) => {
    expect(() =>
      validateDailyImportConfig({ ...config, ...override } as DailyImportConfig),
    ).toThrow();
  });
});

it('restores multiple legacy owners without admitting new helper requests until both reconcile', () => {
  const imports = new ImportCoordinator();
  imports.restore('emby:synthetic-active');
  imports.restore('jellyfin:synthetic-active');
  expect(imports.acquire('new')).toBe(false);
  imports.release('emby:synthetic-active');
  expect(imports.busy).toBe(true);
  expect(imports.acquire('new')).toBe(false);
  imports.release('jellyfin:synthetic-active');
  expect(imports.acquire('new')).toBe(true);
  expect(imports.acquire('duplicate')).toBe(false);
  imports.release('new');
  expect(imports.busy).toBe(false);
});
