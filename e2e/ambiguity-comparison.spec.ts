import { test, expect, navigate, expectContainedLayout } from './fixtures';

test('saved ambiguity compares one source against two destinations without counting the source as a choice', async ({
  page,
  mutations,
}, info) => {
  const source = {
    id: 'synthetic-source-episode',
    name: 'The Crossing',
    type: 'Episode',
    series_name: 'Harbor Stories',
    season_number: 2,
    episode_number: 13,
    provider_ids: { Imdb: 'tt-synthetic-episode', Tvdb: 'synthetic-episode-13' },
    series_provider_ids: { Tvdb: 'synthetic-series' },
    path: '/source/Harbor Stories/Season 02/S02E13.mkv',
    candidate_count: 2,
    method: 'provider_id',
    reason_codes: ['numbering_conflict'],
    candidates: [
      {
        id: 'synthetic-wrong-episode',
        name: 'The Earlier Crossing',
        type: 'Episode',
        series_name: 'Harbor Stories',
        season_number: 2,
        episode_number: 10,
        provider_ids: { Imdb: 'tt-synthetic-episode', Tvdb: 'synthetic-episode-10' },
        series_provider_ids: { Tvdb: 'synthetic-series' },
        path: '/destination/Harbor Stories/Season 02/S02E10.mkv',
      },
      {
        id: 'synthetic-correct-episode',
        name: 'The Crossing',
        type: 'Episode',
        series_name: 'Harbor Stories',
        season_number: 2,
        episode_number: 13,
        provider_ids: { Imdb: 'tt-synthetic-episode', Tvdb: 'synthetic-episode-13' },
        series_provider_ids: { Tvdb: 'synthetic-series' },
        path: '/destination/Harbor Stories/Season 02/S02E13.mkv',
      },
    ],
  };
  const report = {
    id: 'synthetic-ambiguity-report',
    kind: 'migrate',
    status: 'partial',
    created_at: '2026-10-17T05:00:00Z',
    results: [
      {
        username: 'Synthetic viewer',
        status: 'completed',
        ambiguous: 2,
        ambiguous_items: [
          source,
          { ...source, id: 'synthetic-second-source', name: 'Another Episode' },
        ],
      },
    ],
  };
  await page.route('**/api/jobs', async (route) => route.fulfill({ json: { jobs: [report] } }));
  await page.route('**/api/jobs/synthetic-ambiguity-report', async (route) =>
    route.fulfill({ json: report }),
  );
  await page.goto('/');
  await navigate(page, 'Activity');
  await page.getByRole('button', { name: 'View operation details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Migration details' });
  await dialog.getByText('Ambiguous items (2 Emby items)', { exact: true }).click();
  const comparisons = dialog.getByText('Compare 1 Emby item with 2 Jellyfin candidates', {
    exact: true,
  });
  await expect(comparisons).toHaveCount(2);
  await comparisons.first().click();
  await expect(
    dialog.getByText('The Emby source is a reference, not an additional Jellyfin match.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Emby source', exact: true })).toHaveCount(1);
  await expect(dialog.getByRole('region', { name: /^Jellyfin candidate/ })).toHaveCount(2);
  await expect(
    dialog.getByRole('region', { name: 'Jellyfin candidate 3', exact: true }),
  ).toHaveCount(0);
  await expect(dialog.locator('.issue-identity-card')).toHaveCount(3);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('ambiguity-source-and-candidates.png'),
    fullPage: true,
  });
  expect(mutations).toEqual([]);
});
