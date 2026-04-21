// Sample responses for the GitHub Pages mock deploy. The types are loose
// on purpose — the goal is "render something convincing", not strict
// conformance to every optional field. We cast through `unknown` at the
// exports so consumers still see the correct ApiXxx type.
import type {
  ApiChannel,
  ApiNowRecording,
  ApiProgram,
  ApiRankingList,
  ApiRecording,
  ApiRule,
  ApiSearchResult,
  ApiSystemStatus,
  ApiTunerState,
  ApiTvdbEntry,
} from '../api/epghub';

const GENRES: Record<string, { key: string; label: string; dot: string }> = {
  news:  { key: 'news',  label: 'ニュース',     dot: 'oklch(0.65 0.12 40)' },
  drama: { key: 'drama', label: 'ドラマ',       dot: 'oklch(0.6 0.15 10)' },
  doc:   { key: 'doc',   label: 'ドキュメンタリー', dot: 'oklch(0.6 0.1 140)' },
  anime: { key: 'anime', label: 'アニメ',       dot: 'oklch(0.65 0.14 300)' },
  var:   { key: 'var',   label: 'バラエティ',   dot: 'oklch(0.65 0.13 90)' },
  edu:   { key: 'edu',   label: '教育',         dot: 'oklch(0.6 0.1 200)' },
  movie: { key: 'movie', label: '映画',         dot: 'oklch(0.55 0.12 330)' },
  other: { key: 'other', label: 'その他',       dot: 'oklch(0.55 0.02 260)' },
};

export const CHANNELS = [
  { id: 'nhk-g',  name: 'NHK総合',    short: 'NHK G', number: '011', type: 'GR', color: 'oklch(0.55 0.12 28)' },
  { id: 'nhk-e',  name: 'NHK Eテレ',  short: 'Eテレ', number: '021', type: 'GR', color: 'oklch(0.58 0.10 140)' },
  { id: 'ntv',    name: '日テレ',     short: '日テレ', number: '041', type: 'GR', color: 'oklch(0.58 0.12 30)' },
  { id: 'ex',     name: 'テレビ朝日', short: 'EX',    number: '051', type: 'GR', color: 'oklch(0.58 0.12 250)' },
  { id: 'tbs',    name: 'TBS',       short: 'TBS',   number: '061', type: 'GR', color: 'oklch(0.55 0.10 260)' },
  { id: 'tx',     name: 'テレビ東京', short: 'TX',    number: '071', type: 'GR', color: 'oklch(0.60 0.12 150)' },
  { id: 'cx',     name: 'フジテレビ', short: 'CX',    number: '081', type: 'GR', color: 'oklch(0.58 0.10 280)' },
  { id: 'mx',     name: 'TOKYO MX',  short: 'MX',    number: '091', type: 'GR', color: 'oklch(0.60 0.10 200)' },
  { id: 'bs1',    name: 'NHK BS',    short: 'BS',    number: '101', type: 'BS', color: 'oklch(0.55 0.08 220)' },
  { id: 'bsp',    name: 'NHK BSP4K', short: 'BSP',   number: '103', type: 'BS', color: 'oklch(0.55 0.08 300)' },
  { id: 'bs-ntv', name: 'BS日テレ',  short: 'BS日テレ', number: '141', type: 'BS', color: 'oklch(0.55 0.08 30)' },
  { id: 'bs-tbs', name: 'BS-TBS',   short: 'BS-TBS', number: '161', type: 'BS', color: 'oklch(0.55 0.08 260)' },
] as unknown as ApiChannel[];

// Broadcast-day anchor (JST 05:00 of the given date).
function jstBroadcastStart(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, -4, 0, 0));
}

