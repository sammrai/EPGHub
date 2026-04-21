import { defineConfig, devices } from '@playwright/test';

// E2E は Vite dev server を立ち上げ、API (`/api/*`) は各テスト内で
// `page.route()` によりモックする。server/ を起動しないので Postgres や
// Mirakurun に依存しない。
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // 既存 UI は JST 前提で描画されるので、ブラウザも JST に揃える。
    timezoneId: 'Asia/Tokyo',
    locale: 'ja-JP',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
