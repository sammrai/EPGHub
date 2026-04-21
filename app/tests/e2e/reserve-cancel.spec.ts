import { expect, test } from '@playwright/test';
import { createMockApi, currentBroadcastDay, isoForJst, makeProgram } from './fixtures/api';

test('Reserves から予約取消 → Guide のセルから reserved バッジが消える', async ({ page }) => {
  const today = currentBroadcastDay();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '22:00'),
    endAt: isoForJst(today, '22:55'),
    title: 'E2E 取消対象',
  });
  const mock = createMockApi({ programs: [prog] });
  mock.seedRecording({ programId: prog.id, state: 'scheduled' });

  await mock.install(page);

  await page.goto('/reserves');

  // Reserves 行に対象番組が表示されていること
  const reserveRow = page.getByText('E2E 取消対象', { exact: false }).first();
  await expect(reserveRow).toBeVisible();

  // 行の "取消" ボタンを押す。DOM 上 action ボタンはそれぞれの行にある。
  await page.getByRole('button', { name: '取消' }).first().click();

  // サーバ側 recordings が空になる
  await expect.poll(() => mock.state.recordings.length).toBe(0);

  // Guide に戻ってセルを検証
  await page.goto('/');
  const cell = page.getByTestId(`prog-${prog.id}`);
  await expect(cell).toBeVisible();
  await expect(cell).not.toHaveClass(/reserved/);
});
