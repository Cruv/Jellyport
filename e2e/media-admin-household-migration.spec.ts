import { test, expect, expectContainedLayout, paidOwner } from './media-admin-fixtures';

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
  const rows = review.locator('.preview-user');
  await expect(rows).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await rows
      .nth(index)
      .getByRole('searchbox', { name: 'Discord recipient (optional)', exact: true })
      .fill('crew_owner');
    await rows.nth(index).getByRole('button', { name: 'Select @crew_owner', exact: true }).click();
  }
  await expect(review.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await expect(review.getByRole('alert')).toHaveCount(2);
  expect(accepted).toEqual([]);
  await review
    .getByRole('combobox', { name: 'Membership account slot for river', exact: true })
    .selectOption('2');
  await expect(review.getByRole('alert')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Start migration', exact: true })).toBeEnabled();
  await expectContainedLayout(page);
  await review
    .getByRole('combobox', { name: 'Membership account slot for river', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('reviewed-arbitrary-account-slots.png'),
    fullPage: true,
  });
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
