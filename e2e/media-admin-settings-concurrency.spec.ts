import type { Page } from '@playwright/test';
import { test, expect, expectContainedLayout } from './media-admin-fixtures';

test('two Settings tabs merge independent edits and surface a same-field conflict', async ({
  page,
  admin,
}) => {
  const second = await page.context().newPage();
  const route = '/#/settings/accounts/passwords';
  const length = (tab: Page) => tab.getByLabel('Generated password length', { exact: true });
  const save = async (tab: Page) => {
    const saved = tab.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/settings' &&
        response.request().method() === 'PUT',
    );
    await tab.getByRole('button', { name: 'Save settings', exact: true }).click();
    return saved;
  };
  try {
    await Promise.all([page.goto(route), second.goto(route)]);
    await expect(length(page)).toHaveValue('12');
    await expect(length(second)).toHaveValue('12');
    await length(page).fill('18');
    await second.locator('label[for="setting-password_exclude_ambiguous"]').click();
    await expect(
      second.getByRole('checkbox', { name: 'Avoid ambiguous characters' }),
    ).not.toBeChecked();
    const independent = await Promise.all([save(page), save(second)]);
    expect(independent.map((response) => response.status())).toEqual([200, 200]);
    expect(admin.app.jellyport.store.settings()).toMatchObject({
      password_length: 18,
      password_exclude_ambiguous: false,
    });

    await Promise.all([page.reload(), second.reload()]);
    await expect(length(page)).toHaveValue('18');
    await expect(length(second)).toHaveValue('18');
    await length(page).fill('22');
    await length(second).fill('24');
    expect((await save(page)).status()).toBe(200);
    expect((await save(second)).status()).toBe(409);
    await expect(second.getByText('Another save changed these settings.')).toBeVisible();
    await expect(length(second)).toHaveValue('24');
    expect(admin.app.jellyport.store.settings().password_length).toBe(22);
    await expectContainedLayout(second);
    await second.getByRole('button', { name: 'Keep my edits', exact: true }).click();
    expect(admin.app.jellyport.store.settings().password_length).toBe(22);
    expect((await save(second)).status()).toBe(200);
    expect(admin.app.jellyport.store.settings()).toMatchObject({
      password_length: 24,
      password_exclude_ambiguous: false,
    });
    expect(admin.writes).toEqual([]);
  } finally {
    await second.close();
  }
});
