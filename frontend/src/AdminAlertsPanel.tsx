import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Notify } from './types';

export interface AdminAlertStatus {
  enabled: boolean;
  revision: string | null;
  recipient_username: string | null;
  recipient_id: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  pending_count: number;
  connected?: boolean;
}

export default function AdminAlertsPanel({
  api,
  notify,
  demo,
}: {
  api: Api;
  notify: Notify;
  demo: boolean;
}) {
  const [status, setStatus] = useState<AdminAlertStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const stopping = useRef(false);
  const load = useCallback(async () => {
    if (stopping.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    try {
      const value = await api<AdminAlertStatus>('/api/discord/admin-alerts', {
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(value);
      setError('');
    } catch {
      if (mounted.current && !controller.signal.aborted)
        setError('Admin alert status could not be loaded. Refresh before changing delivery.');
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      mounted.current = false;
      active.current?.abort();
      window.clearInterval(interval);
    };
  }, [load]);

  async function stop() {
    if (demo || stopping.current || !status?.revision) return;
    stopping.current = true;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const value = await api<AdminAlertStatus>('/api/discord/admin-alerts/disable', {
        method: 'POST',
        body: { expected_revision: status.revision },
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(value);
      notify('Private admin DMs stopped. Slash-command replies remain private.');
    } catch {
      if (mounted.current && !controller.signal.aborted)
        setError('Admin DMs could not be stopped. Refresh the status and try again.');
    } finally {
      stopping.current = false;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="discord-commands" aria-label="Private admin alerts">
      <h3>Private admin alerts</h3>
      <p>
        Slash-command replies are visible only to the person running the command. For automatic
        notices, run <code>/jellyport alerts action:enable</code> in your Discord server. The bot
        verifies your admin access, tests a private DM, and captures your ID automatically.
      </p>
      <p>
        One selected admin receives brief job outcomes and subscription review notices. Passwords,
        user details, and private owner notes stay out of these alerts. The bot never posts them in
        a server channel.
      </p>
      {status && (
        <div role="status">
          <strong>
            {status.enabled
              ? `Private DMs enabled for @${status.recipient_username || 'selected admin'}`
              : status.revision
                ? 'Private admin DMs are paused'
                : 'Private admin DMs are off'}
          </strong>
          {status.enabled && (
            <p>
              {status.pending_count} pending {status.pending_count === 1 ? 'notice' : 'notices'}
              {status.last_sent_at &&
                ` · Last delivered ${new Date(status.last_sent_at).toLocaleString()}`}
            </p>
          )}
          {status.last_error && <p className="error-block">{status.last_error}</p>}
          {status.enabled && status.connected === false && (
            <p className="error-block">
              The bot is offline. Pending notices will wait for it to reconnect.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-quiet" type="button" disabled={busy} onClick={() => void load()}>
          Refresh status
        </button>
        {status?.revision && (
          <button
            className="btn btn-quiet"
            type="button"
            disabled={busy || demo || !status.revision}
            onClick={() => void stop()}
          >
            {busy ? 'Stopping…' : 'Stop admin DMs'}
          </button>
        )}
      </div>
      <small>
        Use <code>/jellyport alerts action:test</code> to test your DMs, <code>action:status</code>{' '}
        to check delivery, or <code>action:disable</code> to opt out. Allow DMs from the bot;
        delivery problems appear here. Alerts are optional and start off.
      </small>
    </div>
  );
}
