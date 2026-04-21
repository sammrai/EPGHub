// JST 放送日まわりの純粋ヘルパ。App.tsx から抽出 — カレンダー日付と放送日の
// 境界 (05:00 JST) を扱う箇所は多いので単体テストできる単位に切り出している。

// 今の「放送日」(JST 05:00 境界) を YYYY-MM-DD で返す。
//   例) 2026-04-19 02:00 JST → 放送日 2026-04-18 (まだ前放送日の 26時)
//       2026-04-19 05:00 JST → 放送日 2026-04-19
// 深夜帯でもその時点で放送中の番組が載っている方の日付を初期選択する。
// これで 02:00 JST に開いても now-line が前放送日の 26時位置で可視化される。
export function jstTodayYmd(now: Date = new Date()): string {
  const d = new Date(now.getTime() + (9 - 5) * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Add n days to a YYYY-MM-DD (treated as JST calendar day). Used so the
// grid can fetch base-day + base-day+1 and render continuous scroll past
// 29時 into the next broadcast day.
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
