import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Callout, Icon, Modal } from './components';
import DiscordMemberPicker from './DiscordMemberPicker';
import {
  IdentityReviewResult,
  StripeIdentityAccountReview,
  useIdentityRolePolling,
} from './IdentityReviewPanel';
import type { IdentityReviewApplyResult } from '../../server/identity-review-types';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
import { date, num, type Api, type DiscordMember, type MembershipTier, type Notify } from './types';

export interface StripeIntegrationStatus {
  configured: boolean;
  mode: 'live' | 'test' | null;
  review_only: boolean;
  automation_enabled?: boolean;
  automation_enabled_at?: string | null;
  automation_error?: string | null;
  automation_review_count?: number;
  revision: string;
  running: boolean;
  sync_enabled: boolean;
  last_sync: string | null;
  last_error: string | null;
  subscription_count: number;
  linked_customer_count: number;
  price_tiers: { price_id: string; tier_id: string }[];
  hints: { id: string; username: string; tier: string; observed_at: string }[];
  role_cleanup?: {
    enabled: boolean;
    role_ids: string[];
    last_run: string | null;
    running: boolean;
    removed_roles: number;
    failed_members: number;
    readded_members: number;
    last_error: string | null;
    reports: {
      discord_user_id: string;
      status: 'removed' | 'failed' | 'readded' | 'skipped';
      removed_role_ids: string[];
      attempted_at: string;
      message: string;
    }[];
  };
}
interface CleanupRoleOptions {
  roles: { id: string; name: string; manageable: boolean }[];
  can_manage_roles: boolean;
}
export interface StripeSubscriptionReview {
  subscription_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  status: string;
  collection_method: 'charge_automatically' | 'send_invoice';
  pause_collection: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  prices: { id: string; product_id: string | null; name: string | null }[];
  proposed_discord_id: string | null;
  identity_source: string | null;
  linked_discord_id: string | null;
  linked_discord_username: string | null;
  tier_id: string | null;
}

