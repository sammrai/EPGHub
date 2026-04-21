import { expect, test } from '@playwright/test';
import {
  createMockApi,
  currentBroadcastDay,
  isoForJst,
  makeProgram,
  tvdbSeries,
} from './fixtures/api';

test('TVDB シリーズ紐付け済み番組 → シリーズ登録 でルールが作成される', async ({ page }) => {
  const today = currentBroadcastDay();
  const series = tvdbSeries();
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '20:00'),
    endAt: isoForJst(today, '20:45'),
    title: '風の群像 第16回',
    series: 'kaze-no-gunzo',
    tvdb: series,
  });
  const mock = createMockApi({ programs: [prog] });
  await mock.install(page);

  await page.goto('/');

  const cell = page.getByTestId(`prog-${prog.id}`);
  await cell.click();

  // "シリーズを追加" カードを選択
  await page.getByRole('button', { name: /シリーズを追加/ }).click();

  // "シリーズ登録" ボタンが出るので押す
  await page.getByRole('button', { name: /シリーズ登録/ }).click();

  // ルールが作成されたこと (kind='series', 紐付け TVDB が渡っている)
  await expect.poll(() => mock.state.rules.length).toBe(1);
  const rule = mock.state.rules[0];
  expect(rule.kind).toBe('series');
  expect(rule.tvdb?.id).toBe(series.id);
  expect(rule.name).toBe(series.title);
});
