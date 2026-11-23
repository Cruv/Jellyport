import { useEffect, useRef, useState } from 'react';
import { discordDeliveryIssueLabel, type BotMessageHistory } from '../../server/bot-messages';
import { date, type Api, type JobResult } from './types';

function deliveryLabel(status?: string, issue?: BotMessageHistory['delivery_issue']) {
  if (status === 'sent') return 'DM sent';
  if (status === 'pending') return 'DM pending';
  return discordDeliveryIssueLabel(issue) ?? (status === 'failed' ? 'DM error' : undefined);
}

export function DiscordDeliverySummary({
  result,
}: {
  result: Pick<JobResult, 'discord_delivery' | 'delivery_issue' | 'delivery_error'>;
}) {
  const delivery = result.discord_delivery;
  const status = typeof delivery === 'string' ? delivery : delivery?.status;
  const label = deliveryLabel(status, result.delivery_issue);
  if (label) return <p>{label}</p>;
  return result.delivery_error ? <p>Discord send error</p> : null;
}

export default function BotMessageHistoryPanel({ jobId, api }: { jobId: string; api: Api }) {
  const [messages, setMessages] = useState<Omit<BotMessageHistory, 'content'>[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    current.current = null;
    setMessages(null);
    setLoading(false);
    setError('');
    return () => {
      mounted.current = false;
      current.current?.abort();
    };
  }, [jobId]);

  async function read() {
    if (current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setLoading(true);
    setError('');
    try {
      const value = await api<{ messages: Omit<BotMessageHistory, 'content'>[] }>(
        `/api/jobs/${encodeURIComponent(jobId)}/messages`,
        { signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setMessages(value.messages);
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setError('Couldn’t load Discord delivery. Try again.');
      }
    } finally {
      if (current.current === controller) current.current = null;
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <section className="form-stack" aria-label="Discord delivery" aria-busy={loading}>
      <div className="button-row">
        <h3>Discord delivery</h3>
        <button
          type="button"
          className="btn btn-small btn-quiet"
          onClick={() => void read()}
          disabled={loading}
        >
          {loading
            ? 'Loading bot messages…'
            : messages === null
              ? 'View bot messages'
              : 'Refresh bot messages'}
        </button>
      </div>
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {messages?.length === 0 && <p className="section-note">No Discord DMs recorded.</p>}
      {messages?.map((message) => {
        const label = deliveryLabel(message.status, message.delivery_issue);
        return (
          <article
            className="inline-panel form-stack"
            key={message.id}
            aria-label={`Message for ${message.account_username}`}
          >
            <strong>
              {message.account_username} · Slot {message.membership_slot}
            </strong>
            <p className="section-note">
              {message.recipient_username ? `@${message.recipient_username}` : message.recipient_id}
              {label && ` · ${label}`} · {date(message.sent_at || message.created_at)}
            </p>
          </article>
        );
      })}
    </section>
  );
}
