import type { Page } from '@playwright/test';
import { test, expect, expectContainedLayout } from './media-admin-fixtures';

test('two Settings tabs merge independent edits and surface a same-field conflict', async ({
  page,
  admin,
}) => {
  const second = await page.context().newPage();
  const route = '/#/settings/accounts/passwords';
  const length = (tab: Page) => tab.getByLabel('Generated password length', { exact: true });
  const loadSettings = async (tab: Page, action: () => Promise<unknown>) => {
    // Navigation and successful saves mount Settings again. Let its related reads
    // finish before starting another save, reloading or closing the tab.
    const reads = ['/api/account-roles', '/api/discord/admin-alerts'].map(async (path) => {
      const response = await tab.waitForResponse(
        (value) => new URL(value.url()).pathname === path && value.request().method() === 'GET',
      );
      expect(response.ok()).toBe(true);
      expect(await response.finished()).toBeNull();
    });
    await Promise.all([action(), ...reads]);
  };
  const save = async (tab: Page, status: 200 | 409) => {
    const saved = tab.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/settings' &&
        response.request().method() === 'PUT',
    );
    const click = () => tab.getByRole('button', { name: 'Save settings', exact: true }).click();
    const result = status === 200 ? loadSettings(tab, click) : click();
    const [response] = await Promise.all([saved, result]);
    expect(response.status()).toBe(status);
  };
  try {
    await Promise.all([
      loadSettings(page, () => page.goto(route)),
      loadSettings(second, () => second.goto(route)),
    ]);
    await expect(length(page)).toHaveValue('12');
    await expect(length(second)).toHaveValue('12');
    await length(page).fill('18');
    await second.locator('label[for="setting-password_exclude_ambiguous"]').click();
    await expect(
      second.getByRole('checkbox', { name: 'Avoid ambiguous characters' }),
    ).not.toBeChecked();
    await Promise.all([save(page, 200), save(second, 200)]);
    expect(admin.app.jellyport.store.settings()).toMatchObject({
      password_length: 18,
      password_exclude_ambiguous: false,
    });

    await Promise.all([
      loadSettings(page, () => page.reload()),
      loadSettings(second, () => second.reload()),
    ]);
    await expect(length(page)).toHaveValue('18');
    await expect(length(second)).toHaveValue('18');
    await length(page).fill('22');
    await length(second).fill('24');
    await save(page, 200);
    await save(second, 409);
    await expect(second.getByText('Another save changed these settings.')).toBeVisible();
    await expect(length(second)).toHaveValue('24');
    expect(admin.app.jellyport.store.settings().password_length).toBe(22);
    await expectContainedLayout(second);
    await second.getByRole('button', { name: 'Keep my edits', exact: true }).click();
    expect(admin.app.jellyport.store.settings().password_length).toBe(22);
    await save(second, 200);
    expect(admin.app.jellyport.store.settings()).toMatchObject({
      password_length: 24,
      password_exclude_ambiguous: false,
    });
    expect(admin.writes).toEqual([]);
  } finally {
    await second.close();
  }
});
