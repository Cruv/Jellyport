import {
  BOT_MESSAGE_CATALOG,
  MAX_BOT_MESSAGE_TEMPLATE_LENGTH,
  renderBotMessage,
  type BotMessageTemplateId,
  type BotMessageTemplates,
} from '../../server/bot-messages';

export default function BotMessagesSettings({
  templates,
  change,
  selected,
  select,
  retention,
  changeRetention,
  reset,
}: {
  templates: BotMessageTemplates;
  change: (value: BotMessageTemplates) => void;
  selected: BotMessageTemplateId;
  select: (value: BotMessageTemplateId) => void;
  retention: string;
  changeRetention: (value: string) => void;
  reset: () => void;
}) {
  const spec = BOT_MESSAGE_CATALOG[selected];
  const template = templates[selected] ?? spec.template;
  let preview = '',
    error = '';
  try {
    preview = renderBotMessage(selected, templates, spec.example);
  } catch (value) {
    error = value instanceof Error ? value.message : 'Check this message template.';
  }
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Bot messages and delivery history</h3>
          <p>
            Customize outgoing text and how long exact account messages are kept for administrators.
          </p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <p className="section-note">
          These templates work with Jellyport’s Discord bot regardless of your subscription
          provider. Configure the account-holder message under Account defaults → Passwords &amp;
          messages. Subscription announcements are an optional input, separate from outgoing bot
          messages.
        </p>
        <div className="field">
          <label htmlFor="bot-message-kind">Message to customize</label>
          <select
            id="bot-message-kind"
            value={selected}
            onChange={(event) => select(event.target.value as BotMessageTemplateId)}
          >
            {(
              Object.entries(BOT_MESSAGE_CATALOG) as Array<[BotMessageTemplateId, typeof spec]>
            ).map(([id, value]) => (
              <option key={id} value={id}>
                {value.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="setting-bot_message_templates">{spec.label} text</label>
          <textarea
            id="setting-bot_message_templates"
            rows={6}
            value={template}
            maxLength={MAX_BOT_MESSAGE_TEMPLATE_LENGTH}
            onChange={(event) => change({ ...templates, [selected]: event.target.value })}
            aria-describedby="bot-message-help"
          />
          <small id="bot-message-help">
            {spec.description} Supported placeholders:{' '}
            {spec.placeholders.map((key) => `{${key}}`).join(', ')}. Up to 1,200 characters; no code
            or custom regular expressions.{' '}
            {spec.required.length
              ? `Required: ${spec.required.map((key) => `{${key}}`).join(', ')}.`
              : ''}
          </small>
          <button type="button" className="btn btn-small btn-quiet" onClick={reset}>
            Reset selected bot message
          </button>
        </div>
        <div className="inline-panel form-stack" aria-label="Bot message preview">
          <strong>Message preview · fictional example</strong>
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            <pre className="credential-message">{preview}</pre>
          )}
        </div>
        <div className="field">
          <label htmlFor="setting-bot_message_retention_days">
            Bot message history retention (days)
          </label>
          <input
            id="setting-bot_message_retention_days"
            type="number"
            min={0}
            max={3650}
            step={1}
            inputMode="numeric"
            value={retention}
            onChange={(event) => changeRetention(event.target.value)}
          />
          <small>
            Default: 30 days. Use 0 to keep indefinitely, up to 3,650 days otherwise. Exact account
            messages include passwords, are encrypted at rest, and are visible in full to signed-in
            Jellyport administrators under Activity. Deleting a report also deletes its archived
            messages. This does not extend temporary account-recovery credentials or recover older
            deleted messages.
          </small>
        </div>
      </div>
    </section>
  );
}
