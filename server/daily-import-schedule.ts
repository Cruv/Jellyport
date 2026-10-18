import { ServiceError } from './errors.js';

export interface DailyImportConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  time_zone: string;
  revision: string;
}
export type ImportOutcome = 'running' | 'succeeded' | 'failed' | 'interrupted' | null;
export interface DailyImportOccurrence {
  date: string;
  at: string;
}
export const IMPORT_CATCHUP_MS = 60 * 60_000;

export function dailyImportDate(time: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validateDailyImportConfig(value: Omit<DailyImportConfig, 'revision'>): void {
  if (
    typeof value.enabled !== 'boolean' ||
    !Number.isInteger(value.hour) ||
    value.hour < 0 ||
    value.hour > 23 ||
    !Number.isInteger(value.minute) ||
    value.minute < 0 ||
    value.minute > 59
  )
    throw new ServiceError('Choose a valid daily import schedule.');
  try {
    if (typeof value.time_zone !== 'string' || !value.time_zone || value.time_zone.length > 128)
      throw new Error('Invalid zone.');
    new Intl.DateTimeFormat('en', { timeZone: value.time_zone }).format();
  } catch {
    throw new ServiceError('Choose a valid IANA time zone.');
  }
}

/** Exact local wall-clock occurrences: a missing DST time is skipped, a fold runs once. */
export function dailyImportSchedule(
  config: DailyImportConfig,
  claimedDate: string | undefined,
  now = Date.now(),
): { due: DailyImportOccurrence | null; next_run_at: string | null } {
  if (!config.enabled || !Number.isFinite(now)) return { due: null, next_run_at: null };
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.time_zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (time: number) =>
    Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
  const local = parts(now);
  const today = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  const occurrences: DailyImportOccurrence[] = [];
  // A one-hour catch-up can cross local midnight. Four future dates also cover
  // DST gaps and the occasional skipped civil date without scanning minute by minute.
  for (let day = -1; day <= 4; day++) {
    const midnight = today + day * 24 * 60 * 60_000;
    const date = new Date(midnight).toISOString().slice(0, 10);
    if (date === claimedDate) continue;
    const wall = midnight + (config.hour * 60 + config.minute) * 60_000;
    const offsets = new Set<number>();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      const sample = wall + hours * 60 * 60_000;
      const value = parts(sample);
      offsets.add(
        Date.UTC(
          Number(value.year),
          Number(value.month) - 1,
          Number(value.day),
          Number(value.hour),
          Number(value.minute),
        ) - sample,
      );
    }
    const matching: number[] = [];
    for (const offset of offsets) {
      const candidate = wall - offset;
      const value = parts(candidate);
      if (
        `${value.year}-${value.month}-${value.day}` === date &&
        Number(value.hour) === config.hour &&
        Number(value.minute) === config.minute
      )
        matching.push(candidate);
    }
    if (matching.length)
      occurrences.push({ date, at: new Date(Math.min(...matching)).toISOString() });
  }
  const due =
    occurrences
      .filter((occurrence) => {
        const elapsed = now - Date.parse(occurrence.at);
        return elapsed >= 0 && elapsed < IMPORT_CATCHUP_MS;
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  return {
    due,
    next_run_at:
      due?.at ??
      occurrences
        .filter((occurrence) => Date.parse(occurrence.at) > now)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.at ??
      null,
  };
}

/** One helper processes both imports. Ownership spans lookup, enqueue and completion. */
export class ImportCoordinator {
  private readonly owners = new Set<string>();
  restore(owner: string): void {
    this.owners.add(owner);
  }
  acquire(owner: string): boolean {
    if (this.owners.size) return false;
    this.owners.add(owner);
    return true;
  }
  release(owner: string): void {
    this.owners.delete(owner);
  }
  get busy(): boolean {
    return this.owners.size > 0;
  }
}
