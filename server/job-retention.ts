export const JOB_RETENTION_INTERVAL_SECONDS = 60;
export const JOB_RETENTION_BATCH_LIMIT = 100;
export interface JobRetentionCursor {
  age_ms: number;
  id: string;
}
export interface JobRetentionStatus {
  retention_days: number;
  interval_seconds: 60;
  batch_limit: 100;
  last_run_at: string | null;
  last_removed: number;
  last_kept: number;
  error: string | null;
}
const TERMINAL = new Set([
  'completed',
  'partial',
  'failed',
  'interrupted',
  'canceled',
  'cancelled',
]);

/** Prefer the report's completion time; malformed preferred dates are never discarded. */
export function jobRetentionTimestamp(job: {
  status?: unknown;
  finished_at?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
}): number | null {
  if (!TERMINAL.has(String(job.status))) return null;
  const value = job.finished_at || job.updated_at || job.created_at;
  if (typeof value !== 'string') return null;
  // Only unambiguous ISO dates produced by Jellyport (including legacy Python UTC
  // offsets and date-only records) are safe for automatic expiry. Date.parse alone
  // also accepts locale-dependent dates and silently normalizes February 30.
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2})))?$/.exec(
      value,
    );
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1]! ||
    Number(parts[4] ?? 0) > 23 ||
    Number(parts[5] ?? 0) > 59 ||
    Number(parts[6] ?? 0) > 59 ||
    Number(parts[8] ?? 0) > 23 ||
    Number(parts[9] ?? 0) > 59
  )
    return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
