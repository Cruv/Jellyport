import { useEffect, useRef, useState } from 'react';
import type { BotMessageHistory } from '../../server/bot-messages';
import { date, type Api, type JobResult } from './types';

const deliveryLabels: Record<BotMessageHistory['status'], string> = {
  sent: 'DM sent',
  failed: 'DM failed',
  uncertain: 'Check whether they got the DM',
  pending: 'DM pending',
};

export function DiscordDeliverySummary({
  result,
}: {
  result: Pick<JobResult, 'discord_delivery' | 'delivery_error'>;
}) {
  const delivery = result.discord_delivery;
  switch (typeof delivery === 'string' ? delivery : delivery?.status) {
    case 'sent':
      return <p>Discord DM sent</p>;
    case 'failed':
    case 'uncertain':
      return <p>Check whether they got the Discord DM.</p>;
    case 'pending':
      return <p>Discord DM pending</p>;
    default:
      return result.delivery_error ? (
        <div className="error-block">{result.delivery_error}</div>
      ) : null;
  }
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
      {messages?.map((message) => (
        <article
          className="inline-panel form-stack"
          key={message.id}
          aria-label={`Message for ${message.account_username}`}
        >
          <strong>
            {message.account_username} · Slot {message.membership_slot}
          </strong>
          <p className="section-note">
            {message.recipient_username ? `@${message.recipient_username}` : message.recipient_id} ·{' '}
            {deliveryLabels[message.status]} · {date(message.sent_at || message.created_at)}
          </p>
        </article>
      ))}
    </section>
  );
}
