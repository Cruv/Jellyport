import { useState } from 'react';
import { Modal } from './components';
import type { Api, Notify, Settings } from './types';

export const cutoverFields = [
  'discord_guild_id',
  'discord_member_role_id',
  'new_subscriber_source',
  'membership_tiers',
] as const;
type Authority = Pick<Settings, (typeof cutoverFields)[number]>;
type Household = {
  discord_user_id: string;
  username: string;
  tier_id: string | null;
  slots: number;
  proposed_slots: number | null;
  customers: number;
  authority_state: 'current' | 'held' | 'legacy';
  accounts: Array<{ kind: 'emby' | 'jellyfin'; id: string | null; username: string; slot: number }>;
};
export type AuthorityCutover = {
  current: Authority;
  proposed: Authority;
  affected: Household[];
  review_token: string;
};
type HouseholdReview = {
  discord_user_id: string;
  username: string;
  guild_id: string;
  role_id: string;
  has_role: boolean | null;
  tier_id: string | null;
  slots: number;
  accounts: Array<{
    id: string;
    username: string;
    slot: number;
    disabled: boolean;
    pending: boolean;
  }>;
  review_token: string;
};

export function AuthorityCutoverDialog({
  review,
  finish,
}: {
  review: AuthorityCutover;
  finish: (approved: boolean) => void;
}) {
  const disconnectsAuthority =
    review.current.discord_guild_id !== review.proposed.discord_guild_id ||
    review.current.discord_member_role_id !== review.proposed.discord_member_role_id;
  return (
    <Modal
      title="Review affected households"
      description={
        disconnectsAuthority
          ? 'Saving this Discord server or role change preserves account access and holds automation for these linked households until you review them.'
          : 'Review the current accounts and paid slots before saving changes to billing authority or membership tiers.'
      }
      close={() => finish(false)}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={() => finish(false)}>
            Keep editing
          </button>
          <button type="button" className="btn btn-primary" onClick={() => finish(true)}>
            Approve and save settings
          </button>
        </>
      }
    >
      {disconnectsAuthority && (
        <p>
          Proposed Discord server {review.proposed.discord_guild_id || 'unset'} · Subscriber role{' '}
          {review.proposed.discord_member_role_id || 'unset'}
        </p>
      )}
      <p>{review.affected.length} affected households</p>
      <ul className="authority-households">
        {review.affected.map((row) => (
          <li key={row.discord_user_id}>
            <strong>{row.username}</strong> <span className="subtle">{row.discord_user_id}</span>
            <p>
              {row.tier_id ?? 'No saved tier'} · {row.slots} current slots
              {row.proposed_slots !== null ? ` · ${row.proposed_slots} proposed slots` : ''}
              {row.customers ? ` · ${row.customers} linked Stripe customers` : ''}
            </p>
            {row.accounts.length > 0 && (
              <ul>
                {row.accounts.map((account) => (
                  <li key={`${account.kind}:${account.id ?? account.username}`}>
                    {account.kind === 'emby' ? 'Emby' : 'Jellyfin'} {account.username} · Slot{' '}
                    {account.slot}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export default function DiscordAuthorityPanel({ api, notify }: { api: Api; notify: Notify }) {
  const [households, setHouseholds] = useState<Household[] | null>(null);
  const [review, setReview] = useState<HouseholdReview | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const data = await api<{ households: Household[] }>('/api/discord/authority/households');
      setHouseholds(data.households);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Households could not be loaded.', true);
    } finally {
      setBusy(false);
    }
  }
  async function reviewHousehold(id: string) {
    setBusy(true);
    try {
      setReview(
        await api<HouseholdReview>(`/api/discord/authority/households/${id}/review`, {
          method: 'POST',
        }),
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'This household could not be reviewed.',
        true,
      );
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!review) return;
    setBusy(true);
    try {
      await api(`/api/discord/authority/households/${review.discord_user_id}/approve`, {
        method: 'POST',
        body: { review_token: review.review_token },
      });
      setHouseholds(
        (current) =>
          current?.filter((row) => row.discord_user_id !== review.discord_user_id) ?? null,
      );
      setReview(null);
      notify('Discord authority approved. Account access was preserved.');
    } catch (error) {
      setReview(null);
      notify(
        error instanceof Error ? error.message : 'Discord authority could not be approved.',
        true,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="discord-authority-title">
      <h3 id="discord-authority-title">Existing household authority</h3>
      <p className="subtle">
        Review households held after a server or role change and older links with unknown origin.
      </p>
      <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void load()}>
        {households ? 'Refresh held households' : 'Find households to review'}
      </button>
      {households?.length === 0 && <p>No households need an authority review.</p>}
      {!!households?.length && (
        <ul className="authority-households">
          {households.map((row) => (
            <li key={row.discord_user_id}>
              <strong>{row.username}</strong> <span className="subtle">{row.discord_user_id}</span>
              <p>
                {row.authority_state === 'legacy' ? 'Unknown origin' : 'Previous Discord authority'}{' '}
                · {row.slots} saved slots
              </p>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => void reviewHousehold(row.discord_user_id)}
              >
                Review {row.username}
              </button>
            </li>
          ))}
        </ul>
      )}
      {review && (
        <Modal
          title={`Review ${review.username}`}
          description="Approve the verified member and linked accounts under the current authority. Future automation can evaluate this household."
          closeDisabled={busy}
          close={() => {
            if (!busy) setReview(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void approve()}
              >
                Approve household authority
              </button>
            </>
          }
        >
          <p>
            Discord member {review.discord_user_id} · Server {review.guild_id}
          </p>
          <p>
            {review.role_id
              ? `Subscriber role ${review.role_id} ${review.has_role ? 'is present' : 'is absent'}`
              : 'No subscriber role configured'}{' '}
            · {review.slots} saved slots
          </p>
          {!!review.accounts.length && (
            <ul>
              {review.accounts.map((account) => (
                <li key={account.id}>
                  Jellyfin {account.username} · Slot {account.slot} ·{' '}
                  {account.disabled ? 'Disabled' : 'Enabled'}
                  {account.pending ? ' · Pending access recovery' : ''}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </section>
  );
}
