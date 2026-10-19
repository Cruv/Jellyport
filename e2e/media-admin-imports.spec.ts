import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  expectContainedLayout,
  destinationMember,
  movieId,
  type ImportFixture,
} from './media-admin-import-fixture';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function panel(page: Page, kind: 'emby' | 'jellyfin') {
  await page.goto(`/#/settings/history/${kind}`);
  return page.getByRole('region', {
    name: kind === 'emby' ? 'Saved Emby database snapshots' : 'Saved Jellyfin matching catalog',
    exact: true,
  });
}
async function importBackup(
  page: Page,
  imports: ImportFixture,
  kind: 'emby' | 'jellyfin',
  outcome: 'succeeded' | 'failed' = 'succeeded',
) {
  const view = await panel(page, kind);
  const path =
    kind === 'emby' ? '/api/source-snapshots/refresh' : '/api/destination-catalog/refresh';
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
  await view
    .getByRole('button', {
      name: kind === 'emby' ? 'Import latest backup' : 'Import latest Jellyfin backup',
      exact: true,
    })
    .click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  expect((await response.json()).running).toBe(true);
  const progress = view.getByRole('progressbar', {
    name: kind === 'emby' ? 'Backup import progress' : 'Jellyfin catalog import progress',
    exact: true,
  });
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute('value');
  const read = kind === 'emby' ? imports.sourceStatus : imports.destinationStatus;
  await expect.poll(async () => (await read()).last_outcome, { timeout: 15_000 }).toBe(outcome);
  await expect(
    view.getByText(`Last outcome: ${outcome === 'succeeded' ? 'Completed' : 'Failed'}`, {
      exact: true,
    }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(progress).toHaveCount(0);
  return view;
}
async function importBoth(page: Page, imports: ImportFixture) {
  const sourceView = await importBackup(page, imports, 'emby');
  await sourceView.getByText('Saved captures (1)', { exact: true }).click();
  const originalDate = await page.evaluate(
    (value) => new Date(value).toLocaleString(),
    imports.backupAt,
  );
  await expect(
    sourceView.getByRole('table', { name: 'Saved Emby captures', exact: true }),
  ).toContainText(originalDate);
  const destinationView = await importBackup(page, imports, 'jellyfin');
  await expect(
    destinationView.getByRole('table', { name: 'Imported Jellyfin catalog', exact: true }),
  ).toContainText(originalDate);
  const source = (await imports.sourceStatus()).records[0]!;
  const destination = (await imports.destinationStatus()).record!;
  expect(source.backup_created_at).toBe(imports.backupAt);
  expect(destination.backup_created_at).toBe(imports.backupAt);
  expect(source.expires_at).toBe(
    new Date(Date.parse(imports.backupAt) + 48 * 60 * 60_000).toISOString(),
  );
  expect(destination.expires_at).toBe(source.expires_at);
  const status = await imports.destinationStatus();
  expect(status.error_code).toBeNull();
  expect(status.diagnostic).toMatchObject({
    stage: 'validating_catalog',
    source_rows: 2,
    provider_rows: 2,
    items: 2,
  });
  await expect(destinationView.getByText(/Latest attempt duration:/)).toBeVisible();
  await expect(destinationView.getByText('Last observed stage:')).toContainText(
    'Validating matching catalog',
  );
  return { source, destination };
}
async function editSchedule(view: Locator) {
  const editor = view.getByRole('region', { name: 'Daily import schedule', exact: true });
  await editor.getByText('Daily schedule', { exact: true }).click();
  return editor;
}

test('real backup imports, daily execution and restart preserve original freshness and global drafts before played-state migration', async ({
  page,
  imports,
}, testInfo) => {
  test.setTimeout(60_000);
  let manualDestinationImports = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/destination-catalog/refresh'
    )
      manualDestinationImports++;
  });
  const first = await importBoth(page, imports);
  await expect(
    page.getByRole('table', { name: 'Imported Jellyfin catalog', exact: true }),
  ).toContainText('2 matching items');
  expect(imports.helperImports()).toBe(1);
  expect(manualDestinationImports).toBe(1);
  const ciphertext = (await readdir(imports.exchange)).filter((name) => name.endsWith('.db.enc'));
  expect(ciphertext).toHaveLength(2);
  for (const name of ciphertext) {
    const bytes = await readFile(join(imports.exchange, name));
    expect(bytes.includes(Buffer.from('Synthetic first movie'))).toBe(false);
    expect(bytes.includes(Buffer.from('synthetic-private-account-data'))).toBe(false);
  }

  await page.goto('/#/settings/media/jellyfin');
  const unsaved = 'https://synthetic-unsaved.example.invalid';
  await page.getByLabel(/Public sign-in URL/).fill(unsaved);
  await page.getByRole('tab', { name: 'Saved history', exact: true }).click();
  await page.getByRole('tab', { name: 'Jellyfin catalog', exact: true }).click();
  let view = page.getByRole('region', { name: 'Saved Jellyfin matching catalog', exact: true });
  const editor = await editSchedule(view);
  const now = new Date();
  await editor.getByText('Enable daily backup import', { exact: true }).click();
  await expect(
    editor.getByRole('checkbox', { name: 'Enable daily backup import', exact: true }),
  ).toBeChecked();
  await editor
    .getByLabel('Import time', { exact: true })
    .fill(
      `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
    );
  await editor.getByLabel('Time zone', { exact: true }).fill('Etc/UTC');
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/destination-catalog/schedule' &&
      response.request().method() === 'PUT',
  );
  await editor.getByRole('button', { name: 'Save import schedule', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(
    page.getByText('Jellyfin backup import schedule saved.', { exact: true }),
  ).toBeVisible();
  const config = (await imports.destinationStatus()).config;
  expect(config.enabled).toBe(true);
  expect(imports.app.jellyport.store.settings().jellyfin_public_url).toBe('');
  // No manual import request: the saved daily scheduler and real helper perform this work.
  await expect.poll(() => imports.helperImports(), { timeout: 15_000 }).toBe(2);
  expect(manualDestinationImports).toBe(1);
  await expect.poll(async () => (await imports.destinationStatus()).running).toBe(false);
  await view.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(view.getByText('Last outcome: Completed', { exact: true })).toBeVisible();
  expect((await imports.destinationStatus()).record).toMatchObject({
    id: first.destination.id,
    backup_created_at: imports.backupAt,
    expires_at: first.destination.expires_at,
  });
  await page.screenshot({ path: testInfo.outputPath('real-import-schedule.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Servers', exact: true }).click();
  await page.getByRole('tab', { name: 'Jellyfin', exact: true }).click();
  await expect(page.getByLabel(/Public sign-in URL/)).toHaveValue(unsaved);
  await expectContainedLayout(page);

  const attempt = (await imports.destinationStatus()).last_attempt_at;
  await imports.restart(page);
  view = await panel(page, 'jellyfin');
  await expect(view.getByText('Last outcome: Completed', { exact: true })).toBeVisible();
  expect((await imports.destinationStatus()).config).toEqual(config);
  expect((await imports.destinationStatus()).last_attempt_at).toBe(attempt);
  expect(imports.helperImports()).toBe(2);
  await importBackup(page, imports, 'jellyfin');
  expect(imports.helperImports()).toBe(3);
  expect(manualDestinationImports).toBe(2);
  expect((await imports.destinationStatus()).config).toEqual(config);
  expect((await imports.destinationStatus()).record!.backup_created_at).toBe(imports.backupAt);

  await page.goto('/#/migrate');
  await expect(
    page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }),
  ).toBeChecked();
  await page.getByRole('checkbox', { name: 'Select synthetic_member', exact: true }).check();
  await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
  await expect(review).toContainText('Merge into existing account');
  expect(imports.writes).toEqual([]);
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/migrations' &&
      response.request().method() === 'POST',
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
  expect(imports.servers.played[destinationMember]).toEqual(
    new Set(['00000002000000000000000000000001', movieId]),
  );
  expect(imports.writes).toEqual([{ user: destinationMember, item: movieId }]);
  await expect(page.getByRole('dialog')).toContainText('completed', { ignoreCase: true });
});

test('first failed backup imports show no retained data and recover through the same import controls', async ({
  page,
  imports,
}, testInfo) => {
  test.setTimeout(60_000);
  for (const kind of ['emby', 'jellyfin'] as const) {
    await imports.backup(kind, 'missing');
    const view = await importBackup(page, imports, kind, 'failed');
    await expect(view.getByRole('alert')).not.toHaveCount(0);
    await expect(view.getByText(/Previous.*saved data.*retained/i)).toHaveCount(0);
    await expect(
      view.getByText('No previous saved data is available.', { exact: true }),
    ).toBeVisible();
    if (kind === 'emby') {
      const status = await imports.sourceStatus();
      expect(status.records).toEqual([]);
      expect(status.last_error).not.toMatch(/The last good .* is preserved/i);
      await expect(view.getByText('No saved Emby history', { exact: true })).toBeVisible();
    } else {
      const status = await imports.destinationStatus();
      expect(status.record).toBeNull();
      expect(status.last_error).not.toMatch(/The last good .* is preserved/i);
      await expect(
        view.getByText('No saved Jellyfin matching catalog', { exact: true }),
      ).toBeVisible();
    }
    await expectContainedLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`first-${kind}-import-failed.png`),
      fullPage: true,
    });
    expect(imports.writes).toEqual([]);
    await imports.backup(kind, 'valid');
    await importBackup(page, imports, kind);
  }
  expect((await imports.sourceStatus()).records).toHaveLength(1);
  expect((await imports.destinationStatus()).record).not.toBeNull();
  expect(imports.writes).toEqual([]);
});

test('missing and invalid backups fail visibly, retain original valid history, and recover without live fallback', async ({
  page,
  imports,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto('/#/migrate');
  await page.getByRole('checkbox', { name: 'Select synthetic_member', exact: true }).check();
  await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
  await expect(page.getByText(/No completed database capture is available/)).toBeVisible();
  expect(imports.writes).toEqual([]);
  expect(imports.app.jellyport.store.jobs()).toEqual([]);
  const first = await importBoth(page, imports);
  await imports.backup('emby', 'missing');
  let view = await importBackup(page, imports, 'emby', 'failed');
  await expect(view.getByText('Previous saved data is retained.', { exact: true })).toBeVisible();
  expect((await imports.sourceStatus()).records[0]).toMatchObject({
    id: first.source.id,
    backup_created_at: imports.backupAt,
    expires_at: first.source.expires_at,
  });
  await imports.backup('emby', 'valid');
  await importBackup(page, imports, 'emby');

  // A newer incomplete native archive must fail; the older valid archive is not a fallback.
  await imports.backup('jellyfin', 'incomplete');
  view = await importBackup(page, imports, 'jellyfin', 'failed');
  await expect(view.getByText('Previous saved data is retained.', { exact: true })).toBeVisible();
  expect((await imports.destinationStatus()).record).toMatchObject({
    id: first.destination.id,
    backup_created_at: imports.backupAt,
    expires_at: first.destination.expires_at,
  });
  await page.screenshot({
    path: testInfo.outputPath('real-import-failed-retained.png'),
    fullPage: true,
  });
  await imports.backup('jellyfin', 'expired');
  view = await importBackup(page, imports, 'jellyfin', 'failed');
  const expired = await imports.destinationStatus();
  expect(expired.record).toMatchObject({
    id: first.destination.id,
    backup_created_at: imports.backupAt,
    expires_at: first.destination.expires_at,
  });
  expect(expired.error_code).toBe('backup_expired');
  // The actual helper rejects the manifest before reading or indexing any media.
  expect(expired.diagnostic).toMatchObject({
    stage: 'validating_backup',
    source_rows: 0,
    provider_rows: 0,
    items: 0,
    keys: 0,
    bytes: 0,
  });
  await expect(view.getByText('Failure reason:')).toContainText('Backup expired');
  await expect(
    view.getByText('Create a fresh database backup in Jellyfin, then import it.', { exact: true }),
  ).toBeVisible();
  await expect(view.getByText(/Latest attempt duration:/)).toBeVisible();
  await expect(view.getByText('Last observed stage:')).toContainText('Validating backup');
  expect((await readdir(imports.exchange)).filter((name) => name.endsWith('.db.enc'))).toHaveLength(
    2,
  );
  await expectContainedLayout(page);
  await page.screenshot({
    path: testInfo.outputPath('expired-backup-early-rejection.png'),
    fullPage: true,
  });
  await imports.backup('jellyfin', 'valid');
  view = await importBackup(page, imports, 'jellyfin');
  await expect(view.getByText('Saved matching catalog available', { exact: true })).toBeVisible();
  await imports.stopHelper();
  await view.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(
    view.getByText('Jellyfin backup import helper is unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(
    view.getByRole('button', { name: 'Import latest Jellyfin backup', exact: true }),
  ).toBeDisabled();
  expect((await imports.destinationStatus()).usable).toBe(true);
  expect(imports.writes).toEqual([]);
  await expectContainedLayout(page);
});
