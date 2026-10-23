/** Bounded literal formats, shared by provisioning, reviewed matching and the UI.
 * No regular expressions or executable expressions are accepted from settings. */
export interface AccountNaming {
  account_name_primary?: string;
  account_name_additional?: string;
  account_name_aliases?: string[];
}
export const DEFAULT_PRIMARY_NAME = '{username}';
export const DEFAULT_ADDITIONAL_NAME = '{username}_{slot}';
const invalid = /[\u0000-\u001f\u007f\\/<>]/;

function formatParts(format: string, additional: boolean): string[] {
  if (
    typeof format !== 'string' ||
    !format ||
    format !== format.trim() ||
    format.length > 128 ||
    invalid.test(format) ||
    format.split('{username}').length !== 2 ||
    format.split('{slot}').length !== (additional ? 2 : 1) ||
    /[{}]/.test(format.replace('{username}', '').replace('{slot}', ''))
  )
    throw new Error(
      'Account naming formats need one {username}, and additional account formats need one {slot}. Use printable literal text without slashes or angle brackets.',
    );
  return format.split(/(\{username\}|\{slot\})/);
}
function render(format: string, base: string, slot: number): string {
  return format.replace(/\{username\}|\{slot\}/g, (token) =>
    token === '{username}' ? base : String(slot),
  );
}
export function renderAccountUsername(
  base: string,
  slot: number,
  policy: AccountNaming = {},
): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > 3)
    throw new Error('Membership account slots must be between 1 and 3.');
  if (
    typeof base !== 'string' ||
    !base ||
    base !== base.trim() ||
    invalid.test(base) ||
    [...base].length > 64
  )
    throw new Error(
      'Use a membership base username of 1–64 printable characters without slashes or angle brackets.',
    );
  const format =
    slot === 1
      ? (policy.account_name_primary ?? DEFAULT_PRIMARY_NAME)
      : (policy.account_name_additional ?? DEFAULT_ADDITIONAL_NAME);
  formatParts(format, slot !== 1);
  const result = render(format, base, slot);
  if ([...result].length > 64)
    throw new Error(
      'The account username is too long: account formats must produce at most 64 characters. Choose a shorter base username or format.',
    );
  return result;
}
function extract(format: string, name: string, slot: number, additional: boolean): string | null {
  const parts = formatParts(format, additional);
  const marker = parts.indexOf('{username}');
  const before = parts.slice(0, marker).join('').replace('{slot}', String(slot));
  const after = parts
    .slice(marker + 1)
    .join('')
    .replace('{slot}', String(slot));
  if (
    !name.startsWith(before) ||
    !name.endsWith(after) ||
    name.length <= before.length + after.length
  )
    return null;
  const base = name.slice(before.length, after ? -after.length : undefined);
  return !invalid.test(base) && base === base.trim() && render(format, base, slot) === name
    ? base
    : null;
}
/** A naming hint is never identity authority. Exact Discord identities and saved
 * owner/slot decisions must be checked before approving a numbered match. */
export function parseAccountUsername(
  name: string,
  policy: AccountNaming = {},
): { base: string; slot: number } | null {
  if (typeof name !== 'string' || !name || invalid.test(name) || [...name].length > 64) return null;
  const hits = new Map<string, { base: string; slot: number }>();
  for (const format of [
    policy.account_name_additional ?? DEFAULT_ADDITIONAL_NAME,
    ...(policy.account_name_aliases ?? []),
  ])
    for (const slot of [2, 3]) {
      const base = extract(format, name, slot, true);
      if (base) hits.set(JSON.stringify([base, slot]), { base, slot });
    }
  if (hits.size > 1) return null;
  if (hits.size === 1) return [...hits.values()][0]!;
  const base = extract(policy.account_name_primary ?? DEFAULT_PRIMARY_NAME, name, 1, false);
  return base ? { base, slot: 1 } : null;
}
export function validateAccountNaming(policy: AccountNaming): void {
  formatParts(policy.account_name_primary ?? DEFAULT_PRIMARY_NAME, false);
  formatParts(policy.account_name_additional ?? DEFAULT_ADDITIONAL_NAME, true);
  if (
    !Array.isArray(policy.account_name_aliases ?? []) ||
    (policy.account_name_aliases?.length ?? 0) > 8
  )
    throw new Error('Provide at most eight legacy additional account formats.');
  const aliases = policy.account_name_aliases ?? [];
  if (new Set(aliases).size !== aliases.length)
    throw new Error('Legacy account naming formats must be unique.');
  for (const format of aliases) formatParts(format, true);
  for (const base of ['member', 'member_2', 'member{slot}', '2']) {
    const names = [1, 2, 3].map((slot) => renderAccountUsername(base, slot, policy));
    if (new Set(names.map((name) => name.toLowerCase())).size !== 3)
      throw new Error('Account formats must produce a different username for each account slot.');
    for (const slot of [2, 3]) {
      const parsed = parseAccountUsername(names[slot - 1]!, policy);
      if (!parsed || parsed.base !== base || parsed.slot !== slot)
        throw new Error(
          'Account naming formats overlap ambiguously. Choose distinct literal separators.',
        );
    }
  }
}
