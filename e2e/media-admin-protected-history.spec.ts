import {
  test,
  expect,
  expectContainedLayout,
  sourceMember,
  destinationMember,
  movieId,
  type ImportFixture,
} from './media-admin-import-fixture';
import { migrationDetails } from '../server/migration';
import type { Job } from '../server/service';

const alreadyPlayedMovie = '00000002000000000000000000000001';

async function importSavedData(imports: ImportFixture) {
  const session = await imports.client.get('/api/session');
  const headers = { 'X-CSRF-Token': (await session.json()).csrf_token };
  for (const [path, status] of [
    ['/api/source-snapshots', imports.sourceStatus],
    ['/api/destination-catalog', imports.destinationStatus],
  ] as const) {
    const accepted = await imports.client.post(`${path}/refresh`, { headers, data: {} });
    expect(accepted.status()).toBe(202);
    await expect
      .poll(async () => (await status()).last_outcome, { timeout: 15_000 })
      .toBe('succeeded');
  }
}

function accountRecords(imports: ImportFixture) {
  return Object.fromEntries(
    [
      'accounts',
      'credentials',
      'links',
      'user_mappings',
      'account_roles',
      'account_role_assignments',
      'memberships',
      'account_profiles',
      'migration_playlists',
    ].map((table) => [
      table,
      imports.app.jellyport.store.db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
}

for (const protection of ['administrator', 'template'] as const) {
  test(`reviewed ${protection} migration merges only played flags into the pinned existing account`, async ({
    page,
    imports,
  }, info) => {
    test.setTimeout(60_000);
    imports.protectDestinationAs(protection);
    imports.servers.userData[destinationMember] = {
      [alreadyPlayedMovie]: {
        Played: true,
        PlayCount: 17,
        LastPlayedDate: '2026-10-18T19:00:00.000Z',
        PlaybackPositionTicks: 123456789,
        IsFavorite: true,
      },
    };
    imports.servers.display[destinationMember] = { CustomPrefs: { homesection0: 'nextup' } };
    const usersBefore = structuredClone(imports.servers.users.jellyfin);
    const userDataBefore = structuredClone(imports.servers.userData);
    const displayBefore = structuredClone(imports.servers.display);
    const recordsBefore = accountRecords(imports);
    await importSavedData(imports);

    const acceptedMigrations: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/migrations')
        acceptedMigrations.push(request.postDataJSON());
    });
    await page.goto('/#/migrate');
    await expect(
      page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }),
    ).toBeChecked();
    await page.getByRole('checkbox', { name: 'Select synthetic_member', exact: true }).check();
    await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
    let review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
    await expect(review).toBeVisible();
    await expect(review.locator('.preview-user')).toContainText('Watch history only');
    await expect(review.locator('.preview-user')).toContainText(destinationMember);
    await expect(review).toContainText('Saved Emby data selected.');
    await expect(review.getByRole('textbox', { name: /Discord/ })).toHaveCount(0);
    expect(imports.writes).toEqual([]);
    expect(imports.userDataWrites).toEqual([]);
    expect(imports.accountWrites).toEqual([]);
    expect(acceptedMigrations).toEqual([]);
    await expectContainedLayout(page);
    await review
      .getByText(`Jellyfin account ID: ${destinationMember}`, { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`${protection}-history-review.png`),
      fullPage: true,
    });

    // Merely reviewing or backing out cannot approve personal-state writes.
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(review).toHaveCount(0);
    expect(imports.writes).toEqual([]);
    expect(imports.userDataWrites).toEqual([]);
    expect(imports.accountWrites).toEqual([]);
    expect(acceptedMigrations).toEqual([]);
    await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
    review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
    await expect(review.locator('.preview-user')).toContainText('Watch history only');
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/migrations',
    );
    await review.getByRole('button', { name: 'Start migration', exact: true }).click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    const { id } = await response.json();
    await expect
      .poll(async () => (await (await imports.client.get(`/api/jobs/${id}`)).json()).status, {
        timeout: 15_000,
      })
      .toBe('completed');
    const job = await (await imports.client.get(`/api/jobs/${id}`)).json();
    expect(job.results).toHaveLength(1);
    expect(job.results[0]).toMatchObject({
      history_only: true,
      target_user_id: destinationMember,
      created: false,
      applied: 1,
      discord_delivery: 'not_requested',
    });
    expect(acceptedMigrations).toEqual([
      expect.objectContaining({
        source_user_ids: [sourceMember],
        migration_scope: 'watched_only',
        source_snapshot_ids: { [sourceMember]: expect.any(String) },
        discord_recipients: {},
      }),
    ]);
    expect(imports.writes).toEqual([{ user: destinationMember, item: movieId }]);
    expect(imports.userDataWrites).toEqual([
      { user: destinationMember, item: movieId, value: { Played: true } },
    ]);
    expect(imports.accountWrites).toEqual([]);
    expect(imports.servers.played[destinationMember]).toEqual(
      new Set([alreadyPlayedMovie, movieId]),
    );
    expect(imports.servers.users.jellyfin).toEqual(usersBefore);
    expect(imports.servers.userData).toEqual({
      ...userDataBefore,
      [destinationMember]: { ...userDataBefore[destinationMember], [movieId]: { Played: true } },
    });
    expect(imports.servers.display).toEqual(displayBefore);
    expect(accountRecords(imports)).toEqual(recordsBefore);
    await expect(page.getByRole('dialog')).toContainText('Watch history only');
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Reveal new credentials', exact: true }),
    ).toHaveCount(0);
    await expectContainedLayout(page);
    await page.screenshot({
      path: info.outputPath(`${protection}-history-completed.png`),
      fullPage: true,
    });
  });
}

