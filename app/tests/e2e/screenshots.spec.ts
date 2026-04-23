import { test, expect, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Full-screen tour against the /mock dev-mode preview. Writes PNGs under
// `app/screenshots/`. Run with `npx playwright test screenshots`.
//
// Usage:
//   npm run dev          # in another terminal
//   npx playwright test tests/e2e/screenshots.spec.ts --reporter=list

const OUT_DIR = join(process.cwd(), 'screenshots');
mkdirSync(OUT_DIR, { recursive: true });

const shot = async (page: Page, name: string) => {
  await page.screenshot({
    path: join(OUT_DIR, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
};

const gotoMock = async (page: Page, subpath = '/') => {
  await page.goto(`/mock${subpath}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
};

test.describe.configure({ mode: 'serial' });

test('pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const [name, path] of [
    ['01-guide',    '/'],
    ['02-rules',    '/rules'],
    ['03-library',  '/library'],
    ['04-reserves', '/reserves'],
    ['05-discover', '/discover'],
    ['06-settings', '/settings'],
  ] as const) {
    await gotoMock(page, path);
    await shot(page, name);
  }
});

test('settings sub-tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMock(page, '/settings');

  // The settings page renders a left rail of tabs. Walk them and screenshot
  // each one. Labels match what the UI ships with.
  const tabs: Array<[string, string]> = [
    ['40-settings-devices',     'デバイス'],
    ['41-settings-recording',   '録画・エンコード'],
    ['42-settings-storage',     'ストレージ'],
    ['43-settings-maintenance', 'メンテナンス'],
  ];
  for (const [name, label] of tabs) {
    const btn = page.getByRole('button', { name: label }).first();
    if (!(await btn.count())) {
      const fallback = page.locator('text=' + label).first();
      if (!(await fallback.count())) continue;
      await fallback.click();
    } else {
      await btn.click();
    }
    await page.waitForTimeout(400);
    await shot(page, name);
  }
});

test('settings: add device modal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMock(page, '/settings');
  // The devices tab is the default. Click the top-right "追加" trigger.
  const add = page.getByRole('button', { name: /追加/ }).first();
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(400);
    await shot(page, '44-settings-add-device');
  }
});

test('settings: device detail modal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMock(page, '/settings');
  // Click the first registered device row to open DeviceDetailModal.
  // Rows are buttons with the friendly name + tuner count.
  const row = page.getByRole('button', { name: /Mirakurun/ }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(400);
    await shot(page, '45-settings-device-detail');
  }
});

test('library detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Deep-link to a series detail. 362256 = 情熱大陸 in the mock catalog,
  // and series-tvdb-free is now stateByCase='ready' so library has it.
  // (Library detail only renders for series, not movies.)
  await gotoMock(page, '/library/362256');
  await shot(page, '07-library-detail');
});

const CASES = [
  'series-tvdb-rec',
  'series-tvdb-free',
  'series-plain-rec',
  'series-plain-free',
  'movie-tvdb-rec',
  'movie-tvdb-free',
  'movie-plain-rec',
  'movie-plain-free',
] as const;

test('reserve modal — 8 demo cases', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMock(page, '/');

  const demoIds = await page.evaluate(() => {
    const w = window as unknown as {
      __epghubMock?: {
        defaultToday: () => string;
        demoProgramIds: (ymd: string) => Record<string, string[]>;
      };
    };
    if (!w.__epghubMock) return null;
    return w.__epghubMock.demoProgramIds(w.__epghubMock.defaultToday());
  });
  expect(demoIds, 'mock hook exposes demo ids').toBeTruthy();

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const ids = demoIds?.[c] ?? [];
    if (!ids.length) {
      console.warn(`demo case ${c} has no program ids, skipping`);
      continue;
    }
    const pid = ids[0];
    await gotoMock(page, `/?modal=${encodeURIComponent(pid)}`);
    // Wait for the modal container to render.
    await page.waitForSelector('[role="dialog"], .reserve-modal, .modal', { timeout: 4_000 }).catch(() => null);
    await page.waitForTimeout(300);
    await shot(page, `10-modal-${String(i + 1).padStart(2, '0')}-${c}`);
  }
});

test('discover → tvdb add-rule modal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMock(page, '/discover');
  const addBtn = page
    .getByRole('button', { name: /追加|add|ルール/ })
    .first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(500);
    await shot(page, '20-discover-add-rule');
    // Close to leave clean state for next test.
    await page.keyboard.press('Escape');
  }
});

test('guide: date picker / search / channel filter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoMock(page, '/');

  // Date picker — look for a button whose name includes a date-ish label
  // or an explicit "日付" keyword; fall back to the first toolbar button.
  const dateBtn = page
    .getByRole('button', { name: /日付|date|カレンダー/i })
    .first();
  if (await dateBtn.count()) {
    await dateBtn.click();
    await page.waitForTimeout(300);
    await shot(page, '30-date-picker');
    await page.keyboard.press('Escape');
  }

  // Search — '/' shortcut opens the SearchPalette overlay.
  await page.keyboard.press('/');
  await page.waitForTimeout(300);
  const searchBox = page
    .locator('input[placeholder*="横断検索"]')
    .first();
  if (await searchBox.count()) {
    await searchBox.fill('NHK');
    await page.waitForTimeout(500);
    await shot(page, '31-search');
    await page.keyboard.press('Escape');
  }

  // Channel filter / sidebar dropdown — try common affordances.
  const filterBtn = page.getByRole('button', { name: /フィルタ|チャンネル|filter|channel/i }).first();
  if (await filterBtn.count()) {
    await filterBtn.click();
    await page.waitForTimeout(300);
    await shot(page, '32-channel-filter');
    await page.keyboard.press('Escape');
  }
});
