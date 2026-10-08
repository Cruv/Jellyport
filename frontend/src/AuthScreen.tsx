import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon, Loading } from './components';
import { type Api, type Session, type SetupConnection } from './types';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The operation could not be completed.';

export default function AuthScreen({
  session,
  initialError,
  api,
  onSession,
}: {
  session: Session | null;
  initialError: string;
  api: Api;
  onSession: (session: Session) => void;
}) {
  const [connection, setConnection] = useState<SetupConnection | null>(null);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState('');
  const [sessionRetry, setSessionRetry] = useState(0);
  const busyRef = useRef(false);
  const requestVersion = useRef(0);
  const setup = !!session?.setup_required;
  const templates = (connection?.templates || []).filter(
    (user) => !user.Policy?.IsAdministrator && !user.Policy?.IsDisabled,
  );

  useEffect(() => {
    setError(initialError);
  }, [initialError]);
  useEffect(() => {
    if (!session?.setup_required) setConnection(null);
  }, [session?.setup_required]);
  useEffect(() => {
    if (session) return;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    busyRef.current = true;
    setBusy('session');
    void api<Session>('/api/session', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && requestVersion.current === version) {
          setError('');
          setBusy('');
          onSession(value);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted && requestVersion.current === version) {
          setError(errorMessage(reason));
          setBusy('');
        }
      })
      .finally(() => {
        if (requestVersion.current === version) busyRef.current = false;
      });
    return () => controller.abort();
  }, [api, onSession, session, sessionRetry]);
  useEffect(() => {
    if (!session?.setup_required || !session.setup_connected || connection) return;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setBusy('resume');
    void api<SetupConnection>('/api/setup', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && requestVersion.current === version) {
          setBusy('');
          onSession(value.session);
          setConnection(value);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted && requestVersion.current === version)
          setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestVersion.current === version) setBusy('');
      });
    return () => controller.abort();
  }, [api, onSession, session?.setup_required, session?.setup_connected, connection]);
  useEffect(
    () => () => {
      requestVersion.current++;
    },
    [],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = setup
      ? {
          jellyfin_url: String(data.get('jellyfin_url') || '').trim(),
          username: String(data.get('username') || '').trim(),
          password: String(data.get('password') || ''),
        }
      : {
          username: String(data.get('username') || '').trim(),
          password: String(data.get('password') || ''),
        };
    // Remove secrets from the visible form even when the server rejects the request.
    const passwordField = form.elements.namedItem('password');
    if (passwordField instanceof HTMLInputElement) passwordField.value = '';
    busyRef.current = true;
    setBusy(setup ? 'connect' : 'login');
    setError('');
    const version = ++requestVersion.current;
    try {
      if (setup) {
        const current = await api<Session>('/api/session');
        if (requestVersion.current !== version) return;
        onSession(current);
        if (!current.setup_required) return;
        const value = await api<SetupConnection>('/api/setup/connect', {
          method: 'POST',
          body,
        });
        if (requestVersion.current !== version) return;
        onSession(value.session);
        setConnection(value);
      } else {
        const anonymous = await api<Session>('/api/session');
        if (requestVersion.current !== version) return;
        // A retained cookie after failed sign-out supplies CSRF, not renewed console access.
        onSession({ ...anonymous, authenticated: false, user: undefined });
        if (anonymous.setup_required) return;
        const value = await api<Session>('/api/login', { method: 'POST', body });
        if (requestVersion.current !== version) return;
        if (!value.authenticated)
          throw new Error(
            'Sign-in was not successful. Use an enabled Jellyfin administrator account.',
          );
        onSession(value);
      }
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      busyRef.current = false;
      if (requestVersion.current === version) setBusy('');
    }
  }
  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const data = new FormData(event.currentTarget);
    busyRef.current = true;
    setBusy('complete');
    setError('');
    const version = ++requestVersion.current;
    try {
      const current = await api<Session>('/api/session');
      if (requestVersion.current !== version) return;
      onSession(current);
      if (current.authenticated) return;
      if (!current.setup_required || !current.setup_connected) {
        setConnection(null);
        throw new Error('Setup session expired. Connect Jellyfin again.');
      }
      const value = await api<Session>('/api/setup/complete', {
        method: 'POST',
        body: {
          template_user_id: String(data.get('template_user_id') || ''),
          jellyfin_public_url: String(data.get('jellyfin_public_url') || '').trim(),
        },
      });
      if (requestVersion.current !== version) return;
      if (!value.authenticated) throw new Error('Setup was not completed. Try again.');
      onSession(value);
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      busyRef.current = false;
      if (requestVersion.current === version) setBusy('');
    }
  }
  async function refresh() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('refresh');
    setError('');
    const version = ++requestVersion.current;
    try {
      const value = await api<SetupConnection>('/api/setup');
      if (requestVersion.current !== version) return;
      onSession(value.session);
      setConnection(value);
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      busyRef.current = false;
      if (requestVersion.current === version) setBusy('');
    }
  }
  async function reconnect() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('reconnect');
    setError('');
    const version = ++requestVersion.current;
    try {
      const current = await api<Session>('/api/session');
      if (requestVersion.current !== version) return;
      onSession(current);
      const value = await api<Session>('/api/logout', { method: 'POST', body: {} });
      if (requestVersion.current !== version) return;
      onSession(value);
      setConnection(null);
    } catch (reason) {
      if (requestVersion.current === version) setError(errorMessage(reason));
    } finally {
      busyRef.current = false;
      if (requestVersion.current === version) setBusy('');
    }
  }
  return (
    <main className="login-screen">
      <div className={`login-card${setup ? ' setup-card' : ''}`}>
        <div className="brand">
          <span className="brand-icon">
            <Icon name="logo" />
          </span>
          <div>
            Jellyport<small>YOUR NEXT CHAPTER</small>
          </div>
        </div>
        <h1>
          {setup
            ? connection
              ? 'Choose account permissions'
              : 'Connect your Jellyfin server'
            : 'Welcome back'}
        </h1>
        <p>
          {setup
            ? connection
              ? 'New accounts will copy the permissions of your template user.'
              : 'Link Jellyfin once, then sign in with your Jellyfin administrator account.'
            : 'Sign in with your Jellyfin administrator account to manage your community.'}
        </p>
        {setup && (
          <div className="setup-progress" aria-label="Setup progress">
            <span className={!connection ? 'current' : ''}>1 · Connect Jellyfin</span>
            <span className={connection ? 'current' : ''}>2 · Choose template</span>
          </div>
        )}
        {error && (
          <div className="error-block mb-17" role="alert">
            {error}
          </div>
        )}
        {busy === 'resume' || busy === 'session' ? (
          <Loading />
        ) : !session ? (
          <div className="form-stack">
            <p className="muted text-small">Jellyport could not load the sign-in page.</p>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => setSessionRetry((current) => current + 1)}
            >
              <Icon name="refresh" />
              Retry connection
            </button>
          </div>
        ) : connection ? (
          <form key="permissions" className="form-stack" onSubmit={complete}>
            <div className="setup-server">
              <Icon name="jellyfin" />
              <span>
                Connected to <strong>{connection.server.url}</strong>
              </span>
            </div>
            <div className="field">
              <label htmlFor="setup-template">Template user</label>
              <select
                id="setup-template"
                name="template_user_id"
                defaultValue={connection.defaults.template_user_id}
                disabled={!!busy}
              >
                <option value="">Configure an account role after setup</option>
                {templates.map((user) => (
                  <option key={user.Id} value={user.Id}>
                    {user.Name}
                  </option>
                ))}
              </select>
              <small>
                Optionally choose an enabled regular account as a fallback template. You can instead
                finish setup, create a saved account role, and select it as the default in Settings.
              </small>
              {!templates.length && (
                <small className="setup-warning">
                  No regular template users are available. You can finish setup and configure an
                  account role later.
                </small>
              )}
              <button
                className="text-button setup-refresh"
                type="button"
                onClick={() => void refresh()}
                disabled={!!busy}
              >
                {busy === 'refresh' ? 'Refreshing…' : 'Refresh users'}
              </button>
            </div>
            <div className="field">
              <label htmlFor="setup-public-url">
                Public sign-in URL <span className="optional">optional</span>
              </label>
              <input
                id="setup-public-url"
                name="jellyfin_public_url"
                type="url"
                defaultValue={connection.defaults.jellyfin_public_url}
                placeholder="https://jellyfin.example.com"
                disabled={!!busy}
              />
              <small>The address to include when sending account credentials to your users.</small>
            </div>
            <button className="btn btn-primary" type="submit" disabled={!!busy}>
              {busy === 'complete' ? <span className="spinner" /> : <Icon name="check" />}
              {busy === 'complete' ? 'Finishing setup…' : 'Finish setup'}
            </button>
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => void reconnect()}
              disabled={!!busy}
            >
              <Icon name="refresh" />
              {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect Jellyfin'}
            </button>
          </form>
        ) : (
          <form key="credentials" className="form-stack" onSubmit={submit}>
            {setup && (
              <div className="field">
                <label htmlFor="setup-server-url">Jellyfin server URL</label>
                <input
                  key={session.setup_server_url || 'new-server'}
                  id="setup-server-url"
                  name="jellyfin_url"
                  type="url"
                  defaultValue={session.setup_server_url || ''}
                  readOnly={!!session.setup_server_url}
                  placeholder="http://jellyfin:8096"
                  required
                  autoFocus={!session.setup_server_url}
                  disabled={!!busy}
                />
                <small>
                  {session.setup_server_url
                    ? 'Sign in to the Jellyfin server already connected to this workspace.'
                    : 'Use a URL reachable from the Jellyport container.'}
                </small>
              </div>
            )}
            <div className="field">
              <label htmlFor="jellyfin-username">Jellyfin username</label>
              <input
                id="jellyfin-username"
                name="username"
                type="text"
                autoComplete="username"
                defaultValue={session?.demo ? 'admin' : ''}
                required
                autoFocus={!setup || !!session.setup_server_url}
                disabled={!!busy}
              />
              <small>Use a Jellyfin administrator account with a password.</small>
            </div>
            <div className="field">
              <label htmlFor="jellyfin-password">Jellyfin password</label>
              <input
                id="jellyfin-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={!!busy}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={!!busy}>
              {busy ? <span className="spinner" /> : <Icon name="lock" />}
              {busy
                ? setup
                  ? 'Connecting…'
                  : 'Signing in…'
                : setup
                  ? 'Connect Jellyfin'
                  : 'Sign in'}
            </button>
          </form>
        )}
        <div className="login-footer">
          {setup
            ? 'You can connect Emby and Discord in Settings after setup.'
            : session?.demo
              ? 'Demo sign-in: admin / demo-jellyport'
              : 'Only enabled Jellyfin administrators can sign in.'}
        </div>
      </div>
    </main>
  );
}
