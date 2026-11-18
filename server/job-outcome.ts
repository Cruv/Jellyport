import type { Job, JobResult } from './service.js';
import type { MigrationScope } from './migration.js';

type OutcomeResult = Pick<
  JobResult,
  | 'status'
  | 'matched'
  | 'unmatched'
  | 'ambiguous'
  | 'applied'
  | 'error'
  | 'delivery_error'
  | 'warnings'
  | 'migration_outcome'
> & {
  discord_delivery?: string | { status?: string };
  data?: {
    failed_items: number;
    items_updated: number;
    failed_updates?: readonly unknown[];
    write_metrics?: NonNullable<JobResult['data']>['write_metrics'];
    verification?: NonNullable<JobResult['data']>['verification'];
  };
};
type OutcomeJob = Pick<Job, 'kind' | 'status' | 'error'> & {
  migration_scope?: MigrationScope | 'other';
  results?: OutcomeResult[];
  outcome_status?: string;
};

export const MATCHING_COVERAGE_TARGET = 0.95;

export interface MatchingCoverage {
  matched: number;
  unmatched: number;
  ambiguous: number;
  total: number;
  ratio: number | null;
  meetsTarget: boolean;
}

export interface OutcomeDisplay {
  value: string;
  label?: string;
  needsReview: boolean;
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Matching counts refer to source items, independently of writes or destination deduplication. */
export function matchingCoverage(result: OutcomeResult): MatchingCoverage | undefined {
  const { matched, unmatched, ambiguous } = result;
  if (!count(matched) || !count(unmatched) || !count(ambiguous)) return;
  const total = matched + unmatched + ambiguous;
  if (!count(total)) return;
  const ratio = total ? matched / total : null;
  return {
    matched,
    unmatched,
    ambiguous,
    total,
    ratio,
    meetsTarget: ratio !== null && ratio >= MATCHING_COVERAGE_TARGET,
  };
}

function originalOutcome(status: string): OutcomeDisplay {
  return {
    value: status,
    needsReview: ['partial', 'failed', 'interrupted'].includes(status),
  };
}

function verifiedExecution(result: OutcomeResult): boolean {
  const proof = result.migration_outcome;
  if (
    proof?.version !== 1 ||
    proof.execution !== 'verified' ||
    !count(proof.unresolved_source_history) ||
    result.error ||
    result.delivery_error ||
    result.warnings?.length
  )
    return false;
  const delivery =
    typeof result.discord_delivery === 'object'
      ? result.discord_delivery?.status
      : result.discord_delivery;
  if (
    delivery !== undefined &&
    !['not_requested', 'sent', 'skipped_existing_account'].includes(delivery)
  )
    return false;
  const data = result.data;
  const writes = data?.write_metrics;
  const verification = data?.verification;
  if (
    !data ||
    !writes ||
    !verification ||
    data.failed_items !== 0 ||
    data.failed_updates?.length ||
    !count(writes.attempts) ||
    !count(writes.succeeded) ||
    writes.failed !== 0 ||
    writes.attempts !== writes.succeeded ||
    result.applied !== writes.succeeded ||
    data.items_updated !== writes.succeeded ||
    !count(verification.checked) ||
    verification.checked === 0 ||
    verification.checked < writes.succeeded ||
    !count(result.matched) ||
    verification.checked > result.matched ||
    !count(verification.verified) ||
    !count(verification.preserved_newer) ||
    verification.missing !== 0 ||
    verification.mismatched !== 0 ||
    verification.unsupported_fields !== 0 ||
    verification.checked !== verification.verified + verification.preserved_newer
  )
    return false;
  return true;
}

/** Never reinterpret persisted recovery state or infer warning categories from message text. */
export function resultOutcome(
  result: OutcomeResult,
  scope?: OutcomeJob['migration_scope'],
): OutcomeDisplay {
  if (
    result.status === 'partial' &&
    scope !== 'complete' &&
    matchingCoverage(result)?.meetsTarget &&
    verifiedExecution(result)
  )
    return originalOutcome('completed');
  return originalOutcome(result.status);
}

/** Only migration results can refine a partial job's display; operational job errors prevail. */
export function jobOutcome(job: OutcomeJob): OutcomeDisplay {
  if (job.outcome_status) return originalOutcome(job.outcome_status);
  if (
    ['migrate', 'migration'].includes(job.kind) &&
    job.status === 'partial' &&
    !job.error &&
    job.migration_scope !== 'complete' &&
    job.results?.length &&
    job.results.every(
      (result) => resultOutcome(result, job.migration_scope).value === 'completed',
    ) &&
    job.results.some((result) => result.status === 'partial')
  )
    return originalOutcome('completed');
  return originalOutcome(job.status);
}
