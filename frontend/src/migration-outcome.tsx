import { num, type JobResult } from './types';
import { matchingCoverage } from '../../server/job-outcome';

export {
  jobOutcome,
  resultOutcome,
  matchingCoverage,
  MATCHING_COVERAGE_TARGET,
} from '../../server/job-outcome';

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
                ? 'No identifiable source items'
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
          {num(coverage.unmatched)} unmatched · {num(coverage.ambiguous)} ambiguous
        </p>
      )}
      {typeof unresolved === 'number' && Number.isSafeInteger(unresolved) && unresolved > 0 && (
        <p>
          {num(unresolved)} saved-history rows have no verified media identity and are excluded from
          coverage.
        </p>
      )}
    </section>
  );
}
