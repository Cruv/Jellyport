import type { Page, Response } from '@playwright/test';
import {
  test,
  expect,
  navigate,
  expectContainedLayout,
  paidOwner,
  guestOwner,
} from './media-admin-fixtures';
import type { AdminFixture } from './media-admin-fixtures';

test.afterEach(async ({ page }, info) => {
  if (info.status !== 'passed') return;
  await expectContainedLayout(page);
  await page.screenshot({ path: info.outputPath('workflow-outcome.png'), fullPage: true });
});

async function finishJob(admin: AdminFixture, response: Response) {
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await expect
    .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status, {
      timeout: 15_000,
    })
    .toMatch(/^(completed|partial|failed)$/);
  return await (await admin.client.get(`/api/jobs/${id}`)).json();
}

async function chooseMember(page: Page, username: string) {
  await page.getByRole('searchbox', { name: 'Discord member', exact: true }).fill(username);
  await page.getByRole('button', { name: `Select @${username}`, exact: true }).click();
}

async function queueMembership(page: Page, admin: AdminFixture, tier: string) {
  await page.getByRole('combobox', { name: 'Membership tier', exact: true }).selectOption(tier);
  await page.getByRole('button', { name: 'Review membership update', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review membership update', exact: true });
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/memberships/provision' &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Queue membership update', exact: true }).click();
  const job = await finishJob(admin, await accepted);
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  return job;
}

test('saved connection repair reaches verified readiness without sending an unsaved draft', async ({
  page,
  admin,
  mutations,
}) => {
  admin.app.jellyport.store.saveSettings({
    ...admin.app.jellyport.store.settings(),
    emby_url: 'http://offline.example.invalid',
  });
  await page.goto('/#/overview');
  const connection = page.locator('.server-row').filter({ hasText: 'Emby' });
  await expect(connection).toContainText('Offline');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Emby', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByLabel('Server URL', { exact: true })
    .filter({ visible: true })
    .fill('http://emby.example.invalid');
  await page.getByRole('button', { name: 'Test saved connections', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved connection test', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.connection-test-results .server-row').filter({ hasText: 'Emby' }),
  ).toContainText('Offline');
  expect(admin.app.jellyport.store.settings().emby_url).toBe('http://offline.example.invalid');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect
    .poll(() => admin.app.jellyport.store.settings().emby_url)
    .toBe('http://emby.example.invalid');
  await page.getByRole('button', { name: 'Test saved connections', exact: true }).click();
  await expect(
    page.locator('.connection-test-results .server-row').filter({ hasText: 'Emby' }),
  ).toContainText('Connected');
  await page.screenshot({ path: test.info().outputPath('saved-connections.png'), fullPage: true });
  await navigate(page, 'Overview');
  await expect(page.getByText('Servers are ready', { exact: true })).toBeVisible();
  expect(mutations.filter((request) => request === 'PUT /api/settings')).toHaveLength(1);
  expect(admin.writes).toEqual([]);
});

