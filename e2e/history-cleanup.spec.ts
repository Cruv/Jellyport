import { test, expect, navigate, expectContainedLayout } from './fixtures';

test('clears a reviewed report after credentials are consumed, preserving the media account', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/');
  await navigate(page, 'Create account');
  const username = `history-cleanup-${info.project.name}`;
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/accounts' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('main').getByRole('button', { name: 'Create account', exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await expect
    .poll(async () => (await (await page.request.get(`/api/jobs/${id}`)).json()).status)
    .toBe('completed');
  let details = page.getByRole('dialog', { name: 'Operation details' });
  await expect(details.getByRole('button', { name: 'Clear report…', exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Clear report…', exact: true }).click();
  let confirmation = page.getByRole('dialog', { name: 'Clear this report?' });
  await expect(confirmation).toContainText(id);
  await expect(confirmation).toContainText('does not undo migrations');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mutations).not.toContain('POST /api/jobs/cleanup');
  await navigate(page, 'Activity');
  const search = page.getByRole('searchbox', { name: 'Search operations' });
  await search.fill(id);
  await expect(search).toHaveValue(id);
  await expect(page.getByRole('button', { name: 'View operation details' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear history…', exact: true }).click();
  const bulk = page.getByRole('dialog', { name: 'Clear activity history?' });
  await expect(bulk.getByRole('combobox', { name: 'Reports to review' })).toHaveValue('filtered');
  await expect(bulk.getByRole('combobox', { name: 'Recorded before' })).toHaveValue('all');
  await expect(bulk).toContainText('1 finished report selected.');
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('clear-history-review.png'), fullPage: true });
  await bulk.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mutations).not.toContain('POST /api/jobs/cleanup');
  await page.getByRole('button', { name: 'View operation details' }).click();
  details = page.getByRole('dialog', { name: 'Operation details' });
  await details.getByRole('button', { name: 'Clear report…', exact: true }).click();
  confirmation = page.getByRole('dialog', { name: 'Clear this report?' });
  await confirmation.getByRole('button', { name: 'Clear 1 report', exact: true }).click();
  await expect(confirmation).toContainText('0 reports cleared. 1 kept.');
  await expect(confirmation).toContainText(
    'New credentials still await delivery or one-time reveal',
  );
  await confirmation.getByRole('button', { name: 'Done', exact: true }).click();
  expect((await page.request.get(`/api/jobs/${id}`)).ok()).toBe(true);

  await page.getByRole('button', { name: 'View operation details' }).click();
  details = page.getByRole('dialog', { name: 'Operation details' });
  await details.getByRole('button', { name: 'Reveal new credentials', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reveal new account credentials?' })
    .getByRole('button', { name: 'Reveal credentials', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'New account credentials', exact: true })
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.getByRole('button', { name: 'View operation details' }).click();
  details = page.getByRole('dialog', { name: 'Operation details' });
  await details.getByRole('button', { name: 'Clear report…', exact: true }).click();
  confirmation = page.getByRole('dialog', { name: 'Clear this report?' });
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('clear-report-review.png'), fullPage: true });
  await confirmation.getByRole('button', { name: 'Clear 1 report', exact: true }).click();
  await expect(confirmation).toContainText('1 report cleared. 0 kept.');
  await confirmation.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('No matching operations', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/jobs/${id}`)).ok()).toBe(false);
  const users = await (await page.request.get('/api/users')).json();
  expect(users.jellyfin.some((user: { Name: string }) => user.Name === username)).toBe(true);
  await page.reload();
  await navigate(page, 'Activity');
  await page.getByRole('searchbox', { name: 'Search operations' }).fill(id);
  await expect(page.getByText('No matching operations', { exact: true })).toBeVisible();
  expect(mutations.filter((request) => request === 'POST /api/jobs/cleanup')).toHaveLength(2);
});
