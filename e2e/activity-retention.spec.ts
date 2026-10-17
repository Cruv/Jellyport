import { test, expect, navigate, expectContainedLayout } from './fixtures';

test('activity retention has an independent compact settings view and starts off', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/#settings-activity');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Automatic cleanup off', { exact: true })).toBeVisible();
  const form = page.getByRole('form', { name: 'Activity retention' });
  await expect(
    form.getByRole('checkbox', { name: 'Enable automatic activity cleanup' }),
  ).not.toBeChecked();
  await expect(form.getByRole('spinbutton')).toHaveValue('30');
  await expect(form.getByRole('button', { name: 'Save activity retention' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeHidden();
  await expect(page.getByText(/at most 100 reports per pass/)).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('activity-retention.png'), fullPage: true });
  await navigate(page, 'Activity');
  expect(new URL(page.url()).hash).toBe('');
  expect(mutations).not.toContain('PUT /api/jobs/retention');
});

test('failed and review-needed filters select recent finished reports for manual cleanup', async ({
  page,
  mutations,
}) => {
  const now = new Date().toISOString();
  await page.route('**/api/jobs', async (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'synthetic-failed-report',
            kind: 'migrate',
            status: 'failed',
            created_at: now,
            finished_at: now,
          },
          {
            id: 'synthetic-review-report',
            kind: 'migrate',
            status: 'partial',
            created_at: now,
            finished_at: now,
          },
          { id: 'synthetic-active-report', kind: 'migrate', status: 'running', created_at: now },
        ],
      },
    }),
  );
  await page.goto('/');
  await navigate(page, 'Activity');
  for (const status of ['failed', 'partial']) {
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption(status);
    await page.getByRole('button', { name: 'Clear history…' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Clear activity history?' });
    await expect(confirmation.getByRole('combobox', { name: 'Reports to review' })).toHaveValue(
      'filtered',
    );
    await expect(confirmation.getByRole('combobox', { name: 'Recorded before' })).toHaveValue(
      'all',
    );
    await expect(confirmation).toContainText('1 finished report selected.');
    await expect(confirmation).toContainText('Failed and Needs review activity');
    await expectContainedLayout(page);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  expect(mutations).not.toContain('POST /api/jobs/cleanup');
});
