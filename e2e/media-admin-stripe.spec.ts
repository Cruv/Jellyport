import { test, expect, paidOwner, expectContainedLayout } from './media-admin-fixtures';

test('Stripe connection, paginated identity review and disconnect preserve media accounts', async ({
  page,
  admin,
  mutations,
}, info) => {
  const store = admin.app.jellyport.store;
  admin.servers.users.emby.push({
    Id: 'e-crew',
    Name: 'crew_owner',
    Policy: { IsDisabled: false, IsAdministrator: false },
  });
  const roleId = '444444444444444444';
  const roleWrites: { id: string; add: string[]; remove: string[] }[] = [];
  Object.assign(admin.app.jellyport.service.bot!, {
    listTagRoles: async () => ({
      roles: [{ id: roleId, name: 'Emby Member', manageable: true }],
      can_manage_roles: true,
    }),
    memberTagState: async (id: string) => ({
      id,
      username: id === paidOwner ? 'crew_owner' : 'family_guest',
      roles: [],
    }),
    updateTagRoles: async (id: string, add: string[], remove: string[]) => {
      roleWrites.push({ id, add, remove });
    },
  });
  store.saveSettings({
    ...store.settings(),
    discord_guild_id: '333333333333333333',
    discord_emby_role_id: roleId,
  });
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
    review.getByRole('button', { name: 'Review media accounts', exact: true }),
  ).toBeDisabled();
  await review.getByRole('button', { name: 'Find suggested Discord member', exact: true }).click();
  await expect(review.getByText('@crew_owner', { exact: true })).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('stripe-identity-dialog.png') });
  await review.getByRole('button', { name: 'Review media accounts', exact: true }).click();
  const accounts = page.getByRole('dialog', {
    name: 'Confirm Stripe & media accounts',
    exact: true,
  });
  await expect(
    accounts.getByText('Link existing accounts; Jellyfin is optional', { exact: true }),
  ).toBeVisible();
  await expect(
    accounts.getByRole('checkbox', { name: 'Emby · crew_owner', exact: true }),
  ).toBeChecked();
  await expect(accounts.getByRole('checkbox', { name: /Jellyfin/ })).toHaveCount(0);
  await expect(
    accounts.getByRole('button', { name: 'Approve identity & update roles', exact: true }),
  ).toBeInViewport();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('stripe-media-confirmation.png') });
  await accounts
    .getByRole('button', { name: 'Approve identity & update roles', exact: true })
    .click();
  await expect(review).toHaveCount(0);
  await expect(accounts).toHaveCount(0);
  expect(admin.app.jellyport.stripe.subscriptions()[0]!.linked_discord_id).toBe(paidOwner);
  expect(admin.writes).toEqual([]);
  expect(admin.stateWrites).toEqual([]);
  expect(store.jobs()).toEqual([]);
  expect(store.membershipRecords()).toEqual([]);
  expect(roleWrites).toEqual([{ id: paidOwner, add: [roleId], remove: [] }]);
  expect(admin.app.jellyport.service.mediaOwnerships.list(store.settings())[0]).toMatchObject({
    kind: 'emby',
    account_id: 'e-crew',
    discord_user_id: paidOwner,
  });
  expect(mutations).toEqual([
    'POST /api/stripe/config',
    'POST /api/stripe/sync',
    'POST /api/stripe/resolve-candidate',
    'POST /api/identity-review/apply',
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

test('unified member review links an Emby-only owner and acknowledges Discord-only access without provisioning', async ({
  page,
  admin,
  mutations,
}, info) => {
  const store = admin.app.jellyport.store;
  store.saveSettings({ ...store.settings(), discord_guild_id: '333333333333333333' });
  admin.servers.users.emby.push({
    Id: 'e-crew',
    Name: 'crew_owner',
    Policy: { IsDisabled: false, IsAdministrator: false },
  });
  const before = admin.servers.users.jellyfin.map((account) => account.Id);
  await page.goto('/#/memberships/overview');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Memberships', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('2 Discord members', { exact: true })).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Find people or accounts', exact: true })
    .fill('crew_owner');
  await page
    .getByRole('button', { name: 'Select all reliable matches (up to 250)', exact: true })
    .click();
  await page.getByRole('button', { name: 'Review 1 selected identity', exact: true }).click();
  const bulk = page.getByRole('dialog', { name: 'Approve selected identity links?', exact: true });
  await expect(bulk.getByText('Emby · crew_owner', { exact: true })).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('bulk-emby-only-review.png') });
  await bulk
    .getByRole('button', { name: 'Approve 1 identity & update roles', exact: true })
    .click();
  await expect(bulk).toHaveCount(0);
  await expect(page.getByText('Emby · crew_owner', { exact: true })).toBeVisible();
  expect(admin.app.jellyport.service.mediaOwnerships.list(store.settings())).toEqual([
    expect.objectContaining({ kind: 'emby', account_id: 'e-crew', discord_user_id: paidOwner }),
  ]);
  await page
    .getByRole('searchbox', { name: 'Find people or accounts', exact: true })
    .fill('family_guest');
  await page.getByRole('button', { name: 'Review associations', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review @family_guest', exact: true });
  await review
    .locator('summary')
    .filter({ hasText: /^Record an approved access exception$/ })
    .click();
  await review.getByLabel('Gap review exception', { exact: true }).selectOption('non_media');
  await review
    .getByLabel('Private approval note', { exact: true })
    .fill('Approved community-only Discord access.');
  await expectContainedLayout(page);
  await review
    .getByRole('button', { name: 'Approve identity & update roles', exact: true })
    .click();
  await expect(review).toHaveCount(0);
  await expect(
    page.getByText(
      'Approved Discord access without media · Approved community-only Discord access.',
      { exact: true },
    ),
  ).toBeVisible();
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('approved-discord-only-access.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Identity & gaps', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('searchbox', { name: 'Find people or accounts', exact: true })
    .fill('family_guest');
  await expect(
    page.getByText(
      'Approved Discord access without media · Approved community-only Discord access.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(admin.servers.users.jellyfin.map((account) => account.Id)).toEqual(before);
  expect(admin.writes).toEqual([]);
  expect(admin.stateWrites).toEqual([]);
  expect(store.jobs()).toEqual([]);
  expect(store.membershipRecords()).toEqual([]);
  expect(mutations).toEqual(['POST /api/identity-review/apply', 'POST /api/identity-review/apply']);
});
