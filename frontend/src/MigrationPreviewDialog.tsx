import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import DiscordMemberPicker from './DiscordMemberPicker';
import { Callout, Icon, Issues, Modal, SourceSnapshotNote, UserCell } from './components';
import {
  num,
  type Api,
  type DiscordMember,
  type MigrationOwnerMembership,
  type MigrationBillingInventory,
  type MigrationBillingSelection,
  type MigrationAccountReview,
  type MediaUser,
  type Preview,
  type PreviewUser,
} from './types';

type Selection = {
  member: DiscordMember | null;
  manual: string;
  slot: number;
  slotEdited?: boolean;
};
function initialSelection(user: PreviewUser): Selection {
  return {
    member: user.discord_user_id
      ? {
          id: user.discord_user_id,
          username: user.discord_username || user.username,
          display_name: null,
          nickname: null,
          membership_active: null,
        }
      : null,
    manual: '',
    slot: user.membership_slot || 1,
    slotEdited: !!user.membership_slot,
  };
}
function ownerId(value: Selection): string {
  return value.member?.id || value.manual.trim();
}

type OwnerMembershipState =
  | { loading: true; value?: never; error?: never }
  | { loading?: false; value: MigrationOwnerMembership; error?: never }
  | { loading?: false; value?: never; error: string };

/** Keep one bounded request per selected owner; account rows share its result. */
function useOwnerMemberships(api: Api, previewId: string, ownerIds: string[]) {
  const [states, setStates] = useState<Record<string, OwnerMembershipState>>({});
  const entries = useRef(new Map<string, OwnerMembershipState>());
  const requests = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const selected = useRef(new Set(ownerIds));
  selected.current = new Set(ownerIds);
  const key = JSON.stringify([...selected.current].sort());
  const publish = useCallback(() => setStates(Object.fromEntries(entries.current)), []);
  const load = useCallback(
    (
      id: string,
      billing?: MigrationBillingSelection,
      complimentary?: { account_limit: number },
    ) => {
      if (entries.current.has(id) || requests.current.has(id)) return;
      if (!/^[0-9]{15,22}$/.test(id)) {
        entries.current.set(id, { error: 'Enter a valid Discord member ID or select a member.' });
        publish();
        return;
      }
      const controller = new AbortController();
      requests.current.set(id, controller);
      entries.current.set(id, { loading: true });
      publish();
      const current = () =>
        mounted.current &&
        !controller.signal.aborted &&
        selected.current.has(id) &&
        requests.current.get(id) === controller;
      void api<MigrationOwnerMembership>(
        `/api/migrations/preview/${encodeURIComponent(previewId)}/membership`,
        {
          method: 'POST',
          body: {
            discord_user_id: id,
            ...(billing ? { billing } : {}),
            ...(complimentary ? { complimentary } : {}),
          },
          signal: controller.signal,
        },
      )
        .then((value) => {
          if (!current()) return;
          if (
            value.discord_user_id !== id ||
            typeof value.review_token !== 'string' ||
            !value.review_token ||
            !Array.isArray(value.allowed_slots) ||
            value.allowed_slots.some((slot) => ![1, 2, 3].includes(slot)) ||
            !['active', 'complimentary', 'unlinked', 'inactive', 'unavailable', 'held'].includes(
              value.status,
            )
          )
            throw new Error('The membership response was incomplete. Check membership again.');
          entries.current.set(id, { value });
          publish();
        })
        .catch((reason: unknown) => {
          if (!current()) return;
          entries.current.set(id, {
            error: reason instanceof Error ? reason.message : 'Membership could not be checked.',
          });
          publish();
        })
        .finally(() => {
          if (requests.current.get(id) === controller) requests.current.delete(id);
        });
    },
    [api, previewId, publish],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
      entries.current.clear();
    };
  }, [api, previewId]);
  useEffect(() => {
    for (const id of entries.current.keys()) {
      if (selected.current.has(id)) continue;
      requests.current.get(id)?.abort();
      requests.current.delete(id);
      entries.current.delete(id);
    }
    publish();
    for (const id of selected.current) load(id);
  }, [key, load, publish]);
  const retry = (
    id: string,
    billing?: MigrationBillingSelection,
    complimentary?: { account_limit: number },
  ) => {
    requests.current.get(id)?.abort();
    requests.current.delete(id);
    entries.current.delete(id);
    load(id, billing, complimentary);
  };
  return { states, retry };
}

const lockedOwner = (user: PreviewUser) =>
  !!user.discord_user_id && (!!user.mapping_id || !!user.owner_basis);
const membershipTitle = (value: MigrationOwnerMembership) => {
  if (['active', 'complimentary'].includes(value.status))
    return `${value.tier_name || (value.status === 'complimentary' ? 'Complimentary' : 'Subscription')} · ${value.account_limit} ${value.account_limit === 1 ? 'account' : 'accounts'}`;
  return {
    unlinked: value.source === 'stripe' ? 'Stripe identity not linked' : 'No saved membership',
    inactive: 'Membership inactive',
    unavailable: 'Membership unavailable',
    held: 'Membership needs review',
    active: '',
    complimentary: '',
  }[value.status];
};
type BillingCustomer = MigrationBillingInventory['customers'][number];
type BillingDraft = {
  query: string;
  ids: string[];
  prices: Record<string, string>;
  confirmed: boolean;
  inventory?: MigrationBillingInventory;
  known: Record<string, BillingCustomer>;
  error?: string;
  mode?: 'stripe' | 'complimentary';
  complimentaryLimit?: number;
  complimentaryConfirmed?: boolean;
};
const emptyBilling = (): BillingDraft => ({
  query: '',
  ids: [],
  prices: {},
  confirmed: false,
  known: {},
});
type TargetDraft = {
  id: string;
  value?: MigrationAccountReview;
  pending?: boolean;
  error?: string;
};
type OwnerGroup = { id: string; label: string; users: PreviewUser[] };

