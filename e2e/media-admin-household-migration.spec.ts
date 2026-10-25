import { test, expect, expectContainedLayout, paidOwner } from './media-admin-fixtures';
import type { Locator } from '@playwright/test';

async function assignCrewOwner(review: Locator) {
  await review.getByRole('searchbox', { name: 'Discord owner', exact: true }).fill('crew_owner');
  await review.getByRole('button', { name: 'Select @crew_owner', exact: true }).click();
  await review
    .getByRole('button', { name: 'Assign owner to selected accounts', exact: true })
    .click();
  await review.getByRole('button', { name: 'Next: Billing', exact: true }).click();
}

for (const subscriptionSource of ['stripe', 'trusted_messages'] as const)
  test(`migration review finds a selected owner’s verified Stripe tier with ${subscriptionSource} automation and enrolls three custom accounts on approval`, async ({
    page,
    admin,
  }, info) => {
    const { service, store, stripe } = admin.app.jellyport;
    admin.activateStripeSubscription();
    store.saveSettings({
      ...store.settings(),
      discord_enabled: true,
      discord_guild_id: '333333333333333333',
      new_subscriber_source: subscriptionSource,
    });
    await stripe.configure({
      expected_revision: stripe.status().revision,
      api_key: 'rk_live_syntheticBrowserOnly123',
      sync_enabled: false,
      automation_enabled: false,
    });
    await stripe.sync();
    await stripe.linkCustomer({
      customer_id: 'cus_Crew0',
      discord_user_id: paidOwner,
      expected_revision: stripe.status().revision,
    });
    await stripe.configure({
      expected_revision: stripe.status().revision,
      sync_enabled: true,
      automation_enabled: false,
      price_tiers: [{ price_id: 'price_Crew', tier_id: 'galleon' }],
    });
    expect(service.memberships.get(paidOwner, store.settings())).toBeNull();
    // Stripe may confirm access before MEE6 assigns its subscriber role. The
    // verified human must remain selectable without manually entering an ID.
    const searchMembers = service.bot!.searchMembers!.bind(service.bot);
    service.bot!.searchMembers = async (query) => {
      const found = await searchMembers(query);
      return {
        ...found,
        members: found.members.map((member) =>
          member.id === paidOwner ? { ...member, membership_active: false } : member,
        ),
      };
    };
    expect(admin.createdCredentials).toEqual([]);
    const originalEmby = structuredClone(admin.servers.users.emby);
    const existingPasswordCount = admin.createdCredentials.length;
    const ownerReviews: Record<string, unknown>[] = [];
    const accepted: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const path = new URL(request.url()).pathname;
      if (/^\/api\/migrations\/preview\/[^/]+\/membership$/.test(path))
        ownerReviews.push(request.postDataJSON());
      if (path === '/api/migrations') accepted.push(request.postDataJSON());
    });
    await page.goto('/#/migrate');
    await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
    for (const name of ['alex', 'river', 'sam'])
      await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
    await page.getByRole('button', { name: 'Preview migration (3)', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
    await assignCrewOwner(review);
    await expect(review.getByText('Galleon · 3 accounts', { exact: true })).toBeVisible();
    expect(ownerReviews).toEqual([{ discord_user_id: paidOwner }]);
    expect(service.memberships.get(paidOwner, store.settings())).toBeNull();
    expect(accepted).toEqual([]);
    expect(admin.writes).toEqual([]);
    await expect(review.getByRole('button', { name: 'Start migration', exact: true })).toHaveCount(
      0,
    );
    await expectContainedLayout(page);
    await page.screenshot({
      path: info.outputPath('stripe-membership-in-migration-review.png'),
      fullPage: true,
    });
    await review.getByRole('button', { name: 'Next: Accounts', exact: true }).click();
    await expect(
      review.getByRole('combobox', { name: 'Membership account slot for alex', exact: true }),
    ).toHaveValue('1');
    await expect(
      review.getByRole('combobox', { name: 'Membership account slot for river', exact: true }),
    ).toHaveValue('2');
    await expect(
      review.getByRole('combobox', { name: 'Membership account slot for sam', exact: true }),
    ).toHaveValue('3');
    await expect(review.getByRole('alert')).toHaveCount(0);
    await review.getByRole('button', { name: 'Next: Review', exact: true }).click();
    await expect(review.locator('.preview-user')).toHaveCount(3);
    await expect(
      review.getByRole('button', { name: 'Start migration', exact: true }),
    ).toBeEnabled();
    await expectContainedLayout(page);
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/migrations' &&
        response.request().method() === 'POST',
    );
    await review.getByRole('button', { name: 'Start migration', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const { id } = await response.json();
    await expect
      .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status, {
        timeout: 15_000,
      })
      .toMatch(/^(completed|partial)$/);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      source_user_ids: ['e-alex', 'e-river', 'e-sam'],
      discord_recipients: { 'e-alex': paidOwner, 'e-river': paidOwner, 'e-sam': paidOwner },
      membership_slots: { 'e-alex': 1, 'e-river': 2, 'e-sam': 3 },
      membership_review_tokens: { [paidOwner]: expect.any(String) },
    });
    expect(accepted[0]).not.toHaveProperty('tier_id');
    expect(accepted[0]).not.toHaveProperty('account_limit');
    expect(service.memberships.get(paidOwner, store.settings())).toMatchObject({
      tier_id: 'galleon',
      account_limit: 3,
      active: true,
      provision_jellyfin: false,
    });
    expect(
      store
        .linksForMember(paidOwner)
        .map((link) => [link.username, link.membership_slot])
        .sort(),
    ).toEqual([
      ['alex', 1],
      ['river', 2],
      ['sam', 3],
    ]);
    expect(
      admin.createdCredentials
        .slice(existingPasswordCount)
        .map((entry) => entry.username)
        .sort(),
    ).toEqual(['alex', 'sam']);
    expect(admin.servers.played['j-river']).toEqual(new Set(['1', '2']));
    expect(admin.servers.users.emby).toEqual(originalEmby);
    expect(store.settings().new_subscriber_source).toBe(subscriptionSource);
    expect(stripe.status().automation_enabled).toBe(false);
    expect(
      admin.writes.filter((write) => write.kind === 'emby' || write.method === 'rename'),
    ).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto('/#/users');
    const ownerRow = page
      .getByRole('row')
      .filter({ has: page.getByText('@crew_owner', { exact: true }) });
    await expect(ownerRow.locator('[data-label="Emby accounts"] strong')).toHaveText([
      'alex',
      'river',
      'sam',
    ]);
    await expect(ownerRow.locator('[data-label="Jellyfin accounts"] strong')).toHaveText([
      'alex',
      'river',
      'sam',
    ]);
    await page.reload();
    await expect(ownerRow.locator('[data-label="Jellyfin accounts"] strong')).toHaveText([
      'alex',
      'river',
      'sam',
    ]);
    await expectContainedLayout(page);
  });

