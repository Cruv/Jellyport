import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { navigateWorkspace, useRouteTab } from './routing';
import { useWorkspaceDraftState } from './workspace-drafts';
import { Callout, Empty, Heading, Icon, Loading, Modal } from './components';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
import DiscordMemberPicker from './DiscordMemberPicker';
import { MemberIdentityAccountReview } from './IdentityReviewPanel';
import WorkflowRequirements, { useWorkflowAction } from './WorkflowRequirements';
import {
  defaultMembershipTiers,
  type Api,
  type DiscordMember,
  type Job,
  type Membership,
  type MembershipTier,
  type Notify,
  type Settings,
} from './types';

interface MembershipWorkflowPlan {
  review_token: string;
  expires_at: string;
  discord_user_id: string;
  username: string;
  access_mode: 'subscription' | 'complimentary';
  tier_id: string;
  account_limit: number;
  provision_jellyfin: boolean;
  accounts: Array<{
    slot: number;
    username: string;
    action: 'create' | 'migrate' | 'manage' | 'disable' | 'family_preserved';
    kind: 'jellyfin';
    target_user_id?: string;
    source_user_id?: string;
  }>;
  warnings: string[];
  policy_only: boolean;
}
interface MembershipReview {
  draftKey: string;
  member: DiscordMember;
  existing?: Membership;
  tier: MembershipTier;
  accessMode: 'subscription' | 'complimentary';
  usernames: string[];
  provisionJellyfin: boolean;
  plan: MembershipWorkflowPlan;
}
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'The membership could not be updated.';

