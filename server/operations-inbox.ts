import { discordDeliveryIssueLabel } from './bot-messages.js';
import type { DestinationCatalogs } from './destination-catalogs.js';
import type { SourceSnapshots } from './source-snapshots.js';
import type { StripeIntegration } from './stripe-integration.js';
import type { Store } from './store.js';
import type { MediaServerObservation } from './types.js';

type Repair =
  | 'emby_history'
  | 'jellyfin_history'
  | 'stripe'
  | 'identity'
  | 'discord'
  | 'events'
  | 'account_recovery';
export interface InboxItem {
  id: string;
  title: string;
  detail?: string;
  attention: boolean;
  next_run_at?: string | null;
  last_successful_at?: string | null;
  repair?: Repair;
  job_id?: string;
}

export async function operationsInbox(
  store: Store,
  source: SourceSnapshots,
  destination: DestinationCatalogs,
  stripe: StripeIntegration,
  identityGaps: number | null,
  authorityHolds: number,
  sessionId: string,
  observed: {
    emby?: MediaServerObservation;
    jellyfin?: MediaServerObservation;
  },
): Promise<InboxItem[]> {
  const [emby, jellyfin] = await Promise.all([
    source.status(observed.emby),
    destination.status(observed.jellyfin),
  ]);
  const items: InboxItem[] = [];
  const deadline = Date.now() + 12 * 60 * 60_000;
  for (const [repair, name, status, expiry, configured] of [
    [
      'emby_history',
      'Emby saved history',
      emby,
      emby.records[0]?.expires_at,
      emby.configured || emby.config.enabled || !!emby.records.length || !!emby.last_attempt_at,
    ],
    [
      'jellyfin_history',
      'Jellyfin matching backup',
      jellyfin,
      jellyfin.record?.expires_at,
      jellyfin.configured,
    ],
  ] as const) {
    if (!configured) continue;
    const expires = expiry ? Date.parse(expiry) : Infinity;
    const expired = expires <= Date.now();
    const expiring = expires <= deadline;
    const failed = status.last_outcome === 'failed' || status.last_outcome === 'interrupted';
    const detail = failed
      ? (status.last_error ?? 'The most recent import needs review.')
      : expired
        ? 'The latest import has expired.'
        : !status.usable
          ? 'No usable saved history is available. Check the import.'
          : expiring
            ? 'The latest import expires within 12 hours.'
            : status.running
              ? 'Import in progress.'
              : status.available
                ? 'Helper available.'
                : 'The helper is unavailable.';
    items.push({
      id: repair,
      title: name,
      detail,
      attention: failed || expiring || !status.available || !status.usable,
      next_run_at: status.next_run_at,
      last_successful_at: status.last_successful_at,
      repair,
    });
  }
  if (jellyfin.backup_creation?.phase === 'uncertain')
    items.push({
      id: 'backup-uncertain',
      title: 'Jellyfin backup creation needs review',
      detail: 'Check the backup attempt before requesting another copy.',
      attention: true,
      repair: 'jellyfin_history',
    });
  const billing = stripe.status();
  if (billing.automation_review_count || billing.last_error || billing.automation_error)
    items.push({
      id: 'billing',
      title: 'Stripe billing needs review',
      detail: billing.automation_review_count
        ? `${billing.automation_review_count} billing decisions need review.`
        : 'The most recent sync or entitlement evaluation reported an error.',
      attention: true,
      repair: 'stripe',
    });
  if (identityGaps)
    items.push({
      id: 'identity',
      title: 'Identity decisions need review',
      detail: `${identityGaps} gaps in the most recent identity review.`,
      attention: true,
      repair: 'identity',
    });
  if (authorityHolds)
    items.push({
      id: 'discord',
      title: 'Discord household authority needs review',
      detail: `${authorityHolds} households are held for approval.`,
      attention: true,
      repair: 'discord',
    });
  const pending = store.subscriptionCount('pending');
  const failed = store.subscriptionCount('failed');
  if (pending || failed)
    items.push({
      id: 'events',
      title: 'Membership events need review',
      detail: `${pending} pending, ${failed} failed.`,
      attention: true,
      repair: 'events',
    });
  for (const job of store.jobSummaries({ status: 'interrupted', limit: 6 }).jobs)
    items.push({
      id: `interrupted:${job.id}`,
      title: 'Interrupted operation',
      detail: job.results[0]?.username ?? job.kind,
      attention: true,
      job_id: job.id,
    });
  for (const row of store.jobsAwaitingCredentials(6, sessionId))
    items.push({
      id: `credentials:${row.id}`,
      title: row.available ? 'Credentials available' : 'Credential reveal claimed',
      detail: [
        row.available ? `${row.available} available to reveal in this session.` : '',
        row.claimed_elsewhere ? `${row.claimed_elsewhere} claimed in another session.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      attention: true,
      job_id: row.id,
    });
  for (const { id, issue, failed } of store.credentialDeliveryIssues(6)) {
    const error = discordDeliveryIssueLabel(issue) ?? (failed ? 'Discord send error' : undefined);
    items.push({
      id: `delivery:${id}`,
      title: error ?? 'Discord delivery record',
      attention: !!error,
      job_id: id,
    });
  }
  if (
    store.db
      .prepare(
        `SELECT 1 FROM accounts WHERE status IN
    ('uncertain','provisioning','clone_uncertain','clone_incomplete') LIMIT 1`,
      )
      .get()
  )
    items.push({
      id: 'account-recovery',
      title: 'Account setup needs recovery',
      attention: true,
      repair: 'account_recovery',
    });
  return items.sort((left, right) => Number(right.attention) - Number(left.attention));
}
