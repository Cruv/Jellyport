import {
  DEFAULT_ADDITIONAL_NAME,
  DEFAULT_PRIMARY_NAME,
  renderAccountUsername,
  validateAccountNaming,
  type AccountNaming,
} from '../../server/account-naming';

export default function AccountNamingPanel({
  value,
  onChange,
}: {
  value: AccountNaming;
  onChange: (value: AccountNaming) => void;
}) {
  let error = '';
  let examples: string[] = [];
  try {
    const cleaned = {
      ...value,
      account_name_aliases: (value.account_name_aliases ?? [])
        .map((line) => line.trim())
        .filter(Boolean),
    };
    validateAccountNaming(cleaned);
    examples = [1, 2, 3].map((slot) => renderAccountUsername('example_user', slot, cleaned));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Choose valid account formats.';
  }
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Account naming and household matching</h3>
          <p>Set the format for new accounts and suggestions for existing numbered accounts.</p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <div className="field">
          <label htmlFor="account-name-primary">Primary account format</label>
          <input
            id="account-name-primary"
            value={value.account_name_primary ?? DEFAULT_PRIMARY_NAME}
            maxLength={128}
            onChange={(event) => onChange({ ...value, account_name_primary: event.target.value })}
          />
          <small>
            Include {'{username}'} once. Example: {'{username}'}.
          </small>
        </div>
        <div className="field">
          <label htmlFor="account-name-additional">Additional account format</label>
          <input
            id="account-name-additional"
            value={value.account_name_additional ?? DEFAULT_ADDITIONAL_NAME}
            maxLength={128}
            onChange={(event) =>
              onChange({ ...value, account_name_additional: event.target.value })
            }
          />
          <small>
            Include {'{username}'} and {'{slot}'} once each. Slots are 2 and 3.
          </small>
        </div>
        <div className="field">
          <label htmlFor="account-name-aliases">Legacy additional account formats</label>
          <textarea
            id="account-name-aliases"
            value={(value.account_name_aliases ?? []).join('\n')}
            onChange={(event) =>
              onChange({ ...value, account_name_aliases: event.target.value.split('\n') })
            }
            rows={3}
          />
          <small>
            Optional, one per line, up to eight. These suggest ownership only; new accounts use the
            format above. Literal text and placeholders only.
          </small>
        </div>
        {error ? (
          <p role="status" className="error-block">
            {error}
          </p>
        ) : (
          <div className="form-help">
            <strong>Example account names</strong>
            <p>{examples.join(' · ')}</p>
          </div>
        )}
        <p className="subtle text-small">
          Saving does not rename accounts or alter existing approved owner links. Suggestions
          require your approval and do not increase a member’s account allowance. Exact Discord
          usernames take precedence over numbered-name guesses.
        </p>
        <button
          type="button"
          className="btn secondary"
          onClick={() =>
            onChange({
              account_name_primary: DEFAULT_PRIMARY_NAME,
              account_name_additional: DEFAULT_ADDITIONAL_NAME,
              account_name_aliases: [],
            })
          }
        >
          Restore naming defaults
        </button>
      </div>
    </section>
  );
}
