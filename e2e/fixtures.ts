import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

const demoUrl = 'http://127.0.0.1:4179';
type DemoSession = Awaited<ReturnType<APIRequestContext['storageState']>>;

export const test = base.extend<{ mutations: string[] }, { demoSession: DemoSession }>({
  demoSession: [
    async ({ playwright }, use) => {
      const client = await playwright.request.newContext({ baseURL: demoUrl });
      try {
        const session = await client.get('/api/session');
        expect(session.ok()).toBe(true);
        const value = await session.json();
        expect(value.demo, 'Browser tests require the isolated synthetic demo.').toBe(true);
        const login = await client.post('/api/login', {
          headers: { 'X-CSRF-Token': value.csrf_token },
          data: { username: 'admin', password: 'demo-jellyport' },
        });
        expect(login.ok()).toBe(true);
        expect((await login.json()).authenticated).toBe(true);
        // Synthetic cookies stay in memory; no reusable session file is written.
        await use(await client.storageState());
      } finally {
        await client.dispose();
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ demoSession }, use) => use(demoSession),
  page: async ({ page, baseURL }, use) => {
    expect(baseURL).toBe(demoUrl);
    const failures: string[] = [];
    await page.context().route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== demoUrl) {
        failures.push('Unexpected external browser request.');
        await route.abort();
      } else await route.continue();
    });
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500)
        failures.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    await use(page);
    expect(failures, 'No JavaScript crashes, server errors or external requests.').toEqual([]);
  },
  mutations: async ({ page }, use) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method()))
        requests.push(`${request.method()} ${path}`);
    });
    await use(requests);
  },
});

export { expect };

export async function navigate(page: Page, name: string) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('complementary', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

export async function expectContainedLayout(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  const content = await page.locator('#workspace-content').boundingBox();
  expect(content).not.toBeNull();
  expect(content!.x).toBeGreaterThanOrEqual(0);
  expect(content!.x + content!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

export async function isCompactLayout(page: Page) {
  return page.evaluate(
    () =>
      window.matchMedia('(max-width: 700px), (max-width: 1100px) and (pointer: coarse)').matches,
  );
}
