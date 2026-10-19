import type { Locator, Page } from '@playwright/test';
import { test, expect, expectContainedLayout } from './media-admin-import-fixture';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function geometry(page: Page, panel: Locator) {
  // Read after two paints so both React's pending update and browser scroll
  // anchoring have settled. This is render synchronization, not a timed delay.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  return panel.evaluate((element) => {
    const summary = element.querySelector('.status-summary')!.getBoundingClientRect();
    const following = element.querySelector('.section-heading')!.getBoundingClientRect();
    const actions = element.querySelector('.form-actions')!.getBoundingClientRect();
    return {
      summaryTop: summary.top,
      summaryHeight: summary.height,
      followingTop: following.top,
      actionsTop: actions.top,
      actionsHeight: actions.height,
      scroll: window.scrollY,
    };
  });
}

function expectSameGeometry(actual: Awaited<ReturnType<typeof geometry>>, baseline: typeof actual) {
  for (const key of Object.keys(baseline) as Array<keyof typeof baseline>)
    expect(
      Math.abs(actual[key] - baseline[key]),
      `${key} must not shift during status refresh`,
    ).toBeLessThanOrEqual(1);
}

for (const kind of ['jellyfin', 'emby'] as const) {
  test(`${kind} background polls and manual status refresh keep running import layout stable`, async ({
    page,
    imports,
  }, testInfo) => {
    const path = kind === 'jellyfin' ? '/api/destination-catalog' : '/api/source-snapshots';
    const now = new Date().toISOString();
    const status = {
      ...(kind === 'jellyfin' ? await imports.destinationStatus() : await imports.sourceStatus()),
      running: true,
      last_attempt_at: now,
      last_finished_at: null,
      last_outcome: 'running',
      next_run_at: null,
      last_error: null,
      ...(kind === 'jellyfin'
        ? {
            diagnostic: {
              stage: 'reading_items',
              started_at: now,
              updated_at: now,
              source_rows: 46126,
              provider_rows: 0,
              items: 0,
              keys: 0,
              bytes: 0,
            },
          }
        : { users_total: 120, users_processed: 42 }),
    };
    let held:
      | {
          arrived: ReturnType<typeof deferred>;
          release: ReturnType<typeof deferred>;
          fail: boolean;
        }
      | undefined;
    const releases: Array<() => void> = [];
    const holdNextRead = (fail = false) => {
      const next = { arrived: deferred(), release: deferred(), fail };
      held = next;
      releases.push(next.release.resolve);
      return next;
    };
    let statusReads = 0;
    await page.route(`**${path}`, async (route) => {
      expect(route.request().method()).toBe('GET');
      statusReads++;
      const pending = held;
      held = undefined;
      if (pending) {
        pending.arrived.resolve();
        await pending.release.promise;
      }
      await route.fulfill(
        pending?.fail
          ? { status: 400, json: { error: 'Synthetic status read rejected.' } }
          : { json: status },
      );
    });
    try {
      await page.goto(`/#/settings/history/${kind}`);
      const panel = page.getByRole('region', {
        name:
          kind === 'jellyfin' ? 'Saved Jellyfin matching catalog' : 'Saved Emby database snapshots',
        exact: true,
      });
      await expect(panel.getByText('Last outcome: Running', { exact: true })).toBeVisible();
      const refresh = panel.getByRole('button', { name: 'Refresh status', exact: true });
      await expect(refresh).toBeEnabled();
      await refresh.scrollIntoViewIfNeeded();
      const baseline = await geometry(page, panel);
      const automatic = holdNextRead();
      await automatic.arrived.promise;
      expect(statusReads).toBe(2);
      expectSameGeometry(await geometry(page, panel), baseline);
      await expect(page.locator('.toast-region')).toHaveCount(0);
      automatic.release.resolve();
      await expect(refresh).toBeEnabled();
      expectSameGeometry(await geometry(page, panel), baseline);

      const manual = holdNextRead();
      const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
      if (touch) await refresh.tap();
      else await refresh.click();
      await manual.arrived.promise;
      expect(statusReads).toBe(3);
      await expect(refresh).toHaveAttribute('aria-busy', 'true');
      const pendingNotice = page.getByText('Refreshing status…', { exact: true });
      await expect(pendingNotice).toBeVisible();
      await page.locator('.toast-region').evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
      });
      const noticeBounds = await pendingNotice.boundingBox();
      expect(noticeBounds).not.toBeNull();
      expect(noticeBounds!.y).toBeGreaterThanOrEqual(0);
      expect(noticeBounds!.y + noticeBounds!.height).toBeLessThanOrEqual(
        page.viewportSize()!.height,
      );
      expectSameGeometry(await geometry(page, panel), baseline);
      await expectContainedLayout(page);
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-running-manual-refresh-viewport.png`),
      });
      manual.release.resolve();
      await expect(refresh).toBeEnabled();
      await expect(page.getByText('Status refreshed.', { exact: true })).toBeVisible();
      expectSameGeometry(await geometry(page, panel), baseline);

      const failed = holdNextRead(true);
      if (touch) await refresh.tap();
      else await refresh.click();
      await failed.arrived.promise;
      await expect(page.getByText('Refreshing status…', { exact: true })).toBeVisible();
      failed.release.resolve();
      const failure =
        kind === 'jellyfin'
          ? 'Jellyfin catalog status could not be loaded. Refresh status to try again.'
          : 'Saved snapshot status could not be loaded. Refresh status to try again.';
      await expect(page.locator('.toast-region').getByRole('alert')).toHaveText(failure);
      await expect(page.getByText('Synthetic status read rejected.', { exact: true })).toHaveCount(
        0,
      );
      await expect(refresh).toBeEnabled();
      expect(imports.helperImports()).toBe(0);
      expect(imports.nativeBackupCalls()).toBe(0);
      expect(imports.writes).toEqual([]);
    } finally {
      for (const release of releases) release();
    }
  });
}
