import { expect, test } from '@playwright/test';
import { createMockApi, currentBroadcastDay, isoForJst, makeProgram } from './fixtures/api';

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

test('日付ナビ: 明日ボタンで ?date が翌日になり、翌日の番組が描画される', async ({ page }) => {
  const today = currentBroadcastDay();
  const tomorrow = addDays(today, 1);

  const todayProg = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '20:00'),
    endAt: isoForJst(today, '20:30'),
    title: 'TODAY-SHOW',
  });
  const tomorrowProg = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(tomorrow, '20:00'),
    endAt: isoForJst(tomorrow, '20:30'),
    title: 'TOMORROW-SHOW',
  });
  const mock = createMockApi({ programs: [todayProg, tomorrowProg] });
  await mock.install(page);

  await page.goto('/');

  // 初期状態: today の番組が見える
  await expect(page.getByTestId(`prog-${todayProg.id}`)).toBeVisible();

  // "明日" ボタン (Subheader の title 属性で識別)
  await page.getByTitle('明日', { exact: true }).click();

  // URL 更新
  await expect(page).toHaveURL(new RegExp(`[?&]date=${tomorrow}(?:&|$)`));

  // 翌日の番組が描画される
  await expect(page.getByTestId(`prog-${tomorrowProg.id}`)).toBeVisible();
});
