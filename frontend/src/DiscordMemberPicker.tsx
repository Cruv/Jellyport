import { useEffect, useId, useRef, useState } from 'react';
import type { Api, DiscordMember } from './types';

export interface DiscordMemberPickerProps {
  api: Api;
  value: DiscordMember | null;
  onChange: (member: DiscordMember | null) => void;
  suggestedQuery?: string;
  autoSearch?: boolean;
  disabled?: boolean;
  allowInactive?: boolean;
  label?: string;
  id?: string;
  inputName?: string;
}

export default function DiscordMemberPicker({
  api,
  value,
  onChange,
  suggestedQuery = '',
  autoSearch = false,
  disabled = false,
  allowInactive = false,
  label = 'Discord member',
  id,
  inputName,
}: DiscordMemberPickerProps) {
  const generatedId = useId();
  const fieldId = id || `discord-member-${generatedId}`;
  const [query, setQuery] = useState(suggestedQuery.slice(0, 64));
  const [members, setMembers] = useState<DiscordMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [searchEnabled, setSearchEnabled] = useState(autoSearch);
  const [searchVersion, setSearchVersion] = useState(0);
  const generation = useRef(0);
  const previousSuggestion = useRef(suggestedQuery.slice(0, 64));

  useEffect(() => {
    const previous = previousSuggestion.current;
    const next = suggestedQuery.slice(0, 64);
    previousSuggestion.current = next;
    if (!value) setQuery((current) => (!current || current === previous ? next : current));
  }, [suggestedQuery, value]);

  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    setMembers([]);
    setSearched(false);
    setTruncated(false);
    setError('');
    const search = query.trim();
    if (value || disabled || !searchEnabled || search.length < 2) {
      setLoading(false);
      return () => {
        generation.current++;
        abort.abort();
      };
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void api<{ members: DiscordMember[]; truncated: boolean }>(
        `/api/discord/members?query=${encodeURIComponent(search)}`,
        { signal: abort.signal },
      )
        .then((result) => {
          if (abort.signal.aborted || current !== generation.current) return;
          setMembers(
            result.members.filter((member) => allowInactive || member.membership_active !== false),
          );
          setTruncated(result.truncated);
          setSearched(true);
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted || current !== generation.current) return;
          setError(
            reason instanceof Error ? reason.message : 'Discord members could not be searched.',
          );
        })
        .finally(() => {
          if (!abort.signal.aborted && current === generation.current) setLoading(false);
        });
    }, 300);
    return () => {
      generation.current++;
      clearTimeout(timer);
      abort.abort();
    };
  }, [api, query, value, disabled, allowInactive, searchEnabled, searchVersion]);

  const exact = members.filter(
    (member) => member.username.toLowerCase() === query.trim().replace(/^@/, '').toLowerCase(),
  );

  return (
    <div className="field discord-picker">
      <label htmlFor={fieldId}>{label}</label>
      {inputName && <input type="hidden" name={inputName} value={value?.id || ''} />}
      {value ? (
        <div className="discord-picker-selection">
          <div>
            <strong>@{value.username}</strong>
            {value.display_name && value.display_name !== value.username && (
              <small>{value.display_name}</small>
            )}
            {value.nickname && value.nickname !== value.display_name && (
              <small>Server nickname: {value.nickname}</small>
            )}
            {value.membership_active === false && (
              <small>Membership is not currently active.</small>
            )}
            {value.membership_active === null && <small>Membership checked when submitted.</small>}
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={disabled}
            onClick={() => {
              generation.current++;
              onChange(null);
            }}
            aria-label={`Clear Discord member @${value.username}`}
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="discord-picker-search">
            <input
              id={fieldId}
              type="search"
              value={query}
              maxLength={64}
              disabled={disabled}
              onChange={(event) => {
                generation.current++;
                setSearchEnabled(true);
                setQuery(event.target.value.slice(0, 64));
              }}
              onFocus={() => setSearchEnabled(true)}
              placeholder="Search username or server nickname"
              autoComplete="off"
              aria-describedby={`${fieldId}-help`}
            />
            <button
              type="button"
              className="btn"
              disabled={disabled || query.trim().length < 2}
              onClick={() => {
                setSearchEnabled(true);
                setSearchVersion((current) => current + 1);
              }}
            >
              Search
            </button>
          </div>
          <small id={`${fieldId}-help`}>
            Search your Discord server, then select the member. Their actual @username identifies
            the account; their Discord ID is filled in automatically.
          </small>
          {loading && <small role="status">Searching Discord members…</small>}
          {error && (
            <div className="error-block" role="alert">
              {error}
            </div>
          )}
          {!loading && !error && searched && members.length === 0 && (
            <small role="status">
              No matching {allowInactive ? '' : 'active '}members. Try their actual Discord
              username.
            </small>
          )}
          {members.length > 0 && (
            <ul className="discord-picker-results" aria-label="Discord member matches">
              {members.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      generation.current++;
                      onChange(member);
                    }}
                    aria-label={`Select @${member.username}`}
                  >
                    <span>
                      <strong>@{member.username}</strong>
                      {member.display_name && member.display_name !== member.username && (
                        <small>{member.display_name}</small>
                      )}
                      {member.nickname && member.nickname !== member.display_name && (
                        <small>Server nickname: {member.nickname}</small>
                      )}
                      {member.membership_active === false && <small>Membership inactive</small>}
                    </span>
                    {exact.length === 1 && exact[0].id === member.id && (
                      <small>Exact username match</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {truncated && (
            <small role="status">More members match. Keep typing to narrow the results.</small>
          )}
        </>
      )}
    </div>
  );
}
