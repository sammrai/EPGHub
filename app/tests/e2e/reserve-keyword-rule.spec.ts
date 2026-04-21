import { expect, test } from '@playwright/test';
import { createMockApi, currentBroadcastDay, isoForJst, makeProgram } from './fixtures/api';

test('TVDB 紐付け無しの番組 → 自動予約ルール → ルール作成 でキーワードルールが登録される', async ({ page }) => {
  const today = currentBroadcastDay();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '21:00'),
    endAt: isoForJst(today, '21:55'),
    title: 'E2E キーワードルール検証番組',
    tvdb: null,
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  await page.goto('/');

  const cell = page.getByTestId(`prog-${prog.id}`);
  await cell.click();

  // "自動予約ルール" モードカードを選択 (TVDB 紐付け無しのときのみ出る)
  await page.getByRole('button', { name: /自動予約ルール/ }).click();

  // "ルール作成" ボタン
  await page.getByRole('button', { name: /ルール作成/ }).click();

  await expect.poll(() => mock.state.rules.length).toBe(1);
  const rule = mock.state.rules[0];
  expect(rule.kind).toBe('keyword');
  // App.tsx の onCreateRule: program.title.slice(0, 14) をキーワードに使う
  expect(rule.keyword).toBe(prog.title.slice(0, 14));
  expect(rule.channels).toEqual([prog.ch]);
});
