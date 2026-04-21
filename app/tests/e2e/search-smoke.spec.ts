import { expect, test } from '@playwright/test';
import { createMockApi, currentBroadcastDay, isoForJst, makeProgram } from './fixtures/api';

test('search palette: opens, hits API, highlights matches, Enter opens modal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const today = currentBroadcastDay();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '20:00'),
    endAt: isoForJst(today, '20:30'),
    title: 'NHK 大河ドラマ',
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  // Minimal /search stub — first empty (initial open), then a hit on "大河".
  await page.route('**/api/search*', (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    const hit = q.includes('大河');
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        q,
        total: hit ? 1 : 0,
        programs: hit ? [prog] : [],
        series: [],
        channels: [],
        rules: [],
        recordings: [],
      }),
    });
  });

  await page.goto('/');
  await page.locator('.search').first().click();
  await expect(page.locator('.search-palette')).toBeVisible();

  // Open state: hints render, no console error.
  await expect(page.locator('.search-palette-hints')).toBeVisible();

  // Type and verify highlighting + row.
  await page.locator('.search-palette-head input').fill('大河');
  await expect(page.locator('.search-palette-row')).toBeVisible();
  await expect(page.locator('.search-palette-mark').first()).toContainText('大河');

  // Enter commits the first active row — handler navigates to ?modal=<id>.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]modal=/);

  expect(errors, errors.join('\n---\n')).toHaveLength(0);
});

test('search palette: IME 変換中 Enter で確定しない', async ({ page }) => {
  const mock = createMockApi({ programs: [] });
  await mock.install(page);
  // The search query does not matter for this test — Enter should do nothing.
  await page.route('**/api/search*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        q: '',
        total: 0,
        programs: [],
        series: [],
        channels: [],
        rules: [],
        recordings: [],
      }),
    })
  );

  await page.goto('/');
  await page.locator('.search').first().click();
  const input = page.locator('.search-palette-head input');
  await input.fill('ど');

  // IME 変換確定前を模擬。`isComposing` を true にした KeyboardEvent を
  // dispatch すると、onKeyDown ハンドラの composing 分岐で早期 return し、
  // URL は書き換わらないはず。
  const stopped = await input.evaluate((el) => {
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    return el.dispatchEvent(ev);
  });

  // Dispatch 自体は成功。URL も変わっていない (候補選択扱いで commit されない)。
  expect(stopped).toBe(true);
  await expect(page).not.toHaveURL(/[?&]modal=/);
  await expect(page.locator('.search-palette')).toBeVisible();
});