export default function StripeIntegrationPanel({
  api,
  notify,
  demo,
  tiers,
  active = true,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
  tiers: MembershipTier[];
  active?: boolean;
}) {
  const [tab, setTab] = useState('connection');
  const [status, setStatus] = useState<StripeIntegrationStatus | null>(null);
  const [subscriptions, setSubscriptions] = useState<StripeSubscriptionReview[]>([]);
  const [loadedRows, setLoadedRows] = useState(false);
  const [rowsRevision, setRowsRevision] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [roleCleanupEnabled, setRoleCleanupEnabled] = useState(false);
  const [cleanupRoleIds, setCleanupRoleIds] = useState<string[]>([]);
  const [cleanupRoles, setCleanupRoles] = useState<CleanupRoleOptions | null>(null);
  const [cleanupRolesBusy, setCleanupRolesBusy] = useState(false);
  const [cleanupRolesError, setCleanupRolesError] = useState(false);
  const [cleanupRolesRefresh, setCleanupRolesRefresh] = useState(0);
  const [cleanupRoleQuery, setCleanupRoleQuery] = useState('');
  const [priceTiers, setPriceTiers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('unlinked');
  const [review, setReview] = useState<StripeSubscriptionReview | null>(null);
  const [mediaReview, setMediaReview] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [identityResult, setIdentityResult] = useState<IdentityReviewApplyResult | null>(null);
  const [identityRoleRefresh, setIdentityRoleRefresh] = useState(0);
  useIdentityRolePolling(
    api,
    notify,
    active,
    demo,
    identityResult,
    setIdentityResult,
    identityRoleRefresh,
  );
  const [reviewRevision, setReviewRevision] = useState('');
  const [disconnectRevision, setDisconnectRevision] = useState<string | null>(null);
  const [member, setMember] = useState<DiscordMember | null>(null);
  const key = useRef<HTMLInputElement | null>(null);
  const initialized = useRef(false);
  const cleanupRolesNotify = useRef(false);
  const configDirty = useRef(false);
  const draftRevision = useRef('');
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const changing = useRef(false);
  const version = useRef(0);
  const reviewEpoch = useRef(0);
  const currentReview = useRef({ customer: '', revision: '', statusRevision: '', active: false });
  currentReview.current = {
    customer: review?.customer_id || '',
    revision: reviewRevision,
    statusRevision: status?.revision || '',
    active: active && tab === 'review',
  };

  const acceptStatus = useCallback((value: StripeIntegrationStatus) => {
    setStatus(value);
    if (!initialized.current || !configDirty.current) {
      initialized.current = true;
      draftRevision.current = value.revision;
      setSyncEnabled(value.sync_enabled);
      setAutomationEnabled(value.automation_enabled === true);
      setRoleCleanupEnabled(value.role_cleanup?.enabled === true);
      setCleanupRoleIds([...new Set(value.role_cleanup?.role_ids || [])]);
      setPriceTiers(
        Object.fromEntries(value.price_tiers.map((item) => [item.price_id, item.tier_id])),
      );
    }
  }, []);

  const read = useCallback(
    async (manual = false, rows = false) => {
      if (changing.current || demo) return;
      if (manual) setIdentityRoleRefresh((value) => value + 1);
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const current = ++version.current;
      setBusy('load');
      setError('');
      try {
        const [value, list] = await Promise.all([
          api<StripeIntegrationStatus>('/api/stripe/status', { signal: abort.signal }),
          rows
            ? api<{ revision: string; subscriptions: StripeSubscriptionReview[] }>(
                '/api/stripe/subscriptions',
                {
                  signal: abort.signal,
                },
              )
            : Promise.resolve(null),
        ]);
        if (!mounted.current || abort.signal.aborted || current !== version.current) return;
        acceptStatus(value);
        if (list) {
          setSubscriptions(list.subscriptions);
          setRowsRevision(list.revision);
          setLoadedRows(true);
        }
        if (manual) notify('Stripe status refreshed.');
      } catch {
        if (!mounted.current || abort.signal.aborted || current !== version.current) return;
        const detail = 'Stripe data could not be loaded. Refresh to retry.';
        setError(detail);
        if (manual) notify(detail, true);
      } finally {
        if (mounted.current && !abort.signal.aborted && current === version.current) setBusy('');
      }
    },
    [api, notify, demo, acceptStatus],
  );

  useEffect(() => {
    if (!active || demo) return;
    mounted.current = true;
    void read();
    const field = key.current;
    return () => {
      mounted.current = false;
      reviewEpoch.current++;
      version.current++;
      controller.current?.abort();
      changing.current = false;
      if (field) field.value = '';
      if (key.current) key.current.value = '';
    };
  }, [active, demo, read]);

  useEffect(() => {
    if (active && !demo && tab === 'review' && !loadedRows && status?.configured && !status.running)
      void read(false, true);
  }, [active, demo, tab, status?.revision, status?.running, read]);

  useEffect(() => {
    if (!active || demo || tab !== 'cleanup' || !status?.configured) return;
    const abort = new AbortController();
    const manual = cleanupRolesNotify.current;
    cleanupRolesNotify.current = false;
    setCleanupRoles(null);
    setCleanupRolesError(false);
    setCleanupRolesBusy(true);
    void api<CleanupRoleOptions>('/api/stripe/cleanup-roles', { signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return;
        setCleanupRoles(value);
        if (manual) notify('Discord roles refreshed.');
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setCleanupRolesError(true);
        if (manual)
          notify('Discord roles could not be loaded. Check the bot connection and retry.', true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setCleanupRolesBusy(false);
      });
    return () => abort.abort();
  }, [api, notify, active, demo, tab, status?.configured, status?.revision, cleanupRolesRefresh]);

  useEffect(() => {
    if (!active || demo || !(status?.running || status?.role_cleanup?.running) || busy) return;
    const timer = setTimeout(() => void read(false, tab === 'review'), 2500);
    return () => clearTimeout(timer);
  }, [active, demo, status?.running, status?.role_cleanup?.running, busy, read, tab]);

  async function mutate(
    kind: string,
    path: string,
    body: Record<string, unknown>,
    message: string,
    method: 'POST' | 'DELETE' = 'POST',
  ) {
    if (!active || demo || changing.current || busy || !status) return;
    changing.current = true;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++version.current;
    setBusy(kind);
    setError('');
    try {
      const value = await api<StripeIntegrationStatus>(path, {
        method,
        body,
        signal: abort.signal,
      });
      if (!mounted.current || abort.signal.aborted || current !== version.current) return;
      if (kind === 'save' || kind === 'disconnect') configDirty.current = false;
      acceptStatus(value);
      if ((kind === 'save' && body.api_key) || kind === 'disconnect') {
        setSubscriptions([]);
        setRowsRevision('');
      }
      if (kind === 'disconnect') {
        if (key.current) key.current.value = '';
        setDisconnectRevision(null);
        setReview(null);
        setMember(null);
        setCleanupRoles(null);
        setCleanupRolesError(false);
        setCleanupRolesBusy(false);
      }
      setLoadedRows(false);
      if (kind === 'link' || kind === 'unlink') {
        setReview(null);
        setMember(null);
      }
      notify(message);
    } catch {
      if (!mounted.current || abort.signal.aborted || current !== version.current) return;
      const detail =
        kind === 'save'
          ? 'Stripe settings could not be saved. Refresh to check the saved configuration, then re-enter the key if needed.'
          : 'The Stripe action could not be completed. Refresh the latest data before retrying.';
      setError(detail);
      notify(detail, true);
    } finally {
      if (current === version.current) {
        changing.current = false;
        if (mounted.current && !abort.signal.aborted) setBusy('');
      }
    }
  }

  async function resolveCandidate() {
    if (
      !active ||
      tab !== 'review' ||
      demo ||
      changing.current ||
      busy ||
      !review?.proposed_discord_id ||
      !status ||
      status.running ||
      status.revision !== reviewRevision
    )
      return;
    changing.current = true;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++version.current;
    const epoch = reviewEpoch.current;
    const customer = review.customer_id;
    const revision = reviewRevision;
    const proposedId = review.proposed_discord_id;
    const stillCurrent = () =>
      mounted.current &&
      !abort.signal.aborted &&
      current === version.current &&
      epoch === reviewEpoch.current &&
      currentReview.current.active &&
      currentReview.current.customer === customer &&
      currentReview.current.revision === revision &&
      currentReview.current.statusRevision === revision;
    setBusy('resolve');
    setError('');
    try {
      const result = await api<{ member: DiscordMember }>('/api/stripe/resolve-candidate', {
        method: 'POST',
        body: { customer_id: customer, expected_revision: revision },
        signal: abort.signal,
      });
      if (!stillCurrent()) return;
      if (result.member.id !== proposedId || !result.member.username)
        throw new Error('Unexpected candidate.');
      setMember(result.member);
      notify('Suggested Discord member found. Confirm ownership before approving the link.');
    } catch {
      if (!stillCurrent()) return;
      const detail =
        'The suggested Discord member could not be resolved. Search the server members below or refresh this review.';
      setError(detail);
      notify(detail, true);
    } finally {
      if (current === version.current) {
        changing.current = false;
        if (mounted.current && !abort.signal.aborted) setBusy('');
      }
    }
  }

  function save(event: FormEvent, cleanup = false) {
    event.preventDefault();
    if (!status || busy || changing.current) return;
    const apiKey = key.current?.value.trim();
    if (key.current) key.current.value = '';
    if (!status.configured && !apiKey) {
      setError('Enter a restricted Stripe key before saving.');
      return;
    }
    if (apiKey && !/^rk_(live|test)_\S+$/.test(apiKey)) {
      setError('Use a restricted Stripe key beginning with rk_live_ or rk_test_.');
      return;
    }
    if (
      roleCleanupEnabled &&
      (!syncEnabled ||
        status.mode !== 'live' ||
        !status.last_sync ||
        cleanupRoleIds.length === 0 ||
        (cleanup &&
          (!cleanupRoles?.can_manage_roles ||
            cleanupRoleIds.some(
              (id) => !cleanupRoles.roles.some((role) => role.id === id && role.manageable),
            ))))
    ) {
      const detail =
        'Role cleanup needs a synced live Stripe key, periodic billing refresh, and at least one removable subscriber role. Check the Role cleanup tab.';
      setError(detail);
      notify(detail, true);
      return;
    }
    void mutate(
      'save',
      '/api/stripe/config',
      {
        ...(apiKey ? { api_key: apiKey } : {}),
        sync_enabled: syncEnabled,
        automation_enabled: automationEnabled,
        role_cleanup_enabled: roleCleanupEnabled,
        role_cleanup_role_ids: cleanupRoleIds,
        expected_revision: draftRevision.current,
        price_tiers: Object.entries(priceTiers)
          .filter(([, tier]) => tier)
          .map(([price_id, tier_id]) => ({ price_id, tier_id })),
      },
      cleanup
        ? 'Subscriber role cleanup settings saved.'
        : automationEnabled
          ? 'Stripe membership automation settings saved. Existing subscribers remain protected by the activation baseline.'
          : 'Stripe settings saved. Account changes remain under review.',
    );
  }

  const prices = useMemo(() => {
    const values = new Map<string, string>();
    for (const row of subscriptions)
      for (const price of row.prices) values.set(price.id, price.name || price.id);
    for (const id of Object.keys(priceTiers)) if (!values.has(id)) values.set(id, id);
    return [...values];
  }, [subscriptions, priceTiers]);
  const filtered = subscriptions.filter((row) => {
    if (scope === 'unlinked' && row.linked_discord_id) return false;
    if (scope === 'linked' && !row.linked_discord_id) return false;
    const term = query.trim().toLowerCase();
    return [
      row.customer_name,
      row.customer_email,
      row.customer_id,
      row.subscription_id,
      row.linked_discord_username,
      ...row.prices.map((price) => price.name),
    ].some((value) => value?.toLowerCase().includes(term));
  });
  const pagination = usePagination(filtered, 5, `${scope}:${query}`);
  const cleanupPagination = usePagination(status?.role_cleanup?.reports || [], 5);
  const selectedCleanupRoles = cleanupRoleIds.map((id) => ({
    id,
    name: cleanupRoles?.roles.find((role) => role.id === id)?.name || `Unavailable role (${id})`,
    manageable: cleanupRoles?.roles.some((role) => role.id === id && role.manageable) || false,
  }));
  const availableCleanupRoles = cleanupRoles
    ? [
        ...cleanupRoles.roles,
        ...selectedCleanupRoles.filter(
          (selected) => !cleanupRoles.roles.some((role) => role.id === selected.id),
        ),
      ]
    : [];
  const cleanupRolePagination = usePagination(
    availableCleanupRoles.filter((role) =>
      role.name.toLowerCase().includes(cleanupRoleQuery.trim().toLowerCase()),
    ),
    10,
    cleanupRoleQuery,
  );
  const suggested = status?.hints.find((hint) => hint.id === review?.proposed_discord_id);

  return (
    <div className="settings-group" aria-label="Stripe billing integration">
      <Callout
        title={
          status?.automation_enabled
            ? 'Verified billing management'
            : status?.role_cleanup?.enabled
              ? 'Verified subscriber role cleanup'
              : 'Billing review only'
        }
        icon="info"
      >
        {status?.role_cleanup?.enabled && !status.automation_enabled
          ? 'Stripe subscription verification can remove only your selected subscriber roles. MEE6 continues initial role assignment and its normal cancellation cleanup. Media account automation remains separate.'
          : status?.automation_enabled
            ? 'Stripe access remains read-only. Verified paid periods can drive the Jellyport account actions you enabled; uncertain billing preserves existing access. Family and complimentary access remain admin-managed.'
            : 'Stripe reads subscription status. Syncing and approving identity links do not create, disable, or change media accounts. Family and complimentary access remain admin-managed.'}
      </Callout>
      {demo && <p className="section-note">Stripe connections are unavailable in the demo.</p>}
      <IdentityReviewResult result={identityResult} />
      <Tabs
        id="settings-stripe"
        label="Stripe integration sections"
        tabs={[
          { id: 'connection', label: 'Connection' },
          { id: 'review', label: 'Review links' },
          { id: 'cleanup', label: 'Role cleanup' },
          { id: 'mee6', label: 'MEE6 identity hints' },
        ]}
        value={tab}
        onChange={(value) => {
          if (value !== tab) reviewEpoch.current++;
          if (key.current) key.current.value = '';
          setTab(value);
        }}
      />
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Stripe subscriptions</h2>
            <p>
              {status
                ? status.configured
                  ? `${status.mode === 'test' ? 'Test' : 'Live'} restricted key saved`
                  : 'Not connected'
                : 'Connect billing to Discord identities.'}
            </p>
          </div>
          <button
            className="btn btn-small btn-quiet"
            type="button"
            disabled={demo || !!busy}
            onClick={() => void read(true, tab === 'review')}
          >
            <Icon name="refresh" /> Refresh status
          </button>
        </div>
        <div className="panel-body form-stack">
          {error && !(review && active && tab === 'review') && (
            <p className="error-block" role="alert">
              {error}
            </p>
          )}
          {!status && !error && !demo && <p role="status">Loading Stripe connection…</p>}
          {status && (
            <>
              <div className="job-meta">
                <span>{num(status.subscription_count)} subscriptions</span>
                <span>{num(status.linked_customer_count)} customers linked</span>
                <span>
                  Last successful sync: {status.last_sync ? date(status.last_sync) : 'Not run yet'}
                </span>
              </div>
              {status.running && (
                <p role="status">
                  <span className="spinner" /> Reading Stripe subscriptions…
                </p>
              )}
              {status.last_error && (
                <p className="error-block" role="alert">
                  The last Stripe sync could not finish. Check the restricted key permissions and
                  retry.
                </p>
              )}
              {status.automation_enabled && (
                <Callout title="Verified Stripe membership automation enabled">
                  Only approved Discord identities and mapped prices can drive access actions. New
                  account creation and disabling also require the corresponding Jellyport automation
                  switches. Existing Emby users remain opt-in.
                  {status.automation_enabled_at && (
                    <p>Activation baseline: {date(status.automation_enabled_at)}</p>
                  )}
                </Callout>
              )}
              {status.automation_error && (
                <p className="error-block" role="alert">
                  {status.automation_error}
                </p>
              )}
              {!!status.automation_review_count && (
                <p className="section-note">
                  {num(status.automation_review_count)} billing actions require review under
                  Memberships → Events. Uncertain account creation is never retried automatically.
                </p>
              )}
              <button
                className="btn btn-primary"
                type="button"
                disabled={demo || !!busy || !status.configured || status.running}
                onClick={() =>
                  void mutate(
                    'sync',
                    '/api/stripe/sync',
                    {},
                    status.role_cleanup?.enabled
                      ? 'Stripe sync started. Expired subscriber roles will be checked under your saved cleanup policy.'
                      : status.automation_enabled
                        ? 'Stripe sync started. Verified billing actions follow your saved automation policy.'
                        : 'Stripe sync started. No media accounts will be changed.',
                  )
                }
              >
                {busy === 'sync' ? 'Starting sync…' : 'Test & sync Stripe'}
              </button>
            </>
          )}
        </div>
      </section>
      <TabPanel id="settings-stripe" tabId="connection" active={tab === 'connection'}>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>Restricted key & sync</h3>
              <p>Saves separately from other Jellyport settings.</p>
            </div>
          </div>
          <div className="panel-body form-stack">
            <details className="help-disclosure">
              <summary>Exact Stripe key permissions</summary>
              <div className="support-note">
                <p>
                  Create a restricted key in Stripe → Developers → API keys. Choose Read for
                  Customers, Products, Prices, Subscriptions, and Checkout Sessions. Leave every
                  other permission at None. For membership automation, also enable Read for
                  Invoices. Role cleanup also requires Invoices Read. No write permissions are
                  needed.
                </p>
                <p>
                  Use a live key to inspect live subscriptions, including MEE6 subscriptions. Enter
                  it only in the field below; Jellyport never returns the saved key. A blank field
                  keeps the saved key.
                </p>
              </div>
            </details>
            <form
              className="form-stack"
              onSubmit={save}
              aria-label="Stripe connection"
              autoComplete="off"
            >
              <div className="field">
                <label htmlFor="stripe-restricted-key">
                  Restricted Stripe API key{' '}
                  {status?.configured && <span className="optional mint">saved</span>}
                </label>
                <input
                  ref={key}
                  id="stripe-restricted-key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={() => {
                    configDirty.current = true;
                  }}
                  placeholder={status?.configured ? 'Saved · leave blank to keep' : 'rk_live_…'}
                  disabled={demo || !!busy || status?.running || !status}
                />
                <small>
                  Stored encrypted on the Jellyport server. The field is cleared after submission or
                  navigation.
                </small>
                {status?.configured && (
                  <small>
                    Replacing the key clears cached billing data and approved customer links; sync
                    and review them again.
                  </small>
                )}
              </div>
              <div className="toggle-row">
                <div>
                  <label htmlFor="stripe-sync-enabled" className="switch-label">
                    Refresh billing every 15 minutes
                  </label>
                  <p className="muted text-tiny mt-4">
                    Reads billing data. Media account changes require verified membership automation
                    and the separate account-action switches. Subscriber role cleanup has its own
                    opt-in policy.
                  </p>
                </div>
                <label className="toggle">
                  <input
                    id="stripe-sync-enabled"
                    type="checkbox"
                    checked={syncEnabled}
                    onChange={(event) => {
                      configDirty.current = true;
                      setSyncEnabled(event.target.checked);
                      if (!event.target.checked) setRoleCleanupEnabled(false);
                    }}
                    disabled={demo || !!busy || status?.running || !status}
                  />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
              </div>
              <div className="toggle-row">
                <div>
                  <label htmlFor="stripe-automation-enabled" className="switch-label">
                    Use verified Stripe billing for membership automation
                  </label>
                  <p className="muted text-tiny mt-4">
                    First select Stripe as the subscription source in Settings → Automation →
                    Membership automation, save and sync a live key, map prices, and approve
                    customer identities. Enabling captures the existing subscriber baseline; it
                    never bulk creates accounts. MEE6 messages and roles are optional.
                  </p>
                </div>
                <label className="toggle">
                  <input
                    id="stripe-automation-enabled"
                    type="checkbox"
                    checked={automationEnabled}
                    onChange={(event) => {
                      configDirty.current = true;
                      setAutomationEnabled(event.target.checked);
                    }}
                    disabled={
                      demo ||
                      !!busy ||
                      status?.running ||
                      !status ||
                      !status.configured ||
                      status.mode !== 'live' ||
                      !status.last_sync
                    }
                  />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
              </div>
              {prices.length > 0 && (
                <details className="help-disclosure">
                  <summary>Map Stripe prices to membership tiers</summary>
                  <div className="form-stack">
                    {prices.map(([id, name]) => (
                      <div className="field" key={id}>
                        <label htmlFor={`stripe-price-${id}`}>{name}</label>
                        <small className="text-break">{id}</small>
                        <select
                          id={`stripe-price-${id}`}
                          value={priceTiers[id] || ''}
                          disabled={demo || !!busy || status?.running}
                          onChange={(event) => {
                            configDirty.current = true;
                            setPriceTiers((current) => ({ ...current, [id]: event.target.value }));
                          }}
                        >
                          <option value="">Not assigned</option>
                          {tiers.map((tier) => (
                            <option key={tier.id} value={tier.id}>
                              {tier.name} · {tier.account_limit}{' '}
                              {tier.account_limit === 1 ? 'account' : 'accounts'}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className="button-row">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={demo || !!busy || status?.running || !status}
                >
                  {busy === 'save' ? 'Saving…' : 'Save Stripe settings'}
                </button>
                {status?.configured && (
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={demo || !!busy}
                    onClick={() => setDisconnectRevision(status.revision)}
                  >
                    Disconnect Stripe…
                  </button>
                )}
                {status && configDirty.current && draftRevision.current !== status.revision && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={!!busy}
                    onClick={() => {
                      configDirty.current = false;
                      if (key.current) key.current.value = '';
                      acceptStatus(status);
                      setError('');
                    }}
                  >
                    Reset draft to saved Stripe settings
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      </TabPanel>
      <TabPanel id="settings-stripe" tabId="cleanup" active={tab === 'cleanup'}>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>Subscriber role cleanup</h3>
              <p>A Stripe-backed safety net for roles left behind after paid access expires.</p>
            </div>
          </div>
          <div className="panel-body form-stack">
            <Callout title="Keep MEE6 role assignment enabled" icon="info">
              MEE6 continues granting roles and its normal cancellation cleanup. Jellyport only
              removes the subscriber or tier roles you select after verifying that linked paid
              access has expired. It never adds roles. A late invoice payment alone does not restore
              a canceled subscription.
            </Callout>
            <p className="section-note">
              Family accounts, complimentary access, and approved access exceptions stay
              admin-managed. This policy does not require a Jellyfin account or enable media account
              automation. Select Stripe as the subscription source in Settings → Automation, and
              enable Invoices Read on the restricted Stripe key. Incomplete or uncertain billing
              verification preserves roles for review.
            </p>
            <form
              className="form-stack"
              aria-label="Subscriber role cleanup"
              onSubmit={(event) => save(event, true)}
            >
              <div className="toggle-row">
                <div>
                  <label htmlFor="stripe-cleanup-sync" className="switch-label">
                    Refresh billing every 15 minutes for cleanup
                  </label>
                  <p className="muted text-tiny mt-4">
                    Uses the same periodic billing refresh as the Connection tab.
                  </p>
                </div>
                <label className="toggle">
                  <input
                    id="stripe-cleanup-sync"
                    type="checkbox"
                    checked={syncEnabled}
                    onChange={(event) => {
                      configDirty.current = true;
                      setSyncEnabled(event.target.checked);
                      if (!event.target.checked) setRoleCleanupEnabled(false);
                    }}
                    disabled={demo || !!busy || status?.running || !status}
                  />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
              </div>
              <div className="toggle-row">
                <div>
                  <label htmlFor="stripe-role-cleanup-enabled" className="switch-label">
                    Remove expired subscriber roles automatically
                  </label>
                  <p className="muted text-tiny mt-4">
                    Disabled by default. Requires a synced live key, periodic billing refresh, and a
                    bot allowed to manage the selected roles.
                  </p>
                </div>
                <label className="toggle">
                  <input
                    id="stripe-role-cleanup-enabled"
                    type="checkbox"
                    checked={roleCleanupEnabled}
                    onChange={(event) => {
                      configDirty.current = true;
                      setRoleCleanupEnabled(event.target.checked);
                    }}
                    disabled={
                      demo ||
                      !!busy ||
                      status?.running ||
                      !status ||
                      (!roleCleanupEnabled &&
                        (!status.configured ||
                          status.mode !== 'live' ||
                          !status.last_sync ||
                          !syncEnabled ||
                          !cleanupRoles?.can_manage_roles))
                    }
                  />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
              </div>
              {!status?.configured && (
                <p className="section-note">Connect Stripe and complete a live sync first.</p>
              )}
              {cleanupRolesBusy && <p role="status">Loading Discord subscriber roles…</p>}
              {cleanupRolesError && (
                <p className="error-block" role="alert">
                  Discord roles could not be loaded. Check the bot connection and retry. No selected
                  roles have been changed.
                </p>
              )}
              {cleanupRoles && !cleanupRoles.can_manage_roles && (
                <p className="error-block" role="alert">
                  The bot cannot manage Discord roles. Grant Manage Roles and place its role above
                  the subscriber roles before enabling cleanup.
                </p>
              )}
              {cleanupRoles && (
                <>
                  <div className="field">
                    <label htmlFor="stripe-cleanup-role-search">Find subscriber roles</label>
                    <input
                      id="stripe-cleanup-role-search"
                      type="search"
                      value={cleanupRoleQuery}
                      onChange={(event) => setCleanupRoleQuery(event.target.value)}
                      placeholder="Search Discord role names"
                    />
                    <small>
                      {cleanupRoleIds.length} of 20 selected. Choose only paid subscriber and tier
                      roles. Administrator, managed, protected, and bot-inaccessible roles cannot be
                      selected.
                    </small>
                  </div>
                  <div className="record-list" role="group" aria-label="Subscriber roles">
                    {cleanupRolePagination.items.map((role) => {
                      const selected = cleanupRoleIds.includes(role.id);
                      return (
                        <label className="check-label inline-panel" key={role.id}>
                          <input
                            type="checkbox"
                            className="checkbox"
                            checked={selected}
                            disabled={
                              demo ||
                              !!busy ||
                              status?.running ||
                              (!selected &&
                                (!cleanupRoles.can_manage_roles ||
                                  !role.manageable ||
                                  cleanupRoleIds.length >= 20))
                            }
                            onChange={(event) => {
                              configDirty.current = true;
                              setCleanupRoleIds((current) =>
                                event.target.checked
                                  ? [...new Set([...current, role.id])].slice(0, 20)
                                  : current.filter((id) => id !== role.id),
                              );
                            }}
                          />
                          <span className="text-break">
                            {role.name}
                            {!role.manageable && (
                              <small className="muted"> · Unavailable for subscriber cleanup</small>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {cleanupRolePagination.total === 0 && (
                      <p className="section-note">No roles match this view.</p>
                    )}
                  </div>
                  <Pagination
                    label="Subscriber roles"
                    page={cleanupRolePagination.page}
                    total={cleanupRolePagination.total}
                    pageSize={cleanupRolePagination.pageSize}
                    onPageChange={cleanupRolePagination.setPage}
                    onPageSizeChange={cleanupRolePagination.setPageSize}
                  />
                </>
              )}
              {cleanupRoleIds.length > 0 &&
                cleanupRoles &&
                selectedCleanupRoles.some((role) => !role.manageable) && (
                  <p className="error-block" role="alert">
                    A selected role is unavailable or protected. Deselect it before enabling
                    cleanup, or disable this policy to save the configuration.
                  </p>
                )}
              <div className="button-row">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={demo || !!busy || !status || status.running || cleanupRolesBusy}
                >
                  {busy === 'save' ? 'Saving…' : 'Save role cleanup'}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={demo || !!busy || cleanupRolesBusy || !status?.configured}
                  onClick={() => {
                    cleanupRolesNotify.current = true;
                    setCleanupRolesRefresh((value) => value + 1);
                    notify('Refreshing Discord roles…');
                  }}
                >
                  <Icon name="refresh" /> Refresh Discord roles
                </button>
                {status && configDirty.current && draftRevision.current !== status.revision && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={!!busy}
                    onClick={() => {
                      configDirty.current = false;
                      acceptStatus(status);
                      setError('');
                    }}
                  >
                    Reset draft to saved Stripe settings
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
        {status?.role_cleanup && (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h3>Role cleanup results</h3>
                <p>
                  {status.role_cleanup.running
                    ? 'Checking expired subscriber roles…'
                    : status.role_cleanup.last_run
                      ? `Last check: ${date(status.role_cleanup.last_run)}`
                      : 'No role cleanup check has run yet.'}
                </p>
              </div>
            </div>
            <div className="panel-body form-stack">
              <div className="job-meta">
                <span>
                  {num(status.role_cleanup.removed_roles)}{' '}
                  {status.role_cleanup.removed_roles === 1 ? 'role' : 'roles'} removed
                </span>
                <span>
                  {num(status.role_cleanup.failed_members)}{' '}
                  {status.role_cleanup.failed_members === 1 ? 'member' : 'members'} with failed
                  removals
                </span>
                <span>
                  {num(status.role_cleanup.readded_members)}{' '}
                  {status.role_cleanup.readded_members === 1 ? 'member' : 'members'} with re-added
                  roles
                </span>
              </div>
              {status.role_cleanup.last_error && (
                <p className="error-block" role="alert">
                  The last cleanup check could not complete. Check the bot permissions and live
                  Stripe key’s Invoices Read permission. Paused members need explicit approval to
                  retry; follow the retry instructions below.
                </p>
              )}
              {status.role_cleanup.readded_members > 0 && (
                <Callout title="Removed subscriber roles were re-added" icon="info">
                  Review the affected members and other bots’ role rules. These members are paused
                  for review. Jellyport never grants these roles, and a paid old invoice does not
                  reactivate a canceled subscription.
                </Callout>
              )}
              <details className="help-disclosure">
                <summary>Retry paused cleanup members</summary>
                <div className="support-note">
                  <p>
                    Jellyport pauses a member after three failed removals or when a removed role is
                    added again. Fix the bot permissions or competing role rules first.
                  </p>
                  <p>
                    To approve another attempt, disable role cleanup and save, then re-enable it and
                    save. Run Test &amp; sync Stripe afterward to verify billing again. Refreshing
                    billing alone keeps paused members held for review.
                  </p>
                </div>
              </details>
              <div className="record-list">
                {cleanupPagination.items.map((report, index) => (
                  <article
                    className="summary-card"
                    key={`${report.discord_user_id}:${report.attempted_at}:${index}`}
                  >
                    <div className="text-break">
                      <h4>
                        {report.status === 'removed'
                          ? 'Subscriber roles removed'
                          : report.status === 'readded'
                            ? 'Subscriber roles re-added'
                            : report.status === 'failed'
                              ? 'Role removal needs attention'
                              : 'Roles preserved'}
                      </h4>
                      <p className="text-small">{report.message}</p>
                      <p className="muted text-small">
                        Discord member {report.discord_user_id} · {date(report.attempted_at)}
                      </p>
                      {report.removed_role_ids.length > 0 && (
                        <p className="text-small">
                          Removed:{' '}
                          {report.removed_role_ids
                            .map(
                              (id) =>
                                cleanupRoles?.roles.find((role) => role.id === id)?.name || id,
                            )
                            .join(', ')}
                        </p>
                      )}
                    </div>
                  </article>
                ))}
                {cleanupPagination.total === 0 && (
                  <p className="section-note">No role cleanup reports yet.</p>
                )}
              </div>
              <Pagination
                label="Role cleanup reports"
                page={cleanupPagination.page}
                total={cleanupPagination.total}
                pageSize={cleanupPagination.pageSize}
                onPageChange={cleanupPagination.setPage}
                onPageSizeChange={cleanupPagination.setPageSize}
              />
            </div>
          </section>
        )}
      </TabPanel>
      <TabPanel id="settings-stripe" tabId="review" active={tab === 'review'}>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>Review customer links</h3>
              <p>
                Approve each Stripe customer’s Discord identity once. Email and usernames are hints,
                never automatic ownership proof.
              </p>
            </div>
          </div>
          <div className="panel-body form-stack">
            <div className="field-row">
              <div className="field">
                <label htmlFor="stripe-customer-search">Search subscriptions</label>
                <input
                  id="stripe-customer-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Name, email, Discord username, or customer ID"
                />
              </div>
              <div className="field">
                <label htmlFor="stripe-link-filter">Identity links</label>
                <select
                  id="stripe-link-filter"
                  value={scope}
                  onChange={(event) => setScope(event.target.value)}
                >
                  <option value="unlinked">Needs a link</option>
                  <option value="linked">Linked</option>
                  <option value="all">All subscriptions</option>
                </select>
              </div>
            </div>
            {!loadedRows ? (
              <p role="status">
                {status?.configured
                  ? 'Loading subscriptions…'
                  : 'Save a restricted key and run a sync first.'}
              </p>
            ) : pagination.items.length === 0 ? (
              <p className="section-note">No subscriptions match this view.</p>
            ) : (
              <div className="record-list">
                {pagination.items.map((row) => (
                  <article className="summary-card" key={row.subscription_id}>
                    <div>
                      <h4>
                        {row.customer_name || row.customer_email || 'Unnamed Stripe customer'}
                      </h4>
                      {row.customer_name && row.customer_email && (
                        <p className="muted text-small">{row.customer_email}</p>
                      )}
                      <p className="text-small">
                        {row.prices.map((price) => price.name || 'Unnamed plan').join(', ') ||
                          'No plan label'}{' '}
                        · <strong>{row.status}</strong>
                        {row.cancel_at_period_end ? ' · Cancels at period end' : ''}
                        {row.pause_collection ? ' · Payment collection paused' : ''}
                        {row.collection_method === 'send_invoice' ? ' · Invoice billing' : ''}
                      </p>
                      <p className="text-small">
                        {row.linked_discord_id ? (
                          <>
                            Linked:{' '}
                            <strong>
                              {row.linked_discord_username
                                ? `@${row.linked_discord_username}`
                                : 'Discord identity approved'}
                            </strong>
                          </>
                        ) : row.proposed_discord_id ? (
                          'Discord candidate available'
                        ) : (
                          'Needs Discord link'
                        )}
                      </p>
                    </div>
                    <div className="toolbar">
                      <button
                        className="btn"
                        type="button"
                        disabled={demo || !!busy || status?.running || !rowsRevision}
                        onClick={() => {
                          reviewEpoch.current++;
                          setError('');
                          setReview(row);
                          setReviewRevision(rowsRevision);
                          setMediaReview(false);
                          setIdentityResult(null);
                          setMember(
                            row.linked_discord_id && row.linked_discord_username
                              ? {
                                  id: row.linked_discord_id,
                                  username: row.linked_discord_username,
                                  display_name: null,
                                  nickname: null,
                                  membership_active: null,
                                }
                              : null,
                          );
                        }}
                      >
                        {row.linked_discord_id ? 'Review or change link' : 'Review Discord link'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {loadedRows && (
              <Pagination
                label="Stripe subscriptions"
                page={pagination.page}
                total={pagination.total}
                pageSize={pagination.pageSize}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
              />
            )}
          </div>
        </section>
        {review && active && tab === 'review' && (
          <Modal
            title={mediaReview ? 'Confirm Stripe & media accounts' : 'Approve Discord identity'}
            description={review.customer_name || review.customer_email || review.customer_id}
            close={() => {
              if (!busy && !mediaBusy) {
                reviewEpoch.current++;
                setReview(null);
                setMember(null);
              }
            }}
            closeDisabled={!!busy || mediaBusy}
            footer={
              mediaReview ? undefined : (
                <>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={
                      demo ||
                      !!busy ||
                      !member ||
                      status?.running ||
                      status?.revision !== reviewRevision
                    }
                    onClick={() => {
                      reviewEpoch.current++;
                      if (member && status) setMediaReview(true);
                    }}
                  >
                    Review media accounts
                  </button>
                  {review.linked_discord_id && (
                    <button
                      className="btn btn-danger"
                      type="button"
                      disabled={
                        demo || !!busy || status?.running || status?.revision !== reviewRevision
                      }
                      onClick={() => {
                        if (status)
                          void mutate(
                            'unlink',
                            `/api/stripe/links/${encodeURIComponent(review.customer_id)}`,
                            { expected_revision: reviewRevision },
                            'Stripe customer link removed.',
                            'DELETE',
                          );
                      }}
                    >
                      Remove approved link
                    </button>
                  )}
                  <button
                    className="btn btn-quiet"
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      reviewEpoch.current++;
                      setReview(null);
                      setMember(null);
                    }}
                  >
                    Cancel review
                  </button>
                </>
              )
            }
          >
            {mediaReview && member ? (
              <StripeIdentityAccountReview
                api={api}
                notify={notify}
                demo={demo}
                active={active && tab === 'review'}
                customerId={review.customer_id}
                member={member}
                onApplied={(result) => {
                  setIdentityResult(result);
                  reviewEpoch.current++;
                  setReview(null);
                  setMember(null);
                  setMediaReview(false);
                  setLoadedRows(false);
                  void read(false, true);
                }}
                onCancel={() => setMediaReview(false)}
                onBusyChange={setMediaBusy}
              />
            ) : (
              <div className="form-stack">
                {error && (
                  <p className="error-block" role="alert">
                    {error}
                  </p>
                )}
                {status?.revision !== reviewRevision && (
                  <p className="error-block" role="alert">
                    Billing data changed during this review. Cancel and reopen the customer review
                    before approving a link.
                  </p>
                )}
                <p className="section-note">
                  Confirm this Discord member owns Stripe customer {review.customer_id}. A matching
                  email, plan, or username alone does not establish ownership. Next, review their
                  existing Emby or Jellyfin accounts. Jellyfin is optional.
                </p>
                {review.current_period_end && (
                  <p className="text-small">
                    Current billing period ends: {date(review.current_period_end)}
                  </p>
                )}
                {review.proposed_discord_id && (
                  <p className="text-small">
                    Unconfirmed Discord candidate: <code>{review.proposed_discord_id}</code>
                    {review.identity_source ? ` (${review.identity_source})` : ''}
                  </p>
                )}
                {review.proposed_discord_id && (
                  <div className="form-stack">
                    <button
                      className="btn"
                      type="button"
                      aria-busy={busy === 'resolve'}
                      disabled={
                        demo || !!busy || status?.running || status?.revision !== reviewRevision
                      }
                      onClick={() => void resolveCandidate()}
                    >
                      {busy === 'resolve'
                        ? 'Finding Discord member…'
                        : 'Find suggested Discord member'}
                    </button>
                    <small>
                      Looks up the suggested account in your connected Discord server. Subscription
                      ownership remains unconfirmed until you approve the customer link.
                    </small>
                  </div>
                )}
                <DiscordMemberPicker
                  api={api}
                  value={member}
                  onChange={setMember}
                  suggestedQuery={suggested?.username || review.linked_discord_username || ''}
                  disabled={demo || !!busy || status?.running}
                  allowInactive
                />
                <details className="help-disclosure">
                  <summary>Stripe record identifiers</summary>
                  <div className="support-note">
                    <p>Customer: {review.customer_id}</p>
                    <p>Subscription: {review.subscription_id}</p>
                    {review.prices.map((price) => (
                      <p key={price.id}>
                        Price: {price.id}
                        {price.product_id ? ` · Product: ${price.product_id}` : ''}
                      </p>
                    ))}
                  </div>
                </details>
              </div>
            )}
          </Modal>
        )}
      </TabPanel>
      <TabPanel id="settings-stripe" tabId="mee6" active={tab === 'mee6'}>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>MEE6 identity announcements</h3>
              <p>Connect a durable Discord ID to a tier without relying on a display name.</p>
            </div>
          </div>
          <div className="panel-body form-stack">
            <p>
              Add a MEE6 “gains a role” automation for paid membership roles that sends this message
              to your private subscription channel:
            </p>
            <pre
              className="support-note"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {'JELLYPORT_IDENTITY_V1 discord={user.id}'}
            </pre>
            <p className="section-note">
              Confirm MEE6 expands the user ID variable before publishing. Jellyport resolves the
              current username from Discord. Configure the announcement channel and the actual
              announcing bot’s ID in Automation → Access rules.
            </p>
            <Callout title="MEE6 supplies an identity hint, not a Stripe customer ID." icon="info">
              A role announcement cannot identify a Stripe customer or prove payment by itself.
              Jellyport keeps these hints for reviewed customer links; Stripe remains the billing
              source. Removing a tier role during an upgrade does not establish a billing
              cancellation.
            </Callout>
            {status && (
              <p className="text-small">
                {num(status.hints.length)} trusted identity hints received.
              </p>
            )}
          </div>
        </section>
      </TabPanel>
      {disconnectRevision && active && (
        <Modal
          title="Disconnect Stripe?"
          description="Clear Jellyport’s saved billing connection and customer links."
          close={() => {
            if (!busy) setDisconnectRevision(null);
          }}
          closeDisabled={!!busy}
          footer={
            <>
              <button
                className="btn btn-quiet"
                type="button"
                disabled={!!busy}
                onClick={() => setDisconnectRevision(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                type="button"
                disabled={demo || !!busy || status?.revision !== disconnectRevision}
                onClick={() =>
                  void mutate(
                    'disconnect',
                    '/api/stripe/disconnect',
                    { expected_revision: disconnectRevision },
                    'Stripe disconnected. Saved billing data and identity links cleared.',
                  )
                }
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect and clear billing data'}
              </button>
            </>
          }
        >
          <p>
            This removes the saved API key, cached subscription data, approved customer links,
            identity hints, and price mappings from Jellyport. Automatic billing refresh stops.
          </p>
          <p>
            Stripe subscriptions and media accounts remain unchanged. Revoke the restricted key in
            Stripe as well if it will no longer be used.
          </p>
          {status?.revision !== disconnectRevision && (
            <p className="error-block" role="alert">
              Stripe data changed. Cancel and reopen this confirmation.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
