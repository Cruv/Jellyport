import { test, expect, navigate, expectContainedLayout } from './fixtures';

test('creates an independent account and reveals its credentials only on request', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/');
  await navigate(page, 'Create account');
  const username = `browser-test-${info.project.name}`;
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
  await page.getByRole('main').getByRole('button', { name: 'Create account', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Operation details' });
  await expect(details).toBeVisible();
  await expect(details).toContainText(username);
  await details.getByRole('button', { name: 'Reveal new credentials', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Reveal new account credentials?' });
  await expect(confirmation).toContainText('one-time view');
  expect(mutations.filter((request) => request.endsWith('/credentials'))).toEqual([]);
  await confirmation.getByRole('button', { name: 'Reveal credentials', exact: true }).click();
  const credentials = page.getByRole('dialog', { name: 'New account credentials', exact: true });
  await expect(credentials).toBeVisible();
  await expect(credentials).toContainText(username);
  await expect(
    credentials.getByRole('button', { name: 'Copy credentials', exact: true }),
  ).toBeVisible();
  await expectContainedLayout(page);
  await credentials.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(credentials).toHaveCount(0);
  expect(mutations.filter((request) => request === 'POST /api/accounts')).toHaveLength(1);
  expect(mutations.filter((request) => request.endsWith('/credentials'))).toHaveLength(1);
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(storage).toEqual({ local: {}, session: {} });
  await navigate(page, 'Users');
  await page.getByRole('searchbox', { name: 'Search users' }).fill(username);
  await expect(page.getByRole('table')).toContainText(username);
});

test('explicit approval runs a played-only migration through the real demo backend', async ({
  page,
  mutations,
}) => {
  await page.goto('/');
  await navigate(page, 'Migrate users');
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot' }).uncheck();
  await page.getByRole('checkbox', { name: 'Select river', exact: true }).check();
  await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your migration' });
  await expect(review).toBeVisible();
  expect(mutations).not.toContain('POST /api/migrations');
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/migrations' &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Start migration', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const details = page.getByRole('dialog', { name: 'Migration details' });
  await expect(details).toBeVisible();
  await expect(details).toContainText('Independent played-status verification', {
    timeout: 15_000,
  });
  await expect
    .poll(async () => (await (await page.request.get(`/api/jobs/${id}`)).json()).status)
    .toBe('completed');
  const job = await (await page.request.get(`/api/jobs/${id}`)).json();
  expect(job.migration_scope).toBe('watched_only');
  expect(job.results).toHaveLength(1);
  const result = job.results[0];
  expect(result.username).toBe('river');
  expect(result.created).not.toBe(true);
  expect(result.data.verification.missing).toBe(0);
  expect(result.data.verification.mismatched).toBe(0);
  expect(result.data.resume_positions).toBe(0);
  expect(result.data.favorites).toBe(0);
  expect(result.data.playlists_created).toBe(0);
  expect(mutations.filter((request) => request === 'POST /api/migrations')).toHaveLength(1);
  await details.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(details).toHaveCount(0);
});