function todayJstYmd(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (jst.getUTCHours() < 5) jst.setUTCDate(jst.getUTCDate() - 1);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Per-channel sequential programs. Durations sum to 24 × 60 = 1440 so each
// channel covers the full broadcast day (no gaps on the grid). Written in
// broadcast-day order starting from JST 05:00.
//
// The `demo` marker opts a slot into the 2×2×2 sample matrix the UI needs:
//   {movie | series} × {tvdb-linked | plain} × {being-recorded | free}
// — exactly one slot per combination, so screenshots always have coverage.
type DemoCase =
  | 'series-tvdb-rec'   | 'series-tvdb-free'
  | 'series-plain-rec'  | 'series-plain-free'
  | 'movie-tvdb-rec'    | 'movie-tvdb-free'
  | 'movie-plain-rec'   | 'movie-plain-free';

interface Slot {
  dur: number;
  title: string;
  genre: keyof typeof GENRES;
  series?: string;
  ep?: string;
  desc?: string;
  demo?: DemoCase;
  // Only used by demo='*-tvdb-*' slots. Refers to TVDB_CATALOG_RAW.id.
  tvdbId?: number;
}

const DAY_MIN = 24 * 60;

const SCHEDULE: Record<string, Slot[]> = {
  'nhk-g': [
    { dur: 25, title: '映像散歩 里山の春',        genre: 'doc'  },
    { dur: 30, title: 'NHK ニュースおはよう日本 早朝', genre: 'news', series: 'ohayou-nippon', ep: '#9399', tvdbId: 269764 },
    { dur: 90, title: 'NHK ニュース おはよう日本',    genre: 'news', series: 'ohayou-nippon', ep: '#9400', tvdbId: 269764 },
    { dur: 15, title: '連続テレビ小説 みらい色',     genre: 'drama', series: 'asadora-miraiiro', ep: '#58', tvdbId: 270774 },
    { dur: 30, title: 'あさイチ オープニング',       genre: 'var',  series: 'asaichi', ep: '#3399', tvdbId: 269764 },
    { dur: 60, title: 'あさイチ',                  genre: 'var',  series: 'asaichi', ep: '#3400', tvdbId: 269764 },
    { dur: 30, title: 'ごごナマ',                  genre: 'var'  },
    { dur: 180, title: '国会中継',                 genre: 'other', desc: '予算委員会 午後の部。' },
    { dur: 30, title: 'NHK ニュース7',              genre: 'news', series: 'nhk-news-7', ep: '#12000', tvdbId: 253195 },
    { dur: 30, title: 'クローズアップ現代',          genre: 'doc',  series: 'closeup-gendai', ep: '#3400', tvdbId: 253195 },
    { dur: 60, title: 'ダーウィンが来た！',          genre: 'doc',   series: 'darwin', ep: '#824', desc: '深海の巨大イカに迫る。', demo: 'series-tvdb-rec', tvdbId: 339051 },
    { dur: 30, title: 'ガッテン！',                 genre: 'var'  },
    { dur: 55, title: 'NHK スペシャル',              genre: 'doc',   series: 'nhk-special', ep: '#1082', desc: '巨大地震 最新研究。', demo: 'series-tvdb-rec', tvdbId: 419548 },
    { dur: 15, title: 'ニュースウオッチ9',            genre: 'news', series: 'news-watch-9', ep: '#4800', tvdbId: 419548 },
    { dur: 30, title: 'きょうの料理',               genre: 'edu'  },
    { dur: 30, title: '鶴瓶の家族に乾杯',            genre: 'var',   series: 'tsurube', ep: '#986', tvdbId: 464275 },
    { dur: 30, title: 'ドキュメント72時間',          genre: 'doc',   series: 'doc72h', ep: '#620', desc: '深夜のコンビニ。', tvdbId: 339051 },
    { dur: 30, title: 'NHK ニュース845',             genre: 'news' },
    { dur: 60, title: '映像の世紀 バタフライエフェクト', genre: 'doc',  series: 'eizou-seiki', ep: '#64', tvdbId: 419548 },
    { dur: 30, title: '明日のニュース',              genre: 'news' },
    { dur: 60, title: '時論公論',                  genre: 'news' },
    { dur: 90, title: '深夜便 — ラジオ連動',         genre: 'other', desc: '静かな朝。' },
  ],
  'nhk-e': [
    { dur: 15, title: '0655',                     genre: 'var'  },
    { dur: 30, title: 'シャキーン！',               genre: 'var'  },
    { dur: 30, title: 'いないいないばあっ！',         genre: 'edu'  },
    { dur: 30, title: 'おかあさんといっしょ',         genre: 'edu'  },
    { dur: 30, title: 'みいつけた！',               genre: 'edu'  },
    { dur: 30, title: 'えいごであそぼ',              genre: 'edu'  },
    { dur: 60, title: 'みんなのうた/うたコン再放送',   genre: 'var'  },
    { dur: 45, title: '高校講座 日本史',             genre: 'edu'  },
    { dur: 15, title: '高校講座 数学',               genre: 'edu'  },
    { dur: 90, title: '国会中継 (教育)',             genre: 'other' },
    { dur: 30, title: '趣味の園芸',                  genre: 'edu',  series: 'shumi-engei', ep: '#2800', tvdbId: 270774 },
    { dur: 30, title: '将棋フォーカス',              genre: 'var'  },
    { dur: 90, title: 'こどもアニメ劇場',            genre: 'anime' },
    { dur: 30, title: 'サイエンスZERO',              genre: 'doc',   series: 'science-zero', ep: '#780', tvdbId: 324749 },
    { dur: 60, title: 'クラシック音楽館',             genre: 'other', series: 'classic-hall', ep: '#320', desc: 'N響定期演奏会。', tvdbId: 317970 },
    { dur: 30, title: '100分 de 名著',               genre: 'edu',   series: '100de-meicho', ep: '#600', tvdbId: 284314 },
    { dur: 30, title: '先人たちの底力 知恵泉',        genre: 'edu'  },
    { dur: 30, title: 'ETV特集',                    genre: 'doc'  },
    { dur: 30, title: 'バリバラ',                   genre: 'var'  },
    { dur: 30, title: '趣味どきっ！',                genre: 'edu'  },
    { dur: 30, title: 'すくすく子育て',              genre: 'edu'  },
    { dur: 60, title: 'スイッチインタビュー',         genre: 'var'  },
    { dur: 30, title: '100de名著 再放送',             genre: 'edu'  },
    { dur: 60, title: '深夜の教育放送 休止',          genre: 'other' },
    { dur: 30, title: 'NHKプレマップ',              genre: 'other' },
    { dur: 60, title: '深夜のクラシック',             genre: 'other' },
  ],
  ntv: [
    { dur: 30, title: 'Oha!4 NEWS LIVE',           genre: 'news' },
    { dur: 120, title: 'ZIP！',                    genre: 'news', series: 'zip', ep: '#3500', tvdbId: 384681 },
    { dur: 90, title: 'スッキリ',                   genre: 'var'  },
    { dur: 60, title: 'DAY DAY.',                  genre: 'var'  },
    { dur: 30, title: 'ヒルナンデス！前半',           genre: 'var',  series: 'hirunandesu', ep: '#3199', tvdbId: 384681 },
    { dur: 60, title: 'ヒルナンデス！後半',           genre: 'var',  series: 'hirunandesu', ep: '#3200', tvdbId: 384681 },
    { dur: 60, title: '昼の情報 リラックス',          genre: 'var'  },
    { dur: 60, title: 'ミヤネ屋',                  genre: 'news' },
    { dur: 60, title: 'news every.',               genre: 'news' },
    { dur: 60, title: 'ニュースZERO プレ',            genre: 'news' },
    { dur: 60, title: '世界の果てまでイッテQ!',       genre: 'var',   series: 'itteq', ep: '#612', demo: 'series-tvdb-rec', tvdbId: 273667 },
    { dur: 60, title: '行列のできる相談所',           genre: 'var'  },
    { dur: 30, title: 'NEWS ZERO',                 genre: 'news' },
    { dur: 60, title: 'ヒューマングルメンタリー',       genre: 'var'  },
    { dur: 60, title: '金曜ロードショー ナイル殺人事件', genre: 'movie', desc: '名探偵ポアロ最新作。', demo: 'movie-tvdb-rec', tvdbId: 2649 },
    { dur: 30, title: '有吉反省会',                 genre: 'var'  },
    { dur: 30, title: '深夜バラエティ',              genre: 'var'  },
    { dur: 60, title: '潜入！リアルスコープ',         genre: 'doc'  },
    { dur: 60, title: '朝までリラックス',             genre: 'other' },
    { dur: 180, title: '深夜の再放送ゾーン',          genre: 'other' },
  ],
  ex: [
    { dur: 90, title: 'グッド！モーニング 早朝',       genre: 'news' },
    { dur: 90, title: 'グッド！モーニング',           genre: 'news' },
    { dur: 120, title: 'モーニングショー',           genre: 'news' },
    { dur: 60, title: 'ワイド！スクランブル',         genre: 'news' },
    { dur: 60, title: '徹子の部屋',                 genre: 'var'  },
    { dur: 60, title: '午後のロードショー',           genre: 'movie', demo: 'movie-plain-rec' },
    { dur: 60, title: 'スーパーJチャンネル',         genre: 'news' },
    { dur: 30, title: 'Abema×EX コラボ',             genre: 'var'  },
    { dur: 60, title: '報道ステーション プレ',        genre: 'news' },
    { dur: 60, title: '報道ステーション',            genre: 'news', series: 'hodo-station', ep: '#4600', tvdbId: 253195 },
    { dur: 60, title: '金曜ナイトドラマ',             genre: 'drama', series: 'kinyou-drama', ep: '#8', tvdbId: 249250 },
    { dur: 60, title: '相棒 再放送',                 genre: 'drama', series: 'aibou', ep: '#24', desc: '杉下右京が新たな謎に挑む。', demo: 'series-tvdb-rec', tvdbId: 188501 },
    { dur: 30, title: 'お願い！ランキング',           genre: 'var'  },
    { dur: 30, title: 'タモリ倶楽部',                genre: 'var'  },
    { dur: 60, title: '玉川通信',                   genre: 'news' },
    { dur: 60, title: '深夜シネマ',                  genre: 'movie', demo: 'movie-plain-rec' },
    { dur: 90, title: 'ANN ニュース / リプレイ',      genre: 'news' },
    { dur: 120, title: '朝の再放送ゾーン',            genre: 'other' },
  ],
  tbs: [
    { dur: 60, title: 'あさチャン！前半',             genre: 'news' },
    { dur: 60, title: 'THE TIME,',                 genre: 'news' },
    { dur: 120, title: 'ラヴィット！',               genre: 'var'  },
    { dur: 90, title: 'ひるおび！',                  genre: 'news' },
    { dur: 60, title: '鑑定団 再放送',               genre: 'var'  },
    { dur: 60, title: 'Nスタ 夕方',                  genre: 'news' },
    { dur: 60, title: 'Nスタ メイン',                genre: 'news' },
    { dur: 60, title: 'プレバト！！',                genre: 'var', series: 'prebat', ep: '#412', demo: 'series-tvdb-rec', tvdbId: 338042 },
    { dur: 120, title: '金曜ドラマ 静寂の向こう',     genre: 'drama', series: 'nichigeki-2026q2', ep: '#6', desc: '急転の第6話。', demo: 'series-tvdb-rec', tvdbId: 418527 },
    { dur: 60, title: '中居正広の金スマ',            genre: 'var'  },
    { dur: 30, title: 'NEWS23',                    genre: 'news' },
    { dur: 60, title: 'A-Studio+',                  genre: 'var'  },
    { dur: 30, title: '情熱大陸',                   genre: 'doc',   series: 'jonetsu', ep: '#1240', desc: '今夜の主人公は若き建築家。', demo: 'series-tvdb-free', tvdbId: 362256 },
    { dur: 60, title: 'マツコの知らない世界 再放送',   genre: 'var',   series: 'matsuko-shiranai', ep: '#372', tvdbId: 357827 },
    { dur: 60, title: '深夜ドラマ',                  genre: 'drama', series: 'deep-night-drama', demo: 'series-plain-free' },
    { dur: 90, title: 'JNN フラッシュニュース',       genre: 'news' },
    { dur: 120, title: '朝の再放送',                 genre: 'other' },
  ],
  tx: [
    { dur: 180, title: 'モーニングサテライト',        genre: 'news' },
    { dur: 60, title: 'シナぷしゅ',                  genre: 'edu'  },
    { dur: 60, title: 'よじごじDays',                genre: 'var'  },
    { dur: 60, title: 'L4YOU!',                    genre: 'var'  },
    { dur: 60, title: 'ワールドビジネスサテライト プレ', genre: 'news' },
    { dur: 60, title: 'WBS ワールドビジネスサテライト', genre: 'news', series: 'wbs', ep: '#8200', tvdbId: 362147 },
    { dur: 60, title: 'アド街ック天国',              genre: 'var',  series: 'adomachi', ep: '#1460', tvdbId: 369652 },
    { dur: 60, title: 'たけしのTVタックル',           genre: 'var'  },
    { dur: 60, title: '太川・蛭子の路線バスの旅',       genre: 'var'  },
    { dur: 60, title: 'カンブリア宮殿',              genre: 'doc',   series: 'cambria', ep: '#766', tvdbId: 362102 },
    { dur: 60, title: 'ガイアの夜明け',              genre: 'doc',   series: 'gaia', ep: '#1120', tvdbId: 362147 },
    { dur: 30, title: 'ポツンと一軒家',              genre: 'var',   series: 'potsun' },
    { dur: 60, title: '日経プラス10',                genre: 'news' },
    { dur: 30, title: '開運！なんでも鑑定団',         genre: 'var'  },
    { dur: 60, title: 'ポケットモンスター (テレ東)',  genre: 'anime', series: 'pokemon', ep: '#1288', tvdbId: 76703 },
    { dur: 60, title: '深夜のBSテレ東クロス',         genre: 'other' },
    { dur: 90, title: '特撮シネマ ゴジラ vs モスラ',  genre: 'movie', demo: 'movie-tvdb-rec', tvdbId: 45 },
    { dur: 120, title: '朝まで再放送',                genre: 'other' },
  ],
  cx: [
    { dur: 150, title: 'めざましテレビ',             genre: 'news' },
    { dur: 60, title: 'とくダネ！',                  genre: 'news' },
    { dur: 90, title: 'ノンストップ！',               genre: 'var'  },
    { dur: 90, title: 'バイキングMORE',              genre: 'var'  },
    { dur: 60, title: 'Live News it!',              genre: 'news' },
    { dur: 60, title: 'みんなのニュース',             genre: 'news' },
    { dur: 60, title: '金曜プレミアム 劇場版アニメ特集', genre: 'movie', series: 'kinyou-cinema', desc: '劇場版アニメ特集。', demo: 'movie-tvdb-rec', tvdbId: 73 },
    { dur: 60, title: 'VS 嵐 リマスター',            genre: 'var'  },
    { dur: 60, title: 'ネプリーグ',                  genre: 'var'  },
    { dur: 60, title: '世にも奇妙な物語',             genre: 'drama', series: 'yonimo-kimyo', ep: '#340', demo: 'series-tvdb-free', tvdbId: 391636 },
    { dur: 30, title: 'Mr.サンデー',                 genre: 'news' },
    { dur: 60, title: '深夜アニメ (フジ)',            genre: 'anime' },
    { dur: 30, title: 'フジ深夜バラエティ',           genre: 'var'  },
    { dur: 60, title: '通販番組',                   genre: 'other' },
    { dur: 120, title: '朝の再放送',                 genre: 'other' },
    { dur: 30, title: 'めざまし早朝',                 genre: 'news' },
    { dur: 30, title: 'リラックスモーニング',         genre: 'other' },
  ],
  mx: [
    { dur: 60, title: 'おはよう！アニメ',             genre: 'anime' },
    { dur: 60, title: '朝のアニメリピート',           genre: 'anime' },
    { dur: 60, title: '東京マーケットワイド',         genre: 'news' },
    { dur: 60, title: '5時に夢中！',                 genre: 'var'  },
    { dur: 30, title: 'TOKYO MX NEWS',              genre: 'news' },
    { dur: 60, title: 'バラいろダンディ',            genre: 'var'  },
    { dur: 30, title: 'アニメ (再)',                  genre: 'anime' },
    { dur: 30, title: 'アニメイズム',                 genre: 'anime', series: 'euph-2026', ep: '#8', demo: 'series-tvdb-free', tvdbId: 352408 },
    { dur: 30, title: 'ソードアートロード',           genre: 'anime', series: 'kaiju8', ep: '#10' },
    { dur: 30, title: '新作アニメ枠',                 genre: 'anime', series: 'precure', ep: '#12' },
    { dur: 30, title: 'アニメ (後半)',                 genre: 'anime', series: 'tonari-totoro' },
    { dur: 30, title: 'アニメ (深夜)',                genre: 'anime' },
    { dur: 60, title: 'TOKYO応援宣言',               genre: 'var'  },
    { dur: 60, title: '東京マーケット サマリ',        genre: 'news' },
    { dur: 60, title: 'ファッション通販',             genre: 'other' },
    { dur: 90, title: 'アニメ再放送ループ',           genre: 'anime' },
    { dur: 30, title: 'TOKYO MX PRESS',              genre: 'news' },
    { dur: 180, title: '通販 / リラックス',           genre: 'other' },
  ],
  bs1: [
    { dur: 60, title: 'BS1 ワールドニュース',         genre: 'news' },
    { dur: 60, title: 'キャッチ！世界のトップニュース',  genre: 'news' },
    { dur: 120, title: 'MLB 中継',                   genre: 'other', series: 'mlb', ep: '#1080', desc: 'ヤンキース vs レッドソックス。', tvdbId: 319801 },
    { dur: 60, title: '国際報道 2026',                genre: 'news' },
    { dur: 60, title: 'ダーウィンが来た！ 再放送',     genre: 'doc', series: 'darwin', ep: '#823', demo: 'series-tvdb-free', tvdbId: 339051 },
    { dur: 60, title: 'ワールドスポーツMLB',          genre: 'other' },
    { dur: 60, title: '世界で一番美しい瞬間',         genre: 'doc'  },
    { dur: 90, title: '地球 ドローン紀行',             genre: 'doc'  },
    { dur: 60, title: 'アナザーストーリーズ',         genre: 'doc'  },
    { dur: 60, title: 'COOL JAPAN',                  genre: 'var'  },
    { dur: 90, title: 'BS1 ワールドニュース (深夜)',    genre: 'news' },
    { dur: 120, title: '欧州サッカー ダイジェスト',     genre: 'other' },
    { dur: 180, title: '朝までリピート',              genre: 'other' },
    { dur: 60, title: 'おはよう日本 BS',               genre: 'news' },
    { dur: 60, title: 'BS1 天気と交通',                genre: 'news' },
  ],
  bsp: [
    { dur: 30, title: '美の壺 再放送',               genre: 'edu'  },
    { dur: 60, title: '新日本風土記',                 genre: 'doc'  },
    { dur: 90, title: 'BSP シネマ 劇場版アニメ再放送', genre: 'movie', demo: 'movie-tvdb-free', tvdbId: 73 },
    { dur: 60, title: 'NHKスペシャル 再放送',          genre: 'doc', series: 'nhk-special', ep: '#1081', demo: 'series-tvdb-free', tvdbId: 419548 },
    { dur: 60, title: '世界ふれあい街歩き',            genre: 'doc'  },
    { dur: 120, title: 'プレミアムシネマ 名探偵ポアロ', genre: 'movie', series: 'bsp-cinema', demo: 'movie-tvdb-free', tvdbId: 2649 },
    { dur: 60, title: '舞台劇場',                    genre: 'other' },
    { dur: 60, title: '名曲アルバム',                 genre: 'other' },
    { dur: 60, title: 'ドキュランドへようこそ',         genre: 'doc'  },
    { dur: 60, title: 'にっぽん縦断 こころ旅',         genre: 'doc'  },
    { dur: 90, title: '名作ドラマアンコール',         genre: 'drama' },
    { dur: 90, title: '深夜の名画座',                 genre: 'movie', demo: 'movie-plain-free' },
    { dur: 120, title: '朝までリピート',              genre: 'other' },
    { dur: 60, title: '早朝のオーケストラ',           genre: 'other' },
    { dur: 60, title: '美の壺',                      genre: 'edu'  },
  ],
  'bs-ntv': [
    { dur: 60, title: 'BS日テレ 朝ニュース',          genre: 'news' },
    { dur: 120, title: 'ぶらぶらサタデー再放送',      genre: 'var'  },
    { dur: 60, title: 'サンデーラグビー',             genre: 'other' },
    { dur: 60, title: 'ぶらり途中下車の旅',           genre: 'var'  },
    { dur: 60, title: '奥の細道',                    genre: 'doc'  },
    { dur: 90, title: '深層ニュース',                 genre: 'news' },
    { dur: 60, title: '時代劇アワー',                 genre: 'drama', series: 'jidai-geki-hour', ep: '#24', demo: 'series-plain-rec' },
    { dur: 90, title: 'BS日テレシネマ',              genre: 'movie', demo: 'movie-plain-free' },
    { dur: 60, title: '人生の楽園',                   genre: 'var'  },
    { dur: 60, title: 'ぶらり旅 (再)',                 genre: 'var'  },
    { dur: 120, title: '深夜のアニメ枠',              genre: 'anime' },
    { dur: 120, title: '朝までリピート',              genre: 'other' },
    { dur: 60, title: '通販タイム',                   genre: 'other' },
    { dur: 60, title: '早朝のNY株式ニュース',         genre: 'news' },
    { dur: 60, title: 'モーニングジョイ',             genre: 'var'  },
  ],
  'bs-tbs': [
    { dur: 60, title: 'BS-TBS朝ニュース',             genre: 'news' },
    { dur: 60, title: '暮らしのおしゃべり',           genre: 'var'  },
    { dur: 120, title: 'サスペンス劇場',              genre: 'drama', series: 'suspense-gekijo', ep: '#118', demo: 'series-plain-free' },
    { dur: 90, title: '歴史への招待状',               genre: 'doc'  },
    { dur: 60, title: '関口宏の一番新しい近現代史',     genre: 'doc'  },
    { dur: 60, title: 'サンデーニュース',             genre: 'news' },
    { dur: 60, title: 'BS-TBS 夕焼け劇場',            genre: 'drama', series: 'yuuyake-gekijo', ep: '#42', demo: 'series-plain-rec' },
    { dur: 120, title: 'プレミアムシネマ',            genre: 'movie' },
    { dur: 60, title: 'Newsザタイム',                genre: 'news' },
    { dur: 60, title: 'アニソン倶楽部',              genre: 'var'  },
    { dur: 60, title: '昭和歌謡ベスト',                genre: 'var'  },
    { dur: 90, title: '深夜の名作劇場 名もなき映画',  genre: 'movie', demo: 'movie-plain-free' },
    { dur: 120, title: '早朝リピート',                genre: 'other' },
    { dur: 60, title: 'テレショップ',                 genre: 'other' },
    { dur: 60, title: 'モーニングBS',                 genre: 'news' },
  ],
};

// TVDB fixture catalogue. Sourced from the real server Postgres so the
// mock bundle ships actual TVDB artwork URLs instead of empty posters.
// Declared above the schedule expander and ranking helpers to dodge TDZ
// during module load.
const TVDB_CATALOG_RAW = [
  { id: 72454,  slug: 'detective-conan', type: 'series', title: '名探偵コナン', titleEn: 'Detective Conan', network: 'YTV', year: 1996, matchedBy: 'exact', totalSeasons: 33, currentSeason: 33, currentEp: 12, totalEps: 1220, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/5da4995cd30fd.jpg' },
  { id: 76703,  slug: 'pokemon', type: 'series', title: 'ポケットモンスター', titleEn: 'Pokémon', network: 'TV Tokyo', year: 1997, matchedBy: 'exact', totalSeasons: 26, currentSeason: 26, currentEp: 88, totalEps: 1288, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/76703/posters/6985f980c8b38.jpg' },
  { id: 81797,  slug: 'one-piece', type: 'series', title: 'ワンピース', titleEn: 'One Piece', network: 'Fuji TV', year: 1999, matchedBy: 'exact', totalSeasons: 20, currentSeason: 20, currentEp: 28, totalEps: 1100, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/81797/posters/63ab23cde990b.jpg' },
  { id: 165891, slug: 'tamori-bra', type: 'series', title: 'ブラタモリ', titleEn: 'Bura Tamori', network: 'NHK', year: 2009, matchedBy: 'exact', totalSeasons: 8, currentSeason: 8, currentEp: 6, totalEps: 244, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/165891/posters/67ec99047774a.jpg' },
  { id: 188501, slug: 'aibou', type: 'series', title: '相棒', titleEn: 'AIBOU: Detective Duo', network: 'TV Asahi', year: 2002, matchedBy: 'exact', totalSeasons: 24, currentSeason: 24, currentEp: 18, totalEps: 476, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/188501-2.jpg' },
  { id: 204391, slug: 'onihei-hankacho-1989', type: 'series', title: '鬼平犯科帳', titleEn: 'Onihei Hankacho', network: 'Fuji TV', year: 1989, matchedBy: 'exact', totalSeasons: 9, currentSeason: 9, currentEp: 8, totalEps: 150, status: 'ended', poster: 'https://artworks.thetvdb.com/banners/series/204391/posters/5eb1879fee5a7.jpg' },
  { id: 249250, slug: 'iryu-sosa', type: 'series', title: '遺留捜査', titleEn: 'Iryu Sosa', network: 'TV Asahi', year: 2011, matchedBy: 'exact', totalSeasons: 7, currentSeason: 7, currentEp: 9, totalEps: 96, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/249250/posters/62e410ff78ca4.jpg' },
  { id: 253195, slug: 'closeup-gendai', type: 'series', title: 'クローズアップ現代', titleEn: 'Close-Up Gendai', network: 'NHK', year: 1993, matchedBy: 'exact', totalSeasons: 33, currentSeason: 33, currentEp: 40, totalEps: 3400, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/253195/posters/6832a9862b8dc.jpg' },
  { id: 259640, slug: 'sword-art-online', type: 'series', title: 'ソードアート・オンライン', titleEn: 'Sword Art Online', network: 'Tokyo MX', year: 2012, matchedBy: 'exact', totalSeasons: 5, currentSeason: 5, currentEp: 10, totalEps: 96, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/259640-7.jpg' },
  { id: 260548, slug: 'kodoku-no-gurume', type: 'series', title: '孤独のグルメ', titleEn: 'Solitary Gourmet', network: 'TV Tokyo', year: 2012, matchedBy: 'exact', totalSeasons: 11, currentSeason: 11, currentEp: 9, totalEps: 130, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/67134a96b9916.jpg' },
  { id: 266493, slug: 'abarenbo-shogun', type: 'series', title: '暴れん坊将軍', titleEn: 'Abarenbo Shogun', network: 'TV Asahi', year: 1978, matchedBy: 'exact', totalSeasons: 12, currentSeason: 12, currentEp: 20, totalEps: 832, status: 'ended', poster: 'https://artworks.thetvdb.com/banners/v4/series/266493/posters/63f276138b946.jpg' },
  { id: 269764, slug: 'asaichi', type: 'series', title: 'あさイチ', titleEn: 'Asaichi', network: 'NHK', year: 2010, matchedBy: 'exact', totalSeasons: 16, currentSeason: 16, currentEp: 60, totalEps: 3400, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/269764/posters/69ccdb9b648bf.jpg' },
  { id: 270774, slug: 'bi-no-tsubo', type: 'series', title: '美の壺', titleEn: 'The Mark of Beauty', network: 'NHK', year: 2006, matchedBy: 'exact', totalSeasons: 20, currentSeason: 20, currentEp: 8, totalEps: 640, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/270774/posters/68b18d0d96063.jpg' },
  { id: 273667, slug: 'sekai-no-hate-itte-q', type: 'series', title: '世界の果てまでイッテQ!', titleEn: "World's End Q", network: 'Nippon TV', year: 2007, matchedBy: 'exact', totalSeasons: 18, currentSeason: 18, currentEp: 12, totalEps: 574, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/5c69263a47c7d.jpg' },
  { id: 278556, slug: 'ooka-echizen', type: 'series', title: '大岡越前', titleEn: 'Ooka Echizen', network: 'NHK', year: 2013, matchedBy: 'exact', totalSeasons: 7, currentSeason: 7, currentEp: 10, totalEps: 78, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/278556/posters/683f02244a5eb.jpg' },
  { id: 284314, slug: '100-bun-de-meicho', type: 'series', title: '100分de名著', titleEn: '100 Minutes de Meicho', network: 'NHK', year: 2011, matchedBy: 'exact', totalSeasons: 15, currentSeason: 15, currentEp: 4, totalEps: 600, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/284314/posters/6182a7b77e6da.jpg' },
  { id: 286895, slug: 'nintama-rantarou', type: 'series', title: '忍たま乱太郎', titleEn: 'Nintama Rantaro', network: 'NHK', year: 1993, matchedBy: 'exact', totalSeasons: 32, currentSeason: 32, currentEp: 20, totalEps: 2340, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/286895/posters/672caa37ec50e.jpg' },
  { id: 305089, slug: 're-zero-starting-life-in-another-world', type: 'series', title: 'Re：ゼロから始める異世界生活', titleEn: 'Re:Zero − Starting Life in Another World', network: 'AT-X', year: 2016, matchedBy: 'exact', totalSeasons: 3, currentSeason: 3, currentEp: 12, totalEps: 70, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/305089/posters/69cea25cb29e9.jpg' },
  { id: 317970, slug: 'utacon', type: 'series', title: 'うたコン', titleEn: 'Utacon', network: 'NHK', year: 2016, matchedBy: 'exact', totalSeasons: 10, currentSeason: 10, currentEp: 16, totalEps: 420, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/317970/posters/69d4f0f339c10.jpg' },
  { id: 319801, slug: 'getsuyou-kara-yofukashi', type: 'series', title: '月曜から夜ふかし', titleEn: 'Getsuyou Kara Yofukashi', network: 'Nippon TV', year: 2017, matchedBy: 'exact', totalSeasons: 9, currentSeason: 9, currentEp: 10, totalEps: 370, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/319801-1.jpg' },
  { id: 324749, slug: 'science-zero', type: 'series', title: 'サイエンスZERO', titleEn: 'Science ZERO', network: 'NHK', year: 2018, matchedBy: 'exact', totalSeasons: 9, currentSeason: 9, currentEp: 8, totalEps: 320, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/324749/posters/693bdb16d8211.jpg' },
  { id: 336149, slug: 'shin-nihon-fudoki', type: 'series', title: '新日本風土記', titleEn: 'Shin Nihon Fudoki', network: 'NHK', year: 2011, matchedBy: 'exact', totalSeasons: 15, currentSeason: 15, currentEp: 10, totalEps: 620, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/5d97f387006f3.jpg' },
  { id: 338042, slug: 'wednesdays-downtown', type: 'series', title: '水曜日のダウンタウン', titleEn: "Wednesday's Downtown", network: 'TBS', year: 2014, matchedBy: 'exact', totalSeasons: 11, currentSeason: 11, currentEp: 10, totalEps: 560, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/338042-1.jpg' },
  { id: 338455, slug: 'golden-kamuy', type: 'series', title: 'ゴールデンカムイ', titleEn: 'Golden Kamuy', network: 'Tokyo MX', year: 2018, matchedBy: 'exact', totalSeasons: 4, currentSeason: 4, currentEp: 12, totalEps: 48, status: 'ended', poster: 'https://artworks.thetvdb.com/banners/posters/338455-1.jpg' },
  { id: 339051, slug: 'document-72-hours', type: 'series', title: 'ドキュメント72時間', titleEn: 'Document 72 Hours', network: 'NHK', year: 2005, matchedBy: 'exact', totalSeasons: 19, currentSeason: 19, currentEp: 10, totalEps: 620, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/339051/posters/6773fab7d7198.jpg' },
  { id: 345989, slug: 'mikaiketsu-no-onna', type: 'series', title: '未解決の女', titleEn: 'Mikaiketsu no Onna', network: 'TV Asahi', year: 2018, matchedBy: 'exact', totalSeasons: 3, currentSeason: 3, currentEp: 8, totalEps: 28, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/345989-2.jpg' },
  { id: 352408, slug: 'that-time-i-got-reincarnated-as-a-slime', type: 'series', title: '転生したらスライムだった件', titleEn: 'That Time I Got Reincarnated as a Slime', network: 'Tokyo MX', year: 2018, matchedBy: 'exact', totalSeasons: 3, currentSeason: 3, currentEp: 18, totalEps: 72, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/352408/posters/60f0789eb4513.jpg' },
  { id: 357827, slug: 'matsuko-sekai', type: 'series', title: 'マツコの知らない世界', titleEn: "The World Matsuko Doesn't Know", network: 'TBS', year: 2011, matchedBy: 'exact', totalSeasons: 14, currentSeason: 14, currentEp: 12, totalEps: 430, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/5d818afd64265.jpg' },
  { id: 359424, slug: 'sazae-san', type: 'series', title: 'サザエさん', titleEn: 'Sazae-san', network: 'Fuji TV', year: 1969, matchedBy: 'exact', totalSeasons: 57, currentSeason: 57, currentEp: 20, totalEps: 2600, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/359424/posters/62eac46d28773.jpg' },
  { id: 362102, slug: 'cambria-kyuden', type: 'series', title: 'カンブリア宮殿', titleEn: 'Cambria Palace', network: 'TV Tokyo', year: 2021, matchedBy: 'exact', totalSeasons: 5, currentSeason: 5, currentEp: 8, totalEps: 200, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/362102/posters/657aeef24eb8f.jpg' },
  { id: 362147, slug: 'gaia-no-yoake', type: 'series', title: 'ガイアの夜明け', titleEn: 'Dawn of Gaia', network: 'TV Tokyo', year: 2002, matchedBy: 'exact', totalSeasons: 23, currentSeason: 23, currentEp: 16, totalEps: 1100, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/362147/posters/68a7c24420515.jpg' },
  { id: 362256, slug: 'jonetsu-tairiku', type: 'series', title: '情熱大陸', titleEn: 'Passion Continent', network: 'MBS', year: 2014, matchedBy: 'exact', totalSeasons: 12, currentSeason: 12, currentEp: 12, totalEps: 560, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/posters/5cad93a9ccdc8.jpg' },
  { id: 369652, slug: 'potsun-to-ikkenya', type: 'series', title: 'ポツンと一軒家', titleEn: 'A House in the Middle of Nowhere', network: 'TV Asahi', year: 2018, matchedBy: 'exact', totalSeasons: 8, currentSeason: 8, currentEp: 16, totalEps: 330, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/369652/posters/63353ccd6c527.jpg' },
  { id: 377483, slug: 'the-nonfiction', type: 'series', title: 'ザ・ノンフィクション', titleEn: 'The Nonfiction', network: 'Fuji TV', year: 2019, matchedBy: 'exact', totalSeasons: 7, currentSeason: 7, currentEp: 16, totalEps: 320, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/series/377483/posters/62088557.jpg' },
  { id: 377779, slug: 'chico-chan', type: 'series', title: 'チコちゃんに叱られる!', titleEn: "Chico Will Scold You!", network: 'NHK', year: 2018, matchedBy: 'exact', totalSeasons: 8, currentSeason: 8, currentEp: 18, totalEps: 290, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/series/377779/posters/6839abe9b2a3e.jpg' },
  { id: 378977, slug: 'sunday-art-museum', type: 'series', title: '日曜美術館', titleEn: 'Sunday Art Museum', network: 'NHK', year: 2020, matchedBy: 'exact', totalSeasons: 6, currentSeason: 6, currentEp: 10, totalEps: 260, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/series/378977/posters/5e7bb0d65f2e5.jpg' },
  { id: 384681, slug: 'hirunandesu', type: 'series', title: 'ヒルナンデス!', titleEn: 'Hirunandesu!', network: 'Nippon TV', year: 2011, matchedBy: 'exact', totalSeasons: 15, currentSeason: 15, currentEp: 60, totalEps: 3200, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/series/384681/posters/5ffd107fb9639.jpg' },
  { id: 391636, slug: 'thus-spoke-kishibe-rohan', type: 'series', title: '岸辺露伴は動かない', titleEn: 'Thus Spoke Kishibe Rohan', network: 'NHK', year: 2017, matchedBy: 'exact', totalSeasons: 4, currentSeason: 4, currentEp: 3, totalEps: 18, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/series/391636/posters/5fdf312372c6e.jpg' },
  { id: 399881, slug: 'ichikeis-crow', type: 'series', title: 'イチケイのカラス', titleEn: "Ichikei's Crow", network: 'Fuji TV', year: 2021, matchedBy: 'exact', totalSeasons: 2, currentSeason: 2, currentEp: 10, totalEps: 20, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/399881/posters/6707d9b7c93d7.jpg' },
  { id: 414096, slug: 'urusei-yatsura', type: 'series', title: 'うる星やつら', titleEn: 'Urusei Yatsura', network: 'Fuji TV', year: 2022, matchedBy: 'exact', totalSeasons: 2, currentSeason: 2, currentEp: 12, totalEps: 50, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/414096/posters/64e4f02bbc8b2.jpg' },
  { id: 418527, slug: 'shojiki-fudosan', type: 'series', title: '正直不動産', titleEn: 'Shojiki Fudosan', network: 'NHK', year: 2022, matchedBy: 'exact', totalSeasons: 2, currentSeason: 2, currentEp: 10, totalEps: 20, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/418527/posters/689b0b338e23c.jpg' },
  { id: 419548, slug: 'eizou-seiki-butterfly', type: 'series', title: '映像の世紀バタフライエフェクト', titleEn: 'Century in Film: Butterfly Effect', network: 'NHK', year: 2014, matchedBy: 'exact', totalSeasons: 4, currentSeason: 4, currentEp: 3, totalEps: 64, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/419548/posters/66bf4c8e86e39.jpg' },
  { id: 432832, slug: 'dandadan', type: 'series', title: 'ダンダダン', titleEn: 'Dan Da Dan', network: 'MBS', year: 2024, matchedBy: 'exact', totalSeasons: 1, currentSeason: 1, currentEp: 10, totalEps: 24, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/432832/posters/66799de2d4628.jpg' },
  { id: 464275, slug: 'tsurube-no-kazoku-ni-kanpai', type: 'series', title: '鶴瓶の家族に乾杯', titleEn: "Cheers to Tsurube's Family", network: 'NHK', year: 2025, matchedBy: 'exact', totalSeasons: 31, currentSeason: 31, currentEp: 12, totalEps: 986, status: 'continuing', poster: 'https://artworks.thetvdb.com/banners/v4/series/464275/posters/683abd0504d63.jpg' },
  { id: 45,  slug: 'venom', type: 'movie', title: 'ヴェノム', titleEn: 'Venom', network: 'Sony', year: 2018, matchedBy: 'exact', runtime: 112, director: 'Ruben Fleischer', rating: 6.7, poster: 'https://artworks.thetvdb.com/banners/movies/45/posters/2195358.jpg' },
  { id: 73,  slug: 'ready-player-one', type: 'movie', title: 'レディ・プレイヤー1', titleEn: 'Ready Player One', network: 'Warner Bros.', year: 2018, matchedBy: 'exact', runtime: 140, director: 'Steven Spielberg', rating: 7.5, poster: 'https://artworks.thetvdb.com/banners/v4/movie/73/posters/684bbd2328b60.jpg' },
  { id: 281, slug: 'the-devil-wears-prada', type: 'movie', title: 'プラダを着た悪魔', titleEn: 'The Devil Wears Prada', network: '20th Century Fox', year: 2006, matchedBy: 'exact', runtime: 109, director: 'David Frankel', rating: 7.4, poster: 'https://artworks.thetvdb.com/banners/movies/281/posters/281.jpg' },
  { id: 2649, slug: 'the-queen', type: 'movie', title: 'クィーン', titleEn: 'The Queen', network: 'Pathé', year: 2006, matchedBy: 'exact', runtime: 103, director: 'Stephen Frears', rating: 7.3, poster: 'https://artworks.thetvdb.com/banners/movies/2649/posters/2649.jpg' },
  { id: 3496, slug: 'wild', type: 'movie', title: 'わたしに会うまでの1600キロ', titleEn: 'Wild', network: 'Fox Searchlight', year: 2014, matchedBy: 'exact', runtime: 115, director: 'Jean-Marc Vallée', rating: 7.1, poster: 'https://artworks.thetvdb.com/banners/v4/movie/3496/posters/628afdbee935d.jpg' },
  { id: 133330, slug: 'tom-and-jerry', type: 'movie', title: 'トムとジェリー', titleEn: 'Tom and Jerry', network: 'Warner Bros.', year: 2021, matchedBy: 'exact', runtime: 101, director: 'Tim Story', rating: 5.5, poster: 'https://artworks.thetvdb.com/banners/movies/133330/posters/5fe38c41c7eb1.jpg' },
] as const;

export const TVDB_CATALOG = TVDB_CATALOG_RAW as unknown as ApiTvdbEntry[];

// Populated as we expand the schedule. One demo case can cover several
// slots (e.g. 2–3 currently-recording programs) so the grid doesn't have
// a single lonely badge.
const DEMO_PROGRAM_IDS: Partial<Record<DemoCase, string[]>> = {};

function expandChannel(ch: string, base: number, slots: Slot[]): ApiProgram[] {
  const out: ApiProgram[] = [];
  let offset = 0;
  const total = slots.reduce((s, x) => s + x.dur, 0);
  const scale = total > 0 ? DAY_MIN / total : 1;
  slots.forEach((s, i) => {
    const dur = i === slots.length - 1
      ? DAY_MIN - offset
      : Math.max(5, Math.round(s.dur * scale));
    const startAt = new Date(base + offset * 60_000).toISOString();
    const endAt = new Date(base + (offset + dur) * 60_000).toISOString();
    const id = `${ch}_${startAt}`;
    const prog: Record<string, unknown> = {
      id,
      ch,
      title: s.title,
      startAt,
      endAt,
      ep: s.ep ?? null,
      series: s.series ?? null,
      desc: s.desc,
      genre: GENRES[s.genre] ?? GENRES.other,
      hd: true,
    };
    if (s.demo) {
      (DEMO_PROGRAM_IDS[s.demo] ??= []).push(id);
    }
    if (s.tvdbId != null) {
      const tvdb = TVDB_CATALOG_RAW.find((t) => t.id === s.tvdbId);
      if (tvdb) {
        prog.tvdb = tvdb;
        if (tvdb.type === 'series') {
          prog.tvdbSeason = 1;
          prog.tvdbEpisode = Number((s.ep ?? '#1').replace(/\D+/g, '')) || 1;
          prog.tvdbEpisodeName = `${s.title} — 第${prog.tvdbEpisode}話`;
        }
      }
    }
    out.push(prog as unknown as ApiProgram);
    offset += dur;
  });
  return out;
}

export function programsForDate(ymd: string): ApiProgram[] {
  // Reset DEMO_PROGRAM_IDS before each run — expandChannel pushes into it,
  // so repeated calls (e.g. handler → programsForDate, handler again via
  // recordingsList) would otherwise double-count every tagged slot.
  for (const k of Object.keys(DEMO_PROGRAM_IDS)) delete DEMO_PROGRAM_IDS[k as DemoCase];
  const base = jstBroadcastStart(ymd).getTime();
  const progs: ApiProgram[] = [];
  for (const [ch, slots] of Object.entries(SCHEDULE)) {
    progs.push(...expandChannel(ch, base, slots));
  }
  return progs;
}

// Which demo cases should be "being recorded" in the mock (matches the
// -rec suffix). Separate from programsForDate so the recordings list can
// point at the same ProgramIDs after a schedule regen.
const DEMO_RECORDING_CASES: DemoCase[] = [
  'series-tvdb-rec',
  'series-plain-rec',
  'movie-tvdb-rec',
  'movie-plain-rec',
];

function makeRecordings(today: string): ApiRecording[] {
  // Force schedule generation so DEMO_PROGRAM_IDS is populated.
  const progs = programsForDate(today) as unknown as Array<{ id: string; ch: string; title: string; startAt: string; endAt: string }>;
  const byId = new Map(progs.map((p) => [p.id, p] as const));
  const now = new Date();
  const stateByCase: Record<DemoCase, string> = {
    'series-tvdb-rec':   'recording',
    'series-plain-rec':  'scheduled',
    'movie-tvdb-rec':    'scheduled',
    'movie-plain-rec':   'ready',
    'series-tvdb-free':  'scheduled',
    'series-plain-free': 'scheduled',
    'movie-tvdb-free':   'scheduled',
    'movie-plain-free':  'scheduled',
  };
  const rows: unknown[] = [];
  let seq = 1;
  for (const caseId of DEMO_RECORDING_CASES) {
    const ids = DEMO_PROGRAM_IDS[caseId] ?? [];
    ids.forEach((pid) => {
      const p = byId.get(pid);
      if (!p) return;
      rows.push({
        id: `rec-${caseId}-${seq++}`,
        programId: p.id,
        ch: p.ch,
        title: p.title,
        startAt: p.startAt,
        endAt: p.endAt,
        priority: caseId.startsWith('series-tvdb') ? 'high' : 'medium',
        quality: '1080i',
        keepRaw: false,
        marginPre: 0,
        marginPost: 30,
        state: stateByCase[caseId],
        source: { kind: 'once' },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    });
  }
  return rows as unknown as ApiRecording[];
}

export const RULES = [
  { id: 1, name: 'NHK スペシャル', keyword: 'NHKスペシャル', channels: ['nhk-g'], enabled: true,  matches: 12, priority: 'high',   quality: '1080i', skipReruns: true,  kind: 'keyword' },
  { id: 2, name: 'ダーウィンが来た！', keyword: 'ダーウィンが来た', channels: ['nhk-g'], enabled: true,  matches: 48, priority: 'medium', quality: '1080i', skipReruns: true,  kind: 'keyword' },
  { id: 3, name: '深夜アニメ (MX)', keyword: 'アニメ', channels: ['mx'], enabled: false, matches: 0,  priority: 'low',    quality: '1080i', skipReruns: false, kind: 'keyword' },
] as unknown as ApiRule[];

export const TUNERS = [
  { type: 'GR', total: 4, inUse: 1 },
  { type: 'BS', total: 2, inUse: 0 },
  { type: 'CS', total: 2, inUse: 0 },
] as unknown as ApiTunerState[];

// Not typed against the generated schema — it lands on branches where the
// ApiTunerAllocation export may lag. The UI only cares about `slots: []`.
export const TUNER_ALLOCATION = { slots: [] } as unknown;

export function nowRecording(today: string): ApiNowRecording[] {
  // Only the `series-tvdb-rec` case uses state='recording' in makeRecordings,
  // so that's exactly the set of "on-air right now" programs for the badge.
  const progs = programsForDate(today) as unknown as Array<{ id: string; ch: string; title: string; startAt: string; endAt: string }>;
  const ids = new Set(DEMO_PROGRAM_IDS['series-tvdb-rec'] ?? []);
  return progs
    .filter((p) => ids.has(p.id))
    .map((p) => ({
      id: `nr-${p.id}`,
      programId: p.id,
      title: p.title,
      ch: p.ch,
      startAt: p.startAt,
      endAt: p.endAt,
    })) as unknown as ApiNowRecording[];
}

export const SYSTEM = {
  version: '0.1.0-mock',
  storage: { totalBytes: 2_000_000_000_000, usedBytes: 420_000_000_000, path: '/mock/recordings' },
  queues: {
    'record.start': { queued: 0, active: 0 },
    'record.stop':  { queued: 0, active: 0 },
    encode:         { queued: 1, active: 1 },
    'epg.refresh':  { queued: 0, active: 0 },
    'rule.expand':  { queued: 0, active: 0 },
  },
} as unknown as ApiSystemStatus;

// Per-genre ranking items. Each entry either carries a real TVDB link
// (via one of the TVDB_CATALOG_RAW ids) or tvdb: null for the "unlinked"
// case. The Discover tab derives its "add auto-record rule" chip from
// whether tvdb is set, so we keep ~half of each list linked.
interface RankingSeed {
  title: string;
  channelName: string | null;
  delta: number | null;
  tvdbId: number | null;
  quote?: string | null;
}

const RANKING_SEEDS: Record<string, RankingSeed[]> = {
  all: [
    { title: 'NHKスペシャル',              channelName: 'NHK総合',    delta: 2,    tvdbId: 419548, quote: '巨大地震 最新研究' },
    { title: 'ダーウィンが来た！',         channelName: 'NHK総合',    delta: 1,    tvdbId: 339051, quote: '深海の巨大イカに迫る' },
    { title: '世界の果てまでイッテQ!',     channelName: '日テレ',      delta: -2,   tvdbId: 273667, quote: 'みやぞん山籠り' },
    { title: '響け！ユーフォニアム',       channelName: 'TOKYO MX',   delta: null, tvdbId: 352408, quote: '第8話 それぞれの春' },
    { title: 'ブラタモリ',                 channelName: 'NHK総合',    delta: -1,   tvdbId: 165891, quote: '甲府盆地をゆく' },
    { title: '連続テレビ小説 みらい色',     channelName: 'NHK総合',    delta: 0,    tvdbId: 270774, quote: '第58回' },
    { title: '金曜ドラマ 静寂の向こう',     channelName: 'TBS',        delta: 0,    tvdbId: 418527, quote: '急転の第6話' },
    { title: '金曜プレミアム 劇場版アニメ',  channelName: 'フジテレビ', delta: 3,   tvdbId: 133330, quote: '金曜プレミアム枠' },
    { title: '相棒',                       channelName: 'テレビ朝日', delta: 2,    tvdbId: 188501, quote: '杉下右京 新たな謎' },
    { title: 'マツコの知らない世界',        channelName: 'TBS',        delta: 1,    tvdbId: 357827, quote: null },
    { title: '情熱大陸',                   channelName: 'TBS',        delta: 0,    tvdbId: 362256, quote: '若き建築家' },
    { title: 'ポケットモンスター',          channelName: 'テレビ東京', delta: -1,  tvdbId: 76703, quote: null },
  ],
  drama: [
    { title: '金曜ドラマ 静寂の向こう',     channelName: 'TBS',        delta: 0,    tvdbId: 418527, quote: '急転の第6話' },
    { title: '連続テレビ小説 みらい色',     channelName: 'NHK総合',    delta: 1,    tvdbId: 270774, quote: '第58回' },
    { title: '金曜ナイトドラマ',           channelName: 'テレビ朝日', delta: -1,   tvdbId: 249250, quote: null },
    { title: '世にも奇妙な物語',           channelName: 'フジテレビ', delta: 2,    tvdbId: 391636, quote: '新作読み切り' },
    { title: '相棒',                       channelName: 'テレビ朝日', delta: 3,    tvdbId: 188501, quote: '杉下右京 新たな謎' },
    { title: '時代劇アワー',               channelName: 'BS日テレ',   delta: null, tvdbId: null,  quote: null },
    { title: 'サスペンス劇場',             channelName: 'BS-TBS',     delta: 0,    tvdbId: null,  quote: null },
  ],
  anime: [
    { title: '響け！ユーフォニアム',       channelName: 'TOKYO MX',   delta: 1,    tvdbId: 352408, quote: '第8話 それぞれの春' },
    { title: '響け！ユーフォニアム 2026 新章', channelName: 'TOKYO MX', delta: 2,  tvdbId: 352408, quote: '新章放送開始' },
    { title: 'ポケットモンスター',          channelName: 'テレビ東京', delta: 0,   tvdbId: 76703, quote: null },
    { title: '劇場版 名前のないアニメ',     channelName: 'フジテレビ', delta: null, tvdbId: 73, quote: '映画館から直送' },
    { title: 'アニメイズム',               channelName: 'TOKYO MX',   delta: 0,    tvdbId: null,  quote: null },
    { title: 'ソードアートロード',         channelName: 'TOKYO MX',   delta: -1,   tvdbId: null,  quote: null },
    { title: '新作アニメ枠',               channelName: 'TOKYO MX',   delta: 2,    tvdbId: null,  quote: null },
  ],
  doc: [
    { title: 'NHKスペシャル',              channelName: 'NHK総合',    delta: 1,    tvdbId: 419548, quote: null },
    { title: 'ダーウィンが来た！',         channelName: 'NHK総合',    delta: -1,   tvdbId: 339051, quote: null },
    { title: 'ドキュメント72時間',         channelName: 'NHK総合',    delta: 0,    tvdbId: 339051, quote: '深夜のコンビニ' },
    { title: '情熱大陸',                   channelName: 'TBS',        delta: 2,    tvdbId: 362256, quote: '若き建築家' },
    { title: 'カンブリア宮殿',             channelName: 'テレビ東京', delta: 0,    tvdbId: 362102, quote: null },
    { title: 'ガイアの夜明け',             channelName: 'テレビ東京', delta: 1,    tvdbId: 362147, quote: null },
    { title: '映像の世紀 バタフライエフェクト', channelName: 'NHK総合', delta: 2, tvdbId: 419548, quote: null },
    { title: 'アナザーストーリーズ',        channelName: 'NHK BS',     delta: null, tvdbId: null,  quote: null },
  ],
  movie: [
    { title: '金曜プレミアム 劇場版アニメ ワールドツアー', channelName: 'フジテレビ', delta: 3, tvdbId: 133330, quote: null },
    { title: '名探偵ポアロ ナイル殺人事件', channelName: 'NHK BSP4K',  delta: 1,    tvdbId: 2649, quote: '名探偵ポアロ' },
    { title: '劇場版 名前のないアニメ',     channelName: 'フジテレビ', delta: 0,    tvdbId: 73, quote: null },
    { title: 'ゴジラ vs モスラ',            channelName: 'テレビ東京', delta: -2,  tvdbId: 45, quote: '特撮シネマ枠' },
    { title: '山が飛ぶ日',                 channelName: 'BS-TBS',     delta: 2,    tvdbId: 3496, quote: '深夜の名作劇場' },
    { title: '劇場版 仮面ライダー セイバー', channelName: 'BS日テレ',  delta: null, tvdbId: 281, quote: null },
    { title: '金曜ロードショー',           channelName: '日テレ',      delta: 0,   tvdbId: null,  quote: null },
  ],
  var: [
    { title: '世界の果てまでイッテQ!',     channelName: '日テレ',     delta: 1,    tvdbId: 273667, quote: null },
    { title: 'プレバト！！',               channelName: 'TBS',        delta: 0,    tvdbId: 338042, quote: null },
    { title: 'マツコの知らない世界',        channelName: 'TBS',        delta: 2,    tvdbId: 357827, quote: null },
    { title: 'アド街ック天国',             channelName: 'テレビ東京', delta: 0,    tvdbId: 369652, quote: null },
    { title: '鶴瓶の家族に乾杯',           channelName: 'NHK総合',    delta: 1,    tvdbId: 464275, quote: null },
    { title: 'ブラタモリ',                 channelName: 'NHK総合',    delta: -1,   tvdbId: 165891, quote: null },
    { title: 'バリバラ',                   channelName: 'NHK Eテレ',  delta: 2,    tvdbId: null,  quote: null },
    { title: '徹子の部屋',                 channelName: 'テレビ朝日', delta: -1,   tvdbId: null,  quote: null },
  ],
  news: [
    { title: '報道ステーション',           channelName: 'テレビ朝日', delta: 0,    tvdbId: 253195, quote: null },
    { title: 'ワールドビジネスサテライト',  channelName: 'テレビ東京', delta: 2,    tvdbId: 362147, quote: null },
    { title: 'NEWS ZERO',                  channelName: '日テレ',      delta: 1,   tvdbId: null,  quote: null },
    { title: 'Nスタ',                      channelName: 'TBS',        delta: -1,   tvdbId: null,  quote: null },
    { title: 'NHK ニュース7',               channelName: 'NHK総合',    delta: 0,   tvdbId: null,  quote: null },
    { title: 'モーニングサテライト',        channelName: 'テレビ東京', delta: null, tvdbId: null, quote: null },
  ],
  edu: [
    { title: '100分 de 名著',                channelName: 'NHK Eテレ',  delta: 0,    tvdbId: 284314, quote: null },
    { title: 'サイエンスZERO',               channelName: 'NHK Eテレ',  delta: 1,    tvdbId: 324749, quote: null },
    { title: '先人たちの底力 知恵泉',         channelName: 'NHK Eテレ',  delta: -1,   tvdbId: null,  quote: null },
  ],
  sport: [
    { title: 'MLB 中継 NHK',                 channelName: 'NHK BS',     delta: 1,   tvdbId: 319801, quote: 'ヤンキース vs レッドソックス' },
    { title: '欧州サッカー ダイジェスト',     channelName: 'NHK BS',     delta: 0,   tvdbId: null, quote: null },
    { title: 'サンデーラグビー',             channelName: 'BS日テレ',   delta: null, tvdbId: null, quote: null },
  ],
  music: [
    { title: 'クラシック音楽館',             channelName: 'NHK Eテレ',  delta: 0,   tvdbId: 317970, quote: 'N響定期演奏会' },
    { title: '名曲アルバム',                 channelName: 'NHK BSP4K',  delta: 1,   tvdbId: null, quote: null },
    { title: 'アニソン倶楽部',               channelName: 'BS-TBS',     delta: -1,  tvdbId: null, quote: null },
  ],
};

export function rankingsForGenre(genre: string): ApiRankingList {
  const seeds = RANKING_SEEDS[genre] ?? RANKING_SEEDS.all;
  const now = new Date().toISOString();
  const items = seeds.map((s, i) => ({
    rank: i + 1,
    title: s.title,
    channelName: s.channelName,
    delta: s.delta,
    quote: s.quote ?? null,
    tvdb: s.tvdbId != null
      ? (TVDB_CATALOG_RAW.find((t) => t.id === s.tvdbId) ?? null)
      : null,
    syncedAt: now,
  }));
  return { genre, items } as unknown as ApiRankingList;
}

export const RANKINGS = rankingsForGenre('all');

export function searchPrograms(q: string, today: string): ApiSearchResult {
  const lower = q.toLowerCase();
  const progs = programsForDate(today) as unknown as Array<{ title: string; desc?: string }>;
  const hits = programsForDate(today).filter((_, i) => {
    const p = progs[i];
    return p.title.toLowerCase().includes(lower) || (p.desc ?? '').toLowerCase().includes(lower);
  });
  return {
    q,
    total: hits.length,
    programs: hits.slice(0, 20),
    series: [],
    channels: [],
    rules: [],
    recordings: [],
  } as unknown as ApiSearchResult;
}

export function defaultToday(): string {
  return todayJstYmd();
}

export function recordingsList(today: string): ApiRecording[] {
  return makeRecordings(today);
}
