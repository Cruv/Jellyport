import { useEffect, useState } from 'react';
import type { HouseholdTimeline as Timeline } from '../../server/household-timeline';
import { Callout, Loading, Modal, Status } from './components';
import { navigateWorkspace } from './routing';
import { date, type Api } from './types';

const serverLabel = { emby: 'Emby', jellyfin: 'Jellyfin' };
const eventAction = {
  subscribe: 'Subscription started or renewed',
  cancel: 'Subscription canceled',
  expire: 'Subscription expired',
};

export default function HouseholdTimeline({
  api,
  owner,
  close,
  openJob,
}: {
  api: Api;
  owner: { id: string; username: string };
  close: () => void;
  openJob?: (id: string) => void;
}) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTimeline(null);
    setError('');
    api<Timeline>(`/api/memberships/${encodeURIComponent(owner.id)}/timeline`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setTimeline(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : 'The household timeline could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [api, owner.id, version]);

  const reviewDiscord = () => {
    close();
    navigateWorkspace({ page: 'settings', tab: 'discord', subtab: 'connection' });
  };
  const reviewStripe = () => {
    close();
    navigateWorkspace({ page: 'settings', tab: 'stripe' });
  };

  return (
    <Modal title={`Household timeline for ${owner.username}`} close={close} wide>
      {error ? (
        <Callout title="Household timeline unavailable" warning>
          <p>{error}</p>
          <button className="btn" onClick={() => setVersion((value) => value + 1)}>
            Retry
          </button>
        </Callout>
      ) : !timeline ? (
        <Loading />
      ) : (
        <div className="form-stack">
          <section className="summary-card form-stack" aria-label="Owner and membership">
            <h3>Owner and membership</h3>
            <p>
              Discord owner {timeline.username ?? owner.username}{' '}
              <span className="section-note">{timeline.discord_user_id}</span>
            </p>
            {timeline.membership ? (
              <>
                <p>
                  {timeline.membership.access_mode === 'complimentary'
                    ? 'Complimentary'
                    : timeline.membership.tier}
                  {' · '}
                  {timeline.membership.active ? 'Active' : 'Inactive'}
                  {' · '}
                  {timeline.membership.account_limit}{' '}
                  {timeline.membership.account_limit === 1 ? 'slot' : 'slots'}
                  {' · '}
                  {timeline.membership.provision_jellyfin
                    ? 'Jellyfin provisioning enabled'
                    : 'Jellyfin provisioning off'}
                </p>
              </>
            ) : (
              <p>No saved membership policy.</p>
            )}
            {timeline.authority !== 'current' && (
              <Callout title="Discord authority review required" warning>
                <p>
                  {timeline.authority === 'legacy'
                    ? 'The original Discord authority was not recorded.'
                    : 'The configured Discord authority changed.'}
                </p>
                <button className="btn" onClick={reviewDiscord}>
                  Review Discord authority
                </button>
              </Callout>
            )}
          </section>
          <section className="summary-card form-stack" aria-label="Confirmed accounts">
            <h3>Accounts and slots</h3>
            {timeline.accounts.length ? (
              <ul className="account-slot-list">
                {timeline.accounts.map((account) => (
                  <li key={`${account.kind}:${account.account_id}`}>
                    <strong>{account.username}</strong>
                    <span className="section-note">
                      {serverLabel[account.kind]} · Slot {account.slot} · {account.identity}
                      {account.access === 'pending' && ' · Access update pending'}
                      {account.access === 'disabled_by_jellyport' && ' · Disabled by Jellyport'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No confirmed or linked media accounts.</p>
            )}
          </section>
          <section className="summary-card form-stack" aria-label="Stripe billing evidence">
            <h3>Stripe billing evidence</h3>
            <p>
              {timeline.stripe.customer_count
                ? `${timeline.stripe.customer_count} approved Stripe ${timeline.stripe.customer_count === 1 ? 'customer' : 'customers'}`
                : 'No approved Stripe customer.'}
            </p>
            {timeline.stripe.last_sync && (
              <p className="section-note">
                Saved billing inventory from {date(timeline.stripe.last_sync)}
              </p>
            )}
            {timeline.stripe.customer_count > 0 && !timeline.stripe.complete && (
              <p role="status">
                Saved billing inventory is missing evidence for at least one approved customer.
              </p>
            )}
            {timeline.stripe.invoice && (
              <p>
                Current invoice-backed paid through {date(timeline.stripe.invoice.paid_through)} ·
                observed {date(timeline.stripe.invoice.observed_at)}
              </p>
            )}
            {timeline.stripe.subscriptions.length > 0 && (
              <ul className="account-slot-list">
                {timeline.stripe.subscriptions.map((subscription) => (
                  <li key={subscription.id}>
                    <strong>{subscription.tier_id ?? 'Tier needs review'}</strong>
                    <span className="section-note">
                      {subscription.status.replaceAll('_', ' ')}
                      {subscription.cancel_at_period_end && ' · Ends after the current period'}
                      {subscription.paused && ' · Collection paused'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <button className="btn btn-quiet" onClick={reviewStripe}>
                Review Stripe billing
              </button>
            </div>
          </section>
          <section className="summary-card form-stack" aria-label="Recent household activity">
            <h3>Recent activity</h3>
            {timeline.milestones.length ? (
              <ol className="account-slot-list">
                {timeline.milestones.map((entry) => (
                  <li key={`${entry.type}:${entry.key}`}>
                    <strong>
                      {entry.type === 'ownership'
                        ? `Confirmed ${serverLabel[entry.kind]} account ${entry.username}`
                        : entry.type === 'subscription'
                          ? eventAction[entry.action]
                          : entry.type === 'membership'
                            ? 'Membership account operation'
                            : `${entry.disabled ? 'Disabled' : 'Enabled'} ${serverLabel[entry.kind]} account ${entry.username}`}
                    </strong>
                    <span className="section-note">{date(entry.at)}</span>
                    {entry.type === 'subscription' && entry.invoice && (
                      <span className="section-note">
                        Historical invoice paid through {date(entry.invoice.paid_through)} ·
                        observed {date(entry.invoice.observed_at)}
                      </span>
                    )}
                    {(entry.type === 'subscription' || entry.type === 'membership') && (
                      <span className="button-row">
                        <Status
                          value={entry.status}
                          label={entry.status === 'deferred' ? 'Deferred' : undefined}
                        />
                        {entry.job_id && openJob && (
                          <button
                            className="text-button"
                            onClick={() => {
                              close();
                              openJob(entry.job_id!);
                            }}
                          >
                            Open operation
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p>No saved ownership approvals or access events.</p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
