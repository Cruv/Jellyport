import { useState, type FormEvent } from 'react';
import DiscordMemberPicker from './DiscordMemberPicker';
import { Callout, Icon, Issues, Modal, SourceSnapshotNote, UserCell } from './components';
import { num, type Api, type DiscordMember, type Preview, type PreviewUser } from './types';

type Selection = { member: DiscordMember | null; manual: string; slot: number };
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
  };
}
function ownerId(value: Selection): string {
  return value.member?.id || value.manual.trim();
}

export default function MigrationPreviewDialog({
  review,
  api,
  close,
  startMigration,
  refreshPreview,
  busy,
}: {
  review: { preview: Preview; previewId: string; reviewElapsedMs?: number };
  api: Api;
  close: () => void;
  startMigration: (event: FormEvent<HTMLFormElement>) => void;
  refreshPreview: () => void;
  busy: Set<string>;
}) {
  const [selections, setSelections] = useState<Record<string, Selection>>(() =>
    Object.fromEntries(
      review.preview.users.map((user) => [user.source_user_id, initialSelection(user)]),
    ),
  );
  const groups = new Map<string, PreviewUser[]>();
  for (const user of review.preview.users) {
    if (user.history_only) continue;
    const selection = selections[user.source_user_id];
    const owner = ownerId(selection);
    if (!owner) continue;
    const key = `${owner}:${selection.slot}`;
    groups.set(key, [...(groups.get(key) || []), user]);
  }
  const conflicts = new Map<string, string>();
  for (const users of groups.values()) {
    if (users.length < 2) continue;
    for (const user of users)
      conflicts.set(
        user.source_user_id,
        `Account slot ${selections[user.source_user_id].slot} is also selected for ${users
          .filter((other) => other !== user)
          .map((other) => other.username)
          .join(', ')}. Choose a different slot for this owner.`,
      );
  }
  const users = review.preview.users;
  return (
    <Modal
      title="Review your migration"
      description={`${users.length} ${users.length === 1 ? 'user' : 'users'} selected · played status only`}
      wide
      close={close}
      footer={
        <>
          <button className="btn btn-quiet" onClick={close} disabled={busy.has('migration')}>
            Back to users
          </button>
          <button
            className="btn btn-quiet"
            onClick={refreshPreview}
            disabled={busy.has('migration')}
          >
            Refresh review
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="migration-preview-form"
            disabled={busy.has('migration') || conflicts.size > 0}
          >
            {busy.has('migration') ? <span className="spinner" /> : <Icon name="migrate" />}
            {busy.has('migration') ? 'Starting migration…' : 'Start migration'}
          </button>
        </>
      }
    >
      {review.reviewElapsedMs !== undefined && (
        <p className="subtle text-small">
          Review build: {(review.reviewElapsedMs / 1000).toFixed(1)} seconds. This is included in
          the combined migration timing after approval; time spent reviewing is excluded.
        </p>
      )}
      <Callout icon="shield" title="Preview before you move.">
        Played flags from either server are preserved. Only played or unplayed status is migrated;
        resume positions, playback dates, play counts, favorites, playlists, ratings, profile
        images, and preferences are not imported. Existing Jellyfin personal state stays unchanged.
        New accounts still use your account role or template defaults. Unmatched and ambiguous items
        appear in the results and are not changed.
      </Callout>
      {review.preview.source_snapshot_ids && (
        <Callout icon="info" title="Saved Emby data selected.">
          This migration uses the captured snapshots shown below. Their versions stay fixed after
          approval, even if a newer capture finishes. Activity after each capture window is not
          included.
        </Callout>
      )}
      <form
        id="migration-preview-form"
        onSubmit={(event) => {
          if (conflicts.size) {
            event.preventDefault();
            return;
          }
          startMigration(event);
        }}
      >
        <Callout icon="info" title="One member can own several accounts.">
          Select the same Discord member for their accounts, then choose a different account slot
          for each. Slots group ownership and delivery; account names stay unchanged.
        </Callout>
        {conflicts.size > 0 && (
          <Callout warning title="Choose a separate account slot.">
            These accounts share a Discord owner and slot. Choose account 1, 2, or 3 for each before
            starting.
          </Callout>
        )}
        {users.map((user) => (
          <section className="preview-user" key={user.source_user_id}>
            <div className="preview-user-header">
              <UserCell name={user.username} />
              <span className={`status ${user.target_exists ? '' : 'good'}`}>
                {user.history_only
                  ? 'Watch history only'
                  : user.target_exists
                    ? 'Merge into existing account'
                    : 'Create new account'}
              </span>
            </div>
            {user.history_only && (
              <Callout icon="shield" title="Protected account · watch history only">
                Add played flags to this existing administrator or template account. Its password,
                permissions, Home settings, and Discord ownership stay unchanged.
                <p className="text-small">Jellyfin account ID: {user.target_user_id}</p>
              </Callout>
            )}
            {user.mapping_id && (
              <p className="subtle text-small">
                Mapped Emby account: {user.source_username} → Jellyfin: {user.username}
              </p>
            )}
            {user.source_snapshot && <SourceSnapshotNote snapshot={user.source_snapshot} />}
            {user.stats ? (
              <div className="preview-stats">
                {[
                  { value: user.stats.source_played, label: 'Played in Emby', color: '' },
                  { value: user.stats.matched, label: 'Matched to Jellyfin', color: 'mint' },
                  {
                    value: user.stats.unmatched,
                    label: 'Unmatched',
                    color: user.stats.unmatched ? '' : 'muted',
                  },
                  {
                    value: user.stats.ambiguous,
                    label: 'Ambiguous',
                    color: user.stats.ambiguous ? '' : 'muted',
                  },
                ].map((stat) => (
                  <div className="preview-stat" key={stat.label}>
                    <strong className={stat.color}>{num(stat.value)}</strong>
                    <span>{stat.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Callout icon="info" title="History details deferred">
                This lightweight review checks accounts without scanning their history. Matching and
                played flags are read after approval. Counts and item issues will appear in the
                migration results.
              </Callout>
            )}
            <div className="preview-user-body">
              {user.warnings?.map((warning, index) => (
                <p className="subtle text-small" key={index}>
                  {warning}
                </p>
              ))}
              {!!user.stats?.already_played && (
                <p className="subtle text-tiny mb-14">
                  {num(user.stats.already_played)} matched items are already played on Jellyfin.
                </p>
              )}
              {user.stats && (
                <>
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
              )}
              {user.target_exists && (
                <p className="subtle text-tiny mb-14">
                  The existing Jellyfin password and account permissions will be preserved.
                </p>
              )}
              {!user.history_only && (
                <MigrationRecipient
                  key={`${user.source_user_id}:${user.mapping_revision || ''}`}
                  user={user}
                  api={api}
                  value={selections[user.source_user_id]}
                  conflict={conflicts.get(user.source_user_id)}
                  pending={busy.has('migration')}
                  onChange={(value) =>
                    setSelections((current) => ({ ...current, [user.source_user_id]: value }))
                  }
                />
              )}
            </div>
          </section>
        ))}
      </form>
    </Modal>
  );
}

function MigrationRecipient({
  user,
  api,
  value,
  onChange,
  conflict,
  pending,
}: {
  user: PreviewUser;
  api: Api;
  value: Selection;
  onChange: (value: Selection) => void;
  conflict?: string;
  pending: boolean;
}) {
  const mapped = !!user.discord_user_id && (!!user.mapping_id || !!user.owner_basis);
  const hasOwner = !!ownerId(value);
  const slotId = `membership-slot-${user.source_user_id}`;
  const helpId = `${slotId}-help`;
  const errorId = `${slotId}-error`;
  return (
    <>
      <DiscordMemberPicker
        api={api}
        value={value.member}
        onChange={(member) => onChange({ ...value, member, manual: '' })}
        suggestedQuery={
          user.discord_username || user.owner_search || user.source_username || user.username
        }
        disabled={mapped || pending}
        label={
          user.membership_slot
            ? `Discord owner · account ${user.membership_slot}`
            : 'Discord recipient (optional)'
        }
        id={`recipient-${user.source_user_id}`}
        inputName={user.source_user_id}
      />
      <p className="subtle text-tiny">
        {mapped
          ? user.owner_basis === 'numbered_suggestion'
            ? 'Starting confirms this suggested owner and account slot. Every new household account sends its own credentials to this same owner. Save a user mapping to choose a different owner.'
            : 'This member and account slot are confirmed by your saved mapping or ownership review. Edit the mapping to change them.'
          : user.target_exists
            ? 'Select a member to link membership management. Existing credentials are preserved.'
            : 'Select a member for private credential delivery. The selected owner can receive credentials for several differently named accounts.'}
      </p>
      {!mapped && (
        <details>
          <summary>Advanced Discord details</summary>
          <div className="field">
            <label htmlFor={`manual-recipient-${user.source_user_id}`}>
              Discord recipient ID (advanced)
            </label>
            <input
              id={`manual-recipient-${user.source_user_id}`}
              name={`manual-${user.source_user_id}`}
              disabled={!!value.member || pending}
              value={value.manual}
              onChange={(event) => onChange({ ...value, manual: event.target.value })}
              inputMode="numeric"
              pattern="[0-9]{15,22}"
              maxLength={22}
              autoComplete="off"
            />
          </div>
        </details>
      )}
      {hasOwner && (
        <div className="field">
          <label htmlFor={slotId}>Membership account slot for {user.username}</label>
          <select
            id={slotId}
            name={mapped ? undefined : `slot-${user.source_user_id}`}
            value={value.slot}
            disabled={mapped || pending}
            onChange={(event) => onChange({ ...value, slot: Number(event.target.value) })}
            aria-invalid={!!conflict}
            aria-describedby={`${helpId}${conflict ? ` ${errorId}` : ''}`}
          >
            {[1, 2, 3].map((slot) => (
              <option key={slot} value={slot}>
                Account {slot}
              </option>
            ))}
          </select>
          <small id={helpId}>
            {mapped
              ? 'Change a confirmed slot through User mappings or Identity & gaps, then refresh this review.'
              : 'Use a distinct slot for each account belonging to this Discord member. Slots 2 and 3 need an active membership or complimentary allowance covering that slot. Account names and allowances stay unchanged.'}
          </small>
          {conflict && (
            <p id={errorId} className="error-block" role="alert">
              {conflict}
            </p>
          )}
        </div>
      )}
    </>
  );
}
