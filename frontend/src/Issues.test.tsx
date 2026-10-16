// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Issues } from './components';
import type { ItemIssue } from './types';

afterEach(cleanup);

function expandCandidateDetails() {
  const details = screen.getByText(/Compare .* Jellyfin candidate|View saved item details/)
    .parentElement as HTMLDetailsElement;
  act(() => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
}

const episode: ItemIssue = {
  id: 'source-episode',
  name: 'The Crossing',
  type: 'Episode',
  series_name: 'Harbor Stories',
  season_number: 2,
  episode_number: 3,
  path: '/media/tv/Harbor Stories/Season 02/S02E03.mkv',
  provider_ids: { Tvdb: '1003' },
  series_provider_ids: { Tvdb: '100' },
  reason: 'The matching provider ID conflicts with the season and episode numbers.',
  reason_codes: ['numbering_conflict'],
  method: 'provider_id',
  candidate_count: 1,
  candidate_ids: ['target-episode'],
  candidates: [
    {
      id: 'target-episode',
      name: 'The Return',
      type: 'Episode',
      series_name: 'Harbor Stories',
      season_number: 2,
      episode_number: 4,
      path: '/library/tv/Harbor Stories/Season 02/S02E04.mkv',
      provider_ids: { Tvdb: '1003' },
      series_provider_ids: { Tvdb: '100' },
    },
  ],
};

describe('Readable migration item issues', () => {
  it('identifies the show and episode, explains the actual ambiguity, and compares candidates on demand', () => {
    render(<Issues label="Ambiguous items" items={[episode]} count={1} ambiguous />);
    expect(screen.getByText('TV episode')).toBeTruthy();
    expect(screen.getByText('Harbor Stories · S02E03 · The Crossing')).toBeTruthy();
    expect(screen.getByText(episode.reason!)).toBeTruthy();
    expect(screen.getByText('Matching basis: Provider ID.')).toBeTruthy();
    expect(screen.getByText('Compare 1 Jellyfin candidate')).toBeTruthy();
    expect(screen.queryByLabelText('Emby source')).toBeNull();
    expect(screen.queryByText('target-episode')).toBeNull();

    expandCandidateDetails();
    const source = within(screen.getByLabelText('Emby source'));
    const candidate = within(screen.getByLabelText('Jellyfin candidate 1'));
    expect(
      source.getByText('Harbor Stories · S02E03 · The Crossing', { exact: false }),
    ).toBeTruthy();
    expect(
      candidate.getByText('Harbor Stories · S02E04 · The Return', { exact: false }),
    ).toBeTruthy();
    expect(source.getByText(episode.path!)).toBeTruthy();
    expect(candidate.getByText(episode.candidates![0]!.path!)).toBeTruthy();
    expect(source.getByText('Episode provider IDs')).toBeTruthy();
    expect(source.getByText('Show provider IDs')).toBeTruthy();
    expect(source.getByText('Tvdb: 1003')).toBeTruthy();
    expect(source.getByText('Tvdb: 100')).toBeTruthy();
    expect(candidate.getByText('target-episode')).toBeTruthy();
  });

  it('identifies movies and years and presents paths as recorded without inferring an edition or library', () => {
    const movie: ItemIssue = {
      id: 'source-movie',
      name: 'Ocean Voyage',
      type: 'Movie',
      production_year: 1998,
      path: '/source/movies/Ocean Voyage.mkv',
      provider_ids: { Imdb: 'tt1234' },
      reason_codes: ['duplicate_provider_id'],
      candidate_count: 2,
      candidates: [
        {
          id: 'movie-one',
          name: 'Ocean Voyage',
          type: 'Movie',
          production_year: 1998,
          path: '/movies/Ocean Voyage.mkv',
          provider_ids: { Imdb: 'tt1234' },
        },
        {
          id: 'movie-two',
          name: 'Ocean Voyage',
          type: 'Movie',
          production_year: 1998,
          path: '/4K/Ocean Voyage.mkv',
          provider_ids: { Imdb: 'tt1234' },
        },
      ],
    };
    render(<Issues label="Ambiguous items" items={[movie]} ambiguous />);
    expect(screen.getByText('Movie')).toBeTruthy();
    expect(screen.getByText('Ocean Voyage (1998)')).toBeTruthy();
    expect(screen.getByText('Several Jellyfin items share a matching provider ID.')).toBeTruthy();
    expandCandidateDetails();
    expect(screen.getByText('/movies/Ocean Voyage.mkv')).toBeTruthy();
    expect(screen.getByText('/4K/Ocean Voyage.mkv')).toBeTruthy();
    expect(screen.queryByText(/4K library|inaccessible|restricted/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('honestly explains missing details on legacy jobs and retains the saved candidate IDs', () => {
    render(
      <Issues
        label="Ambiguous items"
        items={[{ name: 'Old record', id: 'source-old', candidate_ids: ['old-one', 'old-two'] }]}
        ambiguous
      />,
    );
    expect(screen.getByText('Old record')).toBeTruthy();
    expect(screen.getByText('Media item')).toBeTruthy();
    expect(screen.getByText(/This saved operation does not include the reason/)).toBeTruthy();
    expect(screen.queryByText(/Several Jellyfin items share/)).toBeNull();
    expandCandidateDetails();
    expect(screen.getByText(/Candidate names and metadata were not saved/)).toBeTruthy();
    expect(screen.getByText(/Jellyfin candidate IDs: old-one, old-two/)).toBeTruthy();
  });

  it('formats multi-episode ranges, specials and missing show metadata without guessing', () => {
    render(
      <Issues
        label="Unmatched items"
        items={[
          { ...episode, season_number: 0, episode_number: 2, episode_number_end: 3 },
          { id: 'missing-show', type: 'Episode', name: 'Pilot', episode_number: 1 },
          { id: 'missing-number', type: 'Episode', series_name: 'Harbor Stories' },
          { id: 'season', type: 'Season', series_name: 'Harbor Stories', season_number: 2 },
        ]}
      />,
    );
    expect(screen.getByText('Harbor Stories · S00E02–E03 · The Crossing')).toBeTruthy();
    expect(
      screen.getByText('Show name unavailable · Episode 1 · season unavailable · Pilot'),
    ).toBeTruthy();
    expect(screen.getByText('Harbor Stories · Episode number unavailable')).toBeTruthy();
    expect(screen.getByText('Harbor Stories · Season 2')).toBeTruthy();
    expect(screen.getByText('TV season')).toBeTruthy();
  });

  it('handles malformed or absent display metadata without stringifying objects', () => {
    const malformed = {
      id: 'malformed',
      name: { secret: 'should-never-render' },
      type: 'Episode',
      series_name: { secret: 'should-never-render' },
      season_number: -1,
      episode_number: Infinity,
      provider_ids: { Tvdb: { secret: 'should-never-render' } },
      path: { secret: 'should-never-render' },
      candidates: [null, { id: 'candidate', name: 'Safe candidate', provider_ids: null }],
      reason_codes: ['unknown_future_reason'],
    } as unknown as ItemIssue;
    render(<Issues label="Ambiguous items" items={[malformed]} ambiguous />);
    expect(screen.getByText('Show name unavailable · Episode number unavailable')).toBeTruthy();
    expandCandidateDetails();
    expect(screen.getByText('Safe candidate', { exact: false })).toBeTruthy();
    expect(document.body.textContent).not.toContain('should-never-render');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('escapes all upstream display strings and never renders unrelated user data or links', () => {
    const malicious: ItemIssue = {
      ...episode,
      name: '<img src=x onerror=alert(1)>',
      series_name: '<script>show()</script>',
      reason: '<script>reason()</script>',
      path: 'javascript:alert(1)',
      provider_ids: { '<script>provider()</script>': '<img src=x>' },
      candidates: [
        {
          id: '<script>candidate()</script>',
          name: '<svg onload=alert(1)>',
          type: '<script>type()</script>',
          path: 'https://example.invalid/private?secret=test',
        },
      ],
      UserData: { Played: true, LastPlayedDate: 'private-history-do-not-render' },
      AccessToken: 'private-token-do-not-render',
    } as ItemIssue;
    render(<Issues label="Ambiguous items" items={[malicious]} ambiguous />);
    expandCandidateDetails();
    expect(screen.getByText('<script>reason()</script>')).toBeTruthy();
    expect(screen.getAllByText('Remote URL omitted')).toHaveLength(2);
    expect(document.querySelector('script,img,svg,a')).toBeNull();
    expect(document.body.textContent).not.toContain('private-history-do-not-render');
    expect(document.body.textContent).not.toContain('private-token-do-not-render');
    expect(document.body.textContent).not.toContain('secret=test');
  });

  it('omits credentials and query tokens from legacy remote paths while retaining local Windows paths', () => {
    render(
      <Issues
        label="Ambiguous items"
        items={[
          {
            name: 'Legacy movie',
            path: 'https://account:private-password@example.invalid/movie?api_key=private-key',
            candidates: [{ name: 'Local movie', path: 'C:\\Movies\\Local movie.mkv' }],
          },
        ]}
        ambiguous
      />,
    );
    expandCandidateDetails();
    expect(screen.getByText('Remote URL omitted')).toBeTruthy();
    expect(screen.getByText('C:\\Movies\\Local movie.mkv')).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-password');
    expect(document.body.textContent).not.toContain('private-key');
  });

  it.each([
    'ftp://member:private-password@example.invalid/movie?token=private-key',
    '//member:private-password@example.invalid/movie?token=private-key',
    '\\\\member:private-password@example.invalid\\movie',
    'file://member:private-password@example.invalid/movie',
    '/media/hidden\u0000private-key',
  ])('does not expose unsafe paths from old persisted records: %s', (path) => {
    render(
      <Issues
        label="Ambiguous items"
        items={[{ name: 'Old record', path, candidate_ids: ['candidate-one'] }]}
        ambiguous
      />,
    );
    expandCandidateDetails();
    expect(screen.getByText('Remote URL omitted')).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-password');
    expect(document.body.textContent).not.toContain('private-key');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'safely renders unexpected upstream type %s',
    (type) => {
      render(
        <Issues
          label="Ambiguous items"
          items={[{ name: 'Unknown media', type, reason_codes: [type], method: type }]}
          ambiguous
        />,
      );
      expect(screen.getByText(type)).toBeTruthy();
      expect(screen.getByText(/This saved operation does not include the reason/)).toBeTruthy();
    },
  );

  it('bounds displayed items and lazily bounds candidate comparisons while preserving full counts', () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      id: `candidate-${index}`,
      name: `Candidate ${index}`,
      type: 'Movie',
    }));
    const issues = Array.from({ length: 201 }, (_, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      type: 'Movie',
      candidate_count: 25,
      candidates,
    }));
    render(<Issues label="Ambiguous items" items={issues} count={241} ambiguous />);
    expect(screen.getByText('Ambiguous items (241)')).toBeTruthy();
    expect(screen.getByText(/Showing 200 of 241 items/)).toBeTruthy();
    expect(screen.queryByText('Source 200')).toBeNull();
    expect(screen.queryByText('Candidate 0', { exact: false })).toBeNull();
    const details = screen.getAllByText('Compare 25 Jellyfin candidates')[0]!
      .parentElement as HTMLDetailsElement;
    act(() => {
      details.open = true;
      fireEvent(details, new Event('toggle'));
    });
    expect(screen.getByLabelText('Jellyfin candidate 20')).toBeTruthy();
    expect(screen.queryByLabelText('Jellyfin candidate 21')).toBeNull();
    expect(screen.getByText(/Showing 20 of 25 candidates/)).toBeTruthy();
    expect(screen.getAllByLabelText('Emby source')).toHaveLength(1);
    act(() => {
      details.open = false;
      fireEvent(details, new Event('toggle'));
    });
    expect(screen.queryByLabelText('Emby source')).toBeNull();
  });
});