export default function MembershipsPage({
  settings,
  api,
  notify,
  created,
  embedded = false,
  refreshKey = 0,
  initialMember,
  handoffKey,
  onInitialMemberApplied,
  active = true,
}: {
  settings: Settings;
  api: Api;
  notify: Notify;
  created: (job: Job) => void;
  embedded?: boolean;
  refreshKey?: number;
  initialMember?: { id: string; username: string };
  handoffKey?: number;
  onInitialMemberApplied?: () => void;
  active?: boolean;
}) {
  const identityAction = useWorkflowAction('identity_review');
  const createAction = useWorkflowAction('create_account');
  const tiers = settings.membership_tiers || defaultMembershipTiers;
  const [view, setView] = useRouteTab('memberships', 'accounts');
  const [query, setQuery] = useState('');
  const [accessFilter, setAccessFilter] = useState('all');
  const [memberships, setMemberships] = useState<Membership[]>([]);
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
  const [provisionJellyfin, setProvisionJellyfin] = useWorkspaceDraftState(
    'memberships.provisionJellyfin',
    false,
  );
  const [tierId, setTierId] = useWorkspaceDraftState('memberships.tierId', tiers[0]?.id || '');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<MembershipReview | null>(null);
  const [reviewExpired, setReviewExpired] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [checkVersion, setCheckVersion] = useState(0);
  const [check, setCheck] = useState<{
    key: string;
    pending: boolean;
    error: string;
    value?: MembershipWorkflowPlan;
  }>({ key: '', pending: false, error: '' });
  const handoff = useRef('');
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!busyRef.current) setReview(null);
  }, [view]);
  useEffect(() => {
    if (!review) return;
    const remaining = Date.parse(review.plan.expires_at) - Date.now();
    setReviewExpired(!Number.isFinite(remaining) || remaining <= 0);
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = setTimeout(() => setReviewExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [review]);
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
        const value = await api<{ memberships: Membership[] }>('/api/memberships', {
          signal: controller.signal,
        });
        if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
        setMemberships(value.memberships);
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
  }, [reload, refreshKey]);

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
  const request =
    member && tier && loaded
      ? {
          discord_user_id: member.id,
          access_mode: accessMode,
          ...(accessMode === 'complimentary'
            ? { account_limit: tier.account_limit }
            : { tier_id: tier.id }),
          provision_jellyfin: provisionJellyfin,
          ...(existing?.revision ? { expected_revision: existing.revision } : {}),
        }
      : null;
  // A setup repair invalidates server-retained evidence; keep the draft, not its old token.
  const requestKey = request ? JSON.stringify({ request, settings }) : '';
  const currentCheck =
    check.key === requestKey ? check : { pending: !!requestKey, error: '', value: undefined };
  const usernames =
    currentCheck.value?.accounts
      .filter((account) => account.slot <= (tier?.account_limit || 0))
      .map((account) => account.username) || [];
  useEffect(() => {
    if (!requestKey || busy || identityOpen || !active || view !== 'editor') return;
    const controller = new AbortController();
    setCheck({ key: requestKey, pending: true, error: '' });
    const timer = setTimeout(() => {
      void api<MembershipWorkflowPlan>('/api/memberships/workflow/review', {
        method: 'POST',
        body: JSON.parse(requestKey).request,
        signal: controller.signal,
      })
        .then((value) => {
          if (controller.signal.aborted || !mounted.current) return;
          if (
            value.discord_user_id !== member?.id ||
            !value.review_token ||
            value.access_mode !== accessMode ||
            value.account_limit !== tier?.account_limit ||
            value.provision_jellyfin !== provisionJellyfin ||
            typeof value.policy_only !== 'boolean' ||
            !Number.isFinite(Date.parse(value.expires_at)) ||
            !Array.isArray(value.accounts) ||
            !Array.isArray(value.warnings) ||
            value.accounts.some(
              (account) =>
                account.kind !== 'jellyfin' ||
                !Number.isInteger(account.slot) ||
                account.slot < 1 ||
                account.slot > 3 ||
                typeof account.username !== 'string' ||
                !account.username ||
                !['create', 'migrate', 'manage', 'disable', 'family_preserved'].includes(
                  account.action,
                ),
            )
          )
            throw new Error('The account review was incomplete. Check requirements again.');
          setCheck({ key: requestKey, pending: false, error: '', value });
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted && mounted.current)
            setCheck({ key: requestKey, pending: false, error: message(reason) });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    api,
    requestKey,
    checkVersion,
    busy,
    identityOpen,
    active,
    view,
    identityAction.ready,
    createAction.ready,
  ]);
  useEffect(() => {
    if (review && review.draftKey !== requestKey && !busyRef.current) setReview(null);
  }, [requestKey, review]);

  function selectMember(value: DiscordMember | null) {
    setView('editor');
    setMember(value);
    setError('');
    setIdentityOpen(false);
    const saved = memberships.find((item) => item.discord_user_id === value?.id);
    setProvisionJellyfin(saved ? saved.provision_jellyfin !== false : false);
    setTierId(saved?.tier_id || tiers[0]?.id || '');
    if (saved) {
      setAccessMode(saved.access_mode || 'subscription');
      setComplimentaryLimit(saved.access_mode === 'complimentary' ? saved.account_limit : 1);
    }
  }
  useEffect(() => {
    if (!initialMember || !loaded || loading) return;
    const key = `${handoffKey ?? 0}:${initialMember.id}`;
    if (handoff.current === key) return;
    handoff.current = key;
    selectMember({ ...initialMember, display_name: null, nickname: null, membership_active: null });
    onInitialMemberApplied?.();
  }, [initialMember?.id, initialMember?.username, handoffKey, loaded, loading]);
  function showReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !member ||
      !tier ||
      !loaded ||
      loading ||
      busyRef.current ||
      !currentCheck.value ||
      currentCheck.pending ||
      !!currentCheck.error
    )
      return;
    setError('');
    setReview({
      draftKey: requestKey,
      member,
      existing,
      tier: { ...tier },
      accessMode,
      usernames,
      provisionJellyfin,
      plan: currentCheck.value,
    });
  }
  async function provision() {
    if (
      !review ||
      reviewExpired ||
      Date.parse(review.plan.expires_at) <= Date.now() ||
      busyRef.current
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const result = await api<{ membership: Membership; job: Job | null }>(
        '/api/memberships/workflow/accept',
        {
          method: 'POST',
          body: { review_token: review.plan.review_token },
          signal: controller.signal,
        },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setReview(null);
      if (result.job) {
        created(result.job);
        notify('Membership update queued. Follow account changes in Activity.');
      } else notify('Access policy saved. Existing media accounts are unchanged.');
      await reload();
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) {
        setReview(null);
        setError(message(reason));
        setCheckVersion((value) => value + 1);
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
          provision_jellyfin: provisionJellyfin,
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
      {!embedded && (
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
      )}

      {error && !review && (
        <div className="error-block" role="alert">
          {error}
        </div>
      )}
      <div className="page-stack">
        {embedded && (
          <div className="form-actions">
            <button
              className="btn btn-quiet"
              aria-busy={loading}
              onClick={() => void reload(true)}
              disabled={busy || loading}
            >
              <Icon name="refresh" /> Refresh access
            </button>
          </div>
        )}
        <Tabs
          id="membership-views"
          label="Membership tasks"
          tabs={[
            { id: 'list', label: 'Managed memberships', count: memberships.length },
            { id: 'editor', label: member ? 'Manage member' : 'Add member' },
          ]}
          value={view}
          onChange={(value) => {
            if (!busy && !identityBusy) setView(value);
          }}
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
                  setProvisionJellyfin(false);
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
                text="Add a Discord member to manage access. Jellyfin accounts are optional and require a separate review."
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
                <h2>Manage a member’s access</h2>
                <p>Select the owner and review their account allowance.</p>
              </div>
              <span className="server-icon discord">
                <Icon name="discord" />
              </span>
            </div>
            <div className="panel-body form-stack">
              {member && identityOpen ? (
                <>
                  <h3>Existing relationships for @{member.username}</h3>
                  <p className="section-note">
                    Confirmed relationships are reused. Review missing accounts here, then return to
                    the same access-policy draft.
                  </p>
                  <WorkflowRequirements action="identity_review" compact />
                  <MemberIdentityAccountReview
                    api={api}
                    notify={notify}
                    member={member}
                    active={identityAction.ready}
                    onBusyChange={setIdentityBusy}
                    onCancel={() => setIdentityOpen(false)}
                    onApplied={() => {
                      setIdentityOpen(false);
                      setCheckVersion((value) => value + 1);
                      void reload();
                    }}
                  />
                </>
              ) : (
                <form className="form-stack" onSubmit={showReview}>
                  <DiscordMemberPicker
                    api={api}
                    value={member}
                    onChange={selectMember}
                    disabled={busy || loading}
                    allowInactive={accessMode === 'complimentary'}
                  />
                  {member && (
                    <section
                      className="summary-card form-stack"
                      aria-label="Member workflow requirements"
                    >
                      <div>
                        <h3>@{member.username}</h3>
                        <p className="section-note">
                          {existing
                            ? 'Saved membership and confirmed account relationships are reused.'
                            : 'New membership. Jellyfin access remains optional.'}
                        </p>
                      </div>
                      {currentCheck.pending && (
                        <p role="status">Checking account requirements before review…</p>
                      )}
                      {currentCheck.error && (
                        <Callout warning title="Resolve this before updating accounts">
                          <p>{currentCheck.error}</p>
                          <p>
                            Your policy draft is preserved. Existing account relationships can be
                            reviewed below without leaving this task.
                          </p>
                        </Callout>
                      )}
                      {currentCheck.error && provisionJellyfin && !createAction.ready && (
                        <WorkflowRequirements action="create_account" compact />
                      )}
                      {currentCheck.value && (
                        <p className="section-note">
                          {currentCheck.value.policy_only
                            ? 'Policy-only update: no media account or identity mapping is required.'
                            : `${currentCheck.value.accounts.length} account ${currentCheck.value.accounts.length === 1 ? 'change' : 'changes'} checked. Existing accounts keep their confirmed owner and names.`}
                        </p>
                      )}
                      {existing?.links.length ? (
                        <p className="section-note">
                          Linked Jellyfin accounts:{' '}
                          {existing.links.map((link) => link.username).join(', ')}
                        </p>
                      ) : null}
                      <div className="button-row">
                        <button
                          type="button"
                          className="btn btn-quiet"
                          disabled={busy || loading}
                          onClick={() => setIdentityOpen(true)}
                        >
                          Review existing account links
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet"
                          disabled={busy || currentCheck.pending}
                          onClick={() => setCheckVersion((value) => value + 1)}
                        >
                          Check requirements again
                        </button>
                      </div>
                      {!identityAction.ready && (
                        <p className="section-note">
                          Changing Discord relationships is optional. Existing confirmed account
                          access can still be reviewed; Discord setup is checked when you open
                          account links.
                        </p>
                      )}
                    </section>
                  )}
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
                  <label className="check-card">
                    <input
                      className="checkbox"
                      type="checkbox"
                      aria-label="Enable Jellyfin account provisioning"
                      checked={provisionJellyfin}
                      disabled={busy || loading}
                      onChange={(event) => setProvisionJellyfin(event.target.checked)}
                    />
                    <span>
                      <strong>Enable Jellyfin account provisioning</strong>
                      <small>
                        Optional. Leave off for Emby-only and non-media members. Saving access never
                        creates accounts or migrates history.
                      </small>
                    </span>
                  </label>
                  {member && tier && provisionJellyfin && usernames.length > 0 && (
                    <div className="support-note">
                      <strong>
                        {existing ? 'Saved account names are preserved.' : 'Expected account names'}
                      </strong>
                      <p>{usernames.join(', ')}</p>
                      <p>
                        These names come from the checked server plan. Existing confirmed accounts
                        and owner slots are reused; review missing links above if a name differs.
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
                      disabled={
                        !member ||
                        !tier ||
                        !loaded ||
                        loading ||
                        busy ||
                        currentCheck.pending ||
                        !currentCheck.value ||
                        !!currentCheck.error
                      }
                    >
                      <Icon name="check" />{' '}
                      {currentCheck.pending ? 'Checking requirements…' : 'Review membership update'}
                    </button>
                  </div>
                </form>
              )}
              <details className="help-details">
                <summary>Access rules and available actions</summary>
                <p>
                  Save access policy changes how membership events are handled without changing
                  media accounts. Review membership update checks account slots before queuing
                  access changes to existing linked accounts. Creating missing accounts or migrating
                  history requires Jellyfin provisioning to be enabled.
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
              <button
                className="btn btn-primary"
                disabled={busy || reviewExpired}
                onClick={() => void provision()}
              >
                {busy
                  ? 'Saving…'
                  : review.plan.policy_only
                    ? 'Save reviewed access policy'
                    : 'Queue membership update'}
              </button>
            </>
          }
        >
          <Callout
            title={
              review.plan.policy_only
                ? 'Save the reviewed access policy'
                : 'Account requirements checked'
            }
          >
            {review.plan.policy_only
              ? 'This saves the membership policy without creating, migrating, enabling or disabling media accounts.'
              : 'Only the account changes listed below will be queued. Existing owner relationships, credentials and personal media data are preserved.'}
          </Callout>
          {review.plan.accounts.length > 0 && (
            <div className="record-list">
              {review.plan.accounts.map((account) => (
                <article className="summary-card" key={`${account.slot}:${account.username}`}>
                  <h3>{account.username}</h3>
                  <p className="section-note">Jellyfin · Account slot {account.slot}</p>
                  <p>
                    {
                      {
                        create:
                          'Create a new account with the configured defaults and deliver its generated password to the confirmed owner.',
                        migrate: 'Migrate this owner’s matching Emby account into Jellyfin.',
                        manage:
                          'Reuse the existing confirmed account and preserve its credentials and history.',
                        disable:
                          'Disable this account outside the allowance and preserve its data.',
                        family_preserved: 'Preserve this manually flagged Family account.',
                      }[account.action]
                    }
                  </p>
                </article>
              ))}
            </div>
          )}
          {review.plan.warnings.map((warning, index) => (
            <p className="section-note" key={index}>
              {warning}
            </p>
          ))}
          {reviewExpired && (
            <Callout warning title="Refresh this account review">
              <p>The reviewed account state expired. Your policy draft is preserved.</p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setReview(null);
                  setCheckVersion((value) => value + 1);
                }}
              >
                Check current requirements
              </button>
            </Callout>
          )}
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
