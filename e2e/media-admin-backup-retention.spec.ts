import { test, expect, expectContainedLayout } from './media-admin-import-fixture';

test('Jellyfin backup retention saves independently and keeps safe cleanup diagnostics usable on every layout', async ({
  page,
  imports,
}, testInfo) => {
  await page.goto('/#/settings/history/jellyfin');
  let panel = page.getByRole('region', { name: 'Saved Jellyfin matching catalog', exact: true });
  await panel.getByText('Daily schedule', { exact: true }).click();
  await panel.getByLabel('Import time', { exact: true }).fill('04:30');
  let cleanup = panel.getByRole('region', { name: 'Jellyfin backup cleanup', exact: true });
  await cleanup.getByText('Automatic backup cleanup', { exact: true }).click();
  await expect(cleanup.getByRole('checkbox')).not.toBeChecked();
  await expect(
    cleanup.getByLabel('Jellyport-created backups to keep', { exact: true }),
  ).toHaveValue('7');
  await expect(
    cleanup.getByText('Backup cleanup permission is not enabled on the helper.', { exact: true }),
  ).toBeVisible();
  await cleanup.getByText('Enable automatic Jellyfin backup cleanup', { exact: true }).click();
  await cleanup.getByLabel('Jellyport-created backups to keep', { exact: true }).fill('14');
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/destination-catalog/backup-retention' &&
      response.request().method() === 'PUT',
  );
  await cleanup.getByRole('button', { name: 'Save backup cleanup', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(
    cleanup.getByText('Keep the latest 14 Jellyport-created backups', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel('Import time', { exact: true })).toHaveValue('04:30');
  expect((await imports.destinationStatus()).config).toMatchObject({
    enabled: false,
    hour: 3,
    minute: 0,
  });
  expect(imports.nativeBackupCalls()).toBe(0);
  expect(imports.helperImports()).toBe(0);
  await expectContainedLayout(page);
  await page.screenshot({
    path: testInfo.outputPath('backup-retention-saved.png'),
    fullPage: true,
  });

  await page.reload();
  panel = page.getByRole('region', { name: 'Saved Jellyfin matching catalog', exact: true });
  cleanup = panel.getByRole('region', { name: 'Jellyfin backup cleanup', exact: true });
  await expect(
    cleanup.getByText('Keep the latest 14 Jellyport-created backups', { exact: true }),
  ).toBeVisible();
  await cleanup.getByText('Automatic backup cleanup', { exact: true }).click();
  await expect(cleanup.getByRole('checkbox')).toBeChecked();
  await expect(
    cleanup.getByLabel('Jellyport-created backups to keep', { exact: true }),
  ).toHaveValue('14');

  // Exercise failure presentation using only the isolated synthetic server's
  // local status; keep all external-request and server-error guards enabled.
  await page.route(`${imports.url}/api/destination-catalog`, async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.backup_cleanup = {
      ...value.backup_cleanup,
      last_run_at: '2026-01-02T03:00:00Z',
      last_outcome: 'failed',
      last_deleted: 2,
      error: 'synthetic-internal-detail-not-for-display',
    };
    await route.fulfill({ response, json: value });
  });
  await panel.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(
    cleanup.getByText('Jellyfin backup cleanup could not finish.', { exact: true }),
  ).toBeVisible();
  await expect(cleanup.getByText('Failed', { exact: true })).toBeVisible();
  await expect(
    page.getByText('synthetic-internal-detail-not-for-display', { exact: true }),
  ).toHaveCount(0);
  await expect(
    cleanup.getByRole('button', { name: 'Save backup cleanup', exact: true }),
  ).toBeEnabled();
  await expectContainedLayout(page);
  await page.screenshot({
    path: testInfo.outputPath('backup-retention-failed.png'),
    fullPage: true,
  });
});
