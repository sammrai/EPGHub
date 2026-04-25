import { expect, test } from '@playwright/test';
import {
  createMockApi,
  currentBroadcastDay,
  isoForJst,
  makeProgram,
  tvdbSeries,
} from './fixtures/api';

test('Discover のランキング quote 押下 → /discover 上で Modal が開く (path は変わらない)', async ({
  page,
}) => {
  const today = currentBroadcastDay();
  const series = tvdbSeries({ id: 501, title: 'ディスカバーTest作品', slug: 'dtw' });
  const prog = makeProgram({
    ch: 'nhk-g',
    startAt: isoForJst(today, '23:00'),
    endAt: isoForJst(today, '23:30'),
    title: 'ディスカバー紹介番組',
    tvdb: series,
  });

  const mock = createMockApi({
    programs: [prog],
    rankings: [
      {
        rank: 1,
        title: series.title,
        channelName: 'NHK総合',
        delta: 2,
        quote: '注目の第1話',
        nextProgramId: prog.id,
        tvdb: series,
        syncedAt: new Date().toISOString(),
      },
    ],
  });
  await mock.install(page);

  await page.goto('/discover');

  const quoteBtn = page.getByRole('button', { name: /注目の第1話/ });
  await expect(quoteBtn).toBeVisible();
  await quoteBtn.click();

  // path は /discover のまま。modal= が query に追加されるだけ。
  await expect(page).toHaveURL(/\/discover\?/);
  await expect(page).toHaveURL(
    new RegExp(`[?&]modal=${encodeURIComponent(prog.id).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`),
  );

  // Modal が開いていることを特徴的なボタンで検証 (TVDB シリーズの Modal は
  // ヒーローに series.title を出すため、program.title を直接は assert しない)。
  await expect(page.getByRole('button', { name: 'この回のみ録画' })).toBeVisible();
  await expect(page.getByText(series.title, { exact: false }).first()).toBeVisible();
});
