import { readdir } from 'node:fs/promises';
import { test, expect, expectContainedLayout } from './media-admin-import-fixture';

test('nightly import creates one fresh native backup, waits for completion and retains opt-in across restart', async ({
  page,
  imports,
}, testInfo) => {
  test.setTimeout(60_000);
  let manualImports = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/destination-catalog/refresh'
    )
      manualImports++;
  });
  await page.goto('/#/settings/history/jellyfin');
  let panel = page.getByRole('region', { name: 'Saved Jellyfin matching catalog', exact: true });
  const editor = panel.getByRole('region', { name: 'Daily import schedule', exact: true });
  await editor.getByText('Daily schedule', { exact: true }).click();
  const creation = editor.getByRole('checkbox', {
    name: 'Create a fresh Jellyfin backup before each scheduled import',
    exact: true,
  });
  await expect(creation).not.toBeChecked();
  await editor
    .getByText('Create a fresh Jellyfin backup before each scheduled import', { exact: true })
    .click();
  await expect(creation).toBeChecked();
  await editor.getByText('Enable daily backup import', { exact: true }).click();
  await expect(
    editor.getByRole('checkbox', { name: 'Enable daily backup import', exact: true }),
  ).toBeChecked();
  const now = new Date();
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
  const config = (await imports.destinationStatus()).config;
  expect(config).toMatchObject({ enabled: true, create_backup: true, time_zone: 'Etc/UTC' });
  await expect.poll(() => imports.nativeBackupCalls(), { timeout: 10_000 }).toBe(1);
  await expect(panel.getByText('Creating fresh Jellyfin backup…', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText('Scheduled backup preparation', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Import latest Jellyfin backup' })).toBeDisabled();
  expect((await imports.destinationStatus()).record).toBeNull();
  expect(imports.helperImports()).toBe(0);
  expect((await readdir(imports.exchange)).filter((name) => name.endsWith('.request'))).toEqual([]);
  expect(manualImports).toBe(0);
  await expectContainedLayout(page);
  await page.screenshot({
    path: testInfo.outputPath('nightly-backup-creating.png'),
    fullPage: true,
  });

  const createdAt = await imports.completeNativeBackup();
  expect(Date.parse(createdAt)).toBeGreaterThan(Date.parse(imports.backupAt));
  await expect
    .poll(async () => (await imports.destinationStatus()).last_outcome, { timeout: 20_000 })
    .toBe('succeeded');
  expect((await imports.destinationStatus()).record).toMatchObject({
    backup_created_at: createdAt,
    items: 2,
    keys: 4,
  });
  expect(imports.nativeBackupCalls()).toBe(1);
  expect(imports.helperImports()).toBe(1);
  expect(manualImports).toBe(0);
  await panel.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(panel.getByText('Last outcome: Completed', { exact: true })).toBeVisible();
  await expect(
    panel.getByRole('table', { name: 'Imported Jellyfin catalog', exact: true }),
  ).toContainText('2 matching items');
  await expectContainedLayout(page);
  await page.screenshot({
    path: testInfo.outputPath('nightly-backup-imported.png'),
    fullPage: true,
  });

  await imports.restart();
  await page.context().addCookies((await imports.client.storageState()).cookies);
  await page.reload();
  panel = page.getByRole('region', { name: 'Saved Jellyfin matching catalog', exact: true });
  await expect(panel.getByText('Last outcome: Completed', { exact: true })).toBeVisible();
  expect((await imports.destinationStatus()).config).toEqual(config);
  expect((await imports.destinationStatus()).record?.backup_created_at).toBe(createdAt);
  expect(imports.nativeBackupCalls()).toBe(1);
  expect(imports.helperImports()).toBe(1);
  const manual = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/destination-catalog/refresh' &&
      response.request().method() === 'POST',
  );
  await panel.getByRole('button', { name: 'Import latest Jellyfin backup', exact: true }).click();
  expect((await manual).status()).toBe(202);
  await expect.poll(() => imports.helperImports(), { timeout: 15_000 }).toBe(2);
  await expect.poll(async () => (await imports.destinationStatus()).running).toBe(false);
  expect((await imports.destinationStatus()).record?.backup_created_at).toBe(createdAt);
  expect((await imports.destinationStatus()).config).toEqual(config);
  expect(imports.nativeBackupCalls()).toBe(1);
  expect(manualImports).toBe(1);
});
