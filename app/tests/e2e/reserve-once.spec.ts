import { expect, test } from '@playwright/test';
import { createMockApi, currentBroadcastDay, isoForJst, makeProgram } from './fixtures/api';

test('Guide のセル押下 → Modal → 予約する で単発予約が作成される', async ({ page }) => {
  const today = currentBroadcastDay();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '20:00'),
    endAt: isoForJst(today, '20:45'),
    title: 'E2E 単発予約対象',
    ep: '#1',
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  await page.goto('/');

  // セルが描画されるまで待つ (data-testid="prog-<programId>")
  const cell = page.getByTestId(`prog-${prog.id}`);
  await expect(cell).toBeVisible();
  await cell.click();

  // Modal が開き、対象番組のタイトルが見える
  const modal = page.getByRole('dialog').or(page.locator('.modal-card'));
  await expect(page.getByText('E2E 単発予約対象', { exact: false }).first()).toBeVisible();

  // GuidePanel の "この回のみ録画" カードをクリックすると即座に
  // POST /api/recordings が走る (確認ステップなし)。
  await page.getByRole('button', { name: 'この回のみ録画' }).click();

  // サーバ側 (mock) で POST /api/recordings が 1 件増えたこと
  await expect.poll(() => mock.state.recordings.length).toBe(1);
  const created = mock.state.recordings[0];
  expect(created.programId).toBe(prog.id);
  expect(created.source).toEqual({ kind: 'once' });
  expect(created.state).toBe('scheduled');

  // UI 反映: セルに reserved クラスが付く (badge 表示の根拠)
  await expect(cell).toHaveClass(/reserved/);
});
