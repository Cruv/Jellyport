/** Literal subscription formats. Only bounded, predefined capture groups are generated. */
export interface SubscriptionMessagePattern {
  action: 'subscribe' | 'cancel' | 'expire';
  template: string;
}
export const MAX_SUBSCRIPTION_MESSAGE_PATTERNS = 12;
export const MAX_SUBSCRIPTION_MESSAGE_TEMPLATE_LENGTH = 300;
const token = /\{([^{}]*)\}/g;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const user = '(?<user><@!?[0-9]{1,20}>|@?[A-Za-z0-9_.]{1,32})';
const plan = '(?<plan>[^\\r\\n]{1,100}?)';

export function validateSubscriptionMessagePatterns(
  value: unknown,
): asserts value is SubscriptionMessagePattern[] {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTION_MESSAGE_PATTERNS)
    throw new Error('Configure up to 12 trusted subscription message formats.');
  const unique = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Subscription message formats contain invalid fields.');
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(',') !== 'action,template' ||
      !['subscribe', 'cancel', 'expire'].includes(String(row.action)) ||
      typeof row.template !== 'string' ||
      !row.template.trim() ||
      row.template.length > MAX_SUBSCRIPTION_MESSAGE_TEMPLATE_LENGTH ||
      /\p{C}/u.test(row.template)
    )
      throw new Error(
        'Subscription formats need an action and one line of at most 300 printable characters.',
      );
    const names: string[] = [];
    const remainder = row.template.replace(token, (_match, key: string) => {
      if (key !== 'user' && key !== 'plan')
        throw new Error('Subscription formats support only {user} and {plan}.');
      names.push(key);
      return '';
    });
    if (
      /[{}]/.test(remainder) ||
      names.filter((name) => name === 'user').length !== 1 ||
      names.filter((name) => name === 'plan').length > 1 ||
      (row.action === 'subscribe' && !names.includes('plan')) ||
      /\}\s*\{/.test(row.template)
    )
      throw new Error(
        'Include {user} once, and {plan} once for subscriptions. Separate placeholders with literal message text.',
      );
    const key = row.template
      .trim()
      .replace(/[ \t]+/g, ' ')
      .toLocaleLowerCase();
    if (unique.has(key)) throw new Error('Each subscription message format must be unique.');
    unique.add(key);
  }
}

function compile(template: string): RegExp {
  let pattern = '^',
    previous = 0;
  const literal = (value: string) => escape(value).replace(/[ \t]+/g, '[ \\t]+');
  for (const match of template.trim().matchAll(token)) {
    pattern += literal(template.trim().slice(previous, match.index));
    pattern += match[1] === 'user' ? user : plan;
    previous = match.index + match[0].length;
  }
  pattern += literal(template.trim().slice(previous)) + '$';
  return new RegExp(pattern, 'i');
}

export function parseConfiguredSubscriptionMessage(
  content: unknown,
  patterns: SubscriptionMessagePattern[],
): { action: SubscriptionMessagePattern['action']; user: string; plan?: string } | null {
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    content.length > 500 ||
    /[\r\n]/.test(content)
  )
    return null;
  validateSubscriptionMessagePatterns(patterns);
  const matches = patterns.flatMap((row) => {
    const groups = compile(row.template).exec(content.trim())?.groups;
    if (groups && row.action === 'subscribe' && !groups.plan?.trim()) return [];
    return groups
      ? [
          {
            action: row.action,
            user: groups.user!,
            ...(groups.plan ? { plan: groups.plan.trim() } : {}),
          },
        ]
      : [];
  });
  // Overlapping formats are an ambiguity, never permission to choose a billing action.
  return matches.length === 1 ? matches[0]! : null;
}