export default function MigrationPreviewDialog({
  review,
  api,
  close,
  startMigration,
  refreshPreview,
  busy,
  templateUserId,
}: {
  review: { preview: Preview; previewId: string; reviewElapsedMs?: number };
  api: Api;
  close: () => void;
  startMigration: (event: FormEvent<HTMLFormElement>) => void;
  refreshPreview: () => void;
  busy: Set<string>;
  templateUserId?: string;
}) {
  const users = review.preview.users;
  const pending = busy.has('migration');
  const protectedOnly = users.every((user) => user.history_only);
  const [step, setStep] = useState(protectedOnly ? 3 : 0);
  const [selections, setSelections] = useState<Record<string, Selection>>(() =>
    Object.fromEntries(users.map((user) => [user.source_user_id, initialSelection(user)])),
  );
  const [chosen, setChosen] = useState(
    () =>
      new Set(
        users
          .filter((user) => !user.history_only && !lockedOwner(user) && !user.discord_user_id)
          .map((user) => user.source_user_id),
      ),
  );
  const [batchMember, setBatchMember] = useState<DiscordMember | null>(null);
  const [batchManual, setBatchManual] = useState('');
  const [ownerError, setOwnerError] = useState('');
  const [activeOwner, setActiveOwner] = useState('');
  const [billingDrafts, setBillingDrafts] = useState<Record<string, BillingDraft>>({});
  const [dirtyBilling, setDirtyBilling] = useState<Set<string>>(() => new Set());
  const [targets, setTargets] = useState<Record<string, TargetDraft>>({});
  const [targetUsers, setTargetUsers] = useState<MediaUser[]>([]);
  const [directoryTemplateId, setDirectoryTemplateId] = useState(templateUserId);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryVersion, setDirectoryVersion] = useState(0);
  const targetRequests = useRef(new Map<string, AbortController>());
  const targetVersions = useRef(new Map<string, number>());
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const ownerGroups = new Map<string, OwnerGroup>();
  for (const user of users) {
    if (user.history_only) continue;
    const selection = selections[user.source_user_id],
      id = ownerId(selection);
    if (!id) continue;
    const group = ownerGroups.get(id) || { id, label: selection.member?.username || id, users: [] };
    group.users.push(user);
    ownerGroups.set(id, group);
  }
  const groups = [...ownerGroups.values()];
  const currentOwner = groups.find((group) => group.id === activeOwner) || groups[0];
  const memberships = useOwnerMemberships(
    api,
    review.previewId,
    groups.map((group) => group.id),
  );
  const ownerReady = (id: string) =>
    !!memberships.states[id]?.value &&
    !dirtyBilling.has(id) &&
    !!memberships.states[id].value?.allowed_slots.length;
  const billingBlocked = groups.some((group) => !ownerReady(group.id));
  const conflicts: Record<string, string> = {};
  for (const group of groups) {
    const seen = new Map<number, string>();
    for (const user of group.users) {
      const selection = selections[user.source_user_id],
        membership = memberships.states[group.id]?.value;
      const prior = seen.get(selection.slot);
      if (prior) {
        conflicts[user.source_user_id] =
          `Account ${selection.slot} is also assigned to ${prior}. Choose a distinct slot.`;
        const first = group.users.find((row) => row.username === prior);
        if (first)
          conflicts[first.source_user_id] =
            `Account ${selection.slot} is shared by two selected accounts.`;
      }
      seen.set(selection.slot, user.username);
      if (membership && !membership.allowed_slots.includes(selection.slot))
        conflicts[user.source_user_id] =
          'This account slot is not covered by the selected owner’s membership.';
      if (
        membership?.occupied_slots?.some(
          (slot) =>
            slot.slot === selection.slot &&
            slot.emby_user_id !== user.source_user_id &&
            (!slot.jellyfin_user_id ||
              slot.jellyfin_user_id !==
                (targets[user.source_user_id]?.value?.target_user_id || user.target_user_id)),
        )
      )
        conflicts[user.source_user_id] =
          'This slot belongs to another account outside this migration. Choose a free slot.';
    }
  }
  const targetBlocked = Object.values(targets).some(
    (value) => value.id && (!value.value || value.pending || value.error),
  );
  const usedTargets = new Map<string, string>();
  for (const user of users) {
    const targetId = targets[user.source_user_id]?.value?.target_user_id || user.target_user_id;
    if (!targetId) continue;
    const other = usedTargets.get(targetId);
    if (other)
      conflicts[user.source_user_id] =
        `The Jellyfin account is also selected for ${other}. Choose a separate destination.`;
    usedTargets.set(targetId, user.username);
  }
  const accountsBlocked = billingBlocked || targetBlocked || Object.keys(conflicts).length > 0;
  const accountGroups: OwnerGroup[] = [...groups];
  const independent = users.filter(
    (user) => user.history_only || !ownerId(selections[user.source_user_id]),
  );
  if (independent.length)
    accountGroups.push({
      id: 'independent',
      label: 'Independent & protected accounts',
      users: independent,
    });
  const currentAccounts =
    accountGroups.find((group) => group.id === activeOwner) || accountGroups[0];

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    heading.current?.focus();
    heading.current?.closest('.modal-body')?.scrollTo?.({ top: 0 });
  }, [step]);
  useEffect(
    () => () => {
      for (const controller of targetRequests.current.values()) controller.abort();
    },
    [],
  );
  useEffect(() => {
    if (step !== 2 || protectedOnly) return;
    const controller = new AbortController();
    setDirectoryLoading(true);
    setDirectoryError('');
    void api<{ jellyfin: MediaUser[]; template_user_id?: string }>('/api/users', {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setTargetUsers(value.jellyfin || []);
          setDirectoryTemplateId(value.template_user_id || templateUserId);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setDirectoryError(
            reason instanceof Error ? reason.message : 'Jellyfin accounts could not be loaded.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setDirectoryLoading(false);
      });
    return () => controller.abort();
  }, [api, step, protectedOnly, directoryVersion, templateUserId]);

  function assignOwner(independent = false) {
    const id = independent ? '' : batchMember?.id || batchManual.trim();
    if (!independent && !/^[0-9]{15,22}$/.test(id)) {
      setOwnerError('Select a Discord member before assigning these accounts.');
      return;
    }
    setOwnerError('');
    setSelections((current) => {
      const next = { ...current };
      for (const user of users) {
        if (!chosen.has(user.source_user_id) || user.history_only || lockedOwner(user)) continue;
        const old = current[user.source_user_id];
        next[user.source_user_id] = {
          member: independent ? null : batchMember,
          manual: independent || batchMember ? '' : id,
          slot: old.slot,
          slotEdited:
            (!ownerId(old) && !!user.mapping_id) || ownerId(old) === id ? old.slotEdited : false,
        };
      }
      return next;
    });
  }
  function suggestSlots() {
    setSelections((current) => {
      const next = { ...current };
      for (const group of groups) {
        const membership = memberships.states[group.id]?.value;
        const selectedIds = new Set(group.users.map((user) => user.source_user_id));
        const selectedTargetIds = new Set(
          group.users
            .map(
              (user) => targets[user.source_user_id]?.value?.target_user_id || user.target_user_id,
            )
            .filter(Boolean),
        );
        const used = new Set(
          (membership?.occupied_slots || [])
            .filter(
              (slot) =>
                !selectedIds.has(slot.emby_user_id || '') &&
                !selectedTargetIds.has(slot.jellyfin_user_id),
            )
            .map((slot) => slot.slot),
        );
        for (const user of group.users)
          if (lockedOwner(user) || current[user.source_user_id].slotEdited)
            used.add(current[user.source_user_id].slot);
        for (const user of group.users) {
          const selection = current[user.source_user_id];
          if (lockedOwner(user) || selection.slotEdited) continue;
          const slot = membership?.allowed_slots.find((value) => !used.has(value));
          if (slot) {
            next[user.source_user_id] = { ...selection, slot };
            used.add(slot);
          }
        }
      }
      return next;
    });
  }
  function next() {
    if (step === 0) {
      setStep(groups.length ? 1 : 2);
      return;
    }
    if (step === 1 && !billingBlocked) {
      suggestSlots();
      setStep(2);
      return;
    }
    if (step === 2 && !accountsBlocked) setStep(3);
  }
  function back() {
    setStep(step === 3 ? (protectedOnly ? 3 : 2) : step === 2 && !groups.length ? 0 : step - 1);
  }
  function targetName(user: PreviewUser) {
    return targets[user.source_user_id]?.value?.target_username || user.username;
  }
  function chooseTarget(user: PreviewUser, id: string) {
    const source = user.source_user_id;
    targetRequests.current.get(source)?.abort();
    const version = (targetVersions.current.get(source) || 0) + 1;
    targetVersions.current.set(source, version);
    if (!id) {
      setTargets((current) => {
        const next = { ...current };
        delete next[source];
        return next;
      });
      return;
    }
    const controller = new AbortController();
    targetRequests.current.set(source, controller);
    setTargets((current) => ({ ...current, [source]: { id, pending: true } }));
    void api<MigrationAccountReview>(
      `/api/migrations/preview/${encodeURIComponent(review.previewId)}/account`,
      {
        method: 'POST',
        body: { source_user_id: source, target_user_id: id },
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (controller.signal.aborted || targetVersions.current.get(source) !== version) return;
        if (value.source_user_id !== source || value.target_user_id !== id || !value.review_token)
          throw new Error(
            'The destination account review was incomplete. Choose the account again.',
          );
        setTargets((current) => ({ ...current, [source]: { id, value } }));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && targetVersions.current.get(source) === version)
          setTargets((current) => ({
            ...current,
            [source]: {
              id,
              error:
                reason instanceof Error ? reason.message : 'The destination could not be reviewed.',
            },
          }));
      })
      .finally(() => {
        if (targetRequests.current.get(source) === controller)
          targetRequests.current.delete(source);
      });
  }
  const phaseLabels = ['Owners', 'Billing', 'Accounts', 'Review'];
  return (
    <Modal
      title="Review your migration"
      description={`${users.length} ${users.length === 1 ? 'account' : 'accounts'} selected · played status only`}
      wide
      close={close}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={close} disabled={pending}>
            Cancel
          </button>
          {step > 0 && !protectedOnly && (
            <button type="button" className="btn btn-quiet" onClick={back} disabled={pending}>
              Back
            </button>
          )}
          {step < 3 ? (
            <button
              key="wizard-next"
              type="button"
              className="btn btn-primary"
              disabled={
                pending || (step === 1 && billingBlocked) || (step === 2 && accountsBlocked)
              }
              onClick={(event) => {
                event.preventDefault();
                next();
              }}
            >
              Next: {phaseLabels[step === 0 && !groups.length ? 2 : step + 1]}
            </button>
          ) : (
            <button
              key="wizard-start"
              className="btn btn-primary"
              type="submit"
              form="migration-preview-form"
              disabled={pending || accountsBlocked}
            >
              {pending ? <span className="spinner" /> : <Icon name="migrate" />}
              {pending ? 'Starting migration…' : 'Start migration'}
            </button>
          )}
        </>
      }
    >
      <ol className="migration-wizard-steps" aria-label="Migration steps">
        {phaseLabels.map((label, index) => (
          <li key={label} aria-current={step === index ? 'step' : undefined}>
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <h3 ref={heading} tabIndex={-1}>
        {
          [
            'Choose account owners',
            'Confirm membership & billing',
            'Confirm accounts & slots',
            'Final migration review',
          ][step]
        }
      </h3>
      {review.reviewElapsedMs !== undefined && (
        <p className="subtle text-small">
          Review build: {(review.reviewElapsedMs / 1000).toFixed(1)} seconds. This is included in
          the combined migration timing after approval; time spent reviewing is excluded.
        </p>
      )}
      <form
        id="migration-preview-form"
        onSubmit={(event) => {
          if (step !== 3 || accountsBlocked) {
            event.preventDefault();
            return;
          }
          startMigration(event);
        }}
      >
        {users
          .filter((user) => !user.history_only)
          .map((user) => {
            const selection = selections[user.source_user_id],
              id = ownerId(selection);
            return (
              <div key={user.source_user_id} hidden>
                <input name={user.source_user_id} value={id} readOnly />
                {id && !lockedOwner(user) && (
                  <input name={`slot-${user.source_user_id}`} value={selection.slot} readOnly />
                )}
                {targets[user.source_user_id]?.value && (
                  <input
                    name={`account-review-${user.source_user_id}`}
                    value={targets[user.source_user_id].value!.review_token}
                    readOnly
                  />
                )}
              </div>
            );
          })}
        {groups.map((group) =>
          !dirtyBilling.has(group.id) && memberships.states[group.id]?.value?.review_token ? (
            <input
              key={group.id}
              type="hidden"
              name={`membership-review-${group.id}`}
              value={memberships.states[group.id].value!.review_token}
            />
          ) : null,
        )}
        {step === 0 && (
          <div className="form-stack">
            <p className="subtle">
              Choose the accounts belonging to one person, then assign their Discord owner once.
              Differently named accounts can share an owner. Independent accounts can stay without
              Discord.
            </p>
            <div className="migration-account-list">
              {users.map((user) => (
                <label key={user.source_user_id} className="migration-account-choice">
                  <input
                    type="checkbox"
                    aria-label={`Assign ${user.username}`}
                    checked={chosen.has(user.source_user_id)}
                    disabled={pending || user.history_only || lockedOwner(user)}
                    onChange={(event) =>
                      setChosen((current) => {
                        const next = new Set(current);
                        event.target.checked
                          ? next.add(user.source_user_id)
                          : next.delete(user.source_user_id);
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{user.source_username || user.username}</strong>
                    {user.source_username && user.source_username !== user.username && (
                      <small>Jellyfin: {user.username}</small>
                    )}
                    <small>
                      {user.history_only
                        ? 'Protected · watch history only'
                        : ownerId(selections[user.source_user_id])
                          ? `@${selections[user.source_user_id].member?.username || ownerId(selections[user.source_user_id])}${lockedOwner(user) ? ' · confirmed owner' : ''}`
                          : 'Independent · no Discord owner'}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <DiscordMemberPicker
              api={api}
              value={batchMember}
              onChange={(value) => {
                setBatchMember(value);
                setBatchManual('');
              }}
              label="Discord owner"
              allowInactive
              showMembershipStatus={false}
              disabled={pending || chosen.size === 0}
            />
            <details>
              <summary>Advanced Discord details</summary>
              <label className="field">
                Discord owner ID
                <input
                  aria-label="Discord owner ID"
                  value={batchManual}
                  disabled={pending || !!batchMember}
                  inputMode="numeric"
                  maxLength={22}
                  onChange={(event) => setBatchManual(event.target.value)}
                />
              </label>
            </details>
            {ownerError && (
              <p className="error-block" role="alert">
                {ownerError}
              </p>
            )}
            <div className="button-row">
              <button
                type="button"
                className="btn"
                disabled={pending || !chosen.size || (!batchMember && !batchManual.trim())}
                onClick={() => assignOwner()}
              >
                Assign owner to selected accounts
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={pending || !chosen.size}
                onClick={() => assignOwner(true)}
              >
                Keep selected accounts independent
              </button>
            </div>
            {groups.map((group) => (
              <div className="migration-owner-summary" key={group.id}>
                <strong>@{group.label}</strong>
                <p>{group.users.map((user) => user.source_username || user.username).join(', ')}</p>
                <button
                  type="button"
                  className="text-button"
                  disabled={pending || group.users.every(lockedOwner)}
                  onClick={() => {
                    setChosen(
                      new Set(
                        group.users
                          .filter((user) => !lockedOwner(user))
                          .map((user) => user.source_user_id),
                      ),
                    );
                    setBatchMember(selections[group.users[0].source_user_id].member);
                    setBatchManual(selections[group.users[0].source_user_id].manual);
                  }}
                >
                  Select accounts for @{group.label}
                </button>
              </div>
            ))}
          </div>
        )}
        {step === 1 && currentOwner && (
          <div className="form-stack">
            <GroupPicker
              groups={groups}
              selected={currentOwner.id}
              change={setActiveOwner}
              disabled={pending}
              label="Member to review"
            />
            <p className="subtle">
              {currentOwner.users.map((user) => user.username).join(', ')} ·{' '}
              {currentOwner.users.length} selected{' '}
              {currentOwner.users.length === 1 ? 'account' : 'accounts'}
            </p>
            <BillingPanel
              key={currentOwner.id}
              api={api}
              previewId={review.previewId}
              group={currentOwner}
              state={memberships.states[currentOwner.id]}
              draft={billingDrafts[currentOwner.id] || emptyBilling()}
              pending={pending}
              dirty={dirtyBilling.has(currentOwner.id)}
              update={(draft, changed = false) => {
                setBillingDrafts((current) => ({ ...current, [currentOwner.id]: draft }));
                if (changed) setDirtyBilling((current) => new Set(current).add(currentOwner.id));
              }}
              check={(billing, complimentary) => {
                setDirtyBilling((current) => {
                  const next = new Set(current);
                  next.delete(currentOwner.id);
                  return next;
                });
                memberships.retry(currentOwner.id, billing, complimentary);
              }}
            />
            {groups.length > 1 && (
              <p className="subtle text-small" role="status">
                {groups.filter((group) => ownerReady(group.id)).length} of {groups.length} members
                ready. Review each member before continuing.
              </p>
            )}
          </div>
        )}
        {step === 2 && currentAccounts && (
          <div className="form-stack">
            <GroupPicker
              groups={accountGroups}
              selected={currentAccounts.id}
              change={setActiveOwner}
              disabled={pending}
              label="Accounts to review"
            />
            {currentAccounts.id !== 'independent' &&
              memberships.states[currentAccounts.id]?.value && (
                <Callout title={membershipTitle(memberships.states[currentAccounts.id].value!)}>
                  {memberships.states[currentAccounts.id].value!.message}
                </Callout>
              )}
            {directoryLoading && (
              <p className="subtle" role="status">
                Loading existing Jellyfin accounts…
              </p>
            )}
            {directoryError && (
              <Callout warning title="Existing Jellyfin accounts unavailable">
                <p>{directoryError}</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDirectoryVersion((value) => value + 1)}
                >
                  Retry account directory
                </button>
              </Callout>
            )}
            {currentAccounts.users.map((user) => {
              const selection = selections[user.source_user_id],
                id = ownerId(selection),
                membership = memberships.states[id]?.value;
              const target = targets[user.source_user_id];
              return (
                <section className="migration-owner-summary" key={user.source_user_id}>
                  <h4>{user.source_username || user.username}</h4>
                  <p className="subtle text-small">
                    Jellyfin: {targetName(user)} ·{' '}
                    {user.history_only
                      ? 'Watch history only'
                      : user.target_exists || target?.value
                        ? 'Merge into existing account'
                        : 'Create new account'}
                  </p>
                  {user.history_only ? (
                    <p>
                      Protected administrator or template. Password, permissions and Discord
                      ownership stay unchanged.
                    </p>
                  ) : user.mapping_id ? (
                    <p className="subtle text-small">
                      Saved user mapping · {user.source_username} → {user.username}. Existing
                      mapping stays confirmed.
                    </p>
                  ) : (
                    <label className="field">
                      Jellyfin destination for {user.source_username || user.username}
                      <select
                        aria-label={`Jellyfin destination for ${user.source_username || user.username}`}
                        value={target?.id || ''}
                        disabled={pending || directoryLoading}
                        onChange={(event) => chooseTarget(user, event.target.value)}
                      >
                        <option value="">
                          {user.target_exists
                            ? `Use reviewed match: ${user.username}`
                            : `Create new account: ${user.username}`}
                        </option>
                        {targetUsers
                          .filter(
                            (candidate) =>
                              candidate.Id !== directoryTemplateId &&
                              candidate.Policy?.IsAdministrator === false &&
                              candidate.Policy?.IsDisabled === false,
                          )
                          .map((candidate) => (
                            <option key={candidate.Id} value={candidate.Id}>
                              {candidate.Name}
                            </option>
                          ))}
                      </select>
                      <small>
                        Choose an existing account when names differ. Credentials and account
                        preferences are preserved.
                      </small>
                    </label>
                  )}
                  {target?.pending && (
                    <p className="subtle" role="status">
                      Checking the selected Jellyfin account…
                    </p>
                  )}
                  {target?.error && (
                    <p className="error-block" role="alert">
                      {target.error}
                    </p>
                  )}
                  {!user.history_only && id && (
                    <label className="field">
                      Membership account slot for {user.username}
                      <select
                        aria-label={`Membership account slot for ${user.username}`}
                        value={selection.slot}
                        disabled={pending || lockedOwner(user)}
                        aria-invalid={!!conflicts[user.source_user_id]}
                        onChange={(event) =>
                          setSelections((current) => ({
                            ...current,
                            [user.source_user_id]: {
                              ...current[user.source_user_id],
                              slot: Number(event.target.value),
                              slotEdited: true,
                            },
                          }))
                        }
                      >
                        {[1, 2, 3].map((slot) => (
                          <option
                            value={slot}
                            key={slot}
                            disabled={!membership?.allowed_slots.includes(slot)}
                          >{`Account ${slot}`}</option>
                        ))}
                      </select>
                      <small>
                        {lockedOwner(user)
                          ? 'This account has a confirmed owner and slot. Its existing assignment is preserved.'
                          : 'Free slots are suggested. Review them before continuing; account names stay unchanged.'}
                      </small>
                    </label>
                  )}
                  {conflicts[user.source_user_id] && (
                    <p className="error-block" role="alert">
                      {conflicts[user.source_user_id]}
                    </p>
                  )}
                </section>
              );
            })}
            {accountsBlocked && (
              <p className="subtle text-small">
                Resolve uncovered or shared slots, pending account checks, and membership changes
                before continuing.
              </p>
            )}
          </div>
        )}
        {step === 3 && (
          <div className="form-stack">
            <Callout icon="shield" title="Preview before you move.">
              Played flags from either server are preserved. Only played or unplayed status is
              migrated; resume positions, playback dates, play counts, favorites, playlists,
              ratings, profile images, and preferences are not imported. Existing Jellyfin personal
              state stays unchanged. New accounts still use your account role or template defaults.
            </Callout>
            {review.preview.source_snapshot_ids && (
              <Callout title="Saved Emby data selected.">
                This migration uses the captured snapshots shown below. Their versions stay fixed
                after approval, even if a newer capture finishes. Activity after each capture window
                is not included.
              </Callout>
            )}
            {accountGroups.map((group) => (
              <section key={group.id} className="migration-owner-summary">
                <h4>{group.id === 'independent' ? group.label : `@${group.label}`}</h4>
                {memberships.states[group.id]?.value && (
                  <p>
                    <strong>{membershipTitle(memberships.states[group.id].value!)}</strong>
                  </p>
                )}
                {memberships.states[group.id]?.value?.billing_changes && (
                  <BillingChanges changes={memberships.states[group.id].value!.billing_changes!} />
                )}
                {group.users.map((user) => (
                  <div key={user.source_user_id} className="preview-user migration-review-account">
                    <div className="preview-user-header">
                      <UserCell name={user.source_username || user.username} />
                      <span className="status">
                        {user.history_only
                          ? 'Watch history only'
                          : user.target_exists || targets[user.source_user_id]?.value
                            ? 'Merge into existing account'
                            : 'Create new account'}
                      </span>
                    </div>
                    <p>
                      Jellyfin: <strong>{targetName(user)}</strong>
                      {!user.history_only &&
                        ownerId(selections[user.source_user_id]) &&
                        ` · Account ${selections[user.source_user_id].slot}`}
                    </p>
                    {user.history_only ? (
                      <p className="subtle text-small">
                        <strong>Protected account · watch history only</strong>. Its password,
                        permissions, Home settings, and Discord ownership stay unchanged.
                        <br />
                        <span>Jellyfin account ID: {user.target_user_id}</span>
                      </p>
                    ) : user.target_exists || targets[user.source_user_id]?.value ? (
                      <p className="subtle text-small">
                        The existing Jellyfin password and account permissions will be preserved.
                      </p>
                    ) : (
                      <p className="subtle text-small">
                        A separate password is generated for this account.
                        {group.id !== 'independent'
                          ? ` New credentials are sent privately to @${group.label}.`
                          : ' Credentials can be revealed by the administrator.'}
                      </p>
                    )}
                    <details>
                      <summary>
                        History & matching details for {user.source_username || user.username}
                      </summary>
                      {user.source_snapshot && (
                        <SourceSnapshotNote snapshot={user.source_snapshot} />
                      )}
                      {user.mapping_id && (
                        <p className="subtle text-small">
                          Mapped Emby account: {user.source_username} → Jellyfin: {user.username}
                        </p>
                      )}
                      {user.warnings?.map((warning, index) => (
                        <p className="subtle text-small" key={index}>
                          {warning}
                        </p>
                      ))}
                      {user.stats ? (
                        <>
                          <div className="preview-stats">
                            <div className="preview-stat">
                              <strong>{num(user.stats.source_played)}</strong>
                              <span>Played in Emby</span>
                            </div>
                            <div className="preview-stat">
                              <strong>{num(user.stats.matched)}</strong>
                              <span>Matched to Jellyfin</span>
                            </div>
                          </div>
                          <Issues
                            label="Unmatched items"
                            items={user.unmatched}
                            count={user.stats.unmatched}
                          />
                          <Issues
                            label="Ambiguous items"
                            items={user.ambiguous}
                            count={user.stats.ambiguous}
                            ambiguous
                          />
                        </>
                      ) : (
                        <Callout title="History details deferred">
                          This lightweight review checks accounts without scanning their history.
                          Matching and played flags are read after approval. Counts and item issues
                          will appear in the migration results.
                        </Callout>
                      )}
                    </details>
                  </div>
                ))}
              </section>
            ))}
            <p className="subtle text-small">
              Starting saves only the reviewed identity, price mappings and selected account
              associations, then queues this migration. Back and Cancel do not apply these changes.
            </p>
            <button
              type="button"
              className="text-button"
              onClick={refreshPreview}
              disabled={pending}
            >
              Discard this draft and refresh the review
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function GroupPicker({
  groups,
  selected,
  change,
  disabled,
  label,
}: {
  groups: OwnerGroup[];
  selected: string;
  change: (value: string) => void;
  disabled: boolean;
  label: string;
}) {
  if (groups.length === 1)
    return <h4>{groups[0].id === 'independent' ? groups[0].label : `@${groups[0].label}`}</h4>;
  return (
    <label className="field">
      {label}
      <select value={selected} onChange={(event) => change(event.target.value)} disabled={disabled}>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.id === 'independent' ? group.label : `@${group.label}`} · {group.users.length}{' '}
            accounts
          </option>
        ))}
      </select>
    </label>
  );
}
function BillingChanges({
  changes,
}: {
  changes: NonNullable<MigrationOwnerMembership['billing_changes']>;
}) {
  return (
    <div className="subtle text-small">
      {changes.customer_links.map((customer) => (
        <p key={customer.customer_id}>
          Link Stripe customer: {customer.name || customer.email || customer.customer_id}
          {customer.name && customer.email ? ` · ${customer.email}` : ''}
        </p>
      ))}
      {changes.price_mappings.map((price) => (
        <p key={price.price_id}>
          Map {price.price_name || price.price_id} → {price.tier_name}. This price mapping applies
          globally.
        </p>
      ))}
    </div>
  );
}

function BillingPanel({
  api,
  previewId,
  group,
  state,
  draft,
  pending,
  dirty,
  update,
  check,
}: {
  api: Api;
  previewId: string;
  group: OwnerGroup;
  state?: OwnerMembershipState;
  draft: BillingDraft;
  pending: boolean;
  dirty: boolean;
  update: (value: BillingDraft, changed?: boolean) => void;
  check: (value?: MigrationBillingSelection, complimentary?: { account_limit: number }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const currentUpdate = useRef(update);
  currentUpdate.current = update;
  const checking = !!state?.loading || pending;
  const ready =
    !!state?.value && ['active', 'complimentary'].includes(state.value.status) && !dirty;
  const localPolicy = state?.value?.source === 'saved' && state.value.existing_member !== null;
  const complimentaryMode = draft.mode === 'complimentary';
  const showEditor =
    !complimentaryMode && !!state && (editing || (!ready && !localPolicy && !state.loading));
  const load = useCallback(
    (options: { cursor?: string; refresh?: boolean } = {}) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      const selected = currentDraft.current;
      void api<MigrationBillingInventory>(
        `/api/migrations/preview/${encodeURIComponent(previewId)}/billing`,
        {
          method: 'POST',
          body: {
            discord_user_id: group.id,
            ...(selected.query.trim() ? { query: selected.query.trim() } : {}),
            ...options,
          },
          signal: controller.signal,
        },
      )
        .then((inventory) => {
          if (controller.signal.aborted) return;
          const previous = currentDraft.current;
          const known = { ...previous.known };
          const ids = new Set(previous.ids);
          for (const customer of inventory.customers || []) {
            known[customer.id] = customer;
            if (customer.linked_discord_id === group.id) ids.add(customer.id);
          }
          currentUpdate.current({ ...previous, inventory, known, ids: [...ids], error: undefined });
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            currentUpdate.current({
              ...currentDraft.current,
              error:
                reason instanceof Error ? reason.message : 'Stripe customers could not be loaded.',
            });
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [api, previewId, group.id],
  );
  useEffect(() => {
    if (showEditor && !draft.inventory && !loading && !draft.error) load();
  }, [showEditor, draft.inventory, draft.error, loading, load]);
  useEffect(() => () => request.current?.abort(), []);
  const selectedCustomers = draft.ids.map((id) => draft.known[id]).filter(Boolean);
  const newLinks = selectedCustomers.filter((customer) => !customer.linked_discord_id);
  const prices = new Map<string, BillingCustomer['prices'][number]>();
  for (const customer of selectedCustomers)
    for (const price of customer.prices) prices.set(price.price_id, price);
  const unmapped = [...prices.values()].filter((price) => !price.tier_id);
  const canCheck =
    selectedCustomers.length > 0 &&
    (!newLinks.length || draft.confirmed) &&
    unmapped.every((price) => !!draft.prices[price.price_id]);
  const selectedBilling = (): MigrationBillingSelection | undefined =>
    canCheck
      ? {
          customer_ids: draft.ids,
          price_tiers: unmapped.map((price) => ({
            price_id: price.price_id,
            tier_id: draft.prices[price.price_id],
          })),
        }
      : undefined;
  const selectedComplimentary = () =>
    complimentaryMode && draft.complimentaryConfirmed
      ? { account_limit: draft.complimentaryLimit || 1 }
      : undefined;
  const recheck = () =>
    check(complimentaryMode ? undefined : selectedBilling(), selectedComplimentary());
  const invalidDraft = dirty && (complimentaryMode ? !draft.complimentaryConfirmed : !canCheck);
  return (
    <div className="form-stack">
      {!state || state.loading ? (
        <p role="status" className="subtle">
          Checking this Discord owner’s membership…
        </p>
      ) : state.error ? (
        <Callout warning title="Membership could not be checked">
          <p>{state.error}</p>
          <button
            type="button"
            className="btn"
            disabled={pending || invalidDraft}
            onClick={recheck}
          >
            Check membership again for {group.label}
          </button>
        </Callout>
      ) : (
        state.value && (
          <Callout title={membershipTitle(state.value)} warning={!ready}>
            <p>{state.value.message}</p>
            {dirty && <p>Billing choices changed. Check membership again before continuing.</p>}
            {state.value.billing_changes && (
              <BillingChanges changes={state.value.billing_changes} />
            )}
            <button
              type="button"
              className="text-button"
              disabled={checking || invalidDraft}
              onClick={recheck}
            >
              Check membership again for {group.label}
            </button>
          </Callout>
        )
      )}
      {state?.value?.existing_member === null && !localPolicy && (
        <label className="field">
          Access source
          <select
            aria-label="Access source"
            value={draft.mode || 'stripe'}
            disabled={checking}
            onChange={(event) =>
              update(
                {
                  ...draft,
                  mode: event.target.value as 'stripe' | 'complimentary',
                  complimentaryConfirmed: false,
                },
                true,
              )
            }
          >
            <option value="stripe">Stripe subscription</option>
            <option value="complimentary">Complimentary · admin managed</option>
          </select>
        </label>
      )}
      {complimentaryMode && (
        <section className="migration-owner-summary form-stack">
          <h4>Approve complimentary access</h4>
          <p className="subtle text-small">
            This allowance is managed by you. Subscription cancellations will not disable these
            accounts automatically.
          </p>
          <label className="field">
            Complimentary account allowance
            <select
              aria-label="Complimentary account allowance"
              value={draft.complimentaryLimit || 1}
              disabled={checking}
              onChange={(event) =>
                update(
                  {
                    ...draft,
                    complimentaryLimit: Number(event.target.value),
                    complimentaryConfirmed: false,
                  },
                  true,
                )
              }
            >
              {[1, 2, 3].map((limit) => (
                <option value={limit} key={limit}>
                  {limit} {limit === 1 ? 'account' : 'accounts'}
                </option>
              ))}
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              disabled={checking}
              checked={!!draft.complimentaryConfirmed}
              onChange={(event) =>
                update({ ...draft, complimentaryConfirmed: event.target.checked }, true)
              }
            />
            I approve complimentary, administrator-managed access for @{group.label}
          </label>
          <button
            type="button"
            className="btn"
            disabled={checking || !draft.complimentaryConfirmed}
            onClick={() => check(undefined, selectedComplimentary())}
          >
            Confirm complimentary access
          </button>
        </section>
      )}
      {ready && !localPolicy && !editing && !complimentaryMode && (
        <button
          type="button"
          className="text-button"
          disabled={checking}
          onClick={() => setEditing(true)}
        >
          Review Stripe customer links
        </button>
      )}
      {showEditor && (
        <section
          className="migration-owner-summary form-stack"
          aria-label={`Stripe billing for ${group.label}`}
        >
          <h4>Link this member’s Stripe billing</h4>
          <p className="subtle text-small">
            Suggestions are identity hints. Confirm the customer yourself; Discord roles do not
            prove payment. No link or price mapping is saved until the final migration approval.
          </p>
          <div className="field">
            <label htmlFor={`billing-search-${group.id}`}>Search Stripe customers</label>
            <div className="discord-picker-search">
              <input
                id={`billing-search-${group.id}`}
                value={draft.query}
                maxLength={120}
                disabled={checking || loading}
                placeholder="Name, email, or customer ID"
                onChange={(event) => update({ ...draft, query: event.target.value })}
              />
              <button
                type="button"
                className="btn"
                disabled={checking || loading}
                onClick={() => load()}
              >
                Search
              </button>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={checking || loading}
            onClick={() => load({ refresh: true })}
          >
            {loading ? 'Reading Stripe customers…' : 'Refresh Stripe customers'}
          </button>
          {draft.error && (
            <p className="error-block" role="alert">
              {draft.error}
            </p>
          )}
          {draft.inventory?.message && (
            <p className="subtle text-small">{draft.inventory.message}</p>
          )}
          {draft.inventory?.customers.map((customer) => {
            const otherOwner =
              !!customer.linked_discord_id && customer.linked_discord_id !== group.id;
            return (
              <label key={customer.id} className="migration-account-choice">
                <input
                  type="checkbox"
                  checked={draft.ids.includes(customer.id)}
                  disabled={checking || otherOwner || customer.linked_discord_id === group.id}
                  aria-label={`Stripe customer ${customer.name || customer.email || customer.id}`}
                  onChange={(event) =>
                    update(
                      {
                        ...draft,
                        ids: event.target.checked
                          ? [...draft.ids, customer.id]
                          : draft.ids.filter((id) => id !== customer.id),
                        confirmed: false,
                      },
                      true,
                    )
                  }
                />
                <span>
                  <strong>{customer.name || customer.email || customer.id}</strong>
                  {customer.name && customer.email && <small>{customer.email}</small>}
                  <small>
                    {otherOwner
                      ? `Already linked to @${customer.linked_username || customer.linked_discord_id}`
                      : customer.linked_discord_id === group.id
                        ? 'Existing confirmed link'
                        : customer.suggested
                          ? 'Suggested match · confirm ownership'
                          : 'Not linked'}
                  </small>
                  <small>
                    {customer.prices.map((price) => price.name || price.price_id).join(', ')}
                  </small>
                </span>
              </label>
            );
          })}
          {draft.inventory?.next_cursor && (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={checking || loading}
              onClick={() => load({ cursor: draft.inventory!.next_cursor! })}
            >
              More customers
            </button>
          )}
          {selectedCustomers.length > 0 && (
            <div className="form-stack">
              <p className="subtle text-small">
                Selected:{' '}
                {selectedCustomers
                  .map((customer) => customer.name || customer.email || customer.id)
                  .join(', ')}
              </p>
              {[...prices.values()].map((price) =>
                price.tier_id ? (
                  <p className="subtle text-small" key={price.price_id}>
                    {price.name || price.price_id} ·{' '}
                    {draft.inventory?.tiers.find((tier) => tier.id === price.tier_id)?.name ||
                      price.tier_id}{' '}
                    (configured)
                  </p>
                ) : (
                  <label className="field" key={price.price_id}>
                    Membership tier for {price.name || price.price_id}
                    <select
                      aria-label={`Membership tier for ${price.name || price.price_id}`}
                      value={draft.prices[price.price_id] || ''}
                      disabled={checking}
                      onChange={(event) =>
                        update(
                          {
                            ...draft,
                            prices: { ...draft.prices, [price.price_id]: event.target.value },
                          },
                          true,
                        )
                      }
                    >
                      <option value="">Choose a configured tier</option>
                      {draft.inventory?.tiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name} · {tier.account_limit}{' '}
                          {tier.account_limit === 1 ? 'account' : 'accounts'}
                        </option>
                      ))}
                    </select>
                    <small>
                      Mapping this Stripe price applies globally, including other customers using
                      this price.
                    </small>
                  </label>
                ),
              )}
              {newLinks.length > 0 && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={draft.confirmed}
                    disabled={checking}
                    onChange={(event) =>
                      update({ ...draft, confirmed: event.target.checked }, true)
                    }
                  />
                  I confirm these Stripe customers belong to @{group.label}
                </label>
              )}
              <button
                type="button"
                className="btn"
                disabled={checking || !canCheck}
                onClick={() =>
                  check({
                    customer_ids: draft.ids,
                    price_tiers: unmapped.map((price) => ({
                      price_id: price.price_id,
                      tier_id: draft.prices[price.price_id],
                    })),
                  })
                }
              >
                {checking ? 'Checking membership…' : 'Confirm billing & check membership'}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
