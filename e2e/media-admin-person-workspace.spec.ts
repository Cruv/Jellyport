import { test, expect, expectContainedLayout, paidOwner } from './media-admin-fixtures';
import type { AdminFixture } from './media-admin-fixtures';
import type { Page } from '@playwright/test';

function relationshipCounts(admin: AdminFixture) {
  const { service, store } = admin.app.jellyport;
  const settings = store.settings();
  return {
    owners: service.mediaOwnerships.list(settings).length,
    mappings: service.mappings.list(settings).length,
    memberships: store.membershipRecords().length,
    links: store.links().length,
  };
}
async function chooseOwner(page: Page) {
  await page.getByRole('searchbox', { name: 'Discord member', exact: true }).fill('crew_owner');
  await page.getByRole('button', { name: 'Select @crew_owner', exact: true }).click();
}

test('independent account access can be disabled and restored without mapping or Discord enrollment', async ({
  page,
  admin,
  mutations,
}, info) => {
  const before = structuredClone(
    admin.servers.users.jellyfin.find((user) => user.Id === 'j-other')!,
  );
  const initialRelationships = relationshipCounts(admin);
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('other_member');
  await page.getByRole('button', { name: 'Disable other_member', exact: true }).click();
  let workspace = page.getByRole('dialog', { name: 'Manage other_member', exact: true });
  await expect(workspace.getByRole('tab', { name: 'Account access', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(workspace).toContainText('No Discord link is required');
  await expect(
    workspace.getByRole('searchbox', { name: 'Discord member', exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByRole('button', { name: 'Disable selected account', exact: true }),
  ).toBeEnabled();
  await expect(
    workspace.getByRole('button', { name: 'Disable selected account', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('independent-account-access-viewport.png') });
  await page.screenshot({
    path: info.outputPath('independent-account-access.png'),
    fullPage: true,
  });
  expect(admin.writes).toEqual([]);
  await workspace.getByRole('button', { name: 'Disable selected account', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(
    admin.servers.users.jellyfin.find((user) => user.Id === 'j-other')?.Policy?.IsDisabled,
  ).toBe(true);
  await page.getByRole('button', { name: 'Enable other_member', exact: true }).click();
  workspace = page.getByRole('dialog', { name: 'Manage other_member', exact: true });
  await workspace.getByRole('button', { name: 'Enable selected account', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(admin.servers.users.jellyfin.find((user) => user.Id === 'j-other')).toEqual(before);
  expect(admin.writes).toEqual([
    { kind: 'jellyfin', method: 'setPolicy', id: 'j-other' },
    { kind: 'jellyfin', method: 'setPolicy', id: 'j-other' },
  ]);
  expect(admin.stateWrites).toEqual([]);
  expect(relationshipCounts(admin)).toEqual(initialRelationships);
  expect(mutations).toEqual(['POST /api/accounts/access', 'POST /api/accounts/access']);
  await expectContainedLayout(page);
});

test('household access changes both servers and warns before restoring a lower tier', async ({
  page,
  admin,
  mutations,
}, info) => {
  const { service, store } = admin.app.jellyport;
  const settings = {
    ...store.settings(),
    discord_enabled: true,
    discord_guild_id: '333333333333333333',
  };
  store.saveSettings(settings);
  const accountDetails = [
    { kind: 'jellyfin', id: 'j-household-1', username: 'crew_primary', slot: 1 },
    { kind: 'emby', id: 'e-household-1', username: 'crew_legacy', slot: 1 },
    { kind: 'jellyfin', id: 'j-household-2', username: 'crew_second', slot: 2 },
    { kind: 'emby', id: 'e-household-2', username: 'crew_second_legacy', slot: 2 },
  ] as const;
  const policyWrites = accountDetails.map(({ kind, id }) => ({ kind, id, method: 'setPolicy' }));
  const originalUsers = structuredClone(admin.servers.users);
  for (const { kind, id, username } of accountDetails) {
    const account = {
      Id: id,
      Name: username,
      Policy: { IsAdministrator: false, IsDisabled: false, EnableMediaPlayback: true },
      Configuration: { SubtitleMode: 'None' },
    };
    originalUsers[kind].push(account);
    admin.servers.users[kind].push({
      ...account,
      Policy: { ...account.Policy, IsDisabled: true },
    });
  }
  const membership = service.memberships.save(
    {
      discord_user_id: paidOwner,
      base_username: 'crew_owner',
      tier_id: 'brigantine',
      account_limit: 2,
      active: true,
    },
    settings,
  );
  // Verify both lifecycle links and explicitly approved accounts enter one plan.
  store.saveLink(paidOwner, 'crew_primary', 'j-household-1', false, 1);
  service.mediaOwnerships.save(
    accountDetails.map(({ kind, id, username, slot }) => ({
      kind,
      server_id: `demo-${kind}`,
      account_id: id,
      username,
      discord_user_id: paidOwner,
      slot,
    })),
    settings,
  );
  const initialRelationships = relationshipCounts(admin);

  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('crew_owner');
  const manage = page
    .getByRole('row')
    .filter({ hasText: '@crew_owner' })
    .getByRole('button', {
      name: /^Manage /,
    });
  const workspace = page.getByRole('dialog', { name: 'Manage @crew_owner', exact: true });
  const accept = 'POST /api/accounts/access/accept';
  await manage.click();
  expect(admin.writes).toEqual([]);
  await workspace.getByRole('button', { name: 'Enable household', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(mutations).toEqual([accept]);
  expect(admin.writes).toHaveLength(4);
  expect(admin.writes).toEqual(expect.arrayContaining(policyWrites));
  expect(admin.servers.users).toEqual(originalUsers);

  await manage.click();
  const disable = workspace.getByRole('button', { name: 'Disable household', exact: true });
  await expect(disable).toBeInViewport({ ratio: 1 });
  await disable.click();
  await expect(workspace).toHaveCount(0);
  expect(mutations).toEqual([accept, accept]);
  expect(admin.writes.slice(4)).toHaveLength(4);
  expect(admin.writes.slice(4)).toEqual(expect.arrayContaining(policyWrites));
  for (const { kind, id } of accountDetails)
    expect(admin.servers.users[kind].find((user) => user.Id === id)?.Policy?.IsDisabled).toBe(true);

  await service.setMembershipAccess({
    discord_user_id: paidOwner,
    access_mode: 'subscription',
    tier_id: 'sloop',
    expected_revision: membership.revision,
  });
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('crew_owner');
  await manage.click();
  await workspace.getByRole('button', { name: 'Enable household', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Subscription account limit', exact: true });
  const allowed = warning.getByRole('list', { name: 'Accounts to enable', exact: true });
  const excluded = warning.getByRole('list', { name: 'Excluded accounts', exact: true });
  await expect(allowed.getByRole('listitem')).toHaveCount(2);
  await expect(excluded.getByRole('listitem')).toHaveCount(2);
  for (const { kind, username, slot } of accountDetails) {
    const accountLabel = `${kind === 'emby' ? 'Emby' : 'Jellyfin'}: ${username}`;
    await expect(
      (slot === 1 ? allowed : excluded)
        .getByRole('listitem')
        .filter({ has: page.getByText(accountLabel, { exact: true }) }),
    ).toContainText(slot === 1 ? 'Slot 1' : 'Slot 2 · Over the account limit');
  }
  expect(mutations).toEqual([accept, accept]);
  expect(admin.writes).toHaveLength(8);
  await expectContainedLayout(page);
  const enableEligible = warning.getByRole('button', {
    name: 'Enable eligible accounts',
    exact: true,
  });
  await expect(enableEligible).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('household-tier-warning.png') });
  await enableEligible.click();
  await expect(warning).toHaveCount(0);
  await expect(workspace).toHaveCount(0);
  expect(mutations).toEqual([accept, accept, accept]);
  expect(admin.writes.slice(8)).toHaveLength(2);
  expect(admin.writes.slice(8)).toEqual(
    expect.arrayContaining(
      accountDetails
        .filter(({ slot }) => slot === 1)
        .map(({ kind, id }) => ({ kind, id, method: 'setPolicy' })),
    ),
  );
  for (const kind of ['emby', 'jellyfin'] as const)
    expect(admin.servers.users[kind]).toEqual(
      originalUsers[kind].map((user) =>
        accountDetails.some(
          (account) => account.kind === kind && account.id === user.Id && account.slot === 2,
        )
          ? { ...user, Policy: { ...user.Policy, IsDisabled: true } }
          : user,
      ),
    );
  expect(relationshipCounts(admin)).toEqual(initialRelationships);
  expect(admin.stateWrites).toEqual([]);
  expect(admin.createdCredentials).toEqual([]);
});

test('an unavailable Emby source leaves verified Jellyfin accounts manageable', async ({
  page,
  admin,
  mutations,
}, info) => {
  admin.app.jellyport.store.saveSettings({
    ...admin.app.jellyport.store.settings(),
    emby_url: 'http://offline.example.invalid',
  });
  await page.goto('/#/users');
  await expect(
    page.getByText('Some server accounts are temporarily unavailable', { exact: true }),
  ).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('other_member');
  await expect(page.getByRole('table')).toContainText('other_member');
  await page.getByRole('button', { name: 'Manage other_member', exact: true }).click();
  const workspace = page.getByRole('dialog', { name: 'Manage other_member', exact: true });
  await expect(
    workspace.getByRole('button', { name: 'Disable selected account', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: info.outputPath('partial-directory-access-viewport.png') });
  await page.screenshot({ path: info.outputPath('partial-directory-access.png'), fullPage: true });
  await workspace.getByRole('button', { name: 'Disable selected account', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(admin.writes).toEqual([{ kind: 'jellyfin', method: 'setPolicy', id: 'j-other' }]);
  expect(relationshipCounts(admin)).toEqual({ owners: 0, mappings: 0, memberships: 0, links: 0 });
  expect(mutations).toEqual(['POST /api/accounts/access']);
  await expectContainedLayout(page);
});

test('a missing prerequisite is repaired within the person task while exact selection and notes drafts survive', async ({
  page,
  admin,
  mutations,
}, info) => {
  admin.servers.users.emby.find((user) => user.Id === 'e-alex')!.Policy = {
    IsAdministrator: false,
    IsDisabled: false,
  };
  let release!: () => void;
  const directoryRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workflow-readiness', async (route) => {
    await directoryRead;
    await route.continue();
  });
  await page.route(
    '**/api/user-directory',
    async (route) => {
      const response = await route.fetch();
      admin.app.jellyport.store.saveSettings({
        ...admin.app.jellyport.store.settings(),
        emby_url: 'http://offline.example.invalid',
      });
      release();
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('alex');
  await page.getByRole('button', { name: 'Manage alex', exact: true }).click();
  const workspace = page.getByRole('dialog', { name: 'Manage alex', exact: true });
  await expect(
    workspace.getByRole('heading', { name: 'Before you continue', exact: true }),
  ).toBeVisible();
  await expect(
    workspace.getByRole('button', { name: 'Disable selected account', exact: true }),
  ).toBeDisabled();
  await workspace.getByRole('tab', { name: 'Family & notes', exact: true }).click();
  await workspace.getByRole('textbox', { name: 'Owner name', exact: true }).fill('Draft owner');
  await workspace
    .getByRole('textbox', { name: 'Private owner notes', exact: true })
    .fill('Keep this private draft while repairing the connection.');
  await expect(
    workspace.getByRole('button', { name: 'Save family and owner notes', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('person-profile-viewport.png') });
  await workspace.getByRole('button', { name: 'Resolve requirement', exact: true }).click();
  let setup = page.getByRole('dialog', { name: 'Complete required setup', exact: true });
  await expect(setup).toBeVisible();
  await setup
    .getByLabel('Server URL', { exact: true })
    .filter({ visible: true })
    .fill('http://emby.example.invalid');
  await setup.getByRole('button', { name: 'Return to my task', exact: true }).click();
  await expect(setup).toHaveCount(0);
  expect(admin.app.jellyport.store.settings().emby_url).toBe('http://offline.example.invalid');
  await expect(workspace.getByRole('textbox', { name: 'Owner name', exact: true })).toHaveValue(
    'Draft owner',
  );
  await expect(
    workspace.getByRole('textbox', { name: 'Private owner notes', exact: true }),
  ).toHaveValue('Keep this private draft while repairing the connection.');
  await expect(
    workspace.getByRole('button', { name: 'Save family and owner notes', exact: true }),
  ).toBeDisabled();
  await workspace.getByRole('button', { name: 'Resolve requirement', exact: true }).click();
  setup = page.getByRole('dialog', { name: 'Complete required setup', exact: true });
  await setup
    .getByLabel('Server URL', { exact: true })
    .filter({ visible: true })
    .fill('http://emby.example.invalid');
  await setup.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect
    .poll(() => admin.app.jellyport.store.settings().emby_url)
    .toBe('http://emby.example.invalid');
  await setup.getByRole('button', { name: 'Return to my task', exact: true }).click();
  await expect(setup).toHaveCount(0);
  await expect
    .poll(() => workspace.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await expect(
    workspace.getByRole('textbox', { name: 'Private owner notes', exact: true }),
  ).toHaveValue('Keep this private draft while repairing the connection.');
  await expect(workspace.getByRole('combobox', { name: 'Media account', exact: true })).toHaveValue(
    JSON.stringify(['emby', 'e-alex']),
  );
  expect(admin.writes).toEqual([]);
  expect(
    admin.app.jellyport.service.profiles.get(
      'emby',
      'e-alex',
      admin.app.jellyport.store.settings(),
    ),
  ).toBeNull();
  await workspace.getByRole('tab', { name: 'Account access', exact: true }).click();
  const apply = workspace.getByRole('button', { name: 'Disable selected account', exact: true });
  await expect(apply).toBeEnabled();
  await page.screenshot({ path: info.outputPath('repaired-person-task-viewport.png') });
  await page.screenshot({ path: info.outputPath('repaired-person-task.png'), fullPage: true });
  await apply.click();
  await expect(workspace).toHaveCount(0);
  expect(admin.writes).toEqual([{ kind: 'emby', method: 'setPolicy', id: 'e-alex' }]);
  expect(mutations.filter((value) => value === 'POST /api/accounts/access')).toHaveLength(1);
  expect(mutations.filter((value) => value === 'PUT /api/settings')).toHaveLength(1);
  expect(relationshipCounts(admin)).toEqual({ owners: 0, mappings: 0, memberships: 0, links: 0 });
  expect(new URL(page.url()).hash).toBe('#/users');
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  await expectContainedLayout(page);
});

test('confirming an owner inside the person workspace is reused for later account actions', async ({
  page,
  admin,
  mutations,
}, info) => {
  admin.app.jellyport.store.saveSettings({
    ...admin.app.jellyport.store.settings(),
    discord_enabled: true,
    discord_guild_id: '999999999999999999',
  });
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('other_member');
  await page.getByRole('button', { name: 'Manage other_member', exact: true }).click();
  let workspace = page.getByRole('dialog', { name: 'Manage other_member', exact: true });
  await workspace.getByRole('tab', { name: 'Discord owner', exact: true }).click();
  await chooseOwner(page);
  await workspace.getByRole('button', { name: 'Review owner and accounts', exact: true }).click();
  await expect(
    workspace.getByRole('checkbox', { name: 'Jellyfin · other_member', exact: true }),
  ).toBeChecked();
  expect(relationshipCounts(admin).owners).toBe(0);
  expect(admin.writes).toEqual([]);
  await page.screenshot({ path: info.outputPath('owner-confirmation-viewport.png') });
  await workspace
    .getByRole('checkbox', { name: 'Jellyfin · other_member', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('owner-account-selection-viewport.png') });
  await workspace
    .getByRole('button', { name: 'Approve identity & update roles', exact: true })
    .click();
  await expect(workspace).toHaveCount(0);
  expect(
    admin.app.jellyport.service.mediaOwnerships.list(admin.app.jellyport.store.settings()),
  ).toEqual([
    expect.objectContaining({
      kind: 'jellyfin',
      account_id: 'j-other',
      discord_user_id: paidOwner,
    }),
  ]);
  await page.getByRole('button', { name: 'Manage other_member', exact: true }).click();
  workspace = page.getByRole('dialog', { name: 'Manage other_member', exact: true });
  await workspace.getByRole('tab', { name: 'Discord owner', exact: true }).click();
  await expect(workspace.getByText('Owner already confirmed', { exact: true })).toBeVisible();
  await expect(workspace).toContainText(paidOwner);
  await expect(workspace.getByText('Linked Discord member', { exact: true })).toBeVisible();
  await expect(
    workspace.getByRole('searchbox', { name: 'Discord member', exact: true }),
  ).toHaveCount(0);
  await workspace.getByRole('tab', { name: 'Account access', exact: true }).click();
  await page.screenshot({ path: info.outputPath('confirmed-owner-reused-viewport.png') });
  await page.screenshot({ path: info.outputPath('confirmed-owner-reused.png'), fullPage: true });
  await workspace.getByRole('button', { name: 'Disable household', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(mutations.filter((value) => value === 'POST /api/identity-review/apply')).toHaveLength(1);
  expect(mutations.filter((value) => value === 'POST /api/accounts/access/accept')).toHaveLength(1);
  expect(mutations).not.toContain('POST /api/accounts/link');
  expect(relationshipCounts(admin)).toEqual({ owners: 1, mappings: 0, memberships: 0, links: 0 });
  expect(admin.writes).toEqual([{ kind: 'jellyfin', method: 'setPolicy', id: 'j-other' }]);
  expect(admin.stateWrites).toEqual([]);
  await expectContainedLayout(page);
});
