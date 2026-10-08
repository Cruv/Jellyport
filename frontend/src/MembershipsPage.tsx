import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Callout, Empty, Heading, Icon, Loading, Modal } from './components';
import DiscordMemberPicker from './DiscordMemberPicker';
import {
  defaultMembershipTiers,
  type Api,
  type DiscordMember,
  type Job,
  type Membership,
  type MembershipTier,
  type Notify,
  type Settings,
  type UserMapping,
} from './types';

interface MembershipReview {
  member: DiscordMember;
  existing?: Membership;
  tier: MembershipTier;
  accessMode: 'subscription' | 'complimentary';
  usernames: string[];
}
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'The membership could not be updated.';
const slotName = (base: string, slot: number) => (slot === 1 ? base : `${base}_${slot}`);

export default function MembershipsPage({
  settings,
  api,
  notify,
  created,
}: {
  settings: Settings;
  api: Api;
  notify: Notify;
  created: (job: Job) => void;
}) {
  const tiers = settings.membership_tiers || defaultMembershipTiers;
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [mappings, setMappings] = useState<UserMapping[]>([]);
  const [member, setMember] = useState<DiscordMember | null>(null);
  const [accessMode, setAccessMode] = useState<'subscription' | 'complimentary'>('subscription');
  const [complimentaryLimit, setComplimentaryLimit] = useState(1);
  const [tierId, setTierId] = useState(tiers[0]?.id || '');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<MembershipReview | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const controllers = useRef(new Set<AbortController>());

  const reload = useCallback(async () => {
    const version = ++generation.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError('');
    try {
      const [value, associations] = await Promise.all([
        api<{ memberships: Membership[] }>('/api/memberships', { signal: controller.signal }),
        api<{ mappings: UserMapping[] }>('/api/user-mappings', { signal: controller.signal }),
      ]);
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      setMemberships(value.memberships);
      setMappings(associations.mappings);
      setLoaded(true);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && version === generation.current) {
        setLoaded(false);
        setError(message(reason));
      }
    } finally {
      if (mounted.current && !controller.signal.aborted && version === generation.current)
        setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      generation.current++;
      loadController.current?.abort();
      controllers.current.forEach((controller) => controller.abort());
    };
  }, [reload]);

  const existing = memberships.find((item) => item.discord_user_id === member?.id);
  const tier =
    accessMode === 'complimentary'
      ? {
          id: 'complimentary',
          name: 'Complimentary',
          plan_name: '',
          account_limit: complimentaryLimit,
        }
      : tiers.find((item) => item.id === tierId);
  const mappedSlots = mappings.filter((mapping) => mapping.discord_user_id === member?.id);
  const baseUsername =
    existing?.base_username ||
    mappedSlots.find((mapping) => (mapping.membership_slot || 1) === 1)?.target_username ||
    member?.username ||
    '';
  const usernames = Array.from(
    { length: tier?.account_limit || 0 },
    (_, index) =>
      existing?.links.find((link) => link.membership_slot === index + 1)?.username ||
      mappedSlots.find((mapping) => (mapping.membership_slot || 1) === index + 1)
        ?.target_username ||
      slotName(baseUsername, index + 1),
  );

  function selectMember(value: DiscordMember | null) {
    setMember(value);
    setError('');
    const saved = memberships.find((item) => item.discord_user_id === value?.id);
    setTierId(saved?.tier_id || tiers[0]?.id || '');
    if (saved) {
      setAccessMode(saved.access_mode || 'subscription');
      setComplimentaryLimit(saved.access_mode === 'complimentary' ? saved.account_limit : 1);
    }
  }
  function showReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member || !tier || !loaded || loading || busyRef.current) return;
    setError('');
    setReview({ member, existing, tier: { ...tier }, accessMode, usernames });
  }
  async function provision() {
    if (!review || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      let current = review.existing;
      if (
        review.accessMode === 'complimentary' ||
        (current?.access_mode === 'complimentary' && review.accessMode === 'subscription')
      ) {
        current = await api<Membership>('/api/memberships/access', {
          method: 'POST',
          body: {
            discord_user_id: review.member.id,
            access_mode: review.accessMode,
            ...(review.accessMode === 'complimentary'
              ? { account_limit: review.tier.account_limit }
              : { tier_id: review.tier.id }),
            ...(current?.revision ? { expected_revision: current.revision } : {}),
          },
          signal: controller.signal,
        });
        if (!mounted.current || controller.signal.aborted) return;
        // Keep a failed provision retry bound to the policy that was just saved.
        setMemberships((items) => [
          ...items.filter((item) => item.discord_user_id !== review.member.id),
          { ...current!, links: current!.links || review.existing?.links || [] },
        ]);
        setReview({
          ...review,
          existing: { ...current, links: current.links || review.existing?.links || [] },
        });
      }
      const job = await api<Job>('/api/memberships/provision', {
        method: 'POST',
        body: {
          discord_user_id: review.member.id,
          tier_id: review.tier.id,
          expected_account_limit: review.tier.account_limit,
          expected_usernames: review.usernames,
          ...(current?.revision ? { expected_revision: current.revision } : {}),
        },
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      setReview(null);
      created(job);
      notify('Membership update queued. Follow account creation and access changes in Activity.');
      await reload();
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(message(reason));
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function saveAccess() {
    if (!member || !tier || !loaded || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      await api<Membership>('/api/memberships/access', {
        method: 'POST',
        body: {
          discord_user_id: member.id,
          access_mode: accessMode,
          ...(accessMode === 'complimentary'
            ? { account_limit: tier.account_limit }
            : { tier_id: tier.id }),
          ...(existing?.revision ? { expected_revision: existing.revision } : {}),
        },
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      notify('Access policy saved. Media accounts have not been changed.');
      await reload();
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(message(reason));
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <Heading
        title="One membership, every entitled account."
        description="Manage paid and complimentary accounts for each Discord owner."
        actions={
          <button className="btn" onClick={() => void reload()} disabled={busy || loading}>
            <Icon name="refresh" /> Refresh
          </button>
        }
      />
      <Callout icon="shield" title="Account access is reviewed before changing.">
        New accounts receive the default account role and their own generated password, delivered
        privately to the Discord owner. Downgrades disable extra accounts and preserve their data.
        Upgrades can restore those same accounts when Jellyport disabled them. Complimentary access
        is managed by you and is exempt from subscription cancellation and renewal automation.
      </Callout>
      {error && !review && (
        <div className="error-block" role="alert">
          {error}
        </div>
      )}
      <div className="stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Manage a member’s accounts</h2>
              <p>Select the owner and review their account allowance.</p>
            </div>
            <span className="server-icon discord">
              <Icon name="discord" />
            </span>
          </div>
          <div className="panel-body">
            <form className="form-stack" onSubmit={showReview}>
              <div className="field">
                <label htmlFor="membership-access-mode">Access policy</label>
                <select
                  id="membership-access-mode"
                  value={accessMode}
                  disabled={busy || loading}
                  onChange={(event) =>
                    setAccessMode(event.target.value as 'subscription' | 'complimentary')
                  }
                >
                  <option value="subscription">Subscription managed</option>
                  <option value="complimentary">Complimentary · admin managed</option>
                </select>
                <small>
                  Use complimentary access for family and other non-paying Discord members. Users
                  without Discord can have independent accounts from Create account.
                </small>
              </div>
              <DiscordMemberPicker
                api={api}
                value={member}
                onChange={selectMember}
                disabled={busy || loading}
                allowInactive={accessMode === 'complimentary'}
              />
              {accessMode === 'subscription' ? (
                <div className="field">
                  <label htmlFor="membership-tier">Membership tier</label>
                  <select
                    id="membership-tier"
                    value={tierId}
                    onChange={(event) => setTierId(event.target.value)}
                    disabled={busy || loading}
                    required
                  >
                    {!tiers.some((item) => item.id === tierId) && (
                      <option value="">Select a configured tier</option>
                    )}
                    {tiers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.account_limit}{' '}
                        {item.account_limit === 1 ? 'account' : 'accounts'}
                      </option>
                    ))}
                  </select>
                  <small>
                    Tier names, trusted subscription plan names, and account limits can be changed
                    in Settings.
                  </small>
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="complimentary-allowance">Complimentary account allowance</label>
                  <select
                    id="complimentary-allowance"
                    value={complimentaryLimit}
                    disabled={busy || loading}
                    onChange={(event) => setComplimentaryLimit(Number(event.target.value))}
                  >
                    {[1, 2, 3].map((count) => (
                      <option key={count} value={count}>
                        {count} {count === 1 ? 'account' : 'accounts'}
                      </option>
                    ))}
                  </select>
                  <small>
                    Billing events do not disable these accounts. Save this policy to protect
                    existing accounts without creating or changing any accounts.
                  </small>
                </div>
              )}
              {member && tier && (
                <div className="support-note">
                  <strong>
                    {existing ? 'Saved account names are preserved.' : 'Expected account names'}
                  </strong>
                  <p>{usernames.join(', ')}</p>
                  <p>
                    Use User mappings to associate differently named Emby accounts with the owner’s
                    account slots before provisioning.
                  </p>
                </div>
              )}
              <div className="form-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={!member || !tier || !loaded || loading || busy}
                  onClick={() => void saveAccess()}
                >
                  Save access policy
                </button>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={!member || !tier || !loaded || loading || busy}
                >
                  <Icon name="check" /> Review membership update
                </button>
              </div>
            </form>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Managed memberships</h2>
              <p>Each owner keeps their account slots across upgrades and downgrades.</p>
            </div>
          </div>
          {loading ? (
            <Loading />
          ) : memberships.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Discord owner</th>
                    <th>Tier</th>
                    <th>Linked Jellyfin accounts</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {memberships.map((item) => (
                    <tr key={item.discord_user_id}>
                      <td>
                        <strong>{item.base_username}</strong>
                        <small>Discord ID: {item.discord_user_id}</small>
                      </td>
                      <td>
                        {item.access_mode === 'complimentary'
                          ? 'Complimentary'
                          : tiers.find((entry) => entry.id === item.tier_id)?.name || item.tier_id}
                        <small>
                          {item.access_mode === 'complimentary'
                            ? 'Admin managed · billing exempt'
                            : item.active === false
                              ? 'Inactive membership'
                              : `${item.account_limit} entitled ${item.account_limit === 1 ? 'account' : 'accounts'}`}
                        </small>
                      </td>
                      <td>
                        {item.links.length
                          ? item.links.map((link) => (
                              <div key={link.membership_slot}>
                                <strong>{link.username}</strong>
                                <small>
                                  Slot {link.membership_slot} ·{' '}
                                  {link.pending_disabled !== null
                                    ? 'Access update pending'
                                    : link.disabled_by_jellyport
                                      ? 'Disabled by Jellyport · data preserved'
                                      : 'Linked'}
                                </small>
                              </div>
                            ))
                          : 'No accounts linked yet'}
                      </td>
                      <td className="right">
                        <button
                          className="btn btn-quiet"
                          disabled={busy}
                          onClick={() =>
                            selectMember({
                              id: item.discord_user_id,
                              username: item.base_username,
                              display_name: null,
                              nickname: null,
                              membership_active: null,
                            })
                          }
                          aria-label={`Manage membership for ${item.base_username}`}
                        >
                          Manage
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon="discord"
              title="Give each member their account allowance."
              text="Select a Discord member above to create or migrate the accounts included in their tier."
            />
          )}
        </section>
      </div>
      {review && (
        <Modal
          title="Review membership update"
          description={`@${review.member.username} · ${review.tier.name} · ${review.tier.account_limit} ${review.tier.account_limit === 1 ? 'account' : 'accounts'}`}
          close={() => {
            if (!busy) {
              setReview(null);
              setError('');
            }
          }}
          footer={
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  setError('');
                }}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void provision()}>
                {busy ? 'Queuing…' : 'Queue membership update'}
              </button>
            </>
          }
        >
          <p>Ensure these account slots are available to this member:</p>
          {review.existing?.active === false && (
            <p>This update marks the membership active again and restores eligible accounts.</p>
          )}
          <ul>
            {Array.from({ length: review.tier.account_limit }, (_, index) => {
              const slot = index + 1;
              const link = review.existing?.links.find((entry) => entry.membership_slot === slot);
              return (
                <li key={slot}>
                  <strong>{review.usernames[index]}</strong> ·{' '}
                  {link
                    ? link.disabled_by_jellyport
                      ? 'Re-enable the preserved account if Jellyport disabled it'
                      : 'Preserve the linked account and its data'
                    : 'Migrate a matching Emby account or create a fresh account'}
                </li>
              );
            })}
          </ul>
          {(review.existing?.links || []).some(
            (link) => link.membership_slot > review.tier.account_limit,
          ) && (
            <>
              <p>Disable these accounts outside the new allowance and keep all their data:</p>
              <ul>
                {review.existing?.links
                  .filter((link) => link.membership_slot > review.tier.account_limit)
                  .map((link) => (
                    <li key={link.membership_slot}>
                      <strong>{link.username}</strong>
                    </li>
                  ))}
              </ul>
            </>
          )}
          <p>
            Existing passwords, watch history, favorites, and playlists are preserved. New passwords
            are generated separately and delivered to the same Discord owner. Accounts disabled
            outside Jellyport require your review.
          </p>
          <p>
            {review.accessMode === 'complimentary'
              ? 'This saves complimentary access before queuing the update. Subscription cancellations, missing subscriber roles, and expiry events do not disable these accounts.'
              : 'Expired memberships disable all linked account slots when the expiration event is applied.'}
          </p>
          {error && (
            <div className="error-block mt-18" role="alert">
              {error}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
