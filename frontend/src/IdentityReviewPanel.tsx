import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  IdentityAccount,
  IdentityApproval,
  IdentityException,
  IdentityGap,
  IdentityReviewApplyResult,
  IdentityReviewRow,
  IdentityReviewSnapshot,
} from '../../server/identity-review-types';
import { Callout, Icon, Loading, Modal } from './components';
import DiscordMemberPicker from './DiscordMemberPicker';
import { useClientLayout } from './client-layout';
import { Pagination, usePagination } from './ui-layout';
import { date, num, type Api, type DiscordMember, type Notify } from './types';

const gapNames: Record<IdentityGap, string> = {
  active_subscription_no_media: 'Active subscription · no enabled media account',
  active_subscription_no_discord: 'Active subscription · Discord not confirmed',
  media_without_active_subscription: 'Media access · no active subscription observed',
  discord_without_active_subscription: 'Discord member · no active subscription observed',
  discord_without_media: 'Discord member · no media account confirmed',
  unlinked_media: 'Media account · owner not confirmed',
  unlinked_billing: 'Stripe customer · Discord not confirmed',
  disabled_media: 'Media account disabled',
  media_without_discord: 'Media account · Discord member absent',
  identity_conflict: 'Conflicting identity links',
  billing_unknown: 'Billing status unavailable',
};
const exceptionNames: Record<IdentityException['kind'], string> = {
  non_media: 'Approved Discord access without media',
  complimentary: 'Approved family or complimentary arrangement',
  approved: 'Other approved exception',
};
const keyOf = (account: Pick<IdentityAccount, 'kind' | 'id'>) => `${account.kind}:${account.id}`;
const accountName = (account: IdentityAccount) =>
  `${account.kind === 'emby' ? 'Emby' : 'Jellyfin'} · ${account.name}`;
const memberValue = (row: IdentityReviewRow): DiscordMember | null =>
  row.member
    ? {
        id: row.member.id,
        username: row.member.username,
        display_name: row.member.display_name || null,
        nickname: row.member.nickname || null,
        membership_active: null,
      }
    : null;
function rowTitle(row: IdentityReviewRow) {
  return row.member
    ? `@${row.member.username}`
    : row.customers[0]?.name ||
        row.customers[0]?.email ||
        row.confirmed_accounts[0]?.name ||
        row.suggestions[0]?.account.name ||
        'Unlinked identity';
}
function slotOf(account: IdentityAccount, ownerUsername?: string): number {
  if (account.slot) return account.slot;
  if (ownerUsername && account.name.toLocaleLowerCase() === ownerUsername.toLocaleLowerCase())
    return 1;
  const suffix = Number(account.name.match(/_(\d+)$/)?.[1]);
  return suffix >= 1 && suffix <= 3 ? suffix : 1;
}
function suggestedApproval(row: IdentityReviewRow): IdentityApproval | null {
  if (!row.reliable || row.conflict || !row.member) return null;
  const accounts = row.suggestions
    .filter((item) => item.reliable)
    .map(({ account }) => ({
      kind: account.kind,
      id: account.id,
      slot: slotOf(account, row.member!.username),
    }));
  const occupied = new Map(
    row.confirmed_accounts.map((account) => [`${account.kind}:${slotOf(account)}`, account.id]),
  );
  if (
    accounts.some(
      (account) =>
        occupied.has(`${account.kind}:${account.slot}`) &&
        occupied.get(`${account.kind}:${account.slot}`) !== account.id,
    )
  )
    return null;
  if (
    accounts.length > 6 ||
    row.customers.length > 10 ||
    new Set(accounts.map((account) => `${account.kind}:${account.slot}`)).size !==
      accounts.length ||
    accounts.some((account) => account.slot < 1 || account.slot > 3)
  )
    return null;
  if (!accounts.length && !row.customers.some((item) => !item.linked_discord_id)) return null;
  return {
    row_id: row.id,
    discord_user_id: row.member.id,
    stripe_customer_ids: row.customers.map((item) => item.id),
    accounts,
  };
}
function resultMessage(result: IdentityReviewApplyResult) {
  if (result.roles.status === 'not_requested')
    return 'Review annotation saved; account access and Discord roles unchanged.';
  const base = `${num(result.approved)} ${result.approved === 1 ? 'identity' : 'identities'} approved.`;
  if (result.roles.status === 'updated') return `${base} Discord organization roles updated.`;
  if (result.roles.status === 'queued')
    return `${base} Discord organization roles are updating in the background.`;
  if (result.roles.status === 'not_configured')
    return `${base} Configure Discord organization roles to apply tags.`;
  return `${base} Discord role updates need attention. Check bot permissions and retry role synchronization.`;
}

