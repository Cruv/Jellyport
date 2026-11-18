import { useEffect, useRef, useState } from 'react';
import type { BotMessageHistory } from '../../server/bot-messages';
import { date, type Api, type Notify } from './types';

export default function BotMessageHistoryPanel({
  jobId,
  api,
  notify,
}: {
  jobId: string;
  api: Api;
  notify: Notify;
}) {
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
      notify('Bot message history loaded.');
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setError('Bot messages could not be loaded. Refresh to try again.');
        notify('Bot message history could not be loaded.', true);
      }
    } finally {
      if (current.current === controller) current.current = null;
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <section className="form-stack" aria-label="Bot message history">
      <div className="button-row">
        <h3>Bot messages</h3>
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
      <p className="section-note">
        Delivery records show the recipient, account and delivery outcome.
      </p>
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {messages?.length === 0 && (
        <p className="section-note">
          No archived bot messages are available for this operation. Messages sent before message
          archiving was added, expired messages, and deleted archives cannot be reconstructed.
        </p>
      )}
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
            Discord recipient:{' '}
            {message.recipient_username ? `@${message.recipient_username}` : message.recipient_id} ·{' '}
            {message.status === 'sent'
              ? 'Sent'
              : message.status === 'failed'
                ? 'Delivery failed'
                : message.status === 'uncertain'
                  ? 'Delivery outcome uncertain'
                  : 'Delivery pending'}{' '}
            · {date(message.sent_at || message.created_at)}
          </p>
          {message.status !== 'sent' && (
            <p className="section-note">
              Delivery was unconfirmed. Use the operation’s credential reveal if it is still
              available.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
