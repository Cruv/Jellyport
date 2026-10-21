import { test, expect, paidOwner, expectContainedLayout } from './media-admin-fixtures';

test('Stripe connection, paginated identity review and disconnect preserve media accounts', async ({
  page,
  admin,
  mutations,
}, info) => {
  const store = admin.app.jellyport.store;
  store.saveSettings({ ...store.settings(), discord_guild_id: '333333333333333333' });
  await page.goto('/#/settings/stripe');
  await expect(
    page.getByRole('heading', { name: 'Stripe subscriptions', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Billing review only', { exact: true })).toBeVisible();
  const key = page.getByLabel('Restricted Stripe API key', { exact: false });
  await key.fill('rk_test_syntheticBrowserOnly123');
  await page.getByRole('button', { name: 'Save Stripe settings', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(page.getByText('Test restricted key saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test & sync Stripe', exact: true }).click();
  await expect(page.getByText('24 subscriptions', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Review links', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic crew owner', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Payment collection paused', { exact: false })).toBeVisible();
  await expect(page.locator('article.summary-card')).toHaveCount(5);
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('stripe-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review Discord link', exact: true }).first().click();
  const review = page.getByRole('dialog', { name: 'Approve Discord identity', exact: true });
  await expect(
    review.getByRole('button', { name: 'Approve customer link', exact: true }),
  ).toBeDisabled();
  await review.getByRole('button', { name: 'Find suggested Discord member', exact: true }).click();
  await expect(review.getByText('@crew_owner', { exact: true })).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('stripe-identity-dialog.png') });
  await review.getByRole('button', { name: 'Approve customer link', exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(admin.app.jellyport.stripe.subscriptions()[0]!.linked_discord_id).toBe(paidOwner);
  expect(admin.writes).toEqual([]);
  expect(admin.stateWrites).toEqual([]);
  expect(store.jobs()).toEqual([]);
  expect(store.membershipRecords()).toEqual([]);
  expect(mutations).toEqual([
    'POST /api/stripe/config',
    'POST /api/stripe/sync',
    'POST /api/stripe/resolve-candidate',
    'POST /api/stripe/links',
  ]);
  await page.getByRole('tab', { name: 'Connection', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect Stripe…', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Disconnect Stripe?', exact: true });
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('stripe-disconnect.png'), fullPage: true });
  await confirm
    .getByRole('button', { name: 'Disconnect and clear billing data', exact: true })
    .click();
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
  expect(admin.app.jellyport.stripe.subscriptions()).toEqual([]);
  expect(admin.writes).toEqual([]);
});