test('verified high matching coverage succeeds while failed writes stay in review', async ({
  page,
  imports,
}, info) => {
  const time = new Date().toISOString();
  const job: Job = {
    id: 'synthetic-verified-migration',
    kind: 'migrate',
    status: 'partial',
    migration_scope: 'watched_only',
    created_at: time,
    updated_at: time,
    started_at: time,
    finished_at: time,
    progress: { processed: 1, total: 1 },
    results: [
      {
        username: 'Synthetic matched member',
        status: 'partial',
        created: false,
        target_user_id: destinationMember,
        source_items: 500,
        source_played: 500,
        matched: 480,
        unmatched: 15,
        ambiguous: 5,
        applied: 3,
        already_played: 477,
        discord_delivery: 'not_requested',
        migration_outcome: { version: 1, execution: 'verified', unresolved_source_history: 120 },
        data: {
          ...migrationDetails(),
          items_updated: 3,
          write_metrics: {
            attempts: 3,
            succeeded: 3,
            failed: 0,
            cumulative_ms: 100,
            max_ms: 40,
            peak_in_flight: 3,
          },
          verification: {
            checked: 470,
            verified: 468,
            preserved_newer: 2,
            missing: 0,
            mismatched: 0,
            unsupported_fields: 0,
          },
        },
      },
    ],
  };
  imports.app.jellyport.store.saveJob(job);
  const completed = structuredClone(job);
  completed.id = 'synthetic-completed-migration';
  completed.status = 'completed';
  const completedResult = completed.results[0]!;
  completedResult.username = 'Synthetic completed member';
  completedResult.status = 'completed';
  completedResult.matched = 500;
  completedResult.unmatched = 0;
  completedResult.ambiguous = 0;
  completedResult.already_played = 497;
  completedResult.migration_outcome!.unresolved_source_history = 0;
  completedResult.data!.verification = {
    checked: 500,
    verified: 498,
    preserved_newer: 2,
    missing: 0,
    mismatched: 0,
    unsupported_fields: 0,
  };
  imports.app.jellyport.store.saveJob(completed);
  const failedWrite = structuredClone(job);
  failedWrite.id = 'synthetic-failed-write-migration';
  const result = failedWrite.results[0]!;
  result.username = 'Synthetic failed-write member';
  result.applied = 2;
  result.migration_outcome!.execution = 'needs_review';
  result.data!.failed_items = 1;
  result.data!.items_updated = 2;
  result.data!.write_metrics = {
    attempts: 3,
    succeeded: 2,
    failed: 1,
    cumulative_ms: 100,
    max_ms: 40,
    peak_in_flight: 3,
  };
  result.data!.verification = {
    checked: 470,
    verified: 467,
    preserved_newer: 2,
    missing: 1,
    mismatched: 0,
    unsupported_fields: 0,
  };
  imports.app.jellyport.store.saveJob(failedWrite);

  await page.goto('/#/activity');
  const status = page.getByRole('combobox', { name: 'Status', exact: true });
  const matchedRow = page.getByRole('row').filter({ hasText: 'Synthetic matched member' });
  const completedRow = page.getByRole('row').filter({ hasText: 'Synthetic completed member' });
  const failedRow = page.getByRole('row').filter({ hasText: 'Synthetic failed-write member' });
  await expect(matchedRow).toContainText('Completed');
  await expect(completedRow).toContainText('Completed');
  await expect(failedRow).toContainText('Needs review');
  await expect(page.getByText('Succeeded with warnings', { exact: true })).toHaveCount(0);
  await expect(status.locator('option')).toHaveText([
    'All operations',
    'Running or queued',
    'Completed',
    'Needs review',
    'Failed',
    'Canceled',
  ]);
  await status.selectOption('partial');
  await expect(matchedRow).toHaveCount(0);
  await expect(completedRow).toHaveCount(0);
  await expect(failedRow).toBeVisible();
  await failedRow.getByRole('button', { name: 'View operation details', exact: true }).click();
  const failedDetails = page.getByRole('dialog', { name: 'Migration details', exact: true });
  await expect(
    failedDetails.getByText('Review this operation before retrying.', { exact: true }),
  ).toBeVisible();
  await failedDetails.getByRole('button', { name: 'Close', exact: true }).click();
  await status.selectOption('completed');
  await expect(failedRow).toHaveCount(0);
  await expect(matchedRow).toBeVisible();
  await expect(completedRow).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('matching-success-activity-filter.png'),
    fullPage: true,
  });
  await matchedRow.getByRole('button', { name: 'View operation details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Migration details', exact: true });
  await expect(details.getByText('Completed', { exact: true })).toHaveCount(2);
  await expect(details.getByText('Succeeded with warnings', { exact: true })).toHaveCount(0);
  await expect(
    details.getByText('Review this operation before retrying.', { exact: true }),
  ).toHaveCount(0);
  const coverage = details.getByRole('region', { name: 'Matching coverage', exact: true });
  await expect(coverage).toContainText('96.0% matched');
  await expect(coverage).toContainText('480 of 500 identifiable source items');
  await expect(coverage).toContainText(
    '20 identifiable source items skipped: 15 unmatched · 5 ambiguous',
  );
  await expect(coverage).toContainText('not unique Jellyfin items or every saved-history row');
  await expect(coverage).toContainText('120 saved-history rows have no verified media identity');
  await expect(coverage).toContainText('excluded from this percentage');
  await coverage.scrollIntoViewIfNeeded();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('matching-success-coverage.png'), fullPage: true });
  expect(imports.writes).toEqual([]);
  expect(imports.userDataWrites).toEqual([]);
  expect(imports.accountWrites).toEqual([]);
});
