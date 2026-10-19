import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { navigateWorkspace, useRouteTab } from './routing';
import { useWorkspaceDraftState } from './workspace-drafts';
import { Empty, Heading, Icon, Loading, Modal } from './components';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
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
  const [view, setView] = useRouteTab('memberships');
  const [query, setQuery] = useState('');
  const [accessFilter, setAccessFilter] = useState('all');
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [mappings, setMappings] = useState<UserMapping[]>([]);
  const [member, setMember] = useWorkspaceDraftState<DiscordMember | null>(
    'memberships.member',
    null,
  );
  const [accessMode, setAccessMode] = useWorkspaceDraftState<'subscription' | 'complimentary'>(
    'memberships.accessMode',
    'subscription',
  );
  const [complimentaryLimit, setComplimentaryLimit] = useWorkspaceDraftState(
    'memberships.complimentaryLimit',
    1,
  );
  const [tierId, setTierId] = useWorkspaceDraftState('memberships.tierId', tiers[0]?.id || '');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<MembershipReview | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!busyRef.current) setReview(null);
  }, [view]);
  const generation = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const controllers = useRef(new Set<AbortController>());

  const reload = useCallback(
    async (manual = false) => {
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
        if (manual) notify('Memberships refreshed.');
      } catch (reason) {
        if (mounted.current && !controller.signal.aborted && version === generation.current) {
          setLoaded(false);
          setError(message(reason));
          if (manual) notify(message(reason), true);
        }
      } finally {
        if (mounted.current && !controller.signal.aborted && version === generation.current)
          setLoading(false);
      }
    },
    [api, notify],
  );
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

  const filteredMemberships = memberships.filter(
    (item) =>
      (accessFilter === 'all' || (item.access_mode || 'subscription') === accessFilter) &&
      [item.base_username, ...item.links.map((link) => link.username)].some((name) =>
        name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
  );
  const memberPage = usePagination(filteredMemberships, 25, `${query}:${accessFilter}`);
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
    setView('editor');
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
      if (mounted.current && !controller.signal.aborted) {
        setError(message(reason));
        notify(message(reason), true);
      }
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
      if (mounted.current && !controller.signal.aborted) {
        setError(message(reason));
        notify(message(reason), true);
      }
    } finally {
      controllers.current.delete(controller);
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <Heading
        title="Memberships"
        description="Manage paid and complimentary access, account allowances, and each Discord owner’s linked accounts."
        actions={
          <button
            className="btn btn-quiet"
            aria-busy={loading}
            onClick={() => void reload(true)}
            disabled={busy || loading}
          >
            <Icon name="refresh" /> Refresh
          </button>
        }
      />

      {error && !review && (
        <div className="error-block" role="alert">
          {error}
        </div>
      )}
      <div className="page-stack">
        <Tabs
          id="membership-views"
          label="Membership tasks"
          tabs={[
            { id: 'list', label: 'Managed memberships', count: memberships.length },
            { id: 'editor', label: member ? 'Manage member' : 'Add member' },
          ]}
          value={view}
          onChange={setView}
        />
        <TabPanel id="membership-views" tabId="list" active={view === 'list'}>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Managed memberships</h2>
                <p>Review each owner’s account allowance and linked accounts.</p>
              </div>
              <button
                className="btn btn-primary"
                disabled={busy || loading}
                onClick={() => {
                  setMember(null);
                  setError('');
                  setAccessMode('subscription');
                  setTierId(tiers[0]?.id || '');
                  setComplimentaryLimit(1);
                  setView('editor');
                }}
              >
                Add member
              </button>
            </div>
            <div className="panel-body directory-toolbar">
              <div className="field">
                <label htmlFor="membership-search">Find memberships</label>
                <input
                  id="membership-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search owners or linked accounts"
                />
              </div>
              <div className="field">
                <label htmlFor="membership-filter">Access type</label>
                <select
                  id="membership-filter"
                  value={accessFilter}
                  onChange={(event) => setAccessFilter(event.target.value)}
                >
                  <option value="all">All memberships</option>
                  <option value="subscription">Subscription managed</option>
                  <option value="complimentary">Complimentary</option>
                </select>
              </div>
            </div>
            {loading ? (
              <Loading />
            ) : memberPage.total ? (
              <div className="panel-body record-list">
                {memberPage.items.map((item) => (
                  <article className="summary-card" key={item.discord_user_id}>
                    <div className="record-heading">
                      <div>
                        <h3>{item.base_username}</h3>
                        <p className="section-note">
                          {item.access_mode === 'complimentary'
                            ? 'Complimentary · admin managed · billing exempt'
                            : `${tiers.find((entry) => entry.id === item.tier_id)?.name || item.tier_id} · ${item.active === false ? 'Inactive membership' : `${item.account_limit} entitled ${item.account_limit === 1 ? 'account' : 'accounts'}`}`}
                        </p>
                      </div>
                      <button
                        className="btn"
                        disabled={busy}
                        aria-label={`Manage membership for ${item.base_username}`}
                        onClick={() =>
                          selectMember({
                            id: item.discord_user_id,
                            username: item.base_username,
                            display_name: null,
                            nickname: null,
                            membership_active: null,
                          })
                        }
                      >
                        Manage
                      </button>
                    </div>
                    {item.links.length ? (
                      <ul className="account-slot-list">
                        {item.links.map((link) => (
                          <li key={link.membership_slot}>
                            <strong>{link.username}</strong>
                            <span className="section-note">
                              Slot {link.membership_slot} ·{' '}
                              {link.pending_disabled !== null
                                ? 'Access update pending'
                                : link.disabled_by_jellyport
                                  ? 'Disabled by Jellyport · data preserved'
                                  : 'Linked'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="section-note">No accounts linked yet</p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                icon="discord"
                title={
                  memberships.length
                    ? 'No matching memberships'
                    : 'Give each member their account allowance.'
                }
                text="Add a Discord member to create or migrate the accounts included in their tier."
              />
            )}
            <Pagination
              label="Memberships"
              page={memberPage.page}
              total={memberPage.total}
              pageSize={memberPage.pageSize}
              onPageChange={memberPage.setPage}
              onPageSizeChange={memberPage.setPageSize}
            />
          </section>
        </TabPanel>
        <TabPanel id="membership-views" tabId="editor" active={view === 'editor'}>
          <section className="panel task-panel">
            <div className="panel-header">
              <div>
                <h2>Manage a member’s accounts</h2>
                <p>Select the owner and review their account allowance.</p>
              </div>
              <span className="server-icon discord">
                <Icon name="discord" />
              </span>
            </div>
            <div className="panel-body form-stack">
              <form className="form-stack" onSubmit={showReview}>
                <DiscordMemberPicker
                  api={api}
                  value={member}
                  onChange={selectMember}
                  disabled={busy || loading}
                  allowInactive={accessMode === 'complimentary'}
                />
                <div className="field-row">
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
                      Use complimentary access for family and other non-paying Discord members.
                      Users without Discord can have independent accounts from{' '}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => navigateWorkspace({ page: 'accounts' })}
                      >
                        Create account
                      </button>
                      .
                    </small>
                  </div>
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
                        Tier names, trusted subscription plan names, and account limits can be
                        changed in Settings.
                      </small>
                    </div>
                  ) : (
                    <div className="field">
                      <label htmlFor="complimentary-allowance">
                        Complimentary account allowance
                      </label>
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
                </div>
                {member && tier && (
                  <div className="support-note">
                    <strong>
                      {existing ? 'Saved account names are preserved.' : 'Expected account names'}
                    </strong>
                    <p>{usernames.join(', ')}</p>
                    <p>
                      Use User mappings to associate differently named Emby accounts with the
                      owner’s account slots before provisioning.
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
              <details className="help-details">
                <summary>Access rules and available actions</summary>
                <p>
                  Save access policy changes how membership events are handled without changing
                  media accounts. Review membership update checks account slots before queuing
                  creation, migration, or access changes.
                </p>
                <p>
                  New accounts receive the default role and separate passwords delivered privately
                  to the Discord owner. Downgrades disable extras while preserving data. Upgrades
                  can restore accounts disabled by Jellyport. Complimentary accounts are exempt from
                  subscription cancellation and renewal automation.
                </p>
              </details>
            </div>
          </section>
        </TabPanel>
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
