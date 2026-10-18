import type { Locator, Page } from '@playwright/test';
import { test, expect, navigate, expectContainedLayout, isCompactLayout } from './fixtures';

test.beforeEach(({ browserName, isMobile }) => {
  test.skip(
    browserName !== 'webkit' || !isMobile,
    'These flows exercise the iPhone WebKit profiles.',
  );
});

async function expectTouchTarget(control: Locator) {
  await expect(control).toBeVisible();
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width, 'Touch target width').toBeGreaterThanOrEqual(44);
  expect(bounds!.height, 'Touch target height').toBeGreaterThanOrEqual(44);
}

async function expectEditableControls(page: Page) {
  const tooSmall = await page.locator('input, select, textarea').evaluateAll((elements) =>
    elements
      .filter(
        (element) =>
          element.getClientRects().length &&
          !['checkbox', 'radio', 'hidden'].includes(element.getAttribute('type') || ''),
      )
      .map((element) => ({
        name: element.getAttribute('aria-label') || element.id || element.tagName,
        size: parseFloat(getComputedStyle(element).fontSize),
        height: element.getBoundingClientRect().height,
      }))
      .filter((element) => element.size < 16 || element.height < 44),
  );
  expect(
    tooSmall,
    'Editable controls have 44px targets and at least 16px text to avoid iOS focus zoom.',
  ).toEqual([]);
}

async function expectReachable(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expectTouchTarget(control);
  await expect(control).toBeInViewport({ ratio: 1 });
  const bounds = await control.boundingBox();
  const height = await page.evaluate(() => window.innerHeight);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 1);
}

test('quick administration visits every task without overflow, tiny controls or accidental writes', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/');
  for (const name of [
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
  ]) {
    await navigate(page, name);
    await expectContainedLayout(page);
    await expectEditableControls(page);
    await expectTouchTarget(page.getByRole('button', { name: 'Toggle navigation' }));
    const smallTargets = await page.locator('main button, main summary').evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length)
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            name: element.getAttribute('aria-label') || element.textContent?.trim(),
            width: bounds.width,
            height: bounds.height,
          };
        })
        .filter((target) => target.width < 44 || target.height < 44),
    );
    expect(smallTargets, `${name} controls have 44px touch targets.`).toEqual([]);
  }
  expect(mutations).toEqual([]);
  await page.screenshot({ path: info.outputPath('iphone-settings.png'), fullPage: true });
});

test('search and account actions remain compact in a large directory', async ({
  page,
  mutations,
}, info) => {
  await page.route('**/api/user-directory', async (route) =>
    route.fulfill({
      json: {
        users: Array.from({ length: 120 }, (_, index) => ({
          id: `phone-directory-${index + 1}`,
          emby: [],
          jellyfin: [
            {
              id: `phone-account-${index + 1}`,
              name: `Phone member ${String(index + 1).padStart(3, '0')}`,
              disabled: false,
              protected: false,
            },
          ],
          discord_user_id: null,
          discord_username: null,
          access_mode: 'standalone',
          account_limit: null,
          protected: false,
          family: false,
          requires_review: true,
        })),
      },
    }),
  );
  await page.goto('/');
  await navigate(page, 'Users');
  expect(await isCompactLayout(page)).toBe(true);
  const table = page.getByRole('table', { name: 'Media accounts and confirmed ownership' });
  await expect(table.getByRole('row')).toHaveCount(6);
  const search = page.getByRole('searchbox', { name: 'Search users' });
  await search.fill('Phone member 120');
  await expect(table.getByRole('row')).toHaveCount(2);
  const manage = page.getByRole('button', { name: 'Manage Phone member 120', exact: true });
  await expectTouchTarget(manage);
  await manage.click();
  const access = page.getByRole('button', { name: 'Manage account access for Phone member 120' });
  await expectReachable(page, access);
  await expect(access).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('iphone-user-actions.png'), fullPage: true });
  expect(mutations).toEqual([]);
});

