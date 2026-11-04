import type { Locator } from '@playwright/test';
import { test, expect, expectContainedLayout } from './fixtures';

for (const state of ['checking', 'blocked', 'failed'] as const) {
  test(`migration user selection works while requirements are ${state}`, async ({
    page,
    mutations,
  }, info) => {
    let ready = false;
    let finishCheck: (() => void) | undefined;
    const pendingCheck = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const requirements = () => ({
      checked_at: new Date().toISOString(),
      sources: {},
      actions: Object.fromEntries(
        ['migrate', 'migrate_saved'].map((action) => [
          action,
          {
            ready,
            blockers: ready
              ? []
              : [
                  {
                    code: 'matching_catalog',
                    message: 'Import a current Jellyfin matching catalog before migrating.',
                    route: { page: 'settings', tab: 'history', subtab: 'jellyfin' },
                  },
                ],
            warnings: [],
          },
        ]),
      ),
    });
    await page.route('**/api/workflow-readiness', async (route) => {
      if (state === 'checking') await pendingCheck;
      await route.fulfill({ json: state === 'failed' ? {} : requirements() });
    });
    await page.route('**/api/workflow-readiness/refresh', async (route) => {
      ready = true;
      await route.fulfill({ json: requirements() });
    });
    await page.route('**/api/users', (route) =>
      route.fulfill({
        json: {
          emby: [
            { Id: 'selection-owner', Name: 'TestMember' },
            { Id: 'selection-extra', Name: 'TestMember_2' },
            { Id: 'selection-hidden', Name: 'AnotherUser' },
          ],
          jellyfin: [],
        },
      }),
    );
    try {
      await page.goto('/#/migrate');
      const message =
        state === 'checking'
          ? 'Checking requirements…'
          : state === 'blocked'
            ? 'Before you continue'
            : 'Check requirements before continuing.';
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
      const activate = (control: Locator) => (touch ? control.tap() : control.click());
      const search = page.getByRole('searchbox', { name: 'Search Emby users' });
      await search.fill('TestMember');
      const one = page.getByRole('checkbox', { name: 'Select TestMember', exact: true });
      const two = page.getByRole('checkbox', { name: 'Select TestMember_2', exact: true });
      const all = page.getByRole('checkbox', {
        name: 'Select all visible Emby users',
        exact: true,
      });
      await expect(one).toBeEnabled();
      await expect(two).toBeEnabled();
      await expect(all).toBeEnabled();
      await activate(one);
      await expect(one).toBeChecked();
      await expect(all).toHaveJSProperty('indeterminate', true);
      await activate(two);
      await expect(two).toBeChecked();
      await expect(all).toBeChecked();
      await activate(all);
      await expect(one).not.toBeChecked();
      await expect(two).not.toBeChecked();
      await activate(all);
      await search.clear();
      await expect(
        page.getByRole('checkbox', { name: 'Select AnotherUser', exact: true }),
      ).not.toBeChecked();
      const preview = page.getByRole('button', { name: 'Preview migration (2)', exact: true });
      await expect(preview).toBeDisabled();
      await expectContainedLayout(page);
      await page.screenshot({
        path: info.outputPath('select-before-requirements.png'),
        fullPage: true,
      });
      if (state === 'checking') {
        ready = true;
        finishCheck!();
      } else {
        await activate(
          page.getByRole('button', {
            name: state === 'blocked' ? 'Check requirements again' : 'Check again',
            exact: true,
          }),
        );
      }
      await expect(preview).toBeEnabled();
      await expect(one).toBeChecked();
      await expect(two).toBeChecked();
      expect(mutations).toEqual([]);
    } finally {
      finishCheck!();
    }
  });
}
