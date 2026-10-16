import { test, expect, navigate, expectContainedLayout } from './fixtures';

const pages = [
  'Overview',
  'Users',
  'Migrate users',
  'Create account',
  'User mappings',
  'Account roles',
  'Memberships',
  'Subscriptions',
  'Activity',
  'Settings',
];

for (const name of pages) {
  test(`${name} renders without crashes, overflow or accidental writes`, async ({
    page,
    mutations,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await navigate(page, name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectContainedLayout(page);
    if (name === 'Migrate users') {
      await expect(
        page.getByRole('heading', { name: 'What is migrated', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Use saved Emby snapshot' })).toBeVisible();
    }
    if (name === 'Settings') {
      await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
    }
    expect(mutations).toEqual([]);
  });
}

test('settings section links retain edits, remain visible and survive reload', async ({
  page,
  mutations,
}) => {
  await page.goto('/#settings-accounts');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const length = page.getByRole('spinbutton', { name: 'Generated password length' });
  await length.fill('16');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('link', { name: 'Saved history' }).click();
  await expect(page.getByRole('heading', { name: 'Saved history', exact: true })).toBeInViewport();
  const heading = await page
    .getByRole('heading', { name: 'Saved history', exact: true })
    .boundingBox();
  const bar = await nav.boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
  await nav.getByRole('link', { name: 'Account defaults' }).click();
  await expect(length).toHaveValue('16');
  expect(mutations).toEqual([]);
  await nav.getByRole('link', { name: 'Saved history' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page).toHaveURL(/#settings-history$/);
  await navigate(page, 'Users');
  await expect(page).not.toHaveURL(/#settings-/);
});

test('directory filters work inside the rendered responsive table', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Users');
  await expect(page.getByRole('table')).toContainText('alex');
  const originalRows = await page.getByRole('table').getByRole('row').count();
  expect(originalRows).toBeGreaterThan(2);
  const search = page.getByRole('searchbox', { name: 'Search users' });
  await search.fill('river');
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table')).toContainText('river');
  await search.fill('no-synthetic-user');
  await expect(page.getByText('No users match.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(originalRows);
  await expectContainedLayout(page);
});

test('migration review defers history and closing it never accepts the migration', async ({
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
  await expect(review.getByText('History details deferred', { exact: true })).toBeVisible();
  await expect(review).toContainText(
    'existing Jellyfin password and account permissions will be preserved',
  );
  await review.getByRole('button', { name: 'Back to users', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Select river', exact: true })).toBeChecked();
  expect(mutations).toContain('POST /api/migrations/preview');
  expect(mutations).not.toContain('POST /api/migrations');
  await expectContainedLayout(page);
});

test('mobile navigation contains keyboard focus and restores it on dismissal', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'mobile', 'Desktop navigation is persistent.');
  await page.goto('/');
  await navigate(page, 'Users');
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  const nav = page.getByRole('complementary', { name: 'Main navigation' });
  await toggle.click();
  await expect(nav.getByRole('button', { name: 'Users', exact: true })).toBeFocused();
  await nav.getByRole('button', { name: 'Sign out', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('button', { name: 'Overview', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(nav.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .click({ position: { x: 350, y: 400 } });
  await expect(toggle).toBeFocused();
  await expect(nav).not.toBeInViewport();
});

test.describe('sign-in and sign-out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('uses the real demo session and clears the password after sign-out', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Jellyfin username', exact: true }).fill('admin');
    const password = page.getByLabel('Jellyfin password', { exact: true });
    await password.fill('demo-jellyport');
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Toggle navigation' });
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
    await expect(password).toHaveValue('');
    await expect(page.getByRole('complementary', { name: 'Main navigation' })).toHaveCount(0);
    const session = await page.request.get('/api/session');
    expect((await session.json()).authenticated).toBe(false);
  });
});
