import { test, expect, navigate, expectContainedLayout } from './fixtures';

test('Activity exposes bulk and per-report deletion while protecting active rows and canceled reviews', async ({
  page,
  mutations,
}, info) => {
  const now = new Date().toISOString();
  await page.route('**/api/jobs', async (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'synthetic-finished-report',
            kind: 'migrate',
            status: 'partial',
            created_at: now,
            finished_at: now,
            results: [{ username: 'Synthetic completed member', status: 'completed' }],
          },
          {
            id: 'synthetic-active-report',
            kind: 'migrate',
            status: 'running',
            created_at: '2000-01-01T00:00:00Z',
            progress: { total: 1, processed: 0 },
            results: [{ username: 'Synthetic active member', status: 'running' }],
          },
        ],
      },
    }),
  );
  await page.goto('/#/activity');
  await expect(
    page.getByRole('heading', { name: 'Activity', level: 1, exact: true }),
  ).toBeVisible();
  const bulk = page.getByRole('button', { name: 'Delete activity…', exact: true });
  await expect(bulk).toBeVisible();
  const deletes = page.getByRole('table').getByRole('button', { name: /^Delete activity report / });
  await expect(deletes).toHaveCount(1);
  const single = deletes.filter({ hasText: 'Delete' });
  await expect(single).toHaveAttribute(
    'aria-label',
    'Delete activity report synthetic-finished-report',
  );
  await expect(single).toBeVisible();
  await single.click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText('synthetic-finished-report');
  await expect(confirmation).toContainText('does not undo migrations');
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('activity-delete-discovery.png'), fullPage: true });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await bulk.click();
  await expect(page.getByRole('dialog')).toContainText('1 finished report selected.');
  const age = page.getByRole('dialog').getByRole('combobox', { name: 'Recorded before' });
  await expect(age).toHaveValue('all');
  await age.selectOption('30');
  await expect(page.getByRole('dialog')).toContainText('0 finished reports selected.');
  await expect(page.getByRole('dialog').getByRole('button', { name: /0 reports$/ })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Configure automatic cleanup', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Automatic cleanup off', { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings/activity');
  expect(mutations).toEqual([]);
});

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
  await expect(details.getByRole('button', { name: 'Delete report…', exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Delete report…', exact: true }).click();
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
  await page.getByRole('button', { name: 'Delete activity…', exact: true }).click();
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
  await details.getByRole('button', { name: 'Delete report…', exact: true }).click();
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
  await details.getByRole('button', { name: 'Delete report…', exact: true }).click();
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
