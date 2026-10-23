import { useState } from 'react';
import {
  MAX_SUBSCRIPTION_MESSAGE_PATTERNS,
  MAX_SUBSCRIPTION_MESSAGE_TEMPLATE_LENGTH,
  parseConfiguredSubscriptionMessage,
  type SubscriptionMessagePattern,
} from '../../server/subscription-messages';

export default function SubscriptionMessageFormats({
  formats,
  change,
}: {
  formats: SubscriptionMessagePattern[];
  change: (value: SubscriptionMessagePattern[]) => void;
}) {
  const [example, setExample] = useState('example.user subscribed to Example Plan');
  let parsed = '',
    error = '';
  try {
    const value = formats.length ? parseConfiguredSubscriptionMessage(example, formats) : null;
    parsed = value
      ? `${value.action} · ${value.user}${value.plan ? ` · ${value.plan}` : ''}`
      : formats.length
        ? 'No unambiguous format matched.'
        : 'No custom formats: built-in legacy announcements remain enabled.';
  } catch (value) {
    error = value instanceof Error ? value.message : 'Check the configured formats.';
  }
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Trusted subscription message formats</h3>
          <p>Optional announcement parsing when you use a separate subscription bot.</p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <p className="section-note">
          Stripe does not require these messages. When message watching is enabled, only the
          configured bot in the configured server and channel is trusted. These formats do not
          change that restriction. Leave the list empty to retain built-in legacy subscription
          announcements.
        </p>
        {formats.map((format, index) => (
          <fieldset className="form-stack inline-panel" key={index}>
            <legend>Message format {index + 1}</legend>
            <div className="field">
              <label htmlFor={`subscription-format-action-${index}`}>
                Action for message format {index + 1}
              </label>
              <select
                id={`subscription-format-action-${index}`}
                value={format.action}
                onChange={(event) =>
                  change(
                    formats.map((row, at) =>
                      at === index
                        ? {
                            ...row,
                            action: event.target.value as SubscriptionMessagePattern['action'],
                          }
                        : row,
                    ),
                  )
                }
              >
                <option value="subscribe">Subscribe</option>
                <option value="cancel">Cancel</option>
                <option value="expire">Expire</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`subscription-format-text-${index}`}>
                Text for message format {index + 1}
              </label>
              <input
                id={`subscription-format-text-${index}`}
                value={format.template}
                maxLength={MAX_SUBSCRIPTION_MESSAGE_TEMPLATE_LENGTH}
                onChange={(event) =>
                  change(
                    formats.map((row, at) =>
                      at === index ? { ...row, template: event.target.value } : row,
                    ),
                  )
                }
              />
              <small>
                Use {'{user}'} once for the Discord mention or actual username. Subscribe formats
                also need {'{plan}'} once. Everything else is literal text; case and repeated spaces
                are ignored. No regular expressions.
              </small>
            </div>
            <button
              type="button"
              className="btn btn-small btn-quiet"
              onClick={() => change(formats.filter((_row, at) => at !== index))}
            >
              Remove message format {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="btn btn-small btn-quiet"
          disabled={formats.length >= MAX_SUBSCRIPTION_MESSAGE_PATTERNS}
          onClick={() =>
            change([...formats, { action: 'subscribe', template: '{user} subscribed to {plan}' }])
          }
        >
          Add message format
        </button>
        <details className="help-disclosure">
          <summary>Test a fictional subscription message</summary>
          <div className="form-stack">
            <div className="field">
              <label htmlFor="subscription-format-example">Fictional announcement</label>
              <input
                id="subscription-format-example"
                value={example}
                maxLength={500}
                onChange={(event) => setExample(event.target.value)}
              />
            </div>
            <p aria-label="Subscription format preview" role={error ? 'alert' : undefined}>
              {error || parsed}
            </p>
            <small>This preview does not verify a real member or change access.</small>
          </div>
        </details>
      </div>
    </section>
  );
}
