/** Shared, bounded templates. No expressions, user-supplied regular expressions or markup execution. */
export const MAX_BOT_MESSAGE_TEMPLATE_LENGTH = 1200;
export const MAX_BOT_MESSAGE_LENGTH = 2000;

export const BOT_MESSAGE_CATALOG = {
  job_queued: {
    label: 'Account or migration queued',
    description: 'Private command response after an administrator starts an account operation.',
    template:
      'Job `{job_id}`: {status}.{progress_summary} Use /jellyport status to check progress.',
    placeholders: ['job_id', 'status', 'progress_summary'],
    required: ['job_id', 'status'],
    example: { job_id: 'example_job', status: 'queued', progress_summary: '' },
  },
  job_status: {
    label: 'Operation status',
    description:
      'Private response to the status command. Includes only approved job summary fields.',
    template: 'Job `{job_id}`: {status}.{progress_summary}',
    placeholders: ['job_id', 'status', 'progress_summary'],
    required: ['job_id', 'status'],
    example: {
      job_id: 'example_job',
      status: 'running',
      progress_summary: ' 1/3 users processed.',
    },
  },
  admin_digest: {
    label: 'Private administrator update',
    description: 'Status digest sent only to the administrator who enabled private notifications.',
    template: '{summary}',
    placeholders: ['summary', 'server_url'],
    required: ['summary'],
    example: {
      summary:
        'Jellyport private admin update\nAccount jobs: 2 completed.\nOpen Jellyport to review the details.',
      server_url: 'https://jellyfin.example.test',
    },
  },
  admin_test: {
    label: 'Private administrator test',
    description: 'Test sent when an administrator enables or tests private notifications.',
    template:
      'Jellyport private admin notification test. Only you receive this direct message. Admin alerts contain brief status summaries; account credentials and private owner notes are never included.',
    placeholders: ['username', 'server_url'],
    required: [],
    example: { username: 'example_admin', server_url: 'https://jellyfin.example.test' },
  },
  command_error: {
    label: 'Command error',
    description: 'Wraps the safe explanation when a bot command cannot be completed.',
    template: '{message}',
    placeholders: ['message'],
    required: ['message'],
    example: { message: 'The selected account needs administrator review in Jellyport.' },
  },
  admin_settings: {
    label: 'Private notification settings response',
    description:
      'Wraps the result of enabling, disabling, testing or checking private notifications.',
    template: '{message}',
    placeholders: ['message'],
    required: ['message'],
    example: { message: 'Private admin notifications are enabled for you.' },
  },
} as const;
export type BotMessageTemplateId = keyof typeof BOT_MESSAGE_CATALOG;
export type BotMessageTemplates = Partial<Record<BotMessageTemplateId, string>>;

export interface BotMessageReceipt {
  /** Exact content submitted to Discord, after transport escaping. */
  content: string;
  message_id?: string;
  channel_id?: string;
  sent_at?: string;
}
export interface BotMessageHistory {
  id: string;
  kind: 'credentials';
  recipient_id: string;
  recipient_username?: string;
  account_username: string;
  membership_slot: number;
  content: string;
  status: 'pending' | 'sent' | 'failed' | 'uncertain';
  created_at: string;
  sent_at?: string;
  message_id?: string;
  channel_id?: string;
}

const token = /\{([^{}]*)\}/g;
const controls = /\p{C}/u;
const hasControls = (value: string) => controls.test(value.replaceAll(/\r?\n/g, ''));

export function validateBotMessageTemplate(
  id: BotMessageTemplateId,
  value: unknown,
): asserts value is string {
  const spec = BOT_MESSAGE_CATALOG[id];
  if (
    !spec ||
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_BOT_MESSAGE_TEMPLATE_LENGTH ||
    hasControls(value)
  )
    throw new Error(
      'Bot messages must be plain text of 1–1200 characters, with line breaks only as control characters.',
    );
  const allowed: readonly string[] = spec.placeholders;
  const found = new Set<string>();
  const remainder = value.replace(token, (_match, key: string) => {
    if (!allowed.includes(key))
      throw new Error(`Supported placeholders: ${allowed.map((name) => `{${name}}`).join(', ')}.`);
    found.add(key);
    return '';
  });
  if (/[{}]/.test(remainder))
    throw new Error('Bot message placeholders must use one supported name inside braces.');
  if (spec.required.some((key) => !found.has(key)))
    throw new Error(
      `This message must include ${spec.required.map((key) => `{${key}}`).join(', ')}.`,
    );
}

export function validateBotMessageTemplates(value: unknown): asserts value is BotMessageTemplates {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Bot message templates must be an object.');
  for (const [key, template] of Object.entries(value)) {
    if (!Object.hasOwn(BOT_MESSAGE_CATALOG, key)) throw new Error('Unknown bot message template.');
    validateBotMessageTemplate(key as BotMessageTemplateId, template);
    renderBotMessage(
      key as BotMessageTemplateId,
      { [key]: template },
      BOT_MESSAGE_CATALOG[key as BotMessageTemplateId].example,
    );
  }
}

/** A replacement value is appended literally once and is never reparsed as a template. */
export function renderBotMessage(
  id: BotMessageTemplateId,
  templates: BotMessageTemplates | undefined,
  values: Readonly<Record<string, string>>,
): string {
  const spec = BOT_MESSAGE_CATALOG[id];
  const template = templates?.[id] ?? spec.template;
  validateBotMessageTemplate(id, template);
  const result = template.replace(token, (_match, key: string) => {
    const value = values[key];
    if (typeof value !== 'string' || value.length > MAX_BOT_MESSAGE_LENGTH || hasControls(value))
      throw new Error('Bot message values could not be formatted.');
    return value;
  });
  if (result.length > MAX_BOT_MESSAGE_LENGTH)
    throw new Error('The bot message is too long after inserting its values.');
  return result;
}

/** Real values can be longer than a fictional preview. Preserve a usable,
 * factual response if an override exceeds Discord's limit at delivery time. */
export function renderConfiguredBotMessage(
  id: BotMessageTemplateId,
  templates: BotMessageTemplates | undefined,
  values: Readonly<Record<string, string>>,
): string {
  try {
    return renderBotMessage(id, templates, values);
  } catch {
    return renderBotMessage(id, undefined, values);
  }
}