// Real HTTP review/acceptance and worker persistence; media, Discord and auth are isolated fakes.
test('differently named migration accounts can be explicitly grouped under one Discord owner', async ({
  page,
  admin,
}, info) => {
  const { service, store } = admin.app.jellyport;
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '333333333333333333',
  });
  service.memberships.save(
    {
      discord_user_id: paidOwner,
      base_username: 'crew_owner',
      tier_id: 'brigantine',
      account_limit: 2,
      active: true,
      provision_jellyfin: true,
    },
    store.settings(),
  );
  const originalEmby = structuredClone(admin.servers.users.emby);
  const accepted: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/migrations')
      accepted.push(request.postDataJSON());
  });
  await page.goto('/#/migrate');
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Select alex', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select river', exact: true }).check();
  await page.getByRole('button', { name: 'Preview migration (2)', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
  await assignCrewOwner(review);
  await expect(review.getByText('Brigantine · 2 accounts', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Start migration', exact: true })).toHaveCount(0);
  expect(accepted).toEqual([]);
  await review.getByRole('button', { name: 'Next: Accounts', exact: true }).click();
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for alex', exact: true }),
  ).toHaveValue('1');
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for river', exact: true }),
  ).toHaveValue('2');
  await review
    .getByRole('combobox', { name: 'Membership account slot for river', exact: true })
    .selectOption('1');
  await expect(review.getByRole('alert')).toHaveCount(2);
  await expect(review.getByRole('button', { name: 'Next: Review', exact: true })).toBeDisabled();
  await review
    .getByRole('combobox', { name: 'Membership account slot for river', exact: true })
    .selectOption('2');
  await expect(review.getByRole('alert')).toHaveCount(0);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('reviewed-arbitrary-account-slots.png'),
    fullPage: true,
  });
  await review.getByRole('button', { name: 'Next: Review', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Start migration', exact: true })).toBeEnabled();
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/migrations' &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Start migration', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const { id } = await response.json();
  await expect
    .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status, {
      timeout: 15_000,
    })
    .toMatch(/^(completed|partial)$/);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    source_user_ids: ['e-alex', 'e-river'],
    discord_recipients: { 'e-alex': paidOwner, 'e-river': paidOwner },
    membership_slots: { 'e-alex': 1, 'e-river': 2 },
  });
  const directory = (await (await admin.client.get('/api/user-directory')).json()).users;
  const owned = directory.find(
    (row: { discord_user_id: string }) => row.discord_user_id === paidOwner,
  );
  expect(owned.emby.map((account: { name: string }) => account.name).sort()).toEqual([
    'alex',
    'river',
  ]);
  expect(owned.jellyfin.map((account: { name: string }) => account.name).sort()).toEqual([
    'alex',
    'river',
  ]);
  expect(
    directory.filter(
      (row: { emby: { name: string }[]; discord_user_id: string | null }) =>
        !row.discord_user_id &&
        row.emby.some((account) => ['alex', 'river'].includes(account.name)),
    ),
  ).toEqual([]);
  expect(
    store
      .links()
      .filter((link) => link.discord_user_id === paidOwner)
      .map((link) => [link.username, link.membership_slot])
      .sort(),
  ).toEqual([
    ['alex', 1],
    ['river', 2],
  ]);
  expect(admin.createdCredentials.map((credential) => credential.username)).toEqual(['alex']);
  expect(admin.servers.users.emby).toEqual(originalEmby);
  expect(admin.writes.filter((write) => write.kind === 'emby')).toEqual([]);
  expect(admin.writes.filter((write) => write.method === 'rename')).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto('/#/users');
  const ownerRow = page
    .getByRole('row')
    .filter({ has: page.getByText('@crew_owner', { exact: true }) });
  await expect(ownerRow.locator('[data-label="Emby accounts"] strong')).toHaveText([
    'alex',
    'river',
  ]);
  await expect(ownerRow.locator('[data-label="Jellyfin accounts"] strong')).toHaveText([
    'alex',
    'river',
  ]);
  await page.reload();
  await expect(ownerRow.locator('[data-label="Emby accounts"] strong')).toHaveText([
    'alex',
    'river',
  ]);
  await expect(ownerRow.locator('[data-label="Jellyfin accounts"] strong')).toHaveText([
    'alex',
    'river',
  ]);
  const persisted = (await (await admin.client.get('/api/user-directory')).json()).users.find(
    (row: { discord_user_id: string }) => row.discord_user_id === paidOwner,
  );
  expect(persisted.emby).toHaveLength(2);
  expect(persisted.jellyfin).toHaveLength(2);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('unified-arbitrary-account-owner.png'),
    fullPage: true,
  });
});