test('saving an exact destination mapping is reflected in migration review without changing an account', async ({
  page,
  admin,
  mutations,
}) => {
  const before = structuredClone(admin.servers.users.jellyfin);
  await page.goto('/#/mappings');
  await page.getByRole('tab', { name: 'Add mapping', exact: true }).click();
  await page.getByRole('combobox', { name: 'Emby account', exact: true }).selectOption('e-alex');
  await page
    .getByRole('combobox', { name: 'Jellyfin destination', exact: true })
    .selectOption('j-river');
  await page.getByRole('button', { name: 'Save mapping', exact: true }).click();
  const saved = await admin.client.get('/api/user-mappings');
  await expect
    .poll(async () => (await (await admin.client.get('/api/user-mappings')).json()).mappings.length)
    .toBe(1);
  expect(saved.ok()).toBe(true);
  expect((await (await admin.client.get('/api/user-mappings')).json()).mappings[0]).toMatchObject({
    source_user_id: 'e-alex',
    target_user_id: 'j-river',
    target_username: 'river',
  });
  await navigate(page, 'Migrate users');
  await page.getByRole('checkbox', { name: 'Use saved Emby snapshot', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Select alex', exact: true }).check();
  await page.getByRole('button', { name: 'Preview migration (1)', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your migration', exact: true });
  await expect(review).toContainText('Mapped Emby account: alex → Jellyfin: river');
  await expect(review).toContainText('Merge into existing account');
  await expect(review).toContainText('History details deferred');
  await page.screenshot({ path: test.info().outputPath('mapped-review.png'), fullPage: true });
  await review.getByRole('button', { name: 'Back to users', exact: true }).click();
  expect(admin.servers.users.jellyfin).toEqual(before);
  expect(admin.writes).toEqual([]);
  expect(mutations).not.toContain('POST /api/migrations');
});

test('role copy and assignment precede applying only reviewed permissions to one exact account', async ({
  page,
  admin,
  mutations,
}) => {
  const originalTarget = structuredClone(
    admin.servers.users.jellyfin.find((user) => user.Id === 'j-river'),
  )!;
  const untouched = structuredClone(
    admin.servers.users.jellyfin.find((user) => user.Id === 'j-other'),
  )!;
  await page.goto('/#/roles');
  await page.getByRole('button', { name: 'Create role', exact: true }).click();
  await page.getByRole('textbox', { name: 'Role name', exact: true }).fill('Browser members');
  await page
    .getByRole('combobox', { name: 'Copy settings from', exact: true })
    .selectOption('template');
  await page.getByRole('button', { name: 'Copy settings', exact: true }).click();
  await page.getByRole('button', { name: 'Save new role', exact: true }).click();
  await expect
    .poll(async () => (await (await admin.client.get('/api/account-roles')).json()).roles.length)
    .toBe(1);
  expect(admin.writes).toEqual([]);
  await page.getByRole('tab', { name: 'Apply role', exact: true }).click();
  await page.getByRole('checkbox', { name: /^river / }).check();
  await page.getByRole('button', { name: 'Assign role', exact: true }).click();
  await expect
    .poll(
      async () => (await (await admin.client.get('/api/account-roles')).json()).assignments.length,
    )
    .toBe(1);
  expect(admin.writes).toEqual([]);
  await page.getByRole('checkbox', { name: /^Permissions Library access/ }).check();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  let review = page.getByRole('dialog', { name: 'Apply role settings?', exact: true });
  await expect(review).toContainText('river');
  await expect(review).not.toContainText('other_member');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(admin.writes).toEqual([]);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  review = page.getByRole('dialog', { name: 'Apply role settings?', exact: true });
  const accepted = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/account-roles/apply',
  );
  await review.getByRole('button', { name: 'Apply settings', exact: true }).click();
  const job = await finishJob(admin, await accepted);
  expect(job.status).toBe('completed');
  const updated = admin.servers.users.jellyfin.find((user) => user.Id === 'j-river')!;
  expect(updated.Policy?.EnableMediaPlayback).toBe(true);
  expect(updated.Policy?.EnableContentDownloading).toBe(false);
  expect(updated.Configuration).toEqual(originalTarget.Configuration);
  expect(admin.servers.users.jellyfin.find((user) => user.Id === 'j-other')).toEqual(untouched);
  expect(admin.writes.map(({ method, id }) => ({ method, id }))).toEqual([
    { method: 'setPolicy', id: 'j-river' },
  ]);
  expect(mutations.filter((request) => request === 'POST /api/account-roles/apply')).toHaveLength(
    1,
  );
  await expect(
    page.getByRole('dialog').getByText('Completed', { exact: true }).first(),
  ).toBeVisible();
  await expectContainedLayout(page);
});

test('an uncertain account creation is inspected and recovered without creating a duplicate account', async ({
  page,
  admin,
  mutations,
}) => {
  const name = 'uncertain_member';
  admin.loseCreateResponse(name);
  await page.goto('/#/accounts');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(name);
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/accounts' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('main').getByRole('button', { name: 'Create account', exact: true }).click();
  const failed = await finishJob(admin, await accepted);
  expect(failed.status).toBe('failed');
  expect(admin.app.jellyport.store.account(name)?.status).toBe('uncertain');
  const target = admin.servers.users.jellyfin.find((user) => user.Name === name)!;
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await navigate(page, 'Activity');
  await page.getByRole('searchbox', { name: 'Search operations', exact: true }).fill(failed.id);
  await page.getByRole('button', { name: 'View operation details', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('outcome is uncertain');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Inspect interrupted creation', exact: true })
    .click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/accounts/recover');
  await expect(
    page.getByRole('tab', { name: 'Recover interrupted creation', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Account to inspect', exact: true }).fill('river');
  await page.getByRole('button', { name: 'Inspect account', exact: true }).click();
  await expect(page.getByText('river · Recovery unavailable', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Account to inspect', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Inspect account', exact: true }).click();
  await expect(page.getByText(`${name} · Eligible for recovery`, { exact: true })).toBeVisible();
  const recover = page.getByRole('button', { name: 'Recover account', exact: true });
  await expect(recover).toBeDisabled();
  await page.getByRole('checkbox', { name: /I inspected this Jellyfin account/ }).check();
  const recovery = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/accounts/recover',
  );
  await recover.click();
  expect((await finishJob(admin, await recovery)).status).toBe('completed');
  expect(
    admin.servers.users.jellyfin.filter((user) => user.Name === name).map((user) => user.Id),
  ).toEqual([target.Id]);
  expect(admin.app.jellyport.store.account(name)?.remote_id).toBe(target.Id);
  expect(admin.app.jellyport.store.account(name)?.status).toBe('ready');
  expect(
    admin.writes.filter((write) => write.method === 'create' && write.id === name),
  ).toHaveLength(1);
  expect(mutations.filter((request) => request === 'POST /api/accounts/recover')).toHaveLength(1);
  await expect(
    page.getByRole('dialog').getByText('Completed', { exact: true }).first(),
  ).toBeVisible();
});

test('complimentary policy saves without media writes and paid slots downgrade and reactivate the same accounts', async ({
  page,
  admin,
}) => {
  test.setTimeout(60_000);
  await page.goto('/#/memberships');
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Access policy', exact: true })
    .selectOption('complimentary');
  await chooseMember(page, 'family_guest');
  await page.getByRole('button', { name: 'Save access policy', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await admin.client.get('/api/memberships')).json()).memberships.find(
          (item: { discord_user_id: string }) => item.discord_user_id === guestOwner,
        )?.access_mode,
    )
    .toBe('complimentary');
  expect(admin.writes).toEqual([]);
  await expect(page.locator('.toast-region')).toHaveCount(1);
  await expect(page.locator('.toast-region')).toContainText(
    'Access policy saved. Media accounts have not been changed.',
  );
  await page.getByRole('tab', { name: /^Managed memberships(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await chooseMember(page, 'crew_owner');
  expect((await queueMembership(page, admin, 'galleon')).status).toBe('completed');
  const slots = [1, 2, 3].map((slot) => admin.app.jellyport.store.link(paidOwner, slot)!);
  expect(slots.map((slot) => slot.username)).toEqual([
    'crew_owner',
    'crew_owner_2',
    'crew_owner_3',
  ]);
  for (const [index, slot] of slots.entries())
    admin.servers.played[slot.remote_id] = new Set([String(index + 1)]);
  expect((await queueMembership(page, admin, 'sloop')).status).toBe('completed');
  expect(
    slots.map(
      (slot) =>
        admin.servers.users.jellyfin.find((user) => user.Id === slot.remote_id)?.Policy?.IsDisabled,
    ),
  ).toEqual([false, true, true]);
  expect((await queueMembership(page, admin, 'galleon')).status).toBe('completed');
  expect(
    [1, 2, 3].map((slot) => admin.app.jellyport.store.link(paidOwner, slot)?.remote_id),
  ).toEqual(slots.map((slot) => slot.remote_id));
  expect(
    slots.map(
      (slot) =>
        admin.servers.users.jellyfin.find((user) => user.Id === slot.remote_id)?.Policy?.IsDisabled,
    ),
  ).toEqual([false, false, false]);
  slots.forEach((slot, index) =>
    expect(admin.servers.played[slot.remote_id]).toEqual(new Set([String(index + 1)])),
  );
  const notice = page.locator('.toast-region');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText(
    'Membership update queued. Follow account creation and access changes in Activity.',
  );
  await expect(notice).not.toContainText('Access policy saved.');
  expect(await notice.evaluate((element) => getComputedStyle(element).position)).toBe('static');
  const action = page.getByRole('button', { name: 'Review membership update', exact: true });
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport({ ratio: 1 });
  expect(
    await action.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      return hit === element || (hit !== null && element.contains(hit));
    }),
    'The primary membership action is reachable without a notification overlay.',
  ).toBe(true);
});

test('subscription review provisions the trusted tier and ignoring a later cancellation preserves access', async ({
  page,
  admin,
  mutations,
}) => {
  await admin.app.jellyport.service.recordSubscription({
    id: 'synthetic-subscribe',
    action: 'subscribe',
    discord_user_id: paidOwner,
    username: 'crew_owner',
    source: 'mee6_message',
    detail: 'Sloop Crewman Plan',
  });
  await page.goto('/#/subscriptions');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Process subscription', exact: true });
  await expect(review).toContainText('Sloop Crewman Plan');
  expect(admin.writes).toEqual([]);
  await review.getByRole('button', { name: 'Apply subscription', exact: true }).click();
  await expect
    .poll(() => admin.app.jellyport.store.subscription('synthetic-subscribe')?.status, {
      timeout: 15_000,
    })
    .toBe('applied');
  const link = admin.app.jellyport.store.link(paidOwner)!;
  expect(admin.servers.users.jellyfin.find((user) => user.Id === link.remote_id)?.Name).toBe(
    'crew_owner',
  );
  const jobId = admin.app.jellyport.store.subscription('synthetic-subscribe')!.job_id!;
  expect((await (await admin.client.get(`/api/jobs/${jobId}`)).json()).status).toBe('completed');
  await admin.app.jellyport.service.recordSubscription({
    id: 'synthetic-cancel',
    action: 'cancel',
    discord_user_id: paidOwner,
    username: 'crew_owner',
    source: 'mee6_message',
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect
    .poll(() => admin.app.jellyport.store.subscription('synthetic-cancel')?.status)
    .toBe('ignored');
  expect(
    admin.servers.users.jellyfin.find((user) => user.Id === link.remote_id)?.Policy?.IsDisabled,
  ).toBe(false);
  expect(
    mutations.filter((request) => request === 'POST /api/subscriptions/synthetic-subscribe/apply'),
  ).toHaveLength(1);
});

test('a manually flagged Family account is preserved when a reviewed cancellation disables its paid siblings', async ({
  page,
  admin,
}) => {
  const initial = await admin.app.jellyport.service.provisionMembership(paidOwner, 'galleon');
  await admin.app.jellyport.service.jobTasks.get(initial.id);
  expect(admin.app.jellyport.service.getJob(initial.id).status).toBe('completed');
  const slots = [1, 2, 3].map((slot) => admin.app.jellyport.store.link(paidOwner, slot)!);
  const family = slots[2]!;
  admin.servers.played[family.remote_id] = new Set(['3']);
  admin.writes.length = 0;
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('crew_owner_3');
  await page.getByRole('button', { name: 'Manage crew_owner', exact: true }).click();
  await page
    .getByRole('button', { name: 'Family and owner notes for crew_owner', exact: true })
    .click();
  const profile = page.getByRole('dialog', { name: 'Family and owner notes', exact: true });
  await profile
    .getByRole('combobox', { name: 'Media account', exact: true })
    .selectOption({ label: 'Jellyfin: crew_owner_3' });
  await profile.getByRole('checkbox', { name: 'Family account', exact: true }).check();
  await profile
    .getByRole('textbox', { name: 'Owner name', exact: true })
    .fill('Synthetic family member');
  await profile
    .getByRole('textbox', { name: 'Private owner notes', exact: true })
    .fill('Synthetic private account note');
  await profile.getByRole('button', { name: 'Save family and owner notes', exact: true }).click();
  await expect(profile).toHaveCount(0);
  expect(
    admin.app.jellyport.service.profiles.get(
      'jellyfin',
      family.remote_id,
      admin.app.jellyport.store.settings(),
    ),
  ).toMatchObject({
    family: true,
    owner_name: 'Synthetic family member',
    notes: 'Synthetic private account note',
  });
  await expect(page.getByRole('table')).not.toContainText('Synthetic private account note');
  expect(admin.writes).toEqual([]);
  await admin.app.jellyport.service.recordSubscription({
    id: 'synthetic-family-cancel',
    action: 'cancel',
    discord_user_id: paidOwner,
    username: 'crew_owner',
    source: 'mee6_message',
  });
  await navigate(page, 'Subscriptions');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Process cancellation', exact: true });
  await expect(review).toContainText('Accounts, passwords, and watch history are preserved');
  await review.getByRole('button', { name: 'Disable linked accounts now', exact: true }).click();
  await expect
    .poll(() => admin.app.jellyport.store.subscription('synthetic-family-cancel')?.status)
    .toBe('applied');
  expect(
    slots.map(
      (slot) =>
        admin.servers.users.jellyfin.find((user) => user.Id === slot.remote_id)?.Policy?.IsDisabled,
    ),
  ).toEqual([true, true, false]);
  expect(admin.servers.played[family.remote_id]).toEqual(new Set(['3']));
  expect(admin.writes.every((write) => write.id !== family.remote_id)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, 'Users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('crew_owner');
});

test('unsubmitted editor drafts survive main navigation and Back but disappear after administrator sign-out', async ({
  page,
  admin,
  mutations,
}) => {
  await page.goto('/#/settings/media/emby');
  const serverUrl = page.getByLabel('Server URL', { exact: true }).filter({ visible: true });
  await serverUrl.fill('http://unsubmitted.example.invalid');
  await navigate(page, 'Account roles');
  await page.getByRole('button', { name: 'Create role', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Role name', exact: true })
    .fill('Unsubmitted browser role');
  await navigate(page, 'Settings');
  await expect(serverUrl).toHaveValue('http://unsubmitted.example.invalid');
  expect(admin.app.jellyport.store.settings().emby_url).toBe('http://emby.example.invalid');
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'Role name', exact: true })).toHaveValue(
    'Unsubmitted browser role',
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('textbox', { name: 'Jellyfin username', exact: true }).fill('admin');
  await page.getByLabel('Jellyfin password', { exact: true }).fill('synthetic-admin-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Role name', exact: true })).toHaveValue('');
  await navigate(page, 'Settings');
  await expect(serverUrl).toHaveValue('http://emby.example.invalid');
  expect(mutations).toEqual(['POST /api/logout', 'POST /api/login']);
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
});

test('reduced motion removes spinner and status animation while leaving loading feedback readable', async ({
  page,
  admin,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/overview', async (route) => {
    await blocked;
    await route.continue();
  });
  try {
    await page.goto('/#/overview');
    const status = page.getByRole('status');
    await expect(status).toContainText('Loading');
    await expect(page.locator('.spinner')).toBeVisible();
    expect(
      await page.locator('.spinner').evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expectContainedLayout(page);
  expect(admin.writes).toEqual([]);
});
