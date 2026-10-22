import { test, expect, navigate, expectContainedLayout } from './fixtures';

const pages = [
  ['Overview', '#/overview'],
  ['Users', '#/users'],
  ['Migrate users', '#/migrate'],
  ['Create account', '#/accounts'],
  ['User mappings', '#/mappings'],
  ['Account roles', '#/roles'],
  ['Memberships', '#/memberships'],
  ['Activity', '#/activity'],
  ['Settings', '#/settings/media/emby'],
] as const;

test('every workspace page remains selected after reload without replaying actions', async ({
  page,
  mutations,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  for (const [heading, hash] of pages) {
    await navigate(page, heading);
    await expect.poll(() => new URL(page.url()).hash).toBe(hash);
    await page.reload();
    await expect(page.getByRole('heading', { name: heading, level: 1, exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe(hash);
    const current = page.locator('#workspace-navigation button[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(heading);
    await expectContainedLayout(page);
  }
  expect(mutations).toEqual([]);
});

test('structural tab bookmarks restore only their task, leaving private drafts and account identities out', async ({
  page,
  mutations,
}) => {
  test.setTimeout(60_000);
  for (const [hash, heading, tab] of [
    ['#/users/organization', 'Users', 'Discord organization'],
    ['#/mappings/editor', 'User mappings', 'Add mapping'],
    ['#/roles/apply', 'Account roles', 'Apply role'],
    ['#/accounts/recover', 'Create account', 'Recover interrupted creation'],
    ['#/memberships/accounts/editor', 'Memberships', 'Add member'],
    ['#/memberships/events/history', 'Memberships', 'Processed'],
    ['#/settings/history/jellyfin', 'Settings', 'Jellyfin catalog'],
  ] as const) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { name: heading, level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.reload();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(new URL(page.url()).hash).toBe(hash);
  }
  await page.goto('/#/mappings/editor');
  const draft = page.getByRole('textbox', { name: 'New Jellyfin username', exact: true });
  await draft.fill('synthetic_private_draft');
  expect(new URL(page.url()).hash).toBe('#/mappings/editor');
  await page.reload();
  await expect(draft).toHaveValue('');
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users' }).fill('synthetic-private-filter');
  expect(new URL(page.url()).hash).toBe('#/users');
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search users' })).toHaveValue('');
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  expect(mutations).toEqual([]);
});

test('back and forward restore pages and nested Settings views without duplicate navigation entries', async ({
  page,
  mutations,
}) => {
  await page.goto('/#/activity');
  await navigate(page, 'Users');
  await navigate(page, 'Settings');
  const tabs = page.getByRole('tablist', { name: 'Settings sections' });
  await tabs.getByRole('tab', { name: 'Saved history', exact: true }).click();
  await page.getByRole('tab', { name: 'Jellyfin catalog', exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings/history/jellyfin');
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Emby backup', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings/history/emby');
  await page.goBack();
  await expect(tabs.getByRole('tab', { name: 'Servers', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Users', level: 1, exact: true })).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('tab', { name: 'Emby backup', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goForward();
  await expect(page.getByRole('tab', { name: 'Jellyfin catalog', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Choosing the already-current tab must not create a second history entry.
  await page.getByRole('tab', { name: 'Jellyfin catalog', exact: true }).click();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings/history/emby');
  expect(mutations).toEqual([]);
});

test('invalid and action-like bookmarks normalize to safe views without changing accounts or history', async ({
  page,
  mutations,
}) => {
  for (const [hash, normalized, heading] of [
    ['#/delete-all-history', '#/overview', 'Overview'],
    ['#/activity/delete/synthetic-private-job', '#/activity', 'Activity'],
    ['#/accounts/create?username=synthetic-private-user', '#/accounts', 'Create account'],
  ] as const) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { name: heading, level: 1, exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe(normalized);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(mutations).toEqual([]);
});

test('back navigation dismisses a delete review and forward does not replay its confirmation', async ({
  page,
  mutations,
}) => {
  await page.route('**/api/jobs', async (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'synthetic-private-report',
            kind: 'migrate',
            status: 'completed',
            created_at: '2000-01-01T00:00:00Z',
            finished_at: '2000-01-02T00:00:00Z',
            results: [],
          },
        ],
      },
    }),
  );
  await page.goto('/#/overview');
  await navigate(page, 'Activity');
  await page.getByRole('button', { name: 'Delete activity…', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(new URL(page.url()).hash).toBe('#/activity');
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Overview', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'Activity', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('#/activity');
  expect(mutations).toEqual([]);
});

test.describe('bookmarks behind administrator authentication', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('retains the requested Settings tab through sign-in and reload without applying an action', async ({
    page,
    mutations,
  }) => {
    await page.goto('/#/settings/history/jellyfin');
    await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/settings/history/jellyfin');
    await expect(page.getByRole('complementary', { name: 'Main navigation' })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Jellyfin username', exact: true }).fill('admin');
    await page.getByLabel('Jellyfin password', { exact: true }).fill('demo-jellyport');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Jellyfin catalog', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Jellyfin catalog', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(new URL(page.url()).hash).toBe('#/settings/history/jellyfin');
    expect(mutations).toEqual(['POST /api/login']);
  });
});

test('legacy subscription bookmarks join the membership workspace and keep Jellyfin optional', async ({
  page,
  mutations,
}) => {
  await page.goto('/#/subscriptions/history');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Memberships', exact: true }),
  ).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/memberships/events/history');
  await expect(page.getByRole('tab', { name: 'Processed', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page
      .locator('#workspace-navigation')
      .getByRole('button', { name: 'Subscriptions', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Accounts & access', exact: true }).click();
  await page.getByRole('tab', { name: 'Add member', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Enable Jellyfin account provisioning' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Review membership update', exact: true }),
  ).toBeDisabled();
  await expectContainedLayout(page);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Add member', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('searchbox', { name: 'Discord member' })).toHaveValue('');
  expect(mutations).toEqual([]);
});