test('one wizard reviews a missing Stripe identity, price mapping, account slots and a differently named Jellyfin destination', async ({
  page,
  admin,
}, info) => {
  const { service, store, stripe } = admin.app.jellyport;
  admin.activateStripeSubscription();
  for (const source of admin.servers.users.emby)
    source.Policy = { ...source.Policy, IsAdministrator: false, IsDisabled: false };
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '333333333333333333',
    new_subscriber_source: 'trusted_messages',
  });
  await stripe.configure({
    expected_revision: stripe.status().revision,
    api_key: 'rk_live_syntheticBrowserOnly123',
    sync_enabled: false,
    automation_enabled: false,
  });
  const accepted: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/migrations')
      accepted.push(request.postDataJSON());
  });
  await page.goto('/#/migrate');
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
  for (const name of ['alex', 'river', 'sam'])
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  await page.getByRole('button', { name: 'Preview migration (3)', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
  await review.getByRole('searchbox', { name: 'Discord owner', exact: true }).fill('crew_owner');
  await review.getByRole('button', { name: 'Select @crew_owner', exact: true }).click();
  await review
    .getByRole('button', { name: 'Assign owner to selected accounts', exact: true })
    .click();
  await expectContainedLayout(page);
  await review.locator('.modal-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath('wizard-owner-group.png'), fullPage: true });
  await review.getByRole('button', { name: 'Next: Billing', exact: true }).click();
  await expect(review.getByText('Stripe identity not linked', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Refresh Stripe customers', exact: true }).click();
  const customer = review.getByRole('checkbox', {
    name: 'Stripe customer Synthetic crew owner',
    exact: true,
  });
  await expect(customer).toBeVisible();
  await customer.check();
  const tier = review.getByRole('combobox', { name: /^Membership tier for / });
  await tier.selectOption('galleon');
  await expect(
    review.getByRole('button', { name: 'Confirm billing & check membership', exact: true }),
  ).toBeDisabled();
  await review
    .getByRole('checkbox', {
      name: 'I confirm these Stripe customers belong to @crew_owner',
      exact: true,
    })
    .check();
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('wizard-customer-and-price-review.png'),
    fullPage: true,
  });
  await review
    .getByRole('button', { name: 'Confirm billing & check membership', exact: true })
    .click();
  await expect(review.getByText('Galleon · 3 accounts', { exact: true })).toBeVisible();
  expect(stripe.status().linked_customer_count).toBe(0);
  expect(stripe.status().price_tiers).toEqual([]);
  expect(service.memberships.get(paidOwner, store.settings())).toBeNull();
  expect(store.linksForMember(paidOwner)).toEqual([]);
  expect(admin.writes).toEqual([]);
  expect(accepted).toEqual([]);
  await review.getByRole('button', { name: 'Next: Accounts', exact: true }).click();
  const target = review.getByRole('combobox', {
    name: 'Jellyfin destination for alex',
    exact: true,
  });
  await expect(target).toBeEnabled();
  await expect(target.getByRole('option', { name: 'Member template', exact: true })).toHaveCount(0);
  await target.selectOption('j-other');
  await expect(
    review.getByText('Jellyfin: other_member · Merge into existing account', { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for alex', exact: true }),
  ).toHaveValue('1');
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for river', exact: true }),
  ).toHaveValue('2');
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for sam', exact: true }),
  ).toHaveValue('3');
  await expectContainedLayout(page);
  await review.locator('.modal-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: info.outputPath('wizard-account-slots-and-alias.png'),
    fullPage: true,
  });
  await review.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(review.getByText('Galleon · 3 accounts', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Next: Accounts', exact: true }).click();
  await expect(
    review.getByRole('combobox', { name: 'Jellyfin destination for alex', exact: true }),
  ).toHaveValue('j-other');
  await review.getByRole('button', { name: 'Next: Review', exact: true }).click();
  await expect(review.getByText(/Link Stripe customer:/)).toBeVisible();
  await expect(review.getByText(/This price mapping applies globally/)).toBeVisible();
  await expect(review.locator('.preview-user')).toHaveCount(3);
  await expectContainedLayout(page);
  await expect
    .poll(() => review.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await review.locator('.modal-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: info.outputPath('wizard-final-owner-account-review.png'),
    fullPage: true,
  });
  expect(accepted).toEqual([]);
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/migrations' &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Start migration', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const { id } = await response.json();
  await expect
    .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status, {
      timeout: 15_000,
    })
    .toMatch(/^(completed|partial)$/);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    membership_review_tokens: { [paidOwner]: expect.any(String) },
    account_review_tokens: { 'e-alex': expect.any(String) },
    membership_slots: { 'e-alex': 1, 'e-river': 2, 'e-sam': 3 },
  });
  expect(accepted[0]).not.toHaveProperty('billing');
  expect(accepted[0]).not.toHaveProperty('tier_id');
  expect(stripe.status().linked_customer_count).toBe(1);
  expect(stripe.status().price_tiers).toEqual([{ price_id: 'price_Crew', tier_id: 'galleon' }]);
  expect(service.memberships.get(paidOwner, store.settings())).toMatchObject({
    tier_id: 'galleon',
    account_limit: 3,
    active: true,
    provision_jellyfin: false,
  });
  expect(
    store.linksForMember(paidOwner).map((link) => [link.username, link.membership_slot]),
  ).toEqual([
    ['other_member', 1],
    ['river', 2],
    ['sam', 3],
  ]);
  expect(admin.createdCredentials.map((credential) => credential.username)).toEqual(['sam']);
  expect(admin.servers.played['j-other']).toEqual(new Set(['1', '2', '3']));
  expect(
    admin.writes.filter((write) => write.kind === 'emby' || write.method === 'rename'),
  ).toEqual([]);
  expect(store.settings().new_subscriber_source).toBe('trusted_messages');
  expect(stripe.status().automation_enabled).toBe(false);
  await expect(
    page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).resolves.toEqual({ local: {}, session: {} });
});

