import { test, expect, expectContainedLayout } from './media-admin-fixtures';
import type { Locator, Page } from '@playwright/test';

async function expectDialogFits(page: Page, dialog: Locator) {
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
}

test('family clones copy played flags and settings into independent accounts before renaming the original', async ({
  page,
  admin,
  mutations,
}, info) => {
  test.setTimeout(60_000);
  const sourceId = 'j-river';
  const source = admin.servers.users.jellyfin.find((user) => user.Id === sourceId)!;
  source.Policy = {
    IsAdministrator: false,
    IsDisabled: false,
    IsHidden: true,
    MaxParentalRating: 13,
    BlockUnratedItems: ['Movie'],
    EnableAllFolders: false,
    EnabledFolders: ['family-movies', 'family-shows'],
    EnableMediaPlayback: true,
    EnableContentDownloading: false,
  };
  source.Configuration = {
    SubtitleMode: 'Smart',
    EnableNextEpisodeAutoPlay: false,
    AudioLanguagePreference: 'en',
    HidePlayedInLatest: true,
    DisplayMissingEpisodes: false,
  };
  admin.servers.display[sourceId] = {
    ShowBackdrop: true,
    CustomPrefs: {
      homesection0: 'latestmedia',
      homesection1: 'resume',
      homesection2: 'nextup',
      skipForwardLength: '30000',
    },
  };
  admin.servers.played[sourceId] = new Set(['1', '3']);
  admin.servers.userData[sourceId] = {
    '1': {
      Played: true,
      PlayCount: 7,
      LastPlayedDate: '2026-10-18T19:00:00.000Z',
      PlaybackPositionTicks: 123456789,
      IsFavorite: true,
    },
    '2': { Played: false, PlaybackPositionTicks: 987654321, IsFavorite: true },
    '3': { Played: true, PlayCount: 2 },
  };
  admin.servers.playlists[sourceId] = [
    {
      Id: 'source-playlist',
      Name: 'Family picks',
      items: ['1', '3'],
      IsPublic: false,
      OwnerUserId: sourceId,
    },
  ];
  const originalProfile = await admin.app.jellyport.service.saveAccountProfile({
    kind: 'jellyfin',
    user_id: sourceId,
    family: true,
    owner_name: 'Synthetic family owner',
    notes: 'Private source notes',
    expected_revision: '',
  });
  const before = {
    source: structuredClone(source),
    played: new Set(admin.servers.played[sourceId]),
    state: structuredClone(admin.servers.userData[sourceId]),
    display: structuredClone(admin.servers.display[sourceId]),
    playlists: structuredClone(admin.servers.playlists[sourceId]),
    other: structuredClone(admin.servers.users.jellyfin.filter((user) => user.Id !== sourceId)),
  };
  const acceptedClones: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/accounts/clone')
      acceptedClones.push(request.postDataJSON());
  });
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('river');
  await page.getByRole('button', { name: 'Manage river', exact: true }).click();
  await page.getByRole('button', { name: 'Clone Jellyfin account for river', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Clone Jellyfin account', exact: true });
  await expect(
    dialog.getByRole('checkbox', { name: 'Mark the new accounts as family', exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole('textbox', { name: 'New username 1', exact: true })
    .fill('family_child_two');
  await dialog
    .getByRole('textbox', { name: 'New username 2', exact: true })
    .fill('family_child_three');
  await expectContainedLayout(page);
  await expectDialogFits(page, dialog);
  await page.screenshot({ path: info.outputPath('clone-family-form.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Review clone', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review account clones', exact: true });
  await expect(dialog).toContainText(sourceId);
  await expect(dialog.getByText('river', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog).toContainText('family_child_two · Family, family_child_three · Family');
  await expect(dialog).toContainText(
    'Resume positions, favorites, playlists, passwords, Discord links, and subscription ownership are not copied.',
  );
  await expectContainedLayout(page);
  await expectDialogFits(page, dialog);
  await page.screenshot({ path: info.outputPath('clone-family-review-viewport.png') });
  await page.screenshot({ path: info.outputPath('clone-family-review.png'), fullPage: true });
  expect(admin.cloneHistoryReads).toEqual([]);
  expect(admin.writes).toEqual([]);
  expect(admin.stateWrites).toEqual([]);
  expect(acceptedClones).toEqual([]);
  // Backing out of a prepared review cannot create accounts or copy any history.
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Clone Jellyfin account', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'New username 1', exact: true })).toHaveValue(
    'family_child_two',
  );
  await dialog.getByRole('button', { name: 'Review clone', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review account clones', exact: true });
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/accounts/clone',
  );
  await dialog.getByRole('button', { name: 'Create 2 accounts', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const { id } = await response.json();
  await expect
    .poll(async () => (await (await admin.client.get(`/api/jobs/${id}`)).json()).status, {
      timeout: 15_000,
    })
    .toBe('completed');
  const job = await (await admin.client.get(`/api/jobs/${id}`)).json();
  expect(job.kind).toBe('clone');
  expect(job.results).toHaveLength(2);
  expect(acceptedClones).toEqual([{ review_id: expect.any(String) }]);
  expect(admin.cloneHistoryReads).toEqual([sourceId]);
  expect(admin.servers.users.jellyfin.find((user) => user.Id === sourceId)).toEqual(before.source);
  expect(admin.servers.played[sourceId]).toEqual(before.played);
  expect(admin.servers.userData[sourceId]).toEqual(before.state);
  expect(admin.servers.display[sourceId]).toEqual(before.display);
  expect(admin.servers.playlists[sourceId]).toEqual(before.playlists);
  const children = admin.servers.users.jellyfin.filter((user) =>
    ['family_child_two', 'family_child_three'].includes(user.Name),
  );
  expect(children).toHaveLength(2);
  expect(new Set([sourceId, ...children.map((user) => user.Id)]).size).toBe(3);
  for (const child of children) {
    expect(child.Policy).toEqual(before.source.Policy);
    expect(child.Configuration).toEqual(before.source.Configuration);
    expect(admin.servers.display[child.Id]).toEqual(before.display);
    expect(admin.servers.played[child.Id]).toEqual(before.played);
    expect(admin.servers.userData[child.Id]).toEqual({
      '1': { Played: true },
      '3': { Played: true },
    });
    expect(admin.servers.playlists[child.Id] ?? []).toEqual([]);
    expect(
      admin.app.jellyport.service.profiles.get(
        'jellyfin',
        child.Id,
        admin.app.jellyport.store.settings(),
      ),
    ).toMatchObject({ family: true, owner_name: '', notes: '' });
    expect(
      job.results.find((result: { target_user_id: string }) => result.target_user_id === child.Id),
    ).toMatchObject({
      created: true,
      cloned_from_user_id: sourceId,
      cloned_from_username: 'river',
      applied: 2,
      status: 'completed',
      discord_delivery: 'not_requested',
      data: {
        items_updated: 2,
        resume_positions: 0,
        favorites: 0,
        play_counts: 0,
        last_played_dates: 0,
        playlists_created: 0,
        verification: { checked: 2, verified: 2, missing: 0, mismatched: 0 },
      },
    });
  }
  expect(admin.stateWrites).toHaveLength(4);
  expect(
    admin.stateWrites.every(
      (write) => write.user !== sourceId && JSON.stringify(write.value) === '{"Played":true}',
    ),
  ).toBe(true);
  expect(admin.writes.every((write) => write.id !== sourceId)).toBe(true);
  expect(
    admin.servers.users.jellyfin.filter(
      (user) => ![sourceId, ...children.map((child) => child.Id)].includes(user.Id),
    ),
  ).toEqual(before.other);
  expect(admin.createdCredentials.map((entry) => entry.username).sort()).toEqual([
    'family_child_three',
    'family_child_two',
  ]);
  expect(new Set(admin.createdCredentials.map((entry) => entry.password)).size).toBe(2);
  expect(admin.createdCredentials.every((entry) => /^[A-Za-z2-9]{12}$/.test(entry.password))).toBe(
    true,
  );
  expect(
    admin.app.jellyport.store.db.prepare('SELECT COUNT(*) AS count FROM links').get()?.count,
  ).toBe(0);
  expect(
    admin.app.jellyport.store.db.prepare('SELECT COUNT(*) AS count FROM memberships').get()?.count,
  ).toBe(0);
  const report = page.getByRole('dialog', { name: 'Account cloning details', exact: true });
  await expect(report.getByText('Completed', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(report).not.toContainText('Emby: river');
  expect(
    admin.createdCredentials.every((entry) => !JSON.stringify(job).includes(entry.password)),
  ).toBe(true);
  await expectContainedLayout(page);
  await expectDialogFits(page, report);
  await page.screenshot({ path: info.outputPath('clone-family-completed.png'), fullPage: true });
  await report.getByRole('button', { name: 'Reveal new credentials', exact: true }).click();
  const reveal = page.getByRole('dialog', { name: 'Reveal new account credentials?', exact: true });
  await reveal.getByRole('button', { name: 'Reveal credentials', exact: true }).click();
  const credentials = page.getByRole('dialog', { name: 'New account credentials', exact: true });
  await expect(credentials.locator('.credential')).toHaveCount(2);
  for (const entry of admin.createdCredentials) {
    const credential = credentials.locator('.credential').filter({ hasText: entry.username });
    await expect(credential.locator('.credential-password')).toHaveText(entry.password);
  }
  await expectContainedLayout(page);
  await credentials.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Manage river', exact: true }).click();
  await page
    .getByRole('button', { name: 'Rename Jellyfin account for river', exact: true })
    .click();
  const rename = page.getByRole('dialog', { name: 'Rename Jellyfin account', exact: true });
  await rename
    .getByRole('textbox', { name: 'New sign-in username', exact: true })
    .fill('family_child_one');
  await expect(rename).toContainText(
    'account ID, password, permissions, preferences, and watch history stay the same',
  );
  expect(mutations).not.toContain('POST /api/accounts/rename');
  await expectContainedLayout(page);
  await expectDialogFits(page, rename);
  await page.screenshot({ path: info.outputPath('rename-family-source.png'), fullPage: true });
  const renamed = page.waitForResponse(
    (value) =>
      value.request().method() === 'POST' &&
      new URL(value.url()).pathname === '/api/accounts/rename',
  );
  await rename.getByRole('button', { name: 'Rename account', exact: true }).click();
  expect((await renamed).status()).toBe(200);
  await expect(rename).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('family_child');
  await expect(page.getByRole('table')).toContainText('family_child_one');
  await expect(page.getByRole('table')).toContainText('family_child_two');
  await expect(page.getByRole('table')).toContainText('family_child_three');
  expect(admin.servers.users.jellyfin.find((user) => user.Id === sourceId)).toEqual({
    ...before.source,
    Name: 'family_child_one',
  });
  expect(admin.servers.played[sourceId]).toEqual(before.played);
  expect(admin.servers.userData[sourceId]).toEqual(before.state);
  expect(admin.servers.display[sourceId]).toEqual(before.display);
  expect(admin.servers.playlists[sourceId]).toEqual(before.playlists);
  expect(
    admin.app.jellyport.service.profiles.get(
      'jellyfin',
      sourceId,
      admin.app.jellyport.store.settings(),
    ),
  ).toEqual(originalProfile);
  expect(admin.writes.filter((write) => write.id === sourceId)).toEqual([
    { kind: 'jellyfin', method: 'rename', id: sourceId },
  ]);
  expect(admin.writes.filter((write) => write.method === 'create')).toHaveLength(2);
  expect(mutations.filter((mutation) => mutation === 'POST /api/accounts/clone')).toHaveLength(1);
  expect(mutations.filter((mutation) => mutation === 'POST /api/accounts/rename')).toHaveLength(1);
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  await expectContainedLayout(page);
  await page.screenshot({
    path: info.outputPath('three-independent-family-accounts.png'),
    fullPage: true,
  });
});

test('a rename with uncertain readback can be confirmed after reload without replaying the remote rename', async ({
  page,
  admin,
  mutations,
}, info) => {
  const sourceId = 'j-river';
  const before = structuredClone(
    admin.servers.users.jellyfin.find((user) => user.Id === sourceId)!,
  );
  const sourceState = structuredClone(admin.servers.played[sourceId]);
  admin.loseRenameReadback('renamed_family');
  await page.goto('/#/users');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('river');
  await page.getByRole('button', { name: 'Manage river', exact: true }).click();
  await page
    .getByRole('button', { name: 'Rename Jellyfin account for river', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: 'Rename Jellyfin account', exact: true });
  await dialog
    .getByRole('textbox', { name: 'New sign-in username', exact: true })
    .fill('renamed_family');
  await dialog.getByRole('button', { name: 'Rename account', exact: true }).click();
  await expect(dialog.locator('form').getByRole('alert')).toContainText(
    'rename outcome is uncertain',
  );
  expect(admin.servers.users.jellyfin.find((user) => user.Id === sourceId)).toEqual({
    ...before,
    Name: 'renamed_family',
  });
  expect(admin.writes.filter((write) => write.method === 'rename')).toHaveLength(1);
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill('renamed_family');
  await page.getByRole('button', { name: 'Manage renamed_family', exact: true }).click();
  await page
    .getByRole('button', { name: 'Rename Jellyfin account for renamed_family', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Rename Jellyfin account', exact: true });
  await expect(
    dialog.getByRole('button', { name: 'Confirm previous rename', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('textbox', { name: 'New sign-in username', exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toContainText(sourceId);
  await expect(dialog).toContainText('river');
  await expect(dialog).toContainText('renamed_family');
  await expectContainedLayout(page);
  await expectDialogFits(page, dialog);
  await page.screenshot({ path: info.outputPath('confirm-uncertain-rename-viewport.png') });
  const accepted = page.waitForResponse(
    (value) =>
      value.request().method() === 'POST' &&
      new URL(value.url()).pathname === '/api/accounts/rename',
  );
  await dialog.getByRole('button', { name: 'Confirm previous rename', exact: true }).click();
  expect((await accepted).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  expect(admin.writes.filter((write) => write.method === 'rename')).toEqual([
    { kind: 'jellyfin', method: 'rename', id: sourceId },
  ]);
  expect(admin.servers.users.jellyfin.find((user) => user.Id === sourceId)).toEqual({
    ...before,
    Name: 'renamed_family',
  });
  expect(admin.servers.played[sourceId]).toEqual(sourceState);
  expect(
    admin.app.jellyport.service.renames.get(sourceId, admin.app.jellyport.store.settings()),
  ).toBeNull();
  expect(mutations.filter((mutation) => mutation === 'POST /api/accounts/rename')).toHaveLength(2);
});
