import { completeMigrationWizard } from './fixtures';
import { test, expect, expectContainedLayout } from './media-admin-fixtures';

test('reviewed migration adds unwatched and series favorites while preserving a month of Jellyfin activity', async ({
  page,
  admin,
}) => {
  const favoriteOnly = 'favorite-only';
  const favoriteSeries = 'favorite-series';
  const jellyfinMonth = 'jellyfin-month';
  admin.servers.media.push(
    {
      Id: favoriteOnly,
      Name: 'Unwatched favorite',
      Type: 'Movie',
      ProviderIds: { Tmdb: '900001' },
    },
    { Id: favoriteSeries, Name: 'Favorite show', Type: 'Series', ProviderIds: { Tvdb: '900002' } },
    {
      Id: jellyfinMonth,
      Name: 'Watched on Jellyfin',
      Type: 'Movie',
      ProviderIds: { Tmdb: '900003' },
    },
  );
  admin.servers.played['j-river']!.add(jellyfinMonth);
  admin.servers.userData['e-river'] = {
    '1': { IsFavorite: true },
    [favoriteOnly]: {
      Played: false,
      IsFavorite: true,
      PlaybackPositionTicks: 100,
      PlayCount: 2,
      LastPlayedDate: '2026-09-01T12:00:00.000Z',
    },
    [favoriteSeries]: { IsFavorite: true },
  };
  admin.servers.userData['j-river'] = {
    '2': { IsFavorite: true },
    [favoriteOnly]: {
      Played: false,
      IsFavorite: false,
      PlaybackPositionTicks: 500,
      PlayCount: 7,
      LastPlayedDate: '2026-10-31T12:00:00.000Z',
    },
    [jellyfinMonth]: {
      Played: true,
      IsFavorite: true,
      PlayCount: 4,
      LastPlayedDate: '2026-10-30T12:00:00.000Z',
    },
  };
  const monthBefore = structuredClone(admin.servers.userData['j-river'][jellyfinMonth]);
  const usersBefore = structuredClone(admin.servers.users.jellyfin);

  async function migrate() {
    await page.goto('/#/migrate');
    await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Select river', exact: true }).check();
    await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
    await completeMigrationWizard(review);
    await expect(review).toContainText('played status and favorites');
    await expect(review).toContainText(
      'Matched Emby favorites are added even when they have not been watched.',
    );
    await expect(
      review.getByRole('button', { name: 'Start migration', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const reviewToast = review.locator('.toast');
    if (await reviewToast.count()) await expect(reviewToast).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('played-favorites-review-viewport.png') });
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/migrations' &&
        response.request().method() === 'POST',
    );
    await review.getByRole('button', { name: 'Start migration', exact: true }).click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON().migration_scope).toBe('played_favorites');
    const { id } = await response.json();
    await expect
      .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status)
      .toBe('completed');
    return (await admin.client.get(`/api/jobs/${id}`)).json();
  }

  const job = await migrate();
  expect(job.migration_scope).toBe('played_favorites');
  expect(job.results[0].data.favorites).toBe(3);
  expect(job.results[0].data.verification).toMatchObject({
    missing: 0,
    mismatched: 0,
    unsupported_fields: 0,
  });
  expect(admin.stateWrites).toHaveLength(4);
  expect(admin.stateWrites.find((write) => write.item === favoriteOnly)?.value).toEqual({
    IsFavorite: true,
  });
  expect(admin.stateWrites.find((write) => write.item === favoriteSeries)?.value).toEqual({
    IsFavorite: true,
  });
  for (const write of admin.stateWrites) {
    expect(write.user).toBe('j-river');
    expect(Object.keys(write.value).every((key) => ['Played', 'IsFavorite'].includes(key))).toBe(
      true,
    );
    expect(Object.values(write.value).every((value) => value === true)).toBe(true);
  }
  expect(admin.servers.userData['j-river'][favoriteOnly]).toEqual({
    Played: false,
    IsFavorite: true,
    PlaybackPositionTicks: 500,
    PlayCount: 7,
    LastPlayedDate: '2026-10-31T12:00:00.000Z',
  });
  expect(admin.servers.userData['j-river'][jellyfinMonth]).toEqual(monthBefore);
  expect(admin.servers.userData['j-river']['2']).toEqual({ IsFavorite: true, Played: true });
  expect(admin.servers.played['j-river']).toEqual(new Set(['1', '2', jellyfinMonth]));
  expect(admin.servers.users.jellyfin).toEqual(usersBefore);
  const details = page.getByRole('dialog', { name: 'Migration details', exact: true });
  await expect(details).toContainText('3 favorites added');
  await expect(details).toContainText('Independent played-status and favorites verification');
  await expect(details).not.toContainText('Historical migration');
  await expectContainedLayout(page);
  await details.getByText('3 favorites added', { exact: true }).scrollIntoViewIfNeeded();
  await expect(details.getByRole('button', { name: 'Close dialog', exact: true })).toBeInViewport({
    ratio: 1,
  });
  const reportToast = details.locator('.toast');
  if (await reportToast.count()) await expect(reportToast).toHaveCSS('opacity', '1');
  await page.screenshot({ path: test.info().outputPath('played-favorites-report-viewport.png') });
  await details.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const rerun = await migrate();
  expect(rerun.results[0].data.favorites).toBe(0);
  expect(rerun.results[0].applied).toBe(0);
  expect(admin.stateWrites).toHaveLength(4);
});