test('complimentary household approval stays inside the wizard and cancellation leaves access unchanged', async ({
  page,
  admin,
}, info) => {
  const { service, store } = admin.app.jellyport;
  const familyOwner = '222222222222222222';
  store.saveSettings({
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '333333333333333333',
  });
  const reviewFamily = async () => {
    await page.getByRole('button', { name: 'Preview migration (3)', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
    await review
      .getByRole('searchbox', { name: 'Discord owner', exact: true })
      .fill('family_guest');
    await review.getByRole('button', { name: 'Select @family_guest', exact: true }).click();
    await review
      .getByRole('button', { name: 'Assign owner to selected accounts', exact: true })
      .click();
    await review.getByRole('button', { name: 'Next: Billing', exact: true }).click();
    const mode = review.getByRole('combobox', { name: 'Access source', exact: true });
    await expect(mode).toBeEnabled();
    await mode.selectOption('complimentary');
    await review
      .getByRole('combobox', { name: 'Complimentary account allowance', exact: true })
      .selectOption('3');
    await expect(
      review.getByRole('button', { name: 'Confirm complimentary access', exact: true }),
    ).toBeDisabled();
    await review
      .getByRole('checkbox', {
        name: 'I approve complimentary, administrator-managed access for @family_guest',
        exact: true,
      })
      .check();
    await review.getByRole('button', { name: 'Confirm complimentary access', exact: true }).click();
    await expect(review.getByText('Complimentary · 3 accounts', { exact: true })).toBeVisible();
    return review;
  };
  await page.goto('/#/migrate');
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
  for (const name of ['alex', 'river', 'sam'])
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  let review = await reviewFamily();
  expect(service.memberships.get(familyOwner, store.settings())).toBeNull();
  expect(store.linksForMember(familyOwner)).toEqual([]);
  expect(admin.writes).toEqual([]);
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(service.memberships.get(familyOwner, store.settings())).toBeNull();
  expect(store.jobs()).toEqual([]);
  review = await reviewFamily();
  await review.getByRole('button', { name: 'Next: Accounts', exact: true }).click();
  await expect(
    review.getByRole('combobox', { name: 'Membership account slot for sam', exact: true }),
  ).toHaveValue('3');
  await review.getByRole('button', { name: 'Next: Review', exact: true }).click();
  await expect(review.getByText('Complimentary · 3 accounts', { exact: true })).toBeVisible();
  await expect
    .poll(() => review.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('complimentary-household-final-review.png'),
    fullPage: true,
  });
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/migrations' &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Start migration', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const { id } = await response.json();
  await expect
    .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status, {
      timeout: 15_000,
    })
    .toMatch(/^(completed|partial)$/);
  expect(service.memberships.get(familyOwner, store.settings())).toMatchObject({
    access_mode: 'complimentary',
    active: true,
    account_limit: 3,
    provision_jellyfin: false,
  });
  expect(store.linksForMember(familyOwner).map((link) => link.membership_slot)).toEqual([1, 2, 3]);
  expect(admin.createdCredentials.map((entry) => entry.username).sort()).toEqual(['alex', 'sam']);
  expect(admin.writes.filter((write) => write.kind === 'emby')).toEqual([]);
});
