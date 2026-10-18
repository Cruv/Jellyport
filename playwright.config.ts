import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 400, height: 844 } } },
    {
      name: 'iphone-portrait',
      use: { ...devices['iPhone 16 Pro Max'], browserName: 'webkit' },
    },
    {
      name: 'iphone-landscape',
      testMatch: [
        '**/iphone-admin.spec.ts',
        '**/media-admin-*.spec.ts',
        '**/history-cleanup.spec.ts',
      ],
      use: { ...devices['iPhone 16 Pro Max landscape'], browserName: 'webkit' },
    },
  ],
  webServer: {
    command: 'node scripts/browser-demo.mjs',
    url: 'http://127.0.0.1:4179/health',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
