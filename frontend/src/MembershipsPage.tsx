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
  const tier = tiers.find((item) => item.id === tierId);
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
  }
  function showReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member || !tier || !loaded || loading || busyRef.current) return;
    setError('');
    setReview({ member, existing, tier: { ...tier }, usernames });
  }
  async function provision() {
    if (!review || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const job = await api<Job>('/api/memberships/provision', {
        method: 'POST',
        body: {
          discord_user_id: review.member.id,
          tier_id: review.tier.id,
          expected_account_limit: review.tier.account_limit,
          expected_usernames: review.usernames,
          ...(review.existing?.revision ? { expected_revision: review.existing.revision } : {}),
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

  return (
    <>
      <Heading
        title="One membership, every entitled account."
        description="Manage multiple Jellyfin accounts for the same Discord owner."
        actions={
          <button className="btn" onClick={() => void reload()} disabled={busy || loading}>
            <Icon name="refresh" /> Refresh
          </button>
        }
      />
      <Callout icon="shield" title="Account access is reviewed before changing.">
        New accounts receive the default account role and their own generated password, delivered
        privately to the Discord owner. Downgrades disable extra accounts and preserve their data.
        Upgrades can restore those same accounts when Jellyport disabled them.
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
              <DiscordMemberPicker
                api={api}
                value={member}
                onChange={selectMember}
                disabled={busy || loading}
              />
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
                  Tier names, trusted subscription plan names, and account limits can be changed in
                  Settings.
                </small>
              </div>
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
                        {tiers.find((entry) => entry.id === item.tier_id)?.name || item.tier_id}
                        <small>
                          {item.active === false
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
            Expired memberships disable all linked account slots when the expiration event is
            applied.
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