/** Watching a durable job never repeats the approval or starts another role update. */
export function useIdentityRolePolling(
  api: Api,
  notify: Notify,
  active: boolean,
  demo: boolean,
  result: IdentityReviewApplyResult | null,
  onResult: (result: IdentityReviewApplyResult) => void,
  refreshVersion = 0,
) {
  const currentResult = useRef(result);
  currentResult.current = result;
  const taskId = result?.roles.status === 'queued' ? result.roles.task_id : undefined;
  useEffect(() => {
    if (!active || demo || !taskId) return;
    const abort = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const current = () =>
      !stopped &&
      !abort.signal.aborted &&
      currentResult.current?.roles.status === 'queued' &&
      currentResult.current.roles.task_id === taskId;
    const progressUnavailable = (message: string) => {
      if (!current()) return;
      stopped = true;
      const previous = currentResult.current!;
      onResult({ ...previous, roles: { ...previous.roles, message } });
      abort.abort();
    };
    const deadline = setTimeout(
      () =>
        progressUnavailable(
          'Role updates continue on the server. Refresh the directory later to check their status.',
        ),
      5 * 60_000,
    );
    async function poll() {
      if (!current()) return;
      try {
        const roles = await api<IdentityReviewApplyResult['roles']>(
          `/api/identity-review/roles/${encodeURIComponent(taskId!)}`,
          { signal: abort.signal },
        );
        if (!current()) return;
        if (
          roles.task_id !== taskId ||
          !['queued', 'updated', 'pending', 'failed'].includes(roles.status)
        )
          throw new Error('Unexpected role progress.');
        failures = 0;
        const next = { ...currentResult.current!, roles };
        onResult(next);
        if (roles.status !== 'queued') {
          stopped = true;
          clearTimeout(deadline);
          notify(resultMessage(next), roles.status === 'failed' || roles.status === 'pending');
          return;
        }
      } catch {
        if (!current()) return;
        failures++;
        if (failures >= 3) {
          clearTimeout(deadline);
          progressUnavailable(
            'Role progress could not be refreshed. The saved job continues on the server; refresh later to check it.',
          );
          notify(
            'Discord role progress could not be refreshed. The saved job will continue in the background.',
            true,
          );
          return;
        }
      }
      if (current()) timer = setTimeout(() => void poll(), failures ? 1500 * 2 ** failures : 1500);
    }
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      abort.abort();
    };
  }, [api, notify, active, demo, taskId, onResult, refreshVersion]);
}

function useIdentityReview(api: Api, notify: Notify, active: boolean, demo: boolean) {
  const [snapshot, setSnapshot] = useState<IdentityReviewSnapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<IdentityReviewApplyResult | null>(null);
  const [rolePollingVersion, setRolePollingVersion] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const changing = useRef(false);
  const mounted = useRef(false);
  useIdentityRolePolling(api, notify, active, demo, result, setResult, rolePollingVersion);
  const read = useCallback(
    async (fresh = false, manual = false) => {
      if (!active || demo || changing.current) return;
      if (manual) setRolePollingVersion((value) => value + 1);
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const current = ++generation.current;
      setBusy('load');
      setError('');
      try {
        const value = await api<IdentityReviewSnapshot>(
          fresh ? '/api/identity-review/refresh' : '/api/identity-review',
          { ...(fresh ? { method: 'POST', body: {} } : {}), signal: abort.signal },
        );
        if (!mounted.current || abort.signal.aborted || generation.current !== current) return;
        if (
          !Array.isArray(value.rows) ||
          !Array.isArray(value.accounts) ||
          !value.revision ||
          !value.summary ||
          !value.sources
        )
          throw new Error('Invalid directory response.');
        setSnapshot(value);
        if (manual) notify('Identity directory refreshed. No accounts or roles were changed.');
      } catch {
        if (!mounted.current || abort.signal.aborted || generation.current !== current) return;
        setSnapshot(null);
        const detail =
          'The identity directory could not be loaded. Check the connected sources and refresh.';
        setError(detail);
        if (manual) notify(detail, true);
      } finally {
        if (mounted.current && !abort.signal.aborted && generation.current === current) setBusy('');
      }
    },
    [active, demo, api, notify],
  );
  useEffect(() => {
    mounted.current = active;
    if (active && !demo) void read();
    return () => {
      mounted.current = false;
      generation.current++;
      controller.current?.abort();
      changing.current = false;
    };
  }, [active, demo, read]);
  const apply = async (selections: IdentityApproval[]) => {
    if (!active || demo || changing.current || busy || !snapshot) return null;
    changing.current = true;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current;
    setBusy('apply');
    setError('');
    setResult(null);
    try {
      const value = await api<IdentityReviewApplyResult>('/api/identity-review/apply', {
        method: 'POST',
        body: { revision: snapshot.revision, selections },
        signal: abort.signal,
      });
      if (!mounted.current || abort.signal.aborted || generation.current !== current) return null;
      setResult(value);
      // A reviewed revision is single-use. Require a new directory after any successful apply.
      setSnapshot(null);
      notify(
        resultMessage(value),
        value.roles.status === 'failed' || value.roles.status === 'pending',
      );
      return value;
    } catch {
      if (!mounted.current || abort.signal.aborted || generation.current !== current) return null;
      // The server may have saved links before the response was interrupted. Never replay them.
      setSnapshot(null);
      const detail =
        'Approval could not be confirmed. Refresh the directory and review the saved links before retrying.';
      setError(detail);
      notify(detail, true);
      return null;
    } finally {
      if (generation.current === current) {
        changing.current = false;
        if (mounted.current && !abort.signal.aborted) setBusy('');
      }
    }
  };
  return { snapshot, busy, error, result, read, apply };
}