test('creates an account, explicitly reveals credentials, and cancels clearing its report', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/');
  await navigate(page, 'Create account');
  const username = info.project.name.includes('landscape')
    ? 'iphone-landscape-user'
    : 'iphone-portrait-user';
  const input = page.getByRole('textbox', { name: 'Username', exact: true });
  await input.fill(username);
  const create = page
    .getByRole('main')
    .getByRole('button', { name: 'Create account', exact: true });
  await expectReachable(page, create);
  await create.click();
  const details = page.getByRole('dialog', { name: 'Operation details' });
  await expect(details).toBeVisible();
  await expect(details).toContainText(username);
  const reveal = details.getByRole('button', { name: 'Reveal new credentials', exact: true });
  await expectReachable(page, reveal);
  await reveal.click();
  const approval = page.getByRole('dialog', { name: 'Reveal new account credentials?' });
  const accept = approval.getByRole('button', { name: 'Reveal credentials', exact: true });
  expect(mutations.filter((request) => request.endsWith('/credentials'))).toEqual([]);
  await expectReachable(page, accept);
  await accept.click();
  const credentials = page.getByRole('dialog', { name: 'New account credentials', exact: true });
  await expect(credentials).toContainText(username);
  await expectReachable(
    page,
    credentials.getByRole('button', { name: 'Copy credentials', exact: true }),
  );
  await expectEditableControls(page);
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('iphone-credentials.png'), fullPage: true });
  await credentials.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await navigate(page, 'Activity');
  await page.getByRole('searchbox', { name: 'Search operations' }).fill(username);
  await page.getByRole('button', { name: 'Delete activity…', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Clear activity history?' });
  await expect(confirmation).toContainText('1 finished report selected.');
  const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true });
  await expectReachable(page, cancel);
  await cancel.click();
  await expect(confirmation).toHaveCount(0);
  expect(mutations.filter((request) => request === 'POST /api/accounts')).toHaveLength(1);
  expect(mutations.filter((request) => request.endsWith('/credentials'))).toHaveLength(1);
  expect(mutations).not.toContain('POST /api/jobs/cleanup');
  expect(mutations).not.toContain('POST /api/migrations');
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
});

test('rotation and a reduced keyboard-sized viewport retain drafts and reachable actions', async ({
  page,
  mutations,
}, info) => {
  await page.goto('/#settings-accounts');
  await page.getByRole('tab', { name: 'Passwords & messages' }).click();
  const message = page.getByRole('textbox', { name: 'New account message', exact: true });
  const draft = 'Phone draft {username}\nPassword: {password}\n{server_url}';
  await message.fill(draft);
  const rotated = info.project.name.includes('landscape')
    ? { width: 440, height: 763 }
    : { width: 838, height: 390 };
  await page.setViewportSize(rotated);
  await expect(message).toHaveValue(draft);
  expect(await isCompactLayout(page)).toBe(true);
  await expectContainedLayout(page);
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  await expectTouchTarget(toggle);
  await toggle.click();
  const navigation = page.getByRole('complementary', { name: 'Main navigation' });
  const last = navigation.getByRole('button', { name: 'Sign out', exact: true });
  await expectReachable(page, last);
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(message).toHaveValue(draft);
  // WebKit emulation cannot open the physical iOS keyboard. Shrink its visual
  // editing area to exercise the same short viewport and scroll constraints.
  await message.focus();
  await page.setViewportSize({ width: rotated.width, height: 240 });
  await expect(message).toHaveValue(draft);
  await expectEditableControls(page);
  await expectReachable(page, page.getByRole('button', { name: 'Save settings', exact: true }));
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('iphone-short-editing-viewport.png'),
    fullPage: true,
  });
  expect(mutations).toEqual([]);
});

test('synthetic safe-area insets keep drawer controls and confirmation footers reachable', async ({
  page,
  mutations,
}, info) => {
  await page.route('**/api/jobs', async (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'synthetic-phone-report',
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
  await page.goto('/');
  // Device emulation supplies Safari/touch/screen metrics, not physical notch
  // env() values. Override only the app's inset variables as a synthetic check.
  const insets = info.project.name.includes('landscape')
    ? { top: 0, right: 47, bottom: 21, left: 47 }
    : { top: 47, right: 0, bottom: 34, left: 0 };
  await page.evaluate((value) => {
    for (const [edge, size] of Object.entries(value))
      document.documentElement.style.setProperty(`--safe-area-${edge}`, `${size}px`);
  }, insets);
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  await toggle.click();
  const signOut = page
    .getByRole('complementary', { name: 'Main navigation' })
    .getByRole('button', { name: 'Sign out', exact: true });
  await expectReachable(page, signOut);
  const control = await signOut.boundingBox();
  expect(control!.x).toBeGreaterThanOrEqual(insets.left);
  expect(control!.y + control!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height - insets.bottom + 1,
  );
  await page.keyboard.press('Escape');
  await navigate(page, 'Activity');
  await page.getByRole('button', { name: 'Delete activity…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear activity history?' });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expectReachable(page, cancel);
  const modal = await dialog.boundingBox();
  expect(modal!.x).toBeGreaterThanOrEqual(insets.left);
  expect(modal!.x + modal!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width - insets.right + 1,
  );
  expect(modal!.y).toBeGreaterThanOrEqual(insets.top);
  expect(modal!.y + modal!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height - insets.bottom + 1,
  );
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('iphone-synthetic-safe-areas.png'),
    fullPage: true,
  });
  // A keyboard can leave much less space than the device's landscape viewport.
  // Check clipping inside the dialog as well as its position inside the window.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 240 });
  await expectReachable(page, cancel);
  const body = dialog.locator('.modal-body');
  const usableHeight = await body.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  });
  expect(usableHeight, 'The dialog retains room for a full touch control.').toBeGreaterThanOrEqual(
    44,
  );
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('iphone-short-safe-area-dialog.png'),
    fullPage: true,
  });
  await cancel.click();
  expect(mutations).toEqual([]);
});
