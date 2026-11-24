import { num, type JobResult } from './types';
import { matchingCoverage } from '../../server/job-outcome';

export {
  jobOutcome,
  resultOutcome,
  matchingCoverage,
  MATCHING_COVERAGE_TARGET,
} from '../../server/job-outcome';

const historyCapabilityWarning =
  'Skipped history updates. Jellyfin’s update API could not be verified.';
const legacyCapabilityWarning =
  /^(?:Jellyfin’s partial user-data API could not be verified\.|(?:Played and favorite|Watched-flag) updates require Jellyfin’s partial user-data API\.)/;

export function migrationReport(result: JobResult) {
  const data = result.data;
  const verification = data?.verification;
  const warnings = data?.warnings ?? [];
  const legacyBlock =
    !!verification?.unsupported_fields &&
    data?.write_metrics?.attempts === 0 &&
    warnings.some((warning) => legacyCapabilityWarning.test(warning));
  const unresolved =
    result.migration_outcome?.version === 1 && result.migration_outcome.unresolved_source_history;
  return {
    blocked: legacyBlock || warnings.includes(historyCapabilityWarning),
    failed: legacyBlock ? 0 : (data?.failed_items ?? 0),
    verification: verification && {
      ...verification,
      mismatched: legacyBlock ? 0 : verification.mismatched,
    },
    warnings: [
      ...(legacyBlock ? [historyCapabilityWarning] : []),
      ...warnings.filter(
        (warning) =>
          !(
            unresolved &&
            /^\d+ saved history entries have no verified media identity\./.test(warning)
          ) &&
          !(
            legacyBlock &&
            (legacyCapabilityWarning.test(warning) ||
              warning.startsWith('Failed-update details are limited to ') ||
              warning.startsWith(
                'Independent Jellyfin readback did not verify every intended history field.',
              ))
          ),
      ),
    ],
  };
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
          {[
            coverage.unmatched ? `${num(coverage.unmatched)} unmatched` : '',
            coverage.ambiguous ? `${num(coverage.ambiguous)} ambiguous` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {typeof unresolved === 'number' && Number.isSafeInteger(unresolved) && unresolved > 0 && (
        <p>
          {num(unresolved)} saved history {unresolved === 1 ? 'entry' : 'entries'} without a media
          match.
        </p>
      )}
    </section>
  );
}
