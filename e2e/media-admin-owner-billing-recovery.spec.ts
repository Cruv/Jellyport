import type { Locator } from '@playwright/test';
import { test, expect, paidOwner, expectContainedLayout } from './media-admin-fixtures';
import type { StripeSubscription } from '../server/stripe-client';

test('migration billing hides canceled-only duplicate customers while preserving the confirmed owner and review safeguards', async ({
  page,
  admin,
}, info) => {
  const { service, store, stripe } = admin.app.jellyport;
  const now = Math.floor(Date.now() / 1000);
  const subscriptions: StripeSubscription[] = Array.from({ length: 7 }, (_, index) => ({
    id: `sub_Recovery${index}`,
    customer_id:
      index === 0
        ? 'cus_RecoveryActive'
        : index === 1
          ? 'cus_RecoveryHistorical'
          : `cus_RecoveryOther${index}`,
    customer_name: index < 2 ? 'Synthetic duplicate owner' : `Other synthetic customer ${index}`,
    customer_email: index < 2 ? 'duplicate@example.test' : `other${index}@example.test`,
    status: index === 1 ? 'canceled' : 'active',
    created: now - 90 * 86400,
    ...(index === 1 ? { ended_at: now - 60 * 86400 } : {}),
    collection_method: 'charge_automatically',
    pause_collection: false,
    cancel_at_period_end: false,
    items: [
      {
        id: `si_Recovery${index}`,
        price_id: 'price_Crew',
        product_id: 'prod_Crew',
        quantity: 1,
        current_period_end: index === 1 ? now - 60 * 86400 : now + 29 * 86400,
      },
    ],
    identity_candidates:
      index < 2
        ? [
            {
              discord_user_id: paidOwner,
              source: 'subscription_metadata',
              field: 'discord_user_id',
            },
          ]
        : [],
  }));
  admin.setStripeSubscriptions(subscriptions);
  for (const user of admin.servers.users.emby)
    user.Policy = { ...user.Policy, IsAdministrator: false, IsDisabled: false };
  admin.servers.users.emby.find((user) => user.Id === 'e-alex')!.Name = 'media_crew';
  admin.servers.users.emby.find((user) => user.Id === 'e-river')!.Name = 'media_crew_2';
  admin.servers.users.jellyfin.find((user) => user.Id === 'j-river')!.Name = 'media_crew_2';
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '333333333333333333',
    new_subscriber_source: 'stripe',
  });
  service.mediaOwnerships.save(
    [
      {
        kind: 'emby',
        server_id: 'demo-emby',
        account_id: 'e-river',
        username: 'media_crew_2',
        discord_user_id: paidOwner,
        slot: 2,
      },
    ],
    store.settings(),
  );
  const originalOwnership = structuredClone(service.mediaOwnerships.list(store.settings()));
  const originalMedia = structuredClone(admin.servers.users);
  await stripe.configure({
    expected_revision: stripe.status().revision,
    api_key: 'rk_live_syntheticBrowserOnly123',
    sync_enabled: false,
    automation_enabled: false,
  });
  await stripe.sync();
  await stripe.configure({
    expected_revision: stripe.status().revision,
    sync_enabled: false,
    automation_enabled: false,
    price_tiers: [{ price_id: 'price_Crew', tier_id: 'brigantine' }],
  });
  const membershipChecks: Record<string, unknown>[] = [];
  const accepted: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (/^\/api\/migrations\/preview\/[^/]+\/membership$/.test(path))
      membershipChecks.push(request.postDataJSON());
    if (path === '/api/migrations') accepted.push(request.postDataJSON());
  });
  await page.goto('/#/migrate');
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  const activate = async (control: Locator) => {
    if (touch) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      await control.tap();
    } else await control.click();
  };
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
  for (const name of ['media_crew', 'media_crew_2'])
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  await activate(page.getByRole('button', { name: 'Preview migration (2)', exact: true }));
  const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
  async function expectReachableFooter() {
    const footer = await review.locator('.modal-footer').boundingBox();
    expect(footer).not.toBeNull();
    for (const control of await review.locator('.modal-footer').getByRole('button').all()) {
      await expect(control).toBeInViewport({ ratio: 1 });
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(footer!.y - 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(footer!.y + footer!.height + 1);
      if (touch) {
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
    }
  }
  await expect(
    review.getByRole('checkbox', { name: 'Assign media_crew', exact: true }),
  ).toBeChecked();
  await expect(
    review.getByRole('checkbox', { name: 'Assign media_crew_2', exact: true }),
  ).toHaveCount(0);
  await expect(
    review.getByText('Confirmed owner · @crew_owner. Included in this migration.', { exact: true }),
  ).toBeVisible();
  await review.getByRole('searchbox', { name: 'Discord owner', exact: true }).fill('crew_owner');
  await activate(review.getByRole('button', { name: 'Select @crew_owner', exact: true }));
  await expectContainedLayout(page);
  await review.locator('.modal-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath('confirmed-owner-included.png'), fullPage: true });
  await expectReachableFooter();
  // Next applies the explicit picker choice. There is no separate below-fold
  // assignment button to remember before the wizard advances.
  await activate(review.getByRole('button', { name: 'Next: Billing', exact: true }));
  await expect(
    review.getByRole('heading', { name: 'Confirm membership & billing', exact: true }),
  ).toBeVisible();
  await expect(
    review.getByText('media_crew, media_crew_2 · 2 selected accounts', { exact: true }),
  ).toBeVisible();
  await expect(review.getByText('Stripe identity not linked', { exact: true })).toBeVisible();
  await expect(
    review
      .locator('.migration-account-choice')
      .filter({ has: page.getByRole('checkbox', { name: /^Stripe customer / }) }),
  ).toHaveCount(5);
  const activeCustomer = review
    .locator('.migration-account-choice')
    .filter({ hasText: 'cus_RecoveryActive' });
  const oldCustomer = review
    .locator('.migration-account-choice')
    .filter({ hasText: 'cus_RecoveryHistorical' });
  await expect(activeCustomer).toContainText('Synthetic duplicate owner');
  await expect(activeCustomer).toContainText('active');
  await expect(oldCustomer).toHaveCount(0);
  await activate(activeCustomer.getByRole('checkbox'));
  const approval = review.getByRole('checkbox', {
    name: 'I confirm these Stripe customers belong to @crew_owner',
    exact: true,
  });
  await expect(approval).not.toBeChecked();
  const pages = review.getByRole('navigation', { name: 'Stripe customer results', exact: true });
  await expect(pages.getByRole('status')).toHaveText('1–5 of 6');
  await activate(pages.getByRole('button', { name: 'Next page', exact: true }));
  await expect(
    review.locator('.migration-account-choice').filter({
      has: page.getByRole('checkbox', { name: /^Stripe customer / }),
    }),
  ).toHaveCount(1);
  await expect(oldCustomer).toHaveCount(0);
  await activate(pages.getByRole('button', { name: 'Previous page', exact: true }));
  await expect(activeCustomer.getByRole('checkbox')).toBeChecked();
  await expect(oldCustomer).toHaveCount(0);
  const checksBeforeApproval = membershipChecks.length;
  await activate(review.getByRole('button', { name: 'Next: Accounts', exact: true }));
  await expect(
    review.getByRole('heading', { name: 'Confirm membership & billing', exact: true }),
  ).toBeVisible();
  await expect(approval).toBeFocused();
  await expectReachableFooter();
  expect(membershipChecks).toHaveLength(checksBeforeApproval);
  expect(stripe.status().linked_customer_count).toBe(0);
  expect(admin.writes).toEqual([]);
  expect(accepted).toEqual([]);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('required-billing-confirmation.png'),
    fullPage: true,
  });
  await activate(approval);
  let releaseMembershipResponse!: () => void;
  let membershipResponseHeld = false;
  const membershipResponseGate = new Promise<void>((resolve) => {
    releaseMembershipResponse = resolve;
  });
  await page.route('**/api/migrations/preview/*/membership', async (route) => {
    expect(new URL(route.request().url()).origin).toBe(admin.url);
    if (!route.request().postDataJSON()?.billing) return route.continue();
    // The real local API verifies the selected customers and paid period. Hold
    // only delivery of its unmodified response to inspect the waiting interface.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    membershipResponseHeld = true;
    await membershipResponseGate;
    await route.fulfill({ response });
  });
  try {
    await activate(
      review.getByRole('button', { name: 'Confirm billing & check membership', exact: true }),
    );
    await expect.poll(() => membershipResponseHeld).toBe(true);
    const checking = review.getByRole('button', { name: 'Checking membership…', exact: true });
    await expect(checking).toBeDisabled();
    await expect(checking).toBeInViewport({ ratio: 1 });
    const pendingStatus = review.getByRole('status', { name: 'Billing confirmation result' });
    await expect(pendingStatus).toHaveText(
      'Checking current Stripe subscriptions and paid invoices…',
    );
    await expect(pendingStatus).toBeInViewport({ ratio: 1 });
    await expectReachableFooter();
    await expectContainedLayout(page);
    await page.screenshot({
      path: info.outputPath('billing-verification-pending.png'),
      fullPage: true,
    });
    expect(membershipChecks.filter((request) => request.billing)).toHaveLength(1);
    expect(stripe.status().linked_customer_count).toBe(0);
    expect(admin.writes).toEqual([]);
    expect(accepted).toEqual([]);
  } finally {
    releaseMembershipResponse();
  }
  await expect(
    review.getByRole('heading', { name: 'Confirm accounts & slots', exact: true }),
  ).toBeVisible();
  await expect(review.getByText('Brigantine · 2 accounts', { exact: true })).toBeVisible();
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for media_crew', exact: true }),
  ).toHaveValue('1');
  const confirmedSlot = review.getByRole('combobox', {
    name: 'Membership account slot for media_crew_2',
    exact: true,
  });
  await expect(confirmedSlot).toHaveValue('2');
  await expect(confirmedSlot).toBeDisabled();
  await expectReachableFooter();
  expect(membershipChecks.at(-1)).toMatchObject({
    discord_user_id: paidOwner,
    billing: {
      customer_ids: ['cus_RecoveryActive'],
      price_tiers: [],
    },
  });
  expect(stripe.status().linked_customer_count).toBe(0);
  expect(service.mediaOwnerships.list(store.settings())).toEqual(originalOwnership);
  expect(service.memberships.get(paidOwner, store.settings())).toBeNull();
  expect(store.jobs()).toEqual([]);
  expect(admin.writes).toEqual([]);
  expect(admin.servers.users).toEqual(originalMedia);
  expect(accepted).toEqual([]);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('two-accounts-one-reviewed-owner.png'),
    fullPage: true,
  });
  await activate(review.getByRole('button', { name: 'Cancel', exact: true }));
  await expect(review).toHaveCount(0);
  expect(stripe.status().linked_customer_count).toBe(0);
  expect(service.mediaOwnerships.list(store.settings())).toEqual(originalOwnership);
  expect(store.jobs()).toEqual([]);
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
});
