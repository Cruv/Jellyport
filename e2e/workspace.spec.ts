import { test, expect, navigate, expectContainedLayout, isCompactLayout } from './fixtures';
import type { DirectoryUser, Users } from '../frontend/src/types';

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
  }, info) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await navigate(page, name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectContainedLayout(page);
    if (name === 'Migrate users') {
      const help = page.locator('summary').filter({ hasText: /^What is migrated$/ });
      await expect(help).toBeVisible();
      await expect(
        page.getByText('Only played or unplayed status is migrated.', { exact: false }),
      ).toBeHidden();
      await help.click();
      await expect(
        page.getByText('Only played or unplayed status is migrated.', { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Use saved Emby snapshot' })).toBeVisible();
    }
    if (name === 'Settings') {
      await expect(page.getByRole('tablist', { name: 'Settings sections' })).toBeVisible();
      await expect(page.getByRole('tabpanel')).toHaveCount(2);
      await expect(
        page.getByRole('heading', { name: 'Jellyfin · destination server' }),
      ).toBeHidden();
      await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
    }
    expect(mutations).toEqual([]);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: info.outputPath('workspace.png'), fullPage: true });
  });
}

test('settings task tabs preserve drafts and independent schedules without exposing unrelated forms', async ({
  page,
  mutations,
}) => {
  await page.goto('/#settings-accounts');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const nav = page.getByRole('tablist', { name: 'Settings sections' });
  await expect(nav.getByRole('tab', { name: 'Account defaults' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'New account permissions' })).toBeVisible();
  await page.getByRole('tab', { name: 'Passwords & messages' }).click();
  const length = page.getByRole('spinbutton', { name: 'Generated password length' });
  await length.fill('16');
  const template = page.getByRole('textbox', { name: 'New account message', exact: true });
  const message = 'Welcome {username}\nOpen {server_url}\nPassword: {password}';
  await template.fill(message);
  await nav.getByRole('tab', { name: 'Servers', exact: true }).click();
  const source = page.locator('#setting-emby_url');
  const key = page.locator('#setting-emby_api_key');
  await source.fill('http://synthetic-draft.example.test:8096');
  await key.fill('synthetic-draft-only-key');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(length).toBeHidden();
  await expect(template).toBeHidden();
  await nav.getByRole('tab', { name: 'Saved history', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Saved Emby database snapshots' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved Jellyfin matching catalog' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeHidden();
  const schedule = page.locator('summary').filter({ hasText: /^Daily schedule$/ });
  await expect(schedule).toBeVisible();
  await schedule.click();
  const time = page.getByLabel('Capture time', { exact: true });
  await expect(time).toBeDisabled();
  const scheduleForm = page.getByRole('form', { name: 'Database capture schedule' });
  expect(await scheduleForm.evaluate((element) => element.closest('#settings-form') === null)).toBe(
    true,
  );
  await page.getByRole('tab', { name: 'Jellyfin catalog', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved Jellyfin matching catalog' }),
  ).toBeVisible();
  await expect(time).toBeHidden();
  await page.getByRole('tab', { name: 'Emby backup', exact: true }).click();
  await expect(time).toBeVisible();
  await expect(schedule.locator('..')).toHaveAttribute('open', '');
  await nav.getByRole('tab', { name: 'Account defaults', exact: true }).click();
  await expect(length).toHaveValue('16');
  await expect(template).toHaveValue(message);
  await nav.getByRole('tab', { name: 'Servers', exact: true }).click();
  await expect(source).toHaveValue('http://synthetic-draft.example.test:8096');
  await expect(key).toHaveValue('synthetic-draft-only-key');
  await nav.getByRole('tab', { name: 'Saved history', exact: true }).click();
  await page.reload();
  await expect(page).toHaveURL(/#\/settings\/history\/emby$/);
  await expect(nav.getByRole('tab', { name: 'Saved history' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await nav.getByRole('tab', { name: 'Saved history' }).focus();
  await page.keyboard.press('Home');
  await expect(nav.getByRole('tab', { name: 'Servers' })).toBeFocused();
  await expect(nav.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(nav.getByRole('tab', { name: 'Account defaults' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'New account permissions' })).toBeVisible();
  await navigate(page, 'Users');
  await expect(page).toHaveURL(/#\/users$/);
  expect(mutations).toEqual([]);
});

const settingsViews = [
  ['Servers', 'Emby', 'Emby · source server'],
  ['Servers', 'Jellyfin', 'Jellyfin · destination server'],
  ['Servers', 'Path mapping', 'Media path mapping'],
  ['Account defaults', 'Permissions', 'New account permissions'],
  ['Account defaults', 'Passwords & messages', 'New account passwords and messages'],
  ['Discord', 'Bot connection', 'Discord · optional'],
  ['Discord', 'Private alerts & commands', 'Private admin alerts'],
  ['Automation', 'Membership tiers', 'Membership tiers'],
  ['Automation', 'Automation rules', 'Membership automation'],
  ['Saved history', 'Emby backup', 'Saved Emby database snapshots'],
  ['Saved history', 'Jellyfin catalog', 'Saved Jellyfin matching catalog'],
] as const;

test('each focused Settings view has bounded content and a contained responsive layout', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/#settings-media');
  const nav = page.getByRole('tablist', { name: 'Settings sections' });
  await expect(nav).toBeVisible();
  for (const [main, sub, heading] of settingsViews) {
    await nav.getByRole('tab', { name: main, exact: true }).click();
    await page.getByRole('tab', { name: sub, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toHaveCount(2);
    await expectContainedLayout(page);
    const contentHeight = await page
      .locator('#workspace-content')
      .evaluate((element) => element.scrollHeight);
    expect(contentHeight, `${main} / ${sub} renders only its current task`).toBeLessThanOrEqual(
      (await isCompactLayout(page)) ? 2400 : 1700,
    );
    await page.screenshot({
      path: info.outputPath(`settings-${sub.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`),
      fullPage: true,
    });
  }
  expect(mutations).toEqual([]);
});

const largeDirectory: DirectoryUser[] = Array.from({ length: 120 }, (_, index) => ({
  id: `synthetic-directory-${index + 1}`,
  emby:
    index % 2 === 0
      ? [
          {
            id: `emby-${index + 1}`,
            name: `Member ${String(index + 1).padStart(3, '0')}`,
            disabled: false,
            protected: false,
          },
        ]
      : [],
  jellyfin: [
    {
      id: `jellyfin-${index + 1}`,
      name: `Member ${String(index + 1).padStart(3, '0')}`,
      disabled: false,
      protected: false,
    },
  ],
  discord_user_id: null,
  discord_username: null,
  access_mode: index % 3 === 0 ? 'subscription' : 'standalone',
  account_limit: null,
  family: index % 4 === 0,
  protected: false,
  requires_review: index % 5 === 0,
}));

test('120-user directory keeps rendering bounded and filters reset paging without API writes', async ({
  page,
  mutations,
}, info) => {
  let reads = 0;
  await page.route('**/api/user-directory', async (route) => {
    expect(route.request().method()).toBe('GET');
    reads++;
    await route.fulfill({ json: { users: largeDirectory } });
  });
  await page.goto('/');
  await navigate(page, 'Users');
  const table = page.getByRole('table', { name: 'Media accounts and confirmed ownership' });
  const compact = await isCompactLayout(page);
  const size = compact ? 5 : 25;
  await expect(table.getByRole('row')).toHaveCount(size + 1);
  const pagination = page.getByRole('navigation', { name: 'Users', exact: true });
  await expect(pagination).toContainText(`1–${size} of 120`);
  await expect(table).toContainText('Member 001');
  await expect(table).not.toContainText(`Member ${String(size + 1).padStart(3, '0')}`);
  const initialHeight = await page
    .locator('#workspace-content')
    .evaluate((element) => element.scrollHeight);
  await page.screenshot({ path: info.outputPath('directory-120.png'), fullPage: true });
  expect(
    initialHeight,
    'The default directory page stays bounded with 120 users',
  ).toBeLessThanOrEqual(compact ? 2400 : 1800);
  await pagination.getByRole('button', { name: 'Next page' }).click();
  await expect(table).toContainText(`Member ${String(size + 1).padStart(3, '0')}`);
  await expect(table).not.toContainText('Member 001');
  const search = page.getByRole('searchbox', { name: 'Search users' });
  await search.fill('Member 12');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(pagination).toContainText('Page 1 of 1');
  await expect(table).toContainText('Member 120');
  await page.getByRole('tab', { name: 'Discord organization', exact: true }).click();
  await expect(table).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Discord organization roles' })).toBeVisible();
  await page.getByRole('tab', { name: /Directory/ }).click();
  await expect(search).toHaveValue('Member 12');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(size + 1);
  await page.getByRole('combobox', { name: 'Server presence' }).selectOption('both');
  await expect(pagination).toContainText('of 60');
  await page.getByRole('button', { name: 'More filters' }).click();
  await page.getByRole('combobox', { name: 'Access policy' }).selectOption('standalone');
  await expect(pagination).toContainText('of 40');
  await page.getByRole('button', { name: 'Fewer filters' }).click();
  await expect(page.getByRole('combobox', { name: 'Access policy' })).toBeHidden();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  const manage = table.getByRole('button', { name: 'Manage Member 001', exact: true });
  await expect(
    table.getByRole('button', { name: 'Manage account access for Member 001' }),
  ).toBeHidden();
  await manage.click();
  await expect(manage).toHaveAttribute('aria-expanded', 'true');
  await expect(
    table.getByRole('button', { name: 'Manage account access for Member 001' }),
  ).toBeVisible();
  const second = table.getByRole('button', { name: 'Manage Member 002', exact: true });
  await second.click();
  await expect(manage).toHaveAttribute('aria-expanded', 'false');
  await expect(
    table.getByRole('button', { name: 'Manage account access for Member 001' }),
  ).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(second).toHaveAttribute('aria-expanded', 'false');
  await expect(second).toBeFocused();
  await pagination.getByRole('combobox', { name: 'Users per page' }).selectOption('50');
  await expect(table.getByRole('row')).toHaveCount(51);
  await expect(pagination).toContainText('Page 1 of 3');
  await expectContainedLayout(page);
  expect(reads).toBe(1);
  expect(mutations).toEqual([]);
});

const largeMediaUsers: Users = {
  emby: largeDirectory.map((user, index) => ({
    Id: `synthetic-emby-${index + 1}`,
    Name: user.jellyfin[0]!.name,
    Policy: { IsDisabled: false, IsAdministrator: false },
  })),
  jellyfin: [],
};

test('120 migration candidates paginate with cross-page selections retained until explicitly cleared', async ({
  page,
  mutations,
}, info) => {
  await page.route('**/api/users', async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ json: largeMediaUsers });
  });
  await page.goto('/');
  await navigate(page, 'Migrate users');
  const size = (await isCompactLayout(page)) ? 5 : 25;
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(size + 1);
  await page.screenshot({ path: info.outputPath('migration-120.png'), fullPage: true });
  await page.getByRole('checkbox', { name: 'Select all visible Emby users', exact: true }).check();
  await expect(
    page.getByRole('button', { name: `Preview migration (${size})`, exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('navigation', { name: 'Emby users', exact: true })
    .getByRole('button', { name: 'Next page' })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Select all visible Emby users', exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole('checkbox', {
      name: `Select Member ${String(size + 1).padStart(3, '0')}`,
      exact: true,
    })
    .check();
  await page.getByRole('searchbox', { name: 'Search Emby users' }).fill('Member 120');
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Select Member 120', exact: true }).check();
  await expect(
    page.getByRole('button', { name: `Preview migration (${size + 2})`, exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview migration', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('checkbox', { name: 'Select Member 120', exact: true }),
  ).not.toBeChecked();
  expect(mutations).toEqual([]);
  await expectContainedLayout(page);
});

test('keyboard list actions move focus to the selected task tab when their old panel hides', async ({
  page,
  mutations,
}, info) => {
  await page.route('**/api/user-mappings', async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({
      json: {
        mappings: [
          {
            id: 'synthetic-mapping',
            source_user_id: 'synthetic-source-id',
            source_username: 'example_source',
            target_user_id: null,
            target_username: 'example_destination',
            discord_user_id: null,
            discord_username: null,
            revision: 'synthetic-mapping-revision',
          },
        ],
      },
    });
  });
  await page.goto('/');
  await navigate(page, 'User mappings');
  const edit = page.getByRole('button', { name: 'Edit mapping for example_source', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  const editTab = page.getByRole('tab', { name: 'Edit mapping', exact: true });
  await expect(editTab).toBeFocused();
  await expect(editTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Edit user mapping', exact: true })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'New Jellyfin username', exact: true })
    .fill('draft_destination');
  await page.getByRole('tab', { name: /Saved mappings/ }).click();
  const add = page.getByRole('button', { name: 'Add mapping', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Add mapping', exact: true })).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Add a user mapping', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'New Jellyfin username', exact: true }),
  ).toHaveValue('');
  expect(mutations).toEqual([]);
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('mapping-editor.png'), fullPage: true });
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

test('mobile navigation contains keyboard focus and restores it on dismissal', async ({ page }) => {
  await page.goto('/');
  test.skip(
    !(await page.getByRole('button', { name: 'Toggle navigation' }).isVisible()),
    'Wide pointer-based navigation is persistent.',
  );
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
