import type { MediaOwnership } from './media-ownership.js';
import type { Link } from './store.js';

export type MembershipAccessTarget = [slot: number, username: string, accountId: string];

export function canonicalMembershipAccessTargets(
  targets: MembershipAccessTarget[],
): MembershipAccessTarget[] {
  return [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()].sort(
    (a, b) => a[0] - b[0] || a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]),
  );
}

export function membershipAccessTargets(links: Link[], owners: MediaOwnership[]) {
  return canonicalMembershipAccessTargets([
    ...links.map(({ membership_slot, username, remote_id }): MembershipAccessTarget => [
      membership_slot,
      username,
      remote_id,
    ]),
    ...owners.flatMap(({ kind, slot, username, account_id }): MembershipAccessTarget[] =>
      kind === 'jellyfin' ? [[slot, username, account_id]] : [],
    ),
  ]);
}

export function hasMembershipAccessAboveLimit(
  links: Link[],
  owners: MediaOwnership[],
  limit: number,
) {
  return (
    links.some((link) => link.membership_slot > limit && !link.disabled_by_jellyport) ||
    owners.some(
      (owner) =>
        owner.kind === 'jellyfin' &&
        owner.slot > limit &&
        !links.some(
          (link) =>
            link.remote_id === owner.account_id &&
            link.username === owner.username &&
            link.membership_slot === owner.slot,
        ),
    )
  );
}
