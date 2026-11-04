import type { Locator } from '@playwright/test';
import { test, expect, paidOwner, expectContainedLayout } from './media-admin-fixtures';
import { STRIPE_API_VERSION, STRIPE_INVOICE_PERMISSION_MESSAGE } from '../server/stripe-client';

test('a cached Stripe connection reports missing invoice permission and recovers the same migration with real HTTP parsing', async ({
  page,
  admin,
}, info) => {
  const { store, stripe, service } = admin.app.jellyport;
  const now = Math.floor(Date.now() / 1000);
  let invoicesAllowed = true;
  const reads: Array<{ path: string; status: number; subscription: string | null }> = [];
  const json = (data: unknown[], status = 200) =>
    new Response(
      JSON.stringify(
        status === 200
          ? { object: 'list', has_more: false, data }
          : {
              error: {
                type: 'invalid_request_error',
                code: 'more_permissions_required',
                message: 'synthetic private upstream details',
              },
            },
      ),
      { status, headers: { 'content-type': 'application/json' } },
    );
  admin.setStripeHttpTransport(async (address, init) => {
    const url = new URL(address);
    // This transport never fetches a network URL. Only the six documented
    // read-only Stripe paths receive synthetic HTTP responses.
    expect(url.origin).toBe('https://api.stripe.com');
    expect([
      '/v1/customers',
      '/v1/checkout/sessions',
      '/v1/subscriptions',
      '/v1/products',
      '/v1/prices',
      '/v1/invoices',
    ]).toContain(url.pathname);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer rk_live_syntheticBrowserOnly123',
      'Stripe-Version': STRIPE_API_VERSION,
    });
    const status = url.pathname === '/v1/invoices' && !invoicesAllowed ? 403 : 200;
    reads.push({ path: url.pathname, status, subscription: url.searchParams.get('subscription') });
    if (status === 403) return json([], 403);
    if (url.pathname === '/v1/subscriptions')
      return json([
        {
          id: 'sub_Permission',
          object: 'subscription',
          livemode: true,
          customer: {
            id: 'cus_Permission',
            object: 'customer',
            livemode: true,
            name: 'Synthetic subscriber',
            email: 'subscriber@example.test',
            metadata: {},
          },
          created: now - 90 * 86400,
          status: 'active',
          collection_method: 'charge_automatically',
          cancel_at_period_end: false,
          pause_collection: null,
          metadata: {},
          latest_invoice: 'in_Permission',
          items: {
            has_more: false,
            data: [
              {
                id: 'si_Permission',
                quantity: 1,
                current_period_start: now - 86400,
                current_period_end: now + 29 * 86400,
                price: { id: 'price_Permission', product: 'prod_Permission' },
              },
            ],
          },
        },
      ]);
    if (url.pathname === '/v1/products')
      return json([
        {
          id: 'prod_Permission',
          object: 'product',
          livemode: true,
          name: 'Synthetic crew plan',
          active: true,
        },
      ]);
    if (url.pathname === '/v1/prices')
      return json([{ id: 'price_Permission', object: 'price', livemode: true }]);
    if (url.pathname === '/v1/invoices') {
      expect(url.searchParams.get('limit')).toBe('1');
      if (url.searchParams.has('subscription')) {
        expect(url.searchParams.get('subscription')).toBe('sub_Permission');
        expect(url.searchParams.get('status')).toBe('paid');
      }
      return json([
        {
          id: 'in_Permission',
          object: 'invoice',
          livemode: true,
          status: 'paid',
          amount_remaining: 0,
          customer: 'cus_Permission',
          created: now - 86400,
          status_transitions: { paid_at: now - 86400 + 1 },
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_Permission' },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: 'il_Permission',
                object: 'line_item',
                livemode: true,
                quantity: 1,
                parent: {
                  type: 'subscription_item_details',
                  subscription_item_details: {
                    subscription: 'sub_Permission',
                    subscription_item: 'si_Permission',
                    proration: false,
                  },
                },
                pricing: {
                  type: 'price_details',
                  price_details: { price: 'price_Permission', product: 'prod_Permission' },
                },
                period: { start: now - 86400, end: now + 29 * 86400 },
              },
            ],
          },
        },
      ]);
    }
    return json([]);
  });
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
    price_tiers: [{ price_id: 'price_Permission', tier_id: 'brigantine' }],
  });
  // Existing installations can retain a complete customer cache from before
  // the invoice permission became required. Remove only that synthetic scope.
  invoicesAllowed = false;
  reads.length = 0;
  const originalMedia = structuredClone(admin.servers.users);
  const originalOwnership = service.mediaOwnerships.list(store.settings());
  const accepted: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/migrations')
      accepted.push(request.postDataJSON());
  });
  await page.goto('/#/migrate');
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  const activate = async (control: Locator) => {
    if (touch) await control.tap();
    else await control.click();
  };
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
  for (const name of ['media_crew', 'media_crew_2'])
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  await activate(page.getByRole('button', { name: 'Preview migration (2)', exact: true }));
  const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
  await review.getByRole('searchbox', { name: 'Discord owner', exact: true }).fill('crew_owner');
  await activate(review.getByRole('button', { name: 'Select @crew_owner', exact: true }));
  await activate(review.getByRole('button', { name: 'Next: Billing', exact: true }));
  await review
    .getByRole('checkbox', { name: 'Stripe customer Synthetic subscriber', exact: true })
    .check();
  await review
    .getByRole('checkbox', {
      name: 'I confirm these Stripe customers belong to @crew_owner',
      exact: true,
    })
    .check();
  const changes = store.db.prepare('SELECT total_changes() AS count').get()!.count;
  await activate(
    review.getByRole('button', { name: 'Confirm billing & check membership', exact: true }),
  );
  const result = review.getByRole('status', { name: 'Billing confirmation result' });
  await expect(result).toHaveText(`Membership unavailable: ${STRIPE_INVOICE_PERMISSION_MESSAGE}`);
  await expect(result).toBeFocused();
  await expect(result).toBeInViewport({ ratio: 1 });
  await expect(
    review.getByRole('heading', { name: 'Confirm membership & billing', exact: true }),
  ).toBeAttached();
  expect(reads).toEqual([
    { path: '/v1/subscriptions', status: 200, subscription: null },
    { path: '/v1/invoices', status: 403, subscription: 'sub_Permission' },
  ]);
  const denied = await stripe.reviewMembership(paidOwner, undefined, {
    customer_ids: ['cus_Permission'],
    price_tiers: [],
  });
  expect(denied.proof).toBeUndefined();
  expect(store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
  expect(stripe.status().linked_customer_count).toBe(0);
  expect(store.membershipRecords()).toEqual([]);
  expect(store.jobs()).toEqual([]);
  expect(accepted).toEqual([]);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('invoice-permission-migration-result.png'),
    fullPage: true,
  });

  // A separate local settings tab leaves this private migration draft intact.
  const settings = await page.context().newPage();
  try {
    await settings.goto(`${admin.url}/#/settings/stripe`);
    await settings.getByRole('button', { name: 'Test & sync Stripe', exact: true }).click();
    await expect(
      settings.getByText(STRIPE_INVOICE_PERMISSION_MESSAGE, { exact: true }),
    ).toBeVisible();
    expect(stripe.status().last_error).toBe(STRIPE_INVOICE_PERMISSION_MESSAGE);
    expect(stripe.status().subscription_count).toBe(1);
    expect(
      reads.some(
        (read) => read.path === '/v1/invoices' && read.subscription === null && read.status === 403,
      ),
    ).toBe(true);
    const revision = stripe.status().revision;
    invoicesAllowed = true;
    await settings.getByRole('button', { name: 'Test & sync Stripe', exact: true }).click();
    await expect.poll(() => stripe.status().revision).not.toBe(revision);
    expect(stripe.status().last_error).toBeNull();
  } finally {
    await settings.close();
  }
  await page.bringToFront();
  const beforeRecovery = reads.length;
  await activate(
    review.getByRole('button', { name: 'Confirm billing & check membership', exact: true }),
  );
  await expect(
    review.getByRole('heading', { name: 'Confirm accounts & slots', exact: true }),
  ).toBeVisible();
  await expect(review.getByText('Brigantine · 2 accounts', { exact: true })).toBeVisible();
  expect(reads.slice(beforeRecovery)).toEqual([
    { path: '/v1/subscriptions', status: 200, subscription: null },
    { path: '/v1/invoices', status: 200, subscription: 'sub_Permission' },
  ]);
  expect(stripe.status().linked_customer_count).toBe(0);
  expect(service.mediaOwnerships.list(store.settings())).toEqual(originalOwnership);
  expect(store.membershipRecords()).toEqual([]);
  expect(store.jobs()).toEqual([]);
  expect(admin.writes).toEqual([]);
  expect(admin.stateWrites).toEqual([]);
  expect(admin.servers.users).toEqual(originalMedia);
  expect(accepted).toEqual([]);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('invoice-permission-recovered-accounts.png'),
    fullPage: true,
  });
});