function ApprovalEditor({
  api,
  row,
  snapshot,
  initialMember,
  busy,
  submit,
  cancel,
}: {
  api: Api;
  row: IdentityReviewRow;
  snapshot: IdentityReviewSnapshot;
  initialMember?: DiscordMember;
  busy: boolean;
  submit: (value: IdentityApproval) => void;
  cancel: () => void;
}) {
  const id = useId();
  const [member, setMember] = useState<DiscordMember | null>(initialMember || memberValue(row));
  const [accounts, setAccounts] = useState<
    Record<string, { account: IdentityAccount; slot: number; selected: boolean }>
  >(() =>
    Object.fromEntries([
      ...row.suggestions.map(
        ({ account, reliable }) =>
          [
            keyOf(account),
            {
              account,
              slot: slotOf(account, initialMember?.username || row.member?.username),
              selected: reliable && !account.ownership_conflict,
            },
          ] as const,
      ),
      ...row.confirmed_accounts.map(
        (account) =>
          [
            keyOf(account),
            {
              account,
              slot: slotOf(account, initialMember?.username || row.member?.username),
              selected: true,
            },
          ] as const,
      ),
    ]),
  );
  const [otherAccount, setOtherAccount] = useState('');
  const [search, setSearch] = useState('');
  const [exception, setException] = useState<'preserve' | 'none' | IdentityException['kind']>(
    'preserve',
  );
  const [note, setNote] = useState(row.exception?.note || '');
  const [validation, setValidation] = useState('');
  const available = snapshot.accounts.filter(
    (account) =>
      !accounts[keyOf(account)] &&
      !account.ownership_conflict &&
      (!account.owner_discord_id || account.owner_discord_id === member?.id) &&
      account.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  function approve(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const annotationOnly =
      !member && exception !== 'preserve' && (exception === 'none' || !!note.trim());
    if (!member && !annotationOnly) return;
    const selected = Object.values(accounts).filter((item) => item.selected);
    if (!annotationOnly && selected.some((item) => item.account.ownership_conflict)) {
      setValidation('Resolve conflicting ownership records before linking this account.');
      return;
    }
    if (
      !annotationOnly &&
      selected.some(
        (item) => item.account.owner_discord_id && item.account.owner_discord_id !== member?.id,
      )
    ) {
      setValidation(
        'A selected media account belongs to another Discord owner. Change the selection.',
      );
      return;
    }
    if (
      !annotationOnly &&
      selected.some((item) => !Number.isInteger(item.slot) || item.slot < 1 || item.slot > 3)
    ) {
      setValidation('Use account slots from 1 to 3.');
      return;
    }
    if (
      !annotationOnly &&
      (selected.length > 6 ||
        new Set(selected.map((item) => `${item.account.kind}:${item.slot}`)).size !==
          selected.length)
    ) {
      setValidation(
        'Use a different slot for each account on the same media server, with up to three accounts per server.',
      );
      return;
    }
    if (!['preserve', 'none'].includes(exception) && !note.trim()) {
      setValidation('Add a private note explaining this approved exception.');
      return;
    }
    setValidation('');
    submit({
      row_id: row.id,
      discord_user_id: member?.id || '',
      stripe_customer_ids: annotationOnly ? [] : row.customers.map((customer) => customer.id),
      accounts: annotationOnly
        ? []
        : selected.map(({ account, slot }) => ({ kind: account.kind, id: account.id, slot })),
      ...(exception === 'preserve'
        ? {}
        : { exception: exception === 'none' ? null : { kind: exception, note: note.trim() } }),
    });
  }
  return (
    <form className="form-stack" onSubmit={approve} aria-label="Review identity associations">
      <Callout title="Link existing accounts; Jellyfin is optional">
        Link existing accounts and update Discord roles. Leave Jellyfin unselected for Emby-only
        members. No accounts are created or migrated.
      </Callout>
      {row.conflict && (
        <p className="error-block" role="alert">
          {row.conflict}
        </p>
      )}
      {row.customers.length > 0 && (
        <div>
          {row.customers.map((customer) => (
            <p className="section-note" key={customer.id}>
              Stripe: {customer.name || customer.email || customer.id} ·{' '}
              {customer.statuses.join(', ') || 'Status unavailable'}
            </p>
          ))}
        </div>
      )}
      <DiscordMemberPicker
        api={api}
        value={member}
        onChange={setMember}
        suggestedQuery={row.member_candidates[0]?.username || ''}
        disabled={busy}
        allowInactive
      />
      {!member && row.member_candidates.length > 0 && (
        <div className="button-row">
          {row.member_candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                setMember({
                  id: candidate.id,
                  username: candidate.username,
                  display_name: candidate.display_name || null,
                  nickname: candidate.nickname || null,
                  membership_active: null,
                })
              }
            >
              Use suggested @{candidate.username}
            </button>
          ))}
        </div>
      )}
      <fieldset
        disabled={busy}
        className="form-stack"
        style={{ minWidth: 0, margin: 0, padding: 0, border: 0 }}
      >
        <legend>Existing media accounts</legend>
        <p className="section-note">
          Select only accounts this member owns. Discord-only members can leave these empty.
        </p>
        {Object.values(accounts).map(({ account, selected, slot }) => {
          const confirmed = row.confirmed_accounts.some((item) => keyOf(item) === keyOf(account));
          const suggestion = row.suggestions.find((item) => keyOf(item.account) === keyOf(account));
          return (
            <div className="summary-card form-stack" key={keyOf(account)}>
              <label className="check-label">
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={selected}
                  disabled={confirmed || account.ownership_conflict}
                  onChange={(event) =>
                    setAccounts((current) => ({
                      ...current,
                      [keyOf(account)]: {
                        ...current[keyOf(account)],
                        selected: event.target.checked,
                      },
                    }))
                  }
                />
                {accountName(account)}
                {confirmed ? ' · Already confirmed' : ''}
              </label>
              <p className="section-note">
                {account.disabled ? 'Disabled account. ' : ''}
                {account.family ? 'Family account. ' : ''}
                {account.administrator ? 'Administrator. ' : ''}
                {suggestion?.reason}
              </p>
              {selected && (
                <details className="help-disclosure">
                  <summary>Account slot {slot}</summary>
                  <div className="field">
                    <label htmlFor={`${id}-${keyOf(account)}`}>
                      Account slot for {accountName(account)}
                    </label>
                    <input
                      id={`${id}-${keyOf(account)}`}
                      type="number"
                      min={1}
                      max={3}
                      value={slot}
                      disabled={confirmed}
                      onChange={(event) =>
                        setAccounts((current) => ({
                          ...current,
                          [keyOf(account)]: {
                            ...current[keyOf(account)],
                            slot: Number(event.target.value),
                          },
                        }))
                      }
                    />
                  </div>
                </details>
              )}
            </div>
          );
        })}
        {Object.keys(accounts).length === 0 && (
          <p className="section-note">
            No existing media accounts suggested. You can approve the identity without one.
          </p>
        )}
        <details className="help-disclosure">
          <summary>Choose another existing media account</summary>
          <div className="form-stack">
            <div className="field">
              <label htmlFor={`${id}-search`}>Find media accounts</label>
              <input
                id={`${id}-search`}
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOtherAccount('');
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-account`}>Available account</label>
              <select
                id={`${id}-account`}
                value={otherAccount}
                onChange={(event) => setOtherAccount(event.target.value)}
              >
                <option value="">Select an existing account</option>
                {available.map((account) => (
                  <option key={keyOf(account)} value={keyOf(account)}>
                    {accountName(account)}
                    {account.disabled ? ' · Disabled' : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn"
              disabled={!otherAccount}
              onClick={() => {
                const account = available.find((item) => keyOf(item) === otherAccount);
                if (account)
                  setAccounts((current) => ({
                    ...current,
                    [keyOf(account)]: {
                      account,
                      slot: slotOf(account, member?.username),
                      selected: true,
                    },
                  }));
                setOtherAccount('');
              }}
            >
              Add account to review
            </button>
          </div>
        </details>
      </fieldset>
      <details className="help-disclosure">
        <summary>Record an approved access exception</summary>
        <div className="form-stack">
          <p className="section-note">
            This private review note acknowledges an outlier. It does not grant access, mark
            accounts Family, or exempt a membership from automatic account management.
          </p>
          {row.exception && (
            <p className="section-note">
              Saved: {exceptionNames[row.exception.kind]} · {row.exception.note}
            </p>
          )}
          <div className="field">
            <label htmlFor={`${id}-exception`}>Gap review exception</label>
            <select
              id={`${id}-exception`}
              value={exception}
              onChange={(event) => setException(event.target.value as typeof exception)}
            >
              <option value="preserve">Keep existing review annotation</option>
              <option value="none">Clear review annotation</option>
              {Object.entries(exceptionNames).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {!['preserve', 'none'].includes(exception) && (
            <div className="field">
              <label htmlFor={`${id}-note`}>Private approval note</label>
              <textarea
                id={`${id}-note`}
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          )}
        </div>
      </details>
      {validation && (
        <p className="error-block" role="alert">
          {validation}
        </p>
      )}
      <div
        className="button-row"
        style={{
          position: 'sticky',
          bottom: -18,
          background: 'var(--surface)',
          zIndex: 2,
          borderTop: '1px solid var(--line)',
          paddingBlock: 12,
        }}
      >
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            busy ||
            (!member && (exception === 'preserve' || (exception !== 'none' && !note.trim())))
          }
          aria-busy={busy}
        >
          {busy
            ? 'Approving…'
            : member
              ? 'Approve identity & update roles'
              : 'Save review annotation'}
        </button>
        <button className="btn btn-quiet" type="button" disabled={busy} onClick={cancel}>
          Cancel review
        </button>
      </div>
    </form>
  );
}

export function IdentityReviewResult({ result }: { result: IdentityReviewApplyResult | null }) {
  if (!result) return null;
  return (
    <Callout
      title="Identity review saved"
      warning={result.roles.status === 'failed' || result.roles.status === 'pending'}
    >
      <p>{resultMessage(result)}</p>
      {result.roles.message && <p className="section-note">{result.roles.message}</p>}
      {result.warnings.length > 0 && (
        <ul>
          {result.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

type RecentRoleTask = IdentityReviewApplyResult['roles'] & { task_id: string; created_at: string };
function RecentIdentityRoleTasks({
  api,
  notify,
  active,
  demo,
  refreshKey,
}: {
  api: Api;
  notify: Notify;
  active: boolean;
  demo: boolean;
  refreshKey: string;
}) {
  const [tasks, setTasks] = useState<RecentRoleTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(
    async (manual = false) => {
      if (!active || demo) return;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const current = ++generation.current;
      setLoading(true);
      setError('');
      try {
        const value = await api<{ tasks: RecentRoleTask[] }>('/api/identity-review/roles', {
          signal: abort.signal,
        });
        if (abort.signal.aborted || current !== generation.current) return;
        if (!Array.isArray(value.tasks)) throw new Error('Unexpected task list.');
        setTasks(value.tasks.slice(0, 20));
        if (manual) notify('Discord role update status refreshed.');
      } catch {
        if (abort.signal.aborted || current !== generation.current) return;
        setError('Recent Discord role updates could not be loaded. Refresh to check their status.');
        if (manual) notify('Discord role update status could not be refreshed.', true);
      } finally {
        if (!abort.signal.aborted && current === generation.current) setLoading(false);
      }
    },
    [active, demo, api, notify],
  );
  useEffect(() => {
    if (active && !demo) void read();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [active, demo, read, refreshKey]);
  const pagination = usePagination(tasks, 5, tasks.map((task) => task.task_id).join(':'));
  if (!tasks.length && !error) return null;
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const attention = tasks.filter(
    (task) => task.status === 'pending' || task.status === 'failed',
  ).length;
  return (
    <details className="help-disclosure">
      <summary>
        Recent Discord role updates{queued ? ` · ${queued} updating` : ''}
        {attention ? ` · ${attention} need attention` : ''}
      </summary>
      <div className="form-stack">
        <p className="section-note">
          Saved role jobs continue when you leave this page. This list includes the latest 20 jobs.
        </p>
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {pagination.items.map((task) => (
          <div className="status-summary" key={task.task_id}>
            <span>{date(task.created_at)}</span>
            <strong>
              {task.status === 'queued'
                ? 'Updating in background'
                : task.status === 'updated'
                  ? 'Completed'
                  : 'Needs attention'}
            </strong>
            <span>
              {num(task.updated)} updated · {num(task.failed)} failed
            </span>
            {task.message && <span>{task.message}</span>}
          </div>
        ))}
        <Pagination
          label="Discord role update history"
          page={pagination.page}
          total={pagination.total}
          pageSize={pagination.pageSize}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
        />
        <button
          type="button"
          className="btn btn-quiet"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void read(true)}
        >
          Refresh role updates
        </button>
      </div>
    </details>
  );
}

/** Inline final step of the Stripe identity dialog; uses the same reviewed apply as bulk work. */
export function StripeIdentityAccountReview({
  api,
  notify,
  demo,
  active = true,
  customerId,
  member,
  onApplied,
  onCancel,
  onBusyChange,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
  active?: boolean;
  customerId: string;
  member: DiscordMember;
  onApplied: (result: IdentityReviewApplyResult) => void;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const review = useIdentityReview(api, notify, active, demo);
  useEffect(() => {
    onBusyChange?.(!!review.busy);
    return () => onBusyChange?.(false);
  }, [review.busy, onBusyChange]);
  const row = review.snapshot?.rows.find((item) =>
    item.customers.some((customer) => customer.id === customerId),
  );
  return (
    <div className="form-stack" aria-label="Confirm media ownership">
      {review.error && (
        <p className="error-block" role="alert">
          {review.error}
        </p>
      )}
      <IdentityReviewResult result={review.result} />
      {review.busy === 'load' && <Loading>Loading existing media accounts…</Loading>}
      {review.snapshot && !row && (
        <p className="error-block" role="alert">
          This Stripe customer is no longer in the current review. Close the dialog and refresh
          Stripe.
        </p>
      )}
      {review.snapshot && row && (
        <ApprovalEditor
          api={api}
          key={`${review.snapshot.revision}:${row.id}`}
          row={row}
          snapshot={review.snapshot}
          initialMember={member}
          busy={!!review.busy}
          submit={(selection) =>
            void review.apply([selection]).then((saved) => {
              if (saved) onApplied(saved);
            })
          }
          cancel={onCancel}
        />
      )}
      {!review.snapshot && !review.busy && (
        <button type="button" className="btn" onClick={() => void review.read(true, true)}>
          Refresh account review
        </button>
      )}
    </div>
  );
}

export default function IdentityReviewPanel({
  api,
  notify,
  demo,
  active = true,
  customerId,
  onApplied,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
  active?: boolean;
  customerId?: string;
  onApplied?: () => void;
}) {
  const review = useIdentityReview(api, notify, active, demo);
  const { compactRecords } = useClientLayout();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const selectionKey = `${review.snapshot?.revision || ''}:${filter}:${query}:${customerId || ''}`;
  const [selection, setSelection] = useState({ key: '', ids: new Set<string>() });
  const selected = selection.key === selectionKey ? selection.ids : new Set<string>();
  const setSelected = (next: Set<string> | ((current: Set<string>) => Set<string>)) =>
    setSelection((current) => ({
      key: selectionKey,
      ids:
        typeof next === 'function'
          ? next(current.key === selectionKey ? current.ids : new Set())
          : next,
    }));
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);
  const [bulkReview, setBulkReview] = useState<string | null>(null);
  const [roleRefresh, setRoleRefresh] = useState(0);
  useEffect(() => {
    if (!active) {
      setSelection({ key: '', ids: new Set() });
      setEditing(null);
      setBulkReview(null);
    }
  }, [active]);
  const rows = useMemo(
    () =>
      (review.snapshot?.rows || []).filter((row) => {
        if (customerId && !row.customers.some((customer) => customer.id === customerId))
          return false;
        if (filter === 'suggested' && !suggestedApproval(row)) return false;
        if (filter === 'gaps' && (!row.gaps.length || row.exception)) return false;
        if (filter === 'exceptions' && !row.exception) return false;
        if (filter === 'discord-only' && (!row.member || row.confirmed_accounts.length))
          return false;
        if (
          filter === 'billing-gaps' &&
          !row.gaps.some((gap) =>
            ['active_subscription_no_media', 'active_subscription_no_discord'].includes(gap),
          )
        )
          return false;
        const term = query.trim().toLocaleLowerCase();
        return [
          row.member?.username,
          row.member?.display_name,
          row.member?.nickname,
          ...row.member_candidates.map((item) => item.username),
          ...row.customers.flatMap((item) => [item.name, item.email, item.id]),
          ...row.confirmed_accounts.map((item) => item.name),
          ...row.suggestions.map((item) => item.account.name),
          row.exception?.note,
        ].some((value) => value?.toLocaleLowerCase().includes(term));
      }),
    [review.snapshot, customerId, filter, query],
  );
  const pagination = usePagination(rows, 25, `${filter}:${query}:${customerId || ''}`);
  const approvals = rows
    .filter((row) => selected.has(row.id))
    .map(suggestedApproval)
    .filter((value): value is IdentityApproval => !!value);
  const bulkPage = usePagination(approvals, 10, approvals.map((value) => value.row_id).join(':'));
  const edited =
    editing?.key === selectionKey
      ? review.snapshot?.rows.find((row) => row.id === editing.id)
      : undefined;
  async function submit(selections: IdentityApproval[]) {
    const saved = await review.apply(selections);
    setEditing(null);
    setBulkReview(null);
    setSelected(new Set());
    if (saved) {
      onApplied?.();
      await review.read();
    }
  }
  return (
    <div className="page-stack" aria-label="Identity matching and access gaps">
      <section className="panel">
        <div
          className="panel-header"
          style={compactRecords ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}
        >
          <div>
            <h2>People, accounts & access gaps</h2>
            <p>
              Review Discord, Stripe, Emby and Jellyfin together. Jellyfin accounts are optional.
            </p>
          </div>
          <button
            className="btn btn-quiet"
            type="button"
            disabled={demo || !!review.busy}
            onClick={() => {
              setRoleRefresh((current) => current + 1);
              void review.read(true, true);
            }}
          >
            <Icon name="refresh" />
            Refresh directory
          </button>
        </div>
        <div className="panel-body form-stack">
          <details className="help-disclosure">
            <summary>How matching and gap review work</summary>
            <p className="section-note">
              Suggestions never establish ownership until you approve them. Gap flags are
              observations, not proof of nonpayment. This screen does not create accounts, migrate
              history, disable access, or change Family flags.
            </p>
          </details>
          {demo && (
            <p className="section-note">Live identity matching is unavailable in the demo.</p>
          )}
          {review.error && (
            <p className="error-block" role="alert">
              {review.error}
            </p>
          )}
          <IdentityReviewResult result={review.result} />
          <RecentIdentityRoleTasks
            api={api}
            notify={notify}
            active={active}
            demo={demo}
            refreshKey={`${roleRefresh}:${review.result?.roles.task_id || ''}:${review.result?.roles.status || ''}`}
          />
          {review.busy === 'load' && <Loading>Reading connected directories…</Loading>}
          {review.snapshot && (
            <>
              <div className="job-meta">
                <span>{num(review.snapshot.summary.members)} Discord members</span>
                <span>
                  {num(review.snapshot.summary.unlinked_accounts)} unlinked media accounts
                </span>
                <span>{num(review.snapshot.summary.suggestions)} suggested links</span>
                <span>{num(review.snapshot.summary.gaps)} review gaps</span>
                <span>{num(review.snapshot.summary.acknowledged)} acknowledged</span>
              </div>
              <p className="section-note">
                Directory read {date(review.snapshot.generated_at)}. Approval expires{' '}
                {date(review.snapshot.expires_at)}.
              </p>
              {Object.entries(review.snapshot.sources).some(
                ([, source]) => !source.available || !source.complete,
              ) && (
                <Callout title="Some source data is incomplete" warning>
                  {Object.entries(review.snapshot.sources)
                    .filter(([, source]) => !source.available || !source.complete)
                    .map(([name]) => (
                      <p key={name}>
                        {name === 'stripe'
                          ? 'Stripe billing'
                          : name === 'discord'
                            ? 'Discord roster'
                            : name === 'emby'
                              ? 'Emby accounts'
                              : 'Jellyfin accounts'}{' '}
                        is incomplete or unavailable. Missing records are not evidence that someone
                        lacks access or has not paid.
                      </p>
                    ))}
                </Callout>
              )}
              <div className="field-row">
                <div className="field">
                  <label htmlFor="identity-search">Find people or accounts</label>
                  <input
                    id="identity-search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Discord, media username, Stripe customer, or note"
                  />
                </div>
                <div className="field">
                  <label htmlFor="identity-filter">Review view</label>
                  <select
                    id="identity-filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">Everyone and all accounts</option>
                    <option value="suggested">Reliable suggestions</option>
                    <option value="gaps">Unacknowledged gaps</option>
                    <option value="billing-gaps">Active subscription without access</option>
                    <option value="discord-only">Discord without confirmed media</option>
                    <option value="exceptions">Approved exceptions</option>
                  </select>
                </div>
              </div>
              {(rows.some((row) => suggestedApproval(row)) || selected.size > 0) && (
                <div className="button-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={!!review.busy || !rows.some((row) => suggestedApproval(row))}
                    onClick={() =>
                      setSelected(
                        new Set(
                          rows
                            .filter((row) => suggestedApproval(row))
                            .slice(0, 250)
                            .map((row) => row.id),
                        ),
                      )
                    }
                  >
                    Select all reliable matches (up to 250)
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      !!review.busy || !pagination.items.some((row) => suggestedApproval(row))
                    }
                    onClick={() =>
                      setSelected(
                        (current) =>
                          new Set(
                            [
                              ...current,
                              ...pagination.items
                                .filter((row) => suggestedApproval(row))
                                .map((row) => row.id),
                            ].slice(0, 250),
                          ),
                      )
                    }
                  >
                    Select reliable matches on this page
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!!review.busy || !approvals.length}
                    onClick={() => setBulkReview(selectionKey)}
                  >
                    Review {approvals.length} selected{' '}
                    {approvals.length === 1 ? 'identity' : 'identities'}
                  </button>
                  {selected.size > 0 && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={!!review.busy}
                      onClick={() => setSelected(new Set())}
                    >
                      Clear selection
                    </button>
                  )}
                </div>
              )}
              <div className="record-list">
                {pagination.items.map((row) => (
                  <article className="summary-card" key={row.id}>
                    <div>
                      <div className="record-heading">
                        <h3>{rowTitle(row)}</h3>
                        {suggestedApproval(row) && (
                          <label className="check-label">
                            <input
                              className="checkbox"
                              type="checkbox"
                              aria-label={`Select suggested links for ${rowTitle(row)}`}
                              checked={selected.has(row.id)}
                              disabled={!!review.busy}
                              onChange={(event) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked && next.size < 250) next.add(row.id);
                                  else next.delete(row.id);
                                  return next;
                                })
                              }
                            />
                            Select
                          </label>
                        )}
                      </div>
                      <p className="text-small">
                        {row.confirmed_accounts.length
                          ? row.confirmed_accounts.map(accountName).join(' · ')
                          : 'No media accounts confirmed'}
                      </p>
                      {row.customers.length > 0 && (
                        <p className="text-small">
                          Stripe:{' '}
                          {row.customers
                            .map(
                              (customer) =>
                                `${customer.name || customer.email || 'Customer'} (${customer.statuses.join(', ') || 'Unknown'})`,
                            )
                            .join(' · ')}
                        </p>
                      )}
                      {row.suggestions.length > 0 && (
                        <p className="text-small">
                          Suggested:{' '}
                          {row.suggestions.map(({ account }) => accountName(account)).join(' · ')}
                        </p>
                      )}
                      {row.gaps.length > 0 && (
                        <p className="section-note">
                          {row.gaps.map((gap) => gapNames[gap]).join(' · ')}
                        </p>
                      )}
                      {row.exception && (
                        <p className="mint text-small">
                          {exceptionNames[row.exception.kind]} · {row.exception.note}
                        </p>
                      )}
                      {row.conflict && <p className="error-block">{row.conflict}</p>}
                    </div>
                    <div className="toolbar">
                      <button
                        className="btn"
                        type="button"
                        disabled={!!review.busy}
                        onClick={() => setEditing({ id: row.id, key: selectionKey })}
                      >
                        Review associations
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!pagination.total && <p className="section-note">No identities match this view.</p>}
              <Pagination
                label="Identity directory"
                page={pagination.page}
                total={pagination.total}
                pageSize={pagination.pageSize}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
              />
            </>
          )}
        </div>
      </section>
      {active && edited && review.snapshot && (
        <Modal
          title={`Review ${rowTitle(edited)}`}
          description="Confirm existing accounts and record approved access exceptions."
          close={() => {
            if (!review.busy) setEditing(null);
          }}
          closeDisabled={!!review.busy}
        >
          <ApprovalEditor
            api={api}
            key={`${review.snapshot.revision}:${edited.id}`}
            row={edited}
            snapshot={review.snapshot}
            busy={!!review.busy}
            submit={(value) => void submit([value])}
            cancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {active && bulkReview === selectionKey && review.snapshot && (
        <Modal
          title="Approve selected identity links?"
          description="Review every selected owner and their existing media accounts."
          close={() => {
            if (!review.busy) setBulkReview(null);
          }}
          closeDisabled={!!review.busy}
          footer={
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!review.busy || !approvals.length}
                onClick={() => void submit(approvals)}
              >
                {review.busy === 'apply'
                  ? 'Approving…'
                  : `Approve ${approvals.length} ${approvals.length === 1 ? 'identity' : 'identities'} & update roles`}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={!!review.busy}
                onClick={() => setBulkReview(null)}
              >
                Cancel bulk review
              </button>
            </>
          }
        >
          <div className="form-stack">
            <p>
              Ownership links and configured Discord organization roles will be updated. Emby-only
              members stay Emby-only. No media accounts will be created or disabled.
            </p>
            {bulkPage.items.map((approval) => {
              const row = rows.find((item) => item.id === approval.row_id)!;
              return (
                <div className="summary-card" key={approval.row_id}>
                  <h3>{rowTitle(row)}</h3>
                  <p>
                    {approval.accounts
                      .map((item) =>
                        accountName(
                          review.snapshot!.accounts.find(
                            (account) => keyOf(account) === keyOf(item),
                          )!,
                        ),
                      )
                      .join(' · ') || 'Stripe identity only'}
                  </p>
                  {row.suggestions
                    .filter((item) => item.reliable)
                    .map((item) => (
                      <p className="section-note" key={keyOf(item.account)}>
                        {accountName(item.account)}: {item.reason}
                      </p>
                    ))}
                </div>
              );
            })}
            <Pagination
              label="Selected identity reviews"
              page={bulkPage.page}
              total={bulkPage.total}
              pageSize={bulkPage.pageSize}
              onPageChange={bulkPage.setPage}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
