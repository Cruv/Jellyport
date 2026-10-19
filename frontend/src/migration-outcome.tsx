import { num, type HistoricalMigrationScope, type Job, type JobResult } from './types';

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
export function matchingCoverage(result: JobResult): MatchingCoverage | undefined {
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

function verifiedExecution(result: JobResult): boolean {
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
export function resultOutcome(result: JobResult, scope?: HistoricalMigrationScope): OutcomeDisplay {
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
export function jobOutcome(job: Job): OutcomeDisplay {
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

export function MigrationCoverage({ result }: { result: JobResult }) {
  const coverage = matchingCoverage(result);
  const unresolved =
    result.migration_outcome?.version === 1
      ? result.migration_outcome.unresolved_source_history
      : undefined;
  const pending = ['running', 'queued', 'processing'].includes(result.status);
  return (
    <section className="status-summary form-stack" aria-label="Matching coverage">
      <p>
        <strong>
          {coverage?.ratio !== null && coverage?.ratio !== undefined
            ? `${(coverage.ratio * 100).toFixed(1)}% matched`
            : pending
              ? 'Matching coverage pending'
              : coverage
                ? 'No identifiable played items'
                : 'Matching coverage unavailable'}
        </strong>
        {coverage && coverage.total > 0 && (
          <>
            {' '}
            · {num(coverage.matched)} of {num(coverage.total)} identifiable source items
          </>
        )}
      </p>
      {coverage && coverage.unmatched + coverage.ambiguous > 0 && (
        <p>
          {num(coverage.unmatched + coverage.ambiguous)} identifiable source items skipped:{' '}
          {num(coverage.unmatched)} unmatched · {num(coverage.ambiguous)} ambiguous. Their played
          flags were not changed.
        </p>
      )}
      <p className="subtle text-small">
        Coverage counts identifiable source items, not unique Jellyfin items or every saved-history
        row. Multiple source items can map to the same Jellyfin item.
      </p>
      {count(unresolved) && unresolved > 0 && (
        <p>
          {num(unresolved)} saved-history rows have no verified media identity. They are excluded
          from this percentage and were not migrated or assumed obsolete.
        </p>
      )}
    </section>
  );
}
