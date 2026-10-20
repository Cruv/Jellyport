import { useState, type FormEvent } from 'react';
import { Callout, Loading, Modal } from './components';
import type { DirectoryAccount } from './types';

export interface AccountCloneRequest {
  source_user_id: string;
  expected_source_username: string;
  accounts: { username: string; family: boolean }[];
}
export interface AccountCloneReview {
  id: string;
  source_user_id: string;
  source_username: string;
  accounts: { username: string; family: boolean }[];
  warnings: string[];
  expires_at: string;
}
export interface AccountRenameRecovery {
  user_id: string;
  pending: {
    user_id: string;
    expected_username: string;
    username: string;
    can_confirm: boolean;
  } | null;
}

const normalized = (value: string) => value.trim().toLowerCase();
const accountLabel = (account: DirectoryAccount) => `${account.name} · ${account.id}`;

export default function AccountCloneDialog({
  accounts,
  existingUsernames,
  busy,
  error,
  review,
  prepare,
  edit,
  close,
  submit,
}: {
  accounts: DirectoryAccount[];
  existingUsernames: string[];
  busy: boolean;
  error: string;
  review: AccountCloneReview | null;
  prepare: (request: AccountCloneRequest) => void;
  edit: () => void;
  close: () => void;
  submit: (reviewId: string) => void;
}) {
  const [sourceId, setSourceId] = useState(accounts[0]?.id || '');
  const [usernames, setUsernames] = useState(['', '']);
  const [family, setFamily] = useState(accounts[0]?.profile?.family === true);
  const [validation, setValidation] = useState('');
  const source = accounts.find((account) => account.id === sourceId);
  function requestReview(event: FormEvent) {
    event.preventDefault();
    if (!source || busy) return;
    const names = usernames.map((value) => value.trim());
    if (names.some((value) => !value || value.length > 64 || /[\p{Cc}\p{Cf}]/u.test(value))) {
      setValidation('Enter a username of 1–64 characters for each new account.');
      return;
    }
    if (new Set(names.map(normalized)).size !== names.length) {
      setValidation('Give each new account a different username.');
      return;
    }
    if (
      names.some((name) =>
        existingUsernames.some((existing) => normalized(existing) === normalized(name)),
      )
    ) {
      setValidation(
        'A Jellyfin account already uses one of these usernames. Choose new usernames.',
      );
      return;
    }
    setValidation('');
    prepare({
      source_user_id: source.id,
      expected_source_username: source.name,
      accounts: names.map((username) => ({ username, family })),
    });
  }
  return (
    <Modal
      title={review ? 'Review account clones' : 'Clone Jellyfin account'}
      description="Create separate accounts from an existing Jellyfin account."
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
      footer={
        review ? (
          <div className="form-actions">
            <button className="btn" disabled={busy} onClick={edit}>
              Back
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                if (!busy) submit(review.id);
              }}
            >
              {busy
                ? 'Starting clone…'
                : `Create ${review.accounts.length} ${review.accounts.length === 1 ? 'account' : 'accounts'}`}
            </button>
          </div>
        ) : undefined
      }
    >
      {review ? (
        <div className="form-stack">
          <div className="summary-card">
            <dl>
              <dt>Existing Jellyfin account</dt>
              <dd>{review.source_username}</dd>
              <dt>Account ID</dt>
              <dd>{review.source_user_id}</dd>
              <dt>New independent accounts</dt>
              <dd>
                {review.accounts
                  .map((account) => `${account.username}${account.family ? ' · Family' : ''}`)
                  .join(', ')}
              </dd>
            </dl>
          </div>
          <Callout title="The existing account stays as it is.">
            Each new account receives its own generated password, the source account’s permissions,
            home and playback preferences, and played flags. New accounts can develop separate watch
            histories after cloning.
          </Callout>
          <p className="section-note">
            Resume positions, favorites, playlists, passwords, Discord links, and subscription
            ownership are not copied.
          </p>
          <p className="section-note">
            The operation runs in Activity. Open its report to retrieve the new credentials.
          </p>
          {review.warnings.length > 0 && (
            <Callout warning title="Before creating these accounts">
              <ul>
                {review.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </Callout>
          )}
          {error && (
            <div className="error-block" role="alert">
              {error}
            </div>
          )}
        </div>
      ) : (
        <form className="form-stack" onSubmit={requestReview}>
          <div className="field">
            <label htmlFor="clone-source">Source Jellyfin account</label>
            <select
              id="clone-source"
              value={sourceId}
              disabled={busy}
              onChange={(event) => {
                setSourceId(event.target.value);
                setFamily(
                  accounts.find((account) => account.id === event.target.value)?.profile?.family ===
                    true,
                );
              }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountLabel(account)}
                </option>
              ))}
            </select>
            <small>
              Finish any Emby migration for this account before cloning its played flags.
            </small>
          </div>
          {usernames.map((name, index) => (
            <div className="field" key={index}>
              <label htmlFor={`clone-username-${index}`}>New username {index + 1}</label>
              <input
                id={`clone-username-${index}`}
                value={name}
                required
                maxLength={64}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  setUsernames((current) =>
                    current.map((value, position) =>
                      position === index ? event.target.value : value,
                    ),
                  )
                }
              />
              {usernames.length > 1 && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setUsernames((current) => current.filter((_, position) => position !== index))
                  }
                >
                  Remove new account {index + 1}
                </button>
              )}
            </div>
          ))}
          <div>
            <button
              className="btn"
              type="button"
              disabled={busy || usernames.length >= 10}
              onClick={() => setUsernames((current) => [...current, ''])}
            >
              Add another account
            </button>
          </div>
          <label className="check-line">
            <input
              type="checkbox"
              checked={family}
              disabled={busy}
              onChange={(event) => setFamily(event.target.checked)}
            />
            Mark the new accounts as family
          </label>
          <small>
            Starts with the source account’s family flag. Family accounts stay admin-managed and do
            not require Discord or a paid membership. You can change this choice for the new
            accounts.
          </small>
          <p className="section-note">
            You can rename the existing account separately after cloning.
          </p>
          {(validation || error) && (
            <div className="error-block" role="alert">
              {validation || error}
            </div>
          )}
          <div className="form-actions">
            <button className="btn" type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !source} aria-busy={busy}>
              {busy ? 'Preparing review…' : 'Review clone'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function AccountRenameDialog({
  accounts,
  existingUsernames,
  busy,
  error,
  recovery,
  inspect,
  close,
  submit,
}: {
  accounts: DirectoryAccount[];
  existingUsernames: string[];
  busy: boolean;
  error: string;
  recovery: AccountRenameRecovery | undefined;
  inspect: (userId: string) => void;
  close: () => void;
  submit: (request: { user_id: string; expected_username: string; username: string }) => void;
}) {
  const [sourceId, setSourceId] = useState(accounts[0]?.id || '');
  const [username, setUsername] = useState('');
  const [validation, setValidation] = useState('');
  const source = accounts.find((account) => account.id === sourceId);
  const currentRecovery = recovery?.user_id === sourceId ? recovery : undefined;
  const pending = currentRecovery?.pending;
  function rename(event: FormEvent) {
    event.preventDefault();
    if (!source || busy || !currentRecovery || pending) return;
    const next = username.trim();
    if (!next || next.length > 64 || /[\p{Cc}\p{Cf}]/u.test(next)) {
      setValidation('Enter a new username of 1–64 characters.');
      return;
    }
    if (next === source.name) {
      setValidation('Choose a different username.');
      return;
    }
    if (
      normalized(next) !== normalized(source.name) &&
      existingUsernames.some((name) => normalized(name) === normalized(next))
    ) {
      setValidation('A Jellyfin account already uses this username.');
      return;
    }
    setValidation('');
    submit({ user_id: source.id, expected_username: source.name, username: next });
  }
  return (
    <Modal
      title="Rename Jellyfin account"
      description="Keep the same account and give it a new sign-in name."
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
    >
      <form className="form-stack" onSubmit={rename}>
        <div className="field">
          <label htmlFor="rename-source">Existing Jellyfin account</label>
          <select
            id="rename-source"
            value={sourceId}
            disabled={busy}
            onChange={(event) => {
              setSourceId(event.target.value);
              setUsername('');
              setValidation('');
              inspect(event.target.value);
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </div>
        {!currentRecovery ? (
          <div className="form-stack">
            {busy ? (
              <Loading>Checking previous rename status…</Loading>
            ) : (
              <p>Check this account’s rename status before making another change.</p>
            )}
            {error && (
              <div className="error-block" role="alert">
                {error}
              </div>
            )}
            <button
              className="btn"
              type="button"
              disabled={busy || !source}
              onClick={() => inspect(sourceId)}
            >
              Check rename status
            </button>
          </div>
        ) : pending ? (
          <div className="form-stack">
            <Callout warning title="A previous rename needs confirmation.">
              {pending.can_confirm
                ? 'Jellyfin already has the reviewed new username. Confirming finishes Jellyport’s saved references without renaming the account again.'
                : 'Inspect this account in Jellyfin and restore the reviewed new username and preferences before checking again. Jellyport will preserve the pending change.'}
            </Callout>
            <div className="summary-card">
              <dl>
                <dt>Account ID</dt>
                <dd>{pending.user_id}</dd>
                <dt>Previously reviewed username</dt>
                <dd>{pending.expected_username}</dd>
                <dt>Reviewed new username</dt>
                <dd>{pending.username}</dd>
              </dl>
            </div>
            {error && (
              <div className="error-block" role="alert">
                {error}
              </div>
            )}
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => inspect(sourceId)}
              >
                Check status again
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || !pending.can_confirm}
                aria-busy={busy}
                onClick={() => {
                  if (!busy && pending.can_confirm)
                    submit({
                      user_id: pending.user_id,
                      expected_username: pending.expected_username,
                      username: pending.username,
                    });
                }}
              >
                {busy ? 'Confirming…' : 'Confirm previous rename'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="rename-username">New sign-in username</label>
              <input
                id="rename-username"
                required
                maxLength={64}
                value={username}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <Callout title="The account and its data are preserved.">
              The account ID, password, permissions, preferences, and watch history stay the same.
              Use the new username the next time you sign in.
            </Callout>
            {(validation || error) && (
              <div className="error-block" role="alert">
                {validation || error}
              </div>
            )}
            <div className="form-actions">
              <button className="btn" type="button" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy || !source} aria-busy={busy}>
                {busy ? 'Renaming…' : 'Rename account'}
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
