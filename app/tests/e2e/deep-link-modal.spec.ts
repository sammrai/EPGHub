import { expect, test } from '@playwright/test';
import { createMockApi, currentBroadcastDay, isoForJst, makeProgram } from './fixtures/api';

// 現在は daysLoaded=2 (本日 + 明日) がデフォルトなので、`+3 日以降` を指定すれ
// ばロード済み schedule から外れる。Deep link で範囲外を叩いたときに
// /api/programs/:id フォールバックで Modal が開くことを保証する。
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

test('/?modal=<programId> の直リンクで Modal が対象番組で開く (同一日)', async ({ page }) => {
  const today = currentBroadcastDay();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '19:00'),
    endAt: isoForJst(today, '19:55'),
    title: 'DEEP-LINK-TARGET',
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  await page.goto(`/?modal=${encodeURIComponent(prog.id)}`);

  await expect(page.getByText('DEEP-LINK-TARGET', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '予約する' })).toBeVisible();
});

test('/?modal=<programId> の直リンクは range 外の番組でも /programs/:id フェッチで開く', async ({ page }) => {
  const today = currentBroadcastDay();
  // 本日 + 14 日 → daysLoaded=7 の初期 schedule range には載らない。
  // 例) http://…/?modal=svc-3211841008_2026-04-25T07%3A00%3A00.000Z のようなケース。
  const farAhead = addDays(today, 14);
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(farAhead, '07:00'),
    endAt: isoForJst(farAhead, '07:55'),
    title: 'FAR-FUTURE-DEEP-LINK',
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  await page.goto(`/?modal=${encodeURIComponent(prog.id)}`);

  // range 外でも /programs/:id フォールバックで解決されて Modal が開くこと
  await expect(page.getByText('FAR-FUTURE-DEEP-LINK', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '予約する' })).toBeVisible();
});

test('deep link 直後の close は URL から modal= を剥がす (history が無くても正しく閉じる)', async ({
  page,
}) => {
  const today = currentBroadcastDay();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '10:00'),
    endAt: isoForJst(today, '10:30'),
    title: 'DEEP-LINK-CLOSE-TARGET',
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  await page.goto(`/?modal=${encodeURIComponent(prog.id)}`);
  await expect(page.getByText('DEEP-LINK-CLOSE-TARGET', { exact: false }).first()).toBeVisible();

  // Escape キーで閉じる (App.tsx の closeModal 経路)
  await page.keyboard.press('Escape');

  await expect(page).not.toHaveURL(/[?&]modal=/);
  // Modal 内の特徴的なボタン (予約する) が消えたこと
  await expect(page.getByRole('button', { name: '予約する' })).toHaveCount(0);
});
